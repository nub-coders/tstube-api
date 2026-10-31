import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamJobRedis } from './helpers/streamJobRedis.js';
import { Readable } from 'node:stream';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  player: vi.fn(),
  proxiesEnabled: false,
  redis: new Map<string, string>(),
  files: new Map<string, string>(),
  platformResolve: vi.fn(),
  cacheWrite: vi.fn(),
  mediaProbe: vi.fn(),
  regionRestriction: vi.fn(),
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
vi.mock('../youtubeApi.js', () => ({ fetchRegionRestriction: state.regionRestriction }));
vi.mock('../streamProxy.js', () => ({ proxyStream: state.mediaProbe }));
vi.mock('../platformResolvers.js', () => ({
  detectProvider: (url: string) => url.includes('music.apple.com') ? 'apple_music' : url.includes('soundcloud.com') ? 'soundcloud' : url.includes('jiosaavn.com') ? 'jiosaavn' : 'youtube',
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
import { invalidateMediaProbe } from '../mediaProbe.js';
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

function mediaResponse() {
  const bytes = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
  return { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes 0-${bytes.length - 1}/100000` }, body: Readable.from([bytes]) };
}

function configureProxies(count = 4): WebshareProxy[] {
  state.proxiesEnabled = true;
  const proxies = Array.from({ length: count }, (_, index) => ({
    id: `proxy-${sequence}-${index}`,
    address: `45.61.0.${index + 10}`,
    port: 8000, username: 'u', password: 'p',
    url: `http://u:p@proxy-${sequence}-${index}.example.com:8000`,
    countryCode: 'US', city: '', lastVerification: 0,
  }));
  websharePool._setCandidatesForTest(proxies);
  return proxies;
}

beforeEach(() => {
  for (const [url, options] of state.mediaProbe.mock.calls) invalidateMediaProbe(url, options?.proxyUrl);
  resetInnertube();
  resetJobState();
  state.create.mockReset();
  state.player.mockReset();
  state.platformResolve.mockReset();
  state.regionRestriction.mockReset().mockResolvedValue(null);
  state.mediaProbe.mockReset().mockImplementation(async () => mediaResponse());
  state.proxiesEnabled = true;
  state.jobRedis!.clear();
  state.cacheWrite.mockReset().mockImplementation(async (key: string, _ttl: number, value: string) => {
    state.redis.set(key, value);
    return 'OK';
  });
  state.files.clear();
  configureProxies(1);
  state.create.mockImplementation(async () => ({ session: { player: {} }, getBasicInfo: state.player }));
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected live fetch'); });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('revoked stream invalidation', () => {
  it('does not cache a fresh direct URL serving an HTML error with HTTP 200', async () => {
    state.player.mockResolvedValue(playable(streamUrl('html-error')));
    state.mediaProbe.mockImplementation(async () => ({
      status: 200, headers: { 'content-type': 'text/html' }, body: Readable.from(['<html>Access denied</html>']),
    }));
    expect(await getStream(videoId())).toBeNull();
    expect(state.files.size).toBe(0);
    expect(state.redis.size).toBe(0);
    expect(state.mediaProbe).toHaveBeenCalledTimes(2);
  });

  it('tries the next client after its CDN URL fails both media routes', async () => {
    const fresh = streamUrl('next-client');
    state.player.mockResolvedValueOnce(playable(streamUrl('unusable-client'))).mockResolvedValue(playable(fresh));
    state.mediaProbe.mockResolvedValueOnce({ status: 403, headers: {}, body: null })
      .mockResolvedValueOnce({ status: 403, headers: {}, body: null });
    expect((await getStream(videoId()))?.url).toBe(fresh);
    expect(state.player).toHaveBeenCalledTimes(2);
    expect(state.mediaProbe).toHaveBeenCalledTimes(4);
  });

  it('verifies both formats before memoizing them and does not re-probe cache hits', async () => {
    const id = videoId();
    const audio = streamUrl('audio-format');
    const video = streamUrl('video-format');
    state.player.mockResolvedValue({
      playability_status: { status: 'OK' },
      chooseFormat: ({ type }: { type: string }) => ({ decipher: async () => type === 'audio' ? audio : video }),
    });
    expect((await getStream(id))?.url).toBe(audio);
    expect((await getVideoStream(id))?.url).toBe(video);
    expect((await getStream(id))?.url).toBe(audio);
    expect(state.mediaProbe.mock.calls.map(call => call[0]).sort()).toEqual([audio, audio, video, video].sort());
    expect(state.mediaProbe.mock.calls.every(call => call[1].proxyUrl === null)).toBe(true);
  });

  it('rechecks the same signed URL after invalidation', async () => {
    const id = videoId();
    const media = streamUrl('revoked-same-url');
    state.player.mockResolvedValue(playable(media));
    expect((await getStream(id))?.url).toBe(media);
    await invalidate(id, 'audio:');
    state.mediaProbe.mockResolvedValue({ status: 403, headers: {}, body: null });
    expect(await getStream(id)).toBeNull();
    expect(state.mediaProbe).toHaveBeenCalledTimes(4);
  });

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
    expect(state.mediaProbe).toHaveBeenCalledWith(media, expect.objectContaining({ proxyUrl: null }));
  });

  it.each(['https://soundcloud.com/audit-artist/bad-track', 'https://www.jiosaavn.com/song/bad-track/id'])('does not publish a rejected direct provider URL: %s', async providerUrl => {
    state.platformResolve.mockResolvedValue({ stream_url: streamUrl('bad-provider') });
    state.mediaProbe.mockResolvedValue({ status: 403, headers: {}, body: null });
    expect(await getStream(providerUrl)).toBeNull();
    expect(state.files.size).toBe(0);
    expect(state.redis.size).toBe(0);
  });

  it('keeps video requests unavailable when the player offers only audio', async () => {
    const url = streamUrl('audio-only');
    state.player.mockResolvedValue(playable(url, true));
    expect(await getVideoStream(videoId())).toBeNull();
  });
});

describe('proxy health after player failures', () => {

  it.each([false, true])('targets an allowed country after a proxied geo restriction (exception=%s)', async throws => {
    const proxies = configureProxies(6).map((proxy, index) => ({ ...proxy, countryCode: index === 5 ? 'IN' : 'US' }));
    websharePool._setCandidatesForTest(proxies);
    const geo = { status: 'UNPLAYABLE', reason: 'This video is not available in your country' };
    const geoPlayer = throws
      ? vi.fn().mockRejectedValue(Object.assign(new Error('Video unavailable'), { info: geo }))
      : vi.fn().mockResolvedValue({ playability_status: geo, microformat: { available_countries: ['IN'] } });
    const media = streamUrl('geo-targeted');
    state.create.mockResolvedValue({ session: { player: {} }, getBasicInfo: async () => playable(media) });
    for (let index = 0; index < 4; index++) state.create.mockResolvedValueOnce({ getBasicInfo: geoPlayer });
    state.regionRestriction.mockResolvedValue({ allowed: ['IN'], blocked: ['US'] });
    state.mediaProbe.mockImplementation(async (_url: string, options: { proxyUrl: string | null }) =>
      options.proxyUrl ? mediaResponse() : { status: 403, headers: {}, body: null });
    const countries = vi.spyOn(websharePool, 'getGeoCandidates');
    expect(await getStream(videoId())).toMatchObject({ url: media, proxyUrl: proxies[5].url });
    expect(countries).toHaveBeenCalledWith({ allowed: ['IN'] }, 4, expect.any(Function));
    expect(state.regionRestriction).toHaveBeenCalledTimes(1);
    expect(state.create).toHaveBeenCalledTimes(5); // The extra US exit was skipped.
    expect(websharePool.size).toBe(6);
  });

  function configureProxyPlayer(proxied: string) {
    const proxyPlayer = vi.fn().mockResolvedValue(playable(proxied));
    state.create.mockResolvedValue({ session: { player: {} }, getBasicInfo: proxyPlayer });
    // Model an IP-bound media URL unless the test explicitly permits direct media.
    state.mediaProbe.mockImplementation(async (url: string, options: { proxyUrl: string | null }) =>
      url === proxied && !options.proxyUrl ? { status: 403, headers: {}, body: null } : mediaResponse());
    return proxyPlayer;
  }

  it('checks normal proxy fallback through the bound exit when direct media is rejected', async () => {
    const proxies = configureProxies();
    const proxied = streamUrl('normal-proxy');
    configureProxyPlayer(proxied);
    state.mediaProbe.mockImplementation(async (_url: string, options: { proxyUrl: string | null }) =>
      options.proxyUrl ? mediaResponse() : { status: 403, headers: {}, body: null });
    const result = await getStream(videoId());
    expect(result?.url).toBe(proxied);
    expect(proxies.map(proxy => proxy.url)).toContain(result?.proxyUrl);
    expect(state.mediaProbe).toHaveBeenCalledWith(proxied, expect.objectContaining({ proxyUrl: result?.proxyUrl }));
    expect(state.files.size).toBe(1);
  });

  it.each([false, true])('uses a Webshare-extracted URL directly when media works without Webshare (recovery=%s)', async recovery => {
    configureProxies();
    const id = videoId();
    const media = streamUrl(`proxy-extracted-direct-media-${id}`);
    configureProxyPlayer(media);
    state.mediaProbe.mockImplementation(async () => mediaResponse());
    const result = await getStream(id, { forceProxy: recovery });
    expect(result?.url).toBe(media);
    expect(result?.proxyUrl).toBeNull();
    expect(state.mediaProbe.mock.calls.every(call => call[1].proxyUrl === null)).toBe(true);
    const calls = state.mediaProbe.mock.calls.length;
    expect(await getStream(id)).toEqual(result);
    state.redis.clear(); // The file cache must preserve the direct route too.
    expect(await getStream(id)).toEqual(result);
    expect(state.mediaProbe).toHaveBeenCalledTimes(calls);
  });

  it.each(['audio', 'video'])('keeps independent playback routes when only %s works directly', async directFormat => {
    const [proxy] = configureProxies();
    websharePool._setCandidatesForTest([proxy!]);
    const id = videoId();
    const audio = streamUrl(`mixed-audio-${id}`);
    const video = streamUrl(`mixed-video-${id}`);
    const player = configureProxyPlayer(audio);
    player.mockResolvedValue({
      playability_status: { status: 'OK' },
      chooseFormat: ({ type }: { type: string }) => ({ decipher: async () => type === 'audio' ? audio : video }),
    });
    const directUrl = directFormat === 'audio' ? audio : video;
    state.mediaProbe.mockImplementation(async (url: string, options: { proxyUrl: string | null }) =>
      url === directUrl || options.proxyUrl ? mediaResponse() : { status: 403, headers: {}, body: null });
    const audioResult = await getStream(id, { forceProxy: true });
    const videoResult = await getVideoStream(id, { forceProxy: true });
    expect(audioResult).toMatchObject({ url: audio, proxyUrl: directFormat === 'audio' ? null : proxy!.url });
    expect(videoResult).toMatchObject({ url: video, proxyUrl: directFormat === 'video' ? null : proxy!.url });
    expect(await getStream(id)).toEqual(audioResult);
    expect(await getVideoStream(id)).toEqual(videoResult);
    expect(state.mediaProbe.mock.calls.filter(call => call[0] === directUrl).every(call => call[1].proxyUrl === null)).toBe(true);
  });

  it('publishes the direct media route to a stream job after Webshare extraction', async () => {
    configureProxies();
    const id = videoId();
    const media = streamUrl(`job-extracted-via-webshare-${id}`);
    configureProxyPlayer(media);
    state.mediaProbe.mockImplementation(async () => mediaResponse());
    const capability = await ensureStreamJob(`https://youtu.be/${id}`, 'audio');
    const resolved = (await awaitStreamJob(capability))!;
    expect(resolved.job.extracted_url).toBe(media);
    expect(resolved.job.proxy_url).toBeNull();
    expect(state.mediaProbe.mock.calls.every(call => call[1].proxyUrl === null)).toBe(true);
  });

  it('bypasses Redis, file and stream memo caches when recovering a rejected route', async () => {
    const proxies = configureProxies();
    const id = videoId();
    const original = streamUrl('rejected-direct');
    const fresh = streamUrl('fresh-proxy');
    const player = configureProxyPlayer(original);
    state.mediaProbe.mockImplementation(async (url: string, options: { proxyUrl: string | null }) =>
      url === fresh && !options.proxyUrl ? { status: 403, headers: {}, body: null } : mediaResponse());
    expect((await getStream(id))?.url).toBe(original);
    expect(state.files.size).toBeGreaterThan(0);
    expect(state.redis.size).toBeGreaterThan(0);
    const initialCalls = player.mock.calls.length;
    player.mockResolvedValue(playable(fresh));

    const recovered = await getStream(id, { forceProxy: true });
    expect(recovered?.url).toBe(fresh);
    expect(proxies.map(p => p.url)).toContain(recovered?.proxyUrl);
    expect(player.mock.calls.length).toBeGreaterThan(initialCalls);
    // A proxied URL must not become a direct, unbound player-cache entry.
    expect(await resolveBothWithMeta(id)).toEqual({ urls: [original, original], proxyUrl: null });
  });

  it.each(['audio', 'video'])('refreshes a rejected %s job through a new route with the same capability', async mode => {
    const proxies = configureProxies();
    const id = videoId();
    const original = streamUrl('job-rejected-direct');
    const fresh = streamUrl('job-fresh-proxy');
    const player = configureProxyPlayer(original);
    state.mediaProbe.mockImplementation(async (url: string, options: { proxyUrl: string | null }) =>
      url === fresh && !options.proxyUrl ? { status: 403, headers: {}, body: null } : mediaResponse());
    const capability = await ensureStreamJob(`https://youtu.be/${id}`, mode);
    const resolved = (await awaitStreamJob(capability))!;
    expect(resolved.job.extracted_url).toBe(original);
    const initialCalls = player.mock.calls.length;
    player.mockResolvedValue(playable(fresh));
    const recovered = await refreshStreamUrl(resolved.streamId, resolved.job);
    expect(recovered?.extracted_url).toBe(fresh);
    expect(proxies.map(p => p.url)).toContain(recovered?.proxy_url);
    expect(recovered?.secret).toBe(resolved.job.secret);
    expect(player.mock.calls.length).toBeGreaterThan(initialCalls);
    expect((await awaitStreamJob(capability))?.job.extracted_url).toBe(fresh);
  });

  it('excludes the failed proxy from warm and fallback selections', async () => {
    configureProxies();
    const id = videoId();
    configureProxyPlayer(streamUrl('proxy'));
    const first = await resolveBothWithMeta(id, 'audio', { forceProxy: true });
    expect(first.proxyUrl).toBeTruthy();
    const recovered = await resolveBothWithMeta(id, 'audio', {
      forceProxy: true, excludeProxyUrl: first.proxyUrl,
    });
    expect(recovered.proxyUrl).toBeTruthy();
    expect(recovered.proxyUrl).not.toBe(first.proxyUrl);
    expect(state.player).not.toHaveBeenCalled();
  });

  it('does not reuse the rejected route when no replacement proxy exists', async () => {
    const [proxy] = configureProxies();
    websharePool._setCandidatesForTest([proxy!]);
    const id = videoId();
    configureProxyPlayer(streamUrl('proxy'));
    const recovered = await resolveBothWithMeta(id, 'audio', {
      forceProxy: true, excludeProxyUrl: proxy!.url,
    });
    expect(recovered).toEqual({ urls: [null, null], proxyUrl: null });
    expect(state.create).not.toHaveBeenCalled();
    expect(websharePool.size).toBe(1);
  });

  it('rejects player successes whose CDN responds 403 before caching a replacement', async () => {
    const proxies = configureProxies();
    configureProxyPlayer(streamUrl('proxy'));
    const bodies: Readable[] = [];
    state.mediaProbe.mockImplementation(async (_url: string, options: { proxyUrl: string | null; rangeHeader: string | null }) => {
      const response = mediaResponse();
      const body = response.body;
      bodies.push(body);
      return { ...response, status: !options.proxyUrl || options.proxyUrl === proxies[0]!.url ? 403 : 206 };
    });
    const recovered = await getStream(videoId(), { forceProxy: true });
    expect(recovered?.proxyUrl).toBeTruthy();
    expect(recovered?.proxyUrl).not.toBe(proxies[0]!.url);
    const recoveredChecks = state.mediaProbe.mock.calls.filter(([, options]) => options.proxyUrl === recovered?.proxyUrl);
    expect(recoveredChecks.map(([, options]) => options.rangeHeader)).toEqual([null, 'bytes=0-16383']);
    expect(state.player).not.toHaveBeenCalled();
    expect(bodies.every(body => body.destroyed)).toBe(true);
    expect(websharePool.size).toBe(4);
  });

  it('does not publish a recovery candidate with a successful status but no media bytes', async () => {
    configureProxies();
    configureProxyPlayer(streamUrl('proxy'));
    state.mediaProbe.mockImplementation(async () => ({ ...mediaResponse(), body: Readable.from([]) }));
    expect(await getStream(videoId(), { forceProxy: true })).toBeNull();
    expect(state.files.size).toBe(0);
    expect(state.redis.size).toBe(0);
  });

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
    // One session per reachable Webshare exit, retained across videos.
    expect(state.create).toHaveBeenCalledTimes(4);
  });

  it('retains proxies when youtubei throws its structured unavailable-video error', async () => {
    configureProxies();
    state.player.mockRejectedValue(Object.assign(new Error('This video is unavailable'), {
      info: { status: 'ERROR', reason: 'This video has been removed by the uploader' },
    }));
    for (let index = 0; index < 3; index += 1) await resolveBothWithMeta(videoId());
    expect(websharePool.size).toBe(4);
    expect(state.create).toHaveBeenCalledTimes(4);
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
