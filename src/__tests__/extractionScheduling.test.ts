import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(), player: vi.fn(), mediaProbe: vi.fn(), hlsProbe: vi.fn(), candidates: vi.fn(),
  markOk: vi.fn(), markReachable: vi.fn(), markBad: vi.fn(),
}));

vi.mock('youtubei.js', () => ({
  Innertube: { create: state.create }, Platform: { shim: {} },
  Parser: { addRuntimeParser() {}, setParserErrorHandler() {} }, Helpers: { YTNode: class {} },
}));
vi.mock('undici', () => ({
  ProxyAgent: class {}, fetch: () => { throw new Error('Unexpected live proxy fetch'); },
}));
vi.mock('../config.js', () => ({ config: () => ({ EXTRACTION_DIRECT_FALLBACK: false }) }));
vi.mock('../youtubeApi.js', () => ({ fetchRegionRestriction: async () => null }));
vi.mock('../mediaProbe.js', () => ({ probeMedia: state.mediaProbe, invalidateMediaProbe: vi.fn() }));
vi.mock('../hlsProxy.js', () => ({ probeHls: state.hlsProbe }));
vi.mock('../proxy.js', () => ({ websharePool: {
  enabled: true, getWarmCandidates: state.candidates, getAllCandidates: state.candidates,
  getProxy: async () => null, markOk: state.markOk,
  markReachable: state.markReachable, markBad: state.markBad,
} }));

import { getInnertube, resetInnertube, resolveBothWithMeta } from '../innertube.js';
import { requestSignal, withRequestDeadline } from '../requestDeadline.js';

const warm = { id: 'warm', url: 'http://u:p@warm.example.com:8000', address: 'warm.example.com', port: 8000, countryCode: 'US' };
const cold = { ...warm, id: 'cold', url: 'http://u:p@cold.example.com:8000', address: 'cold.example.com' };

function playable(url: string) {
  return {
    playability_status: { status: 'OK' },
    chooseFormat: () => ({ url, decipher: async () => url }),
  };
}

/** Mirror transport cancellation so one client's timer cannot leak into another. */
function delay<T>(ms: number, value: T, signal = requestSignal()): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', aborted);
    const timer = setTimeout(() => { cleanup(); resolve(value); }, ms);
    const aborted = () => { clearTimeout(timer); cleanup(); reject(signal?.reason); };
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetInnertube();
  vi.resetAllMocks();
  state.candidates.mockReturnValue([warm]);
  state.create.mockResolvedValue({ session: { player: {} }, getBasicInfo: state.player });
  state.mediaProbe.mockResolvedValue(true);
  state.hlsProbe.mockResolvedValue(false);
});

afterEach(() => {
  resetInnertube();
  vi.useRealTimers();
});

it('tries a usable cold exit while a warm exit stalls throughout its client ladder', async () => {
  const fresh = 'https://rr1.googlevideo.com/videoplayback?test=cold-scheduling';
  const coldPlayer = vi.fn(async () => playable(fresh));
  state.create.mockResolvedValueOnce({ session: { player: {} }, getBasicInfo: state.player })
    .mockResolvedValue({ session: { player: {} }, getBasicInfo: coldPlayer });
  await getInnertube();
  state.candidates.mockReturnValue([warm, cold]);
  state.player.mockImplementation(() => new Promise(() => {}));

  const pending = resolveBothWithMeta('schedule001', 'muxed');
  await vi.advanceTimersByTimeAsync(40_001);

  expect.soft((await pending).urls[0]).toBe(fresh);
  expect(coldPlayer).toHaveBeenCalled();
});

it('leaves budget for later clients when earlier player responses have slow rejected media', async () => {
  const fresh = 'https://rr1.googlevideo.com/videoplayback?test=late-client';
  await getInnertube();
  state.player.mockImplementation((_id: string, { client }: { client: string }) => client === 'WEB'
    ? Promise.resolve(playable(fresh))
    : delay(7_000, playable(`https://rr1.googlevideo.com/videoplayback?test=denied-${client}`)));
  state.mediaProbe.mockImplementation((url: string, options: { deadline: number }) => url === fresh
    ? Promise.resolve(true)
    : delay(Math.min(5_000, Math.max(0, options.deadline - Date.now())), false));

  const pending = resolveBothWithMeta('schedule002', 'muxed');
  await vi.advanceTimersByTimeAsync(40_001);

  expect.soft((await pending).urls[0]).toBe(fresh);
  expect(state.player.mock.calls.some(([, options]) => options.client === 'WEB')).toBe(true);
});

it('retains verified requested video when its separate audio format remains unusable', async () => {
  const fresh = 'https://rr1.googlevideo.com/videoplayback?test=requested-video';
  const deniedAudio = 'https://rr1.googlevideo.com/videoplayback?test=denied-audio';
  state.player.mockResolvedValue({
    playability_status: { status: 'OK' },
    chooseFormat: ({ type }: { type: string }) => ({
      decipher: async () => type === 'video+audio' ? fresh : deniedAudio,
    }),
  });
  state.mediaProbe.mockImplementation((url: string, options: { deadline: number }) => url === fresh
    ? Promise.resolve(true)
    : delay(Math.min(5_000, Math.max(0, options.deadline - Date.now())), false));

  const pending = resolveBothWithMeta('schedule003', 'muxed');
  await vi.advanceTimersByTimeAsync(40_001);

  expect((await pending).urls[0]).toBe(fresh);
});

it('shares ongoing media validation when a fallback client returns the same URL', async () => {
  const fresh = 'https://rr1.googlevideo.com/videoplayback?test=reused-after-timeout';
  state.player.mockImplementation((_id: string, { client }: { client: string }) => client === 'ANDROID'
    ? delay(7_000, playable(fresh))
    : Promise.resolve(playable(fresh)));
  let first = true;
  state.mediaProbe.mockImplementation(() => {
    if (requestSignal()?.aborted) return Promise.resolve(false);
    if (first) {
      first = false;
      return delay(2_000, true).catch(() => false);
    }
    return Promise.resolve(true);
  });

  const pending = resolveBothWithMeta('schedule004', 'muxed');
  await vi.advanceTimersByTimeAsync(40_001);

  expect.soft((await pending).urls[0]).toBe(fresh);
  expect(state.player.mock.calls.some(([, options]) => options.client === 'TV_SIMPLY')).toBe(true);
  expect(state.mediaProbe).toHaveBeenCalledTimes(1);
});

it('allows a valid proxy route when player and media stages together take more than eight seconds', async () => {
  const fresh = 'https://rr1.googlevideo.com/videoplayback?test=slow-valid-proxy';
  state.player.mockImplementation(() => delay(3_000, playable(fresh)));
  state.mediaProbe.mockImplementation((_url: string, options: { proxyUrl: string | null }) =>
    options.proxyUrl ? delay(1_000, true) : delay(5_000, false));
  const pending = resolveBothWithMeta('schedule007', 'muxed');
  await vi.advanceTimersByTimeAsync(10_001);
  const result = await pending;
  expect(result.urls[0]).toBe(fresh);
  expect(result.proxyUrls?.[0] ?? result.proxyUrl).toBe(warm.url);
  expect(state.mediaProbe).toHaveBeenCalledTimes(2);
});

it('keeps a combined audio source verified near the deadline while dedicated audio stalls', async () => {
  const muxed = 'https://rr1.googlevideo.com/videoplayback?test=late-combined';
  const audio = 'https://rr1.googlevideo.com/videoplayback?test=late-audio';
  state.player.mockImplementation((_id: string, { client }: { client: string }) => delay(7_000,
    client === 'MWEB' ? {
      playability_status: { status: 'OK' },
      chooseFormat: ({ type }: { type: string }) => ({ decipher: async () => type === 'audio' ? audio : muxed }),
    } : { playability_status: { status: 'UNPLAYABLE', reason: 'client unavailable' } }));
  state.mediaProbe.mockImplementation((url: string) => url === muxed ? delay(4_000, true) : delay(5_000, false));
  const pending = resolveBothWithMeta('schedule008', 'audio');
  await vi.advanceTimersByTimeAsync(40_001);
  expect((await pending).urls[1]).toBe(muxed);
});

it('keeps shared extraction running when one caller cancels before another caller receives media', async () => {
  const fresh = 'https://rr1.googlevideo.com/videoplayback?test=shared-cancellation';
  let transportSignal: AbortSignal | undefined;
  state.player.mockImplementation(() => {
    transportSignal = requestSignal();
    return delay(2_000, playable(fresh));
  });
  const short = withRequestDeadline(500, 'short subscriber', () => resolveBothWithMeta('schedule005', 'muxed'));
  const cancelled = expect(short).rejects.toThrow('short subscriber timed out');
  const long = withRequestDeadline(10_000, 'long subscriber', () => resolveBothWithMeta('schedule005', 'muxed'));

  await vi.advanceTimersByTimeAsync(501);
  await cancelled;
  expect(transportSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1_500);

  expect((await long).urls[0]).toBe(fresh);
  expect(state.player).toHaveBeenCalledTimes(1);
  expect(state.create).toHaveBeenCalledTimes(1);
});

it('keeps verified live audio through its pinned exit while live video validation stalls', async () => {
  const manifest = 'https://manifest.googlevideo.com/api/manifest/hls_playlist?test=partial-live';
  state.player.mockResolvedValue({
    playability_status: { status: 'OK' }, basic_info: { is_live: true },
    streaming_data: { hls_manifest_url: manifest },
  });
  state.hlsProbe.mockImplementation((_url: string, options: { mode: string; proxyUrl: string | null; signal: AbortSignal }) => {
    if (options.signal.aborted) return Promise.resolve(false);
    return options.mode === 'audio'
      ? Promise.resolve(options.proxyUrl === warm.url)
      : delay(9_000, false, options.signal).catch(() => false);
  });

  const pending = resolveBothWithMeta('schedule006', 'audio');
  await vi.advanceTimersByTimeAsync(40_001);
  const result = await pending;

  expect(result.urls).toEqual([null, manifest]);
  expect(result.streamTypes).toEqual([null, 'hls']);
  expect(result.proxyUrls).toEqual([null, warm.url]);
  expect(state.mediaProbe).not.toHaveBeenCalled();
});
