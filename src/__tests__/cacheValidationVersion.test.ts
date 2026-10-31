import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  redisExpires: new Map<string, number>(),
  files: new Map<string, string>(),
  resolve: vi.fn(),
  setex: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  invalidateResolved: vi.fn(),
  invalidateProbe: vi.fn(),
  probe: vi.fn(),
  provider: 'youtube',
  platformResolve: vi.fn(),
}));

vi.mock('../innertube.js', () => ({
  extractId: (input: string) => {
    if (/^[\w-]{11}$/.test(input)) return input;
    const match = input.match(/(?:youtu\.be\/|[?&]v=)([\w-]{11})/);
    return match?.[1] ?? null;
  },
  resolveWithMeta: state.resolve,
  invalidateResolvedStream: state.invalidateResolved,
}));
vi.mock('../redis.js', () => ({ redis: () => ({ get: state.get, setex: state.setex, del: state.del }) }));
vi.mock('../platformResolvers.js', () => ({
  detectProvider: () => state.provider,
  resolveToPlayableStream: state.platformResolve,
}));
vi.mock('../searchService.js', () => ({ fetchResults: vi.fn() }));
vi.mock('../requestDeadline.js', () => ({ requestSignal: () => undefined }));
vi.mock('../mediaProbe.js', () => ({ probeMedia: state.probe, invalidateMediaProbe: state.invalidateProbe }));
vi.mock('../logger.js', () => ({ getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));
vi.mock('node:fs', () => ({
  existsSync: (path: string) => state.files.has(path),
  mkdirSync() {},
  readFileSync: (path: string) => {
    const value = state.files.get(path);
    if (value === undefined) throw new Error('ENOENT');
    return value;
  },
  writeFileSync: (path: string, value: string) => { state.files.set(path, value); },
  rmSync: (path: string) => { state.files.delete(path); },
}));

import { _cacheDirOverride, decodeCached, encodeCached, getStream, getVideoStream, invalidate, md5 } from '../cacheManager.js';
import { HLS_STREAM_TTL_S, STREAM_VALIDATION_VERSION } from '../streamPolicy.js';

const id = 'cache000001';
const proxy = 'http://u:p@proxy.example.com:8000';
const signed = (tag: string) => `https://rr1.googlevideo.com/videoplayback?expire=4102444800&tag=${tag}`;
const hls = (tag: string) => `https://manifest.googlevideo.com/api/manifest/hls_variant/id/${tag}`;
const filePath = (url: string, prefix = 'video:') => join(_cacheDirOverride(), md5(prefix + url) + '.json');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:00:00Z'));
  vi.resetAllMocks();
  state.redis.clear();
  state.redisExpires.clear();
  state.files.clear();
  state.provider = 'youtube';
  state.probe.mockResolvedValue(true);
  state.resolve.mockResolvedValue({ url: signed('fresh'), proxyUrl: null });
  state.get.mockImplementation(async (key: string) => {
    const expire = state.redisExpires.get(key);
    if (expire !== undefined && expire <= Date.now()) {
      state.redis.delete(key);
      state.redisExpires.delete(key);
    }
    return state.redis.get(key) ?? null;
  });
  state.setex.mockImplementation(async (key: string, ttl: number, value: string) => {
    state.redis.set(key, value);
    state.redisExpires.set(key, Date.now() + ttl * 1000);
    return 'OK';
  });
  state.del.mockImplementation(async (key: string) => {
    state.redisExpires.delete(key);
    return Number(state.redis.delete(key));
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('stream cache validation migration', () => {
  it.each([
    ['plain URL', signed('old-audio')],
    ['unversioned envelope', JSON.stringify({ u: signed('old-audio'), p: proxy, v: id })],
    ['old version', JSON.stringify({ u: signed('old-audio'), validationVersion: STREAM_VALIDATION_VERSION - 1 })],
    ['future version', JSON.stringify({ u: signed('old-audio'), validationVersion: STREAM_VALIDATION_VERSION + 1 })],
    ['string version', JSON.stringify({ u: signed('old-audio'), validationVersion: String(STREAM_VALIDATION_VERSION) })],
  ])('re-extracts a video instead of reusing %s from Redis', async (_label, raw) => {
    state.redis.set(`cache:video:${id}`, raw);

    expect((await getVideoStream(id))?.url).toBe(signed('fresh'));
    expect(state.resolve).toHaveBeenCalledWith(id, 'muxed', {});
    expect(JSON.parse(state.redis.get(`cache:video:${id}`)!)).toMatchObject({
      u: signed('fresh'), validationVersion: STREAM_VALIDATION_VERSION,
    });
    expect(state.del).not.toHaveBeenCalled();
  });

  it.each([undefined, STREAM_VALIDATION_VERSION - 1, STREAM_VALIDATION_VERSION + 1, String(STREAM_VALIDATION_VERSION)])(
    'does not restore a file written under validation version %s', async validationVersion => {
      state.files.set(filePath(id), JSON.stringify({ url: signed('old-audio'), expire: 4102444800, proxy, videoId: id, validationVersion }));

      expect((await getVideoStream(id))?.url).toBe(signed('fresh'));
      expect(state.resolve).toHaveBeenCalledTimes(1);
      expect(JSON.parse(state.files.get(filePath(id))!)).toMatchObject({
        url: signed('fresh'), validationVersion: STREAM_VALIDATION_VERSION,
      });
    },
  );

  it('rejects both pre-policy stores when fresh extraction cannot supply video', async () => {
    state.redis.set(`cache:video:${id}`, JSON.stringify({ u: signed('old-audio') }));
    state.files.set(filePath(id), JSON.stringify({ url: signed('old-audio'), expire: 4102444800 }));
    state.resolve.mockResolvedValue({ url: null, proxyUrl: null });

    expect(await getVideoStream(id)).toBeNull();
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(state.setex).not.toHaveBeenCalled();
    expect(state.files.has(filePath(id))).toBe(false);
  });

  it.each(['redis', 'file'] as const)('reuses a current %s stream with its identity and route', async layer => {
    const stream = { url: signed('current'), proxyUrl: proxy, videoId: id };
    if (layer === 'redis') state.redis.set(`cache:video:${id}`, JSON.stringify({ u: stream.url, p: proxy, v: id, validationVersion: STREAM_VALIDATION_VERSION }));
    else state.files.set(filePath(id), JSON.stringify({ url: stream.url, proxy, videoId: id, expire: 4102444800, validationVersion: STREAM_VALIDATION_VERSION }));

    expect(await getVideoStream(id)).toEqual(stream);
    expect(state.resolve).not.toHaveBeenCalled();
    if (layer === 'file') expect(JSON.parse(state.redis.get(`cache:video:${id}`)!)).toMatchObject({
      u: stream.url, p: proxy, v: id, validationVersion: STREAM_VALIDATION_VERSION,
    });
  });

  it('keeps legacy decoding and invalidation identity available', async () => {
    const legacy = JSON.stringify({ u: signed('legacy'), p: proxy, v: id });
    expect(decodeCached(legacy)).toEqual({ url: signed('legacy'), proxyUrl: proxy, videoId: id });
    expect(decodeCached(signed('plain'))).toEqual({ url: signed('plain'), proxyUrl: null });
    state.redis.set('cache:audio:platform-key', legacy);

    await invalidate('platform-key', 'audio:');
    expect(state.invalidateResolved).toHaveBeenCalledWith(id);
    expect(state.invalidateProbe).toHaveBeenCalledWith(signed('legacy'), proxy);
    expect(state.redis.has('cache:audio:platform-key')).toBe(false);
  });

  it.each(['soundcloud', 'jiosaavn'])('does not publish a direct %s audio source as validated video', async provider => {
    state.provider = provider;
    state.platformResolve.mockResolvedValue({ stream_url: signed('provider-audio') });
    const source = `https://${provider}.com/artist/song`;

    expect(await getVideoStream(source)).toBeNull();
    expect(state.files.size).toBe(0);
    expect(state.setex).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();

    expect((await getStream(source))?.url).toBe(signed('provider-audio'));
    expect(state.probe).toHaveBeenCalledTimes(1);
    expect(JSON.parse(state.redis.get(`cache:audio:${source}`)!)).toMatchObject({ validationVersion: STREAM_VALIDATION_VERSION });
  });
});

describe('live stream cache lifetime', () => {
  it('serializes the HLS type and validation version', () => {
    const stream = { url: hls('encoded'), proxyUrl: proxy, videoId: id, streamType: 'hls' as const };
    const raw = encodeCached(stream);
    expect(JSON.parse(raw)).toEqual({ u: stream.url, p: proxy, v: id, streamType: 'hls', validationVersion: STREAM_VALIDATION_VERSION });
    expect(decodeCached(raw)).toEqual(stream);
  });

  it.each([false, true])('caps an HLS stream without URL expiry across both stores (proxy=%s)', async bound => {
    const source = { url: hls('live'), proxyUrl: bound ? proxy : null, streamType: 'hls' as const };
    state.resolve.mockResolvedValue(source);
    const stream = { ...source, videoId: id };

    expect(await getStream(id)).toEqual(stream);
    const key = `cache:audio:${id}`;
    expect(state.setex).toHaveBeenCalledWith(key, HLS_STREAM_TTL_S, expect.any(String));
    expect(JSON.parse(state.redis.get(key)!)).toMatchObject({ streamType: 'hls', validationVersion: STREAM_VALIDATION_VERSION });
    expect(JSON.parse(state.files.get(filePath(id, 'audio:'))!)).toMatchObject({
      streamType: 'hls', validationVersion: STREAM_VALIDATION_VERSION, expire: Date.now() / 1000 + HLS_STREAM_TTL_S,
    });
    expect(await getStream(id)).toEqual(stream);
    expect(state.resolve).toHaveBeenCalledTimes(1);

    state.redis.clear();
    vi.setSystemTime(Date.now() + 20_000);
    expect(await getStream(id)).toEqual(stream);
    expect(state.setex).toHaveBeenLastCalledWith(key, HLS_STREAM_TTL_S - 20, expect.any(String));
    expect(state.resolve).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + (HLS_STREAM_TTL_S - 19) * 1000);
    state.resolve.mockResolvedValue({ ...source, url: hls('renewed') });
    expect((await getStream(id))?.url).toBe(hls('renewed'));
    expect(state.resolve).toHaveBeenCalledTimes(2);
  });

  it('caps HLS lifetime even when the URL declares a distant expiry', async () => {
    state.resolve.mockResolvedValue({ url: `${hls('signed')}?expire=4102444800`, proxyUrl: proxy, streamType: 'hls' });
    await getVideoStream(id);
    expect(state.setex).toHaveBeenCalledWith(`cache:video:${id}`, HLS_STREAM_TTL_S, expect.any(String));
    expect(JSON.parse(state.files.get(filePath(id))!).expire).toBe(Date.now() / 1000 + HLS_STREAM_TTL_S);
  });

  it('does not give a fallback live lifetime to an explicitly expired URL', async () => {
    state.resolve.mockResolvedValue({ url: `${hls('expired')}?expire=${Date.now() / 1000 - 1}`, proxyUrl: null, streamType: 'hls' });
    await getVideoStream(id);
    expect(state.setex).not.toHaveBeenCalled();
    expect(state.files.size).toBe(0);
  });
});
