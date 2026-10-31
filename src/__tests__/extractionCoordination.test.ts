import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(), player: vi.fn(), proxyFetch: vi.fn(), probe: vi.fn(), hlsProbe: vi.fn(),
  candidates: vi.fn(), markOk: vi.fn(), markReachable: vi.fn(), markBad: vi.fn(),
  region: vi.fn(), geoCandidates: vi.fn(),
  directFallback: false,
}));
vi.mock('youtubei.js', () => ({
  Innertube: { create: state.create }, Platform: { shim: {} },
  Parser: { addRuntimeParser() {}, setParserErrorHandler() {} }, Helpers: { YTNode: class {} },
}));
vi.mock('undici', () => ({ ProxyAgent: class {}, fetch: state.proxyFetch }));
vi.mock('../config.js', () => ({ config: () => ({ EXTRACTION_DIRECT_FALLBACK: state.directFallback }) }));
vi.mock('../youtubeApi.js', () => ({ fetchRegionRestriction: state.region }));
vi.mock('../mediaProbe.js', () => ({ probeMedia: state.probe, invalidateMediaProbe: vi.fn() }));
vi.mock('../hlsProxy.js', () => ({ probeHls: state.hlsProbe }));
vi.mock('../proxy.js', () => ({ websharePool: {
  enabled: true, size: 0, getWarmCandidates: state.candidates, getAllCandidates: state.candidates,
  getProxy: async () => null, markOk: state.markOk, markReachable: state.markReachable, markBad: state.markBad,
  getGeoCandidates: state.geoCandidates, getProxyForCountries: async () => null,
} }));
import { getInnertube, invalidateResolvedStream, resetInnertube, resolveBothWithMeta, resolveWithMeta } from '../innertube.js';
import { withIndependentRequestDeadline, withRequestDeadline } from '../requestDeadline.js';

const proxy = { id: 'shared-exit', url: 'http://u:p@proxy.example.com:8000', address: 'proxy.example.com', port: 8000, countryCode: 'US' };
let sequence = 0;
const videoId = () => `share${String(sequence++).padStart(6, '0')}`;
const media = (tag: string) => `https://rr1.googlevideo.com/videoplayback?expire=4102444800&tag=${tag}`;
function playable(audio = media('audio'), video: string | null = media('video')) {
  return { playability_status: { status: 'OK' }, chooseFormat: ({ type }: { type: string }) => {
    const url = type === 'audio' ? audio : video;
    if (!url) throw new Error('No muxed format');
    return { url, decipher: async () => url };
  } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}
beforeEach(() => {
  resetInnertube();
  vi.resetAllMocks();
  state.candidates.mockReturnValue([proxy]);
  state.create.mockResolvedValue({ session: { player: {} }, getBasicInfo: state.player });
  state.player.mockResolvedValue(playable());
  state.probe.mockResolvedValue(true);
  state.hlsProbe.mockResolvedValue(true);
  state.region.mockResolvedValue(null);
  state.geoCandidates.mockReturnValue([]);
  state.directFallback = false;
});
afterEach(() => { resetInnertube(); vi.useRealTimers(); });

it('coalesces a cold session bootstrap across concurrent callers', async () => {
  const boot = deferred<unknown>();
  state.create.mockReturnValue(boot.promise);
  const calls = [getInnertube(), getInnertube(), getInnertube()];
  await vi.waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
  const instance = { session: { player: {} }, getBasicInfo: state.player };
  boot.resolve(instance);
  expect(await Promise.all(calls)).toEqual([instance, instance, instance]);
});

it('bounds concurrent cold bootstraps across rotating Webshare exits', async () => {
  vi.useFakeTimers();
  const exits = Array.from({ length: 12 }, (_, index) => ({ ...proxy, id: `bootstrap-exit-${index}`, url: `http://u:p@boot-${index}.example.com:8000` }));
  let selected = 0;
  state.candidates.mockImplementation(() => [exits[selected++ % exits.length]]);
  const boot = deferred<unknown>();
  state.create.mockReturnValue(boot.promise);
  const calls = Array.from({ length: 12 }, () => getInnertube());
  await vi.advanceTimersByTimeAsync(0);
  expect(state.create).toHaveBeenCalledTimes(8);
  boot.resolve({ session: { player: {} }, getBasicInfo: state.player });
  await Promise.all(calls);
  expect(state.create).toHaveBeenCalledTimes(12);
});

it('releases bootstrap admission when every caller cancels even if session creation ignores abort', async () => {
  vi.useFakeTimers();
  const exits = Array.from({ length: 9 }, (_, index) => ({ ...proxy, id: `cancel-boot-${index}`, url: `http://u:p@cancel-${index}.example.com:8000` }));
  let selected = 0;
  state.candidates.mockImplementation(() => [exits[selected++ % exits.length]]);
  state.create.mockImplementation(() => new Promise(() => {}));
  const calls = Array.from({ length: 8 }, () => withRequestDeadline(100, 'bootstrap caller', () => getInnertube()));
  const cancelled = Promise.all(calls.map(call => call.then(() => false, () => true)));
  await vi.advanceTimersByTimeAsync(101);
  expect(await cancelled).toEqual(Array(8).fill(true));
  state.create.mockResolvedValue({ session: { player: {} }, getBasicInfo: state.player });
  await getInnertube();
  expect(state.create).toHaveBeenCalledTimes(9);
  expect(state.markBad).not.toHaveBeenCalled();
});

it('does not attempt direct extraction when the flag is off', async () => {
  state.candidates.mockReturnValue([]);
  await expect(getInnertube()).rejects.toThrow('No usable Webshare proxy');
  expect(state.create).not.toHaveBeenCalled();
});

it('falls back to a direct session when the pool is empty and the flag is on', async () => {
  state.candidates.mockReturnValue([]);
  state.directFallback = true;
  const instance = await getInnertube();
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(state.create.mock.calls[0][0]).toHaveProperty('fetch');
  expect(instance).toHaveProperty('getBasicInfo');
});

it('resolves a video without a proxy through the direct fallback', async () => {
  state.candidates.mockReturnValue([]);
  state.directFallback = true;
  const meta = await resolveWithMeta(videoId(), 'muxed');
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(meta.url).toBeTruthy();
  expect(meta.proxyUrl).toBeNull();
});

it('coalesces concurrent audio and video extraction through one player ladder', async () => {
  const info = deferred<unknown>();
  state.player.mockReturnValue(info.promise);
  const id = videoId();
  const audio = resolveWithMeta(id, 'audio');
  const video = resolveWithMeta(id, 'muxed');
  await vi.waitFor(() => expect(state.player).toHaveBeenCalledTimes(1));
  info.resolve(playable());
  expect(await audio).toEqual({ url: media('audio'), proxyUrl: null });
  expect(await video).toEqual({ url: media('video'), proxyUrl: null });
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(state.player).toHaveBeenCalledTimes(1);
});

it('keeps a shared extraction alive when its initiating caller times out', async () => {
  vi.useFakeTimers();
  const info = deferred<unknown>();
  state.player.mockReturnValue(info.promise);
  const id = videoId();
  const short = withRequestDeadline(100, 'short caller', () => resolveWithMeta(id, 'audio'));
  const rejected = expect(short).rejects.toThrow('short caller timed out');
  const long = withRequestDeadline(2_000, 'long caller', () => resolveWithMeta(id, 'audio'));
  await vi.advanceTimersByTimeAsync(101);
  await rejected;
  info.resolve(playable());
  expect(await long).toEqual({ url: media('audio'), proxyUrl: null });
  expect(state.player).toHaveBeenCalledTimes(1);
});

it('keeps a shared cold bootstrap alive when its first subscriber times out', async () => {
  vi.useFakeTimers();
  const boot = deferred<unknown>();
  state.create.mockReturnValue(boot.promise);
  const short = withRequestDeadline(100, 'short bootstrap caller', () => getInnertube());
  const rejected = expect(short).rejects.toThrow('short bootstrap caller timed out');
  const long = withRequestDeadline(2_000, 'long bootstrap caller', () => getInnertube());
  await vi.advanceTimersByTimeAsync(101);
  await rejected;
  const instance = { session: { player: {} }, getBasicInfo: state.player };
  boot.resolve(instance);
  expect(await long).toBe(instance);
  expect(await getInnertube()).toBe(instance);
  expect(state.create).toHaveBeenCalledTimes(1);
});

it('does not keep searching for a format whose only subscriber has left', async () => {
  vi.useFakeTimers();
  const info = deferred<unknown>();
  state.player.mockReturnValue(info.promise);
  const id = videoId();
  const short = withRequestDeadline(100, 'video caller', () => resolveWithMeta(id, 'muxed'));
  const rejected = expect(short).rejects.toThrow('video caller timed out');
  const audio = withRequestDeadline(2_000, 'audio caller', () => resolveWithMeta(id, 'audio'));
  await vi.advanceTimersByTimeAsync(101);
  await rejected;
  info.resolve(playable(media('only-audio'), null));
  expect(await audio).toEqual({ url: media('only-audio'), proxyUrl: null });
  expect(state.player).toHaveBeenCalledTimes(1);
});

it('does not let an old bootstrap restore the session pool after a reset', async () => {
  const boot = deferred<unknown>();
  state.create.mockReturnValueOnce(boot.promise);
  const old = getInnertube();
  const rejected = expect(old).rejects.toThrow('No usable Webshare proxy');
  await vi.waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
  resetInnertube();
  const fresh = await getInnertube();
  boot.resolve({ session: { player: {} }, getBasicInfo: vi.fn() });
  await rejected;
  expect(await getInnertube()).toBe(fresh);
  expect(state.create).toHaveBeenCalledTimes(2);
  expect(state.markBad).not.toHaveBeenCalled();
});

it('cancels shared proxy work after its last caller leaves and never memoizes a late response', async () => {
  vi.useFakeTimers();
  const response = deferred<Response>();
  const signals: AbortSignal[] = [];
  state.proxyFetch.mockImplementation((_url, init) => { signals.push(init.signal); return response.promise; });
  state.create.mockImplementation(async (options: { fetch: typeof fetch }) => ({
    session: { player: {} }, getBasicInfo: async () => { await options.fetch('https://www.youtube.com/youtubei/v1/player'); return playable(); },
  }));
  const id = videoId();
  const first = withRequestDeadline(100, 'first caller', () => resolveWithMeta(id, 'audio'));
  const second = withRequestDeadline(200, 'second caller', () => resolveWithMeta(id, 'audio'));
  const rejections = [expect(first).rejects.toThrow(), expect(second).rejects.toThrow()];
  await vi.advanceTimersByTimeAsync(201);
  await Promise.all(rejections);
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
  response.resolve(new Response('{}'));
  await vi.advanceTimersByTimeAsync(0);
  state.create.mockResolvedValue({ session: { player: {} }, getBasicInfo: state.player });
  state.player.mockResolvedValue(playable(media('fresh-audio'), media('fresh-video')));
  resetInnertube();
  expect((await resolveWithMeta(id, 'audio')).url).toBe(media('fresh-audio'));
});

it('limits concurrent player calls on one exit and does not start cancelled queued work', async () => {
  vi.useFakeTimers();
  const info = deferred<unknown>();
  let active = 0;
  let peak = 0;
  state.player.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    try { return await info.promise; } finally { active--; }
  });
  const first = resolveWithMeta(videoId(), 'audio');
  const second = resolveWithMeta(videoId(), 'audio');
  const queued = withRequestDeadline(100, 'queued caller', () => resolveWithMeta(videoId(), 'audio'));
  const rejection = expect(queued).rejects.toThrow('queued caller timed out');
  await vi.advanceTimersByTimeAsync(101);
  await rejection;
  expect(peak).toBe(1);
  expect(state.player).toHaveBeenCalledTimes(1);
  expect(state.markBad).not.toHaveBeenCalled();
  info.resolve(playable());
  await Promise.all([first, second]);
  await vi.advanceTimersByTimeAsync(0);
  expect(state.player).toHaveBeenCalledTimes(2);
});

it('bounds total player work across distinct Webshare exits', async () => {
  vi.useFakeTimers();
  const exits = Array.from({ length: 12 }, (_, index) => ({ ...proxy, id: `global-exit-${index}`, url: `http://u:p@exit-${index}.example.com:8000` }));
  let selected = 0;
  state.candidates.mockImplementation((count?: number) => count === undefined ? exits : [exits[selected++ % exits.length]]);
  state.create.mockImplementation(async () => ({ session: { player: {} }, getBasicInfo: state.player }));
  const info = deferred<unknown>();
  let active = 0;
  let peak = 0;
  state.player.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    try { return await info.promise; } finally { active--; }
  });
  const calls = Array.from({ length: 12 }, () => resolveWithMeta(videoId(), 'audio'));
  await vi.advanceTimersByTimeAsync(0);
  expect(peak).toBe(8);
  expect(state.player).toHaveBeenCalledTimes(8);
  info.resolve(playable());
  expect((await Promise.all(calls)).every(result => result.url === media('audio'))).toBe(true);
  expect(peak).toBe(8);
  expect(state.player).toHaveBeenCalledTimes(12);
});

it('keeps an excluded-exit recovery independent from an ordinary resolve of the same video', async () => {
  const other = { ...proxy, id: 'other-exit', url: 'http://u:p@other.example.com:8000' };
  state.candidates.mockReturnValue([proxy, other]);
  state.create.mockResolvedValueOnce({ session: { player: {} }, getBasicInfo: async () => playable(media('first-exit')) })
    .mockResolvedValue({ session: { player: {} }, getBasicInfo: async () => playable(media('other-exit')) });
  const id = videoId();
  const ordinary = resolveWithMeta(id, 'audio');
  const recovery = resolveWithMeta(id, 'audio', { forceProxy: true, excludeProxyUrl: proxy.url });
  expect((await ordinary).url).toBe(media('first-exit'));
  expect((await recovery).url).toBe(media('other-exit'));
  expect(state.create).toHaveBeenCalledTimes(2);
});

it('does not let an audio-only memo prevent a later video extraction', async () => {
  const id = videoId();
  state.player.mockResolvedValueOnce(playable(media('only-audio'), null)).mockResolvedValue(playable());
  expect(await resolveWithMeta(id, 'audio')).toEqual({ url: media('only-audio'), proxyUrl: null });
  expect(await resolveWithMeta(id, 'muxed')).toEqual({ url: media('video'), proxyUrl: null });
  expect(state.player).toHaveBeenCalledTimes(2);
});

it('continues the client ladder until the requested video format is usable', async () => {
  state.player.mockResolvedValueOnce(playable(media('only-audio'), null)).mockResolvedValue(playable());
  expect(await resolveWithMeta(videoId(), 'muxed')).toEqual({ url: media('video'), proxyUrl: null });
  expect(state.player).toHaveBeenCalledTimes(2);
});

it('retries a late video subscriber when an audio attempt already stopped before video joined', async () => {
  const id = videoId();
  let late!: ReturnType<typeof resolveWithMeta>;
  state.markOk.mockImplementationOnce(() => {
    late = withIndependentRequestDeadline(2_000, 'late caller', new AbortController().signal, () => resolveWithMeta(id, 'muxed'));
  });
  state.player.mockResolvedValueOnce(playable(media('only-audio'), null)).mockResolvedValue(playable());
  expect((await resolveWithMeta(id, 'audio')).url).toBe(media('only-audio'));
  expect((await late).url).toBe(media('video'));
  expect(state.player).toHaveBeenCalledTimes(2);
});

it('uses geo evidence for a missing video mode even when the same exit yields usable audio', async () => {
  const india = { ...proxy, id: 'india-exit', url: 'http://u:p@india.example.com:8000', countryCode: 'IN' };
  state.candidates.mockImplementation((count?: number) => count === undefined ? [proxy, india] : [proxy]);
  const usPlayer = vi.fn().mockResolvedValueOnce(playable(media('us-audio'), null))
    .mockResolvedValue({ playability_status: { status: 'UNPLAYABLE', reason: 'This video is not available in your country' }, microformat: { available_countries: ['IN'] } });
  state.create.mockResolvedValueOnce({ session: { player: {} }, getBasicInfo: usPlayer })
    .mockResolvedValue({ session: { player: {} }, getBasicInfo: state.player });
  state.region.mockResolvedValue({ allowed: ['IN'], blocked: ['US'] });
  state.geoCandidates.mockReturnValue([india]);
  expect((await resolveWithMeta(videoId(), 'muxed')).url).toBe(media('video'));
  expect(state.geoCandidates).toHaveBeenCalledWith({ allowed: ['IN'] }, 4, expect.any(Function));
  expect(state.region).toHaveBeenCalledTimes(1);
});

it('keeps video unavailable when every client offers only audio', async () => {
  state.player.mockResolvedValue(playable(media('only-audio'), null));
  expect(await resolveWithMeta(videoId(), 'muxed')).toEqual({ url: null, proxyUrl: null });
  expect(state.player).toHaveBeenCalledTimes(5);
});

it('rejects an audio itag returned as a muxed choice even when the chooser supplies no track flags', async () => {
  state.player.mockResolvedValue(playable(`${media('audio-itag')}&itag=140`, `${media('audio-itag')}&itag=140`));
  expect(await resolveWithMeta(videoId(), 'muxed')).toEqual({ url: null, proxyUrl: null });
});

it('selects a validated HLS source for live playback and keeps its route per mode', async () => {
  const id = videoId();
  const manifest = 'https://manifest.googlevideo.com/api/manifest/hls_variant/live.m3u8';
  state.player.mockResolvedValue({ ...playable(`${media('fragment')}&itag=140&live=1`, null),
    basic_info: { is_live: true }, streaming_data: { hls_manifest_url: manifest },
  });
  state.hlsProbe.mockImplementation(async (_url, options) => options.mode === 'audio' || options.proxyUrl === proxy.url);
  const [audio, video] = await Promise.all([resolveWithMeta(id, 'audio'), resolveWithMeta(id, 'muxed')]);
  expect(audio).toEqual({ url: manifest, proxyUrl: null, streamType: 'hls' });
  expect(video).toEqual({ url: manifest, proxyUrl: proxy.url, streamType: 'hls' });
  expect(state.probe).not.toHaveBeenCalled();
  expect(state.hlsProbe.mock.calls.map(([, options]) => [options.mode, options.proxyUrl])).toEqual([
    ['video', null], ['audio', null], ['video', proxy.url],
  ]);
});

it('does not renew live manifests through the settled direct-file memo', async () => {
  const id = videoId();
  const oldManifest = 'https://manifest.googlevideo.com/old.m3u8';
  const freshManifest = 'https://manifest.googlevideo.com/fresh.m3u8';
  state.player.mockResolvedValueOnce({ basic_info: { is_live: true }, playability_status: { status: 'OK' }, streaming_data: { hlsManifestUrl: oldManifest } })
    .mockResolvedValue({ basic_info: { is_live: true }, playability_status: { status: 'OK' }, streaming_data: { hls_manifest_url: freshManifest } });
  expect((await resolveWithMeta(id, 'audio')).url).toBe(oldManifest);
  expect((await resolveWithMeta(id, 'audio')).url).toBe(freshManifest);
  expect(state.player).toHaveBeenCalledTimes(2);
});

it.each([true, false])('rejects finite live fragments when no HLS manifest is available (live flag=%s)', async flagged => {
  state.player.mockResolvedValue({ ...playable(`${media('fragment')}&itag=140&live=1`, null),
    ...(flagged ? { basic_info: { is_live: true } } : {}),
  });
  expect(await resolveWithMeta(videoId(), 'audio')).toEqual({ url: null, proxyUrl: null });
  expect(state.probe).not.toHaveBeenCalled();
  expect(state.hlsProbe).not.toHaveBeenCalled();
});

it('replaces invalidated shared work without an older cleanup deleting the replacement', async () => {
  const id = videoId();
  const old = deferred<unknown>();
  const fresh = deferred<unknown>();
  state.player.mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);
  const first = resolveBothWithMeta(id);
  await vi.waitFor(() => expect(state.player).toHaveBeenCalledTimes(1));
  invalidateResolvedStream(id);
  const second = resolveBothWithMeta(id);
  await vi.waitFor(() => expect(state.player).toHaveBeenCalledTimes(2));
  old.resolve(playable(media('old-audio'), media('old-video')));
  fresh.resolve(playable());
  const results = await Promise.all([first, second]);
  expect(results.every(result => result.urls[1] === media('audio'))).toBe(true);
  expect(state.player).toHaveBeenCalledTimes(2);
});

it('keeps finite VOD sources when the player also advertises an HLS manifest', async () => {
  state.player.mockResolvedValue({ ...playable(), basic_info: { is_live: false },
    streaming_data: { hls_manifest_url: 'https://manifest.googlevideo.com/vod.m3u8' } });
  expect(await resolveWithMeta(videoId(), 'muxed')).toEqual({ url: media('video'), proxyUrl: null });
  expect(state.hlsProbe).not.toHaveBeenCalled();
});
