import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamJobRedis } from './helpers/streamJobRedis.js';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  player: vi.fn(),
  proxiesEnabled: false,
  redis: new Map<string, string>(),
  files: new Map<string, string>(),
  platformResolve: vi.fn(),
  cacheWrite: vi.fn(),
  jobRedis: undefined as StreamJobRedis | undefined,
}));

vi.mock('youtubei.js', () => ({
  Innertube: { create: state.create },
  Platform: { shim: {} },
  Parser: { addRuntimeParser() {}, setParserErrorHandler() {} },
  Helpers: { YTNode: class {} },
}));
vi.mock('undici', () => ({
  ProxyAgent: class {},
  fetch: () => { throw new Error('Unexpected live proxy fetch'); },
}));
vi.mock('../config.js', () => ({
  config: () => ({ WEBSHARE_API_KEY: state.proxiesEnabled ? 'dummy-key' : null }),
}));
vi.mock('../youtubeApi.js', () => ({ fetchRegionRestriction: async () => null }));
vi.mock('../platformResolvers.js', () => ({
  detectProvider: (url: string) => url.includes('music.apple.com') ? 'apple_music' : url.includes('soundcloud.com') ? 'soundcloud' : 'youtube',
  resolveToPlayableStream: state.platformResolve,
}));
vi.mock('../searchService.js', () => ({ fetchResults: async () => null }));
vi.mock('../redis.js', async () => {
  const { StreamJobRedis } = await import('./helpers/streamJobRedis.js');
  const jobRedis = new StreamJobRedis();
  state.redis = jobRedis.store;
  state.jobRedis = jobRedis;
  return { redis: () => ({
    get: jobRedis.get.bind(jobRedis),
    set: jobRedis.set.bind(jobRedis),
    eval: jobRedis.eval.bind(jobRedis),
    setex: state.cacheWrite,
    del: jobRedis.del.bind(jobRedis),
  }) };
});
// Exercise the file-cache serialization without touching the service's cache directory.
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

import { getStream, getVideoStream, invalidate } from '../cacheManager.js';
import { invalidateResolvedStream, resetInnertube, resolveBothWithMeta } from '../innertube.js';
import { websharePool, type WebshareProxy } from '../proxy.js';
import { awaitStreamJob, ensureStreamJob, refreshStreamUrl, resetJobState } from '../streamJobs.js';

let sequence = 0;
function videoId(): string { return `audit${String(sequence++).padStart(6, '0')}`; }
function streamUrl(tag: string): string {
  return `https://rr1.googlevideo.com/videoplayback?expire=4102444800&tag=${tag}`;
}
function playable(url: string, audioOnly = false): Record<string, unknown> {
  return {
    playability_status: { status: 'OK' },
    chooseFormat: ({ type }: { type: string }) => {
      if (audioOnly && type === 'video+audio') throw new Error('No muxed format');
      return { url, decipher: async () => url };
    },
  };
}

beforeEach(() => {
  resetInnertube();
  resetJobState();
  state.create.mockReset();
  state.player.mockReset();
  state.platformResolve.mockReset();
  state.proxiesEnabled = false;
  state.jobRedis!.clear();
  state.cacheWrite.mockReset().mockImplementation(async (key: string, _ttl: number, value: string) => {
    state.redis.set(key, value);
    return 'OK';
  });
  state.files.clear();
  websharePool._setCandidatesForTest([]);
  state.create.mockImplementation(async () => ({ session: { player: {} }, getBasicInfo: state.player }));
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected live fetch'); });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('revoked stream invalidation', () => {
  it('re-fetches the player after invalidation instead of reusing its direct memo', async () => {
    const id = videoId();
    const original = streamUrl('original');
    const fresh = streamUrl('fresh');
    state.player.mockResolvedValueOnce(playable(original)).mockResolvedValue(playable(fresh));

    expect((await getStream(id))?.url).toBe(original);
    expect((await getStream(id))?.url).toBe(original);
    expect(state.player).toHaveBeenCalledTimes(1);
    await invalidate(id, 'audio:');
    expect((await getStream(id))?.url).toBe(fresh);
    expect(state.player).toHaveBeenCalledTimes(2);
    expect((await getStream(id))?.url).toBe(fresh);
  });

  it.each(['redis', 'file'] as const)('invalidates a platform target using identity from its %s cache', async (layer) => {
    const id = videoId();
    const original = streamUrl('platform-old');
    const fresh = streamUrl('platform-fresh');
    const platformUrl = `https://music.apple.com/in/song/audit/${id}`;
    state.platformResolve.mockResolvedValue({ stream_url: `https://youtu.be/${id}` });
    state.player.mockResolvedValueOnce(playable(original)).mockResolvedValue(playable(fresh));
    expect((await getStream(platformUrl))?.url).toBe(original);
    if (layer === 'redis') state.files.clear();
    else state.redis.clear();

    await invalidate(platformUrl, 'audio:');
    expect((await getStream(platformUrl))?.url).toBe(fresh);
    expect(state.player).toHaveBeenCalledTimes(2);
  });

  it('discards extraction that was in flight when its URL was invalidated', async () => {
    const id = videoId();
    const original = streamUrl('inflight-old');
    const fresh = streamUrl('inflight-fresh');
    let release!: (info: unknown) => void;
    state.player.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    state.player.mockResolvedValue(playable(fresh));
    const pending = getStream(id);
    await vi.waitFor(() => expect(state.player).toHaveBeenCalledTimes(1));
    await invalidate(id, 'audio:');
    release(playable(original));

    expect((await pending)?.url).toBe(fresh);
    expect((await getStream(id))?.url).toBe(fresh);
    expect([...state.redis.values()].join('')).not.toContain('inflight-old');
    expect([...state.files.values()].join('')).not.toContain('inflight-old');
  });

  it('waits for a delayed Redis write before deleting it and publishing a fresh result', async () => {
    const id = videoId();
    const original = streamUrl('delayed-old');
    const fresh = streamUrl('delayed-fresh');
    state.player.mockResolvedValueOnce(playable(original)).mockResolvedValue(playable(fresh));
    let release!: () => void;
    state.cacheWrite.mockImplementationOnce((key: string, _ttl: number, value: string) => new Promise((resolve) => {
      release = () => { state.redis.set(key, value); resolve('OK'); };
    }));
    const pending = getStream(id);
    await vi.waitFor(() => expect(state.cacheWrite).toHaveBeenCalledTimes(1));
    const invalidating = invalidate(id, 'audio:');
    release();
    await invalidating;
    expect((await pending)?.url).toBe(fresh);
    expect((await getStream(id))?.url).toBe(fresh);
    expect([...state.redis.values()].join('')).not.toContain('delayed-old');
  });

  it('does not republish a standalone player request invalidated while in flight', async () => {
    const id = videoId();
    const fresh = streamUrl('standalone-fresh');
    let release!: (info: unknown) => void;
    state.player.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    state.player.mockResolvedValue(playable(fresh));
    const pending = resolveBothWithMeta(id);
    await vi.waitFor(() => expect(state.player).toHaveBeenCalledTimes(1));
    invalidateResolvedStream(id);
    release(playable(streamUrl('standalone-old')));
    expect((await pending).urls).toEqual([fresh, fresh]);
    expect((await resolveBothWithMeta(id)).urls).toEqual([fresh, fresh]);
    expect(state.player).toHaveBeenCalledTimes(2);
  });

  it('refreshes a real stream job through cacheManager and the player', async () => {
    const id = videoId();
    const original = streamUrl('job-old');
    const fresh = streamUrl('job-fresh');
    state.player.mockResolvedValueOnce(playable(original)).mockResolvedValue(playable(fresh));
    const capability = await ensureStreamJob(`https://youtu.be/${id}`, 'audio');
    const resolved = (await awaitStreamJob(capability))!;
    expect(resolved.job.extracted_url).toBe(original);
    expect(state.player).toHaveBeenCalledTimes(1);

    const refreshed = await refreshStreamUrl(resolved.streamId, resolved.job);
    expect(refreshed?.extracted_url).toBe(fresh);
    expect(state.player).toHaveBeenCalledTimes(2);
    expect((await awaitStreamJob(capability))?.job.extracted_url).toBe(fresh);
  });

  it('returns a resolved SoundCloud media URL through the direct provider path', async () => {
    const url = 'https://soundcloud.com/audit-artist/audit-track';
    const media = 'https://cf-media.sndcdn.com/audit-track.mp3';
    state.platformResolve.mockResolvedValue({ stream_url: media });
    expect(await getStream(url)).toEqual({ url: media, proxyUrl: null });
    expect(state.platformResolve).toHaveBeenCalledWith(url);
    expect(state.player).not.toHaveBeenCalled();
  });

  it('preserves the explicit audio fallback for muxed requests', async () => {
    const url = streamUrl('audio-only');
    state.player.mockResolvedValue(playable(url, true));
    expect((await getVideoStream(videoId()))?.url).toBe(url);
  });
});

describe('proxy health after player failures', () => {
  function configureProxies(): WebshareProxy[] {
    state.proxiesEnabled = true;
    const proxies = Array.from({ length: 4 }, (_, index) => ({
      id: `proxy-${sequence}-${index}`,
      address: `45.61.0.${index + 10}`,
      port: 8000, username: 'u', password: 'p',
      url: `http://u:p@proxy-${sequence}-${index}.example.com:8000`,
      countryCode: 'US', city: '', lastVerification: 0,
    }));
    websharePool._setCandidatesForTest(proxies);
    return proxies;
  }

  it.each([
    ['UNPLAYABLE', 'This video is unavailable'],
    ['LOGIN_REQUIRED', 'This video is private'],
    ['UNPLAYABLE', 'The uploader has not made this video available in your country'],
  ])('retains reachable proxies and their sessions after %s: %s', async (status, reason) => {
    configureProxies();
    state.player.mockResolvedValue({ playability_status: { status, reason } });
    for (let index = 0; index < 3; index += 1) {
      expect((await resolveBothWithMeta(videoId())).urls).toEqual([null, null]);
      expect(websharePool.size).toBe(4);
    }
    // One direct session plus one per reachable exit, all retained across videos.
    expect(state.create).toHaveBeenCalledTimes(5);
  });

  it('retains proxies when youtubei throws its structured unavailable-video error', async () => {
    configureProxies();
    state.player.mockRejectedValue(Object.assign(new Error('This video is unavailable'), {
      info: { status: 'ERROR', reason: 'This video has been removed by the uploader' },
    }));
    for (let index = 0; index < 3; index += 1) await resolveBothWithMeta(videoId());
    expect(websharePool.size).toBe(4);
    expect(state.create).toHaveBeenCalledTimes(5);
  });

  it.each([
    () => Promise.reject(new Error('fetch failed: ECONNRESET')),
    () => Promise.resolve({ playability_status: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } }),
  ])('still evicts exits after repeated transport or exit-blocking failures', async (response) => {
    configureProxies();
    state.player.mockImplementation(response);
    for (let index = 0; index < 3; index += 1) await resolveBothWithMeta(videoId());
    expect(websharePool.size).toBe(0);
  });
});
