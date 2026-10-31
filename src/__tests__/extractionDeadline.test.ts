import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(), player: vi.fn(), proxyFetch: vi.fn(), mediaProbe: vi.fn(),
  enabled: true, candidates: vi.fn(), getProxy: vi.fn(), markOk: vi.fn(), markReachable: vi.fn(), markBad: vi.fn(),
}));
vi.mock('youtubei.js', () => ({
  Innertube: { create: state.create }, Platform: { shim: {} },
  Parser: { addRuntimeParser() {}, setParserErrorHandler() {} }, Helpers: { YTNode: class {} },
}));
vi.mock('undici', () => ({
  ProxyAgent: class { constructor(readonly proxy: string) {} }, fetch: state.proxyFetch,
}));
vi.mock('../youtubeApi.js', () => ({ fetchRegionRestriction: async () => null }));
vi.mock('../mediaProbe.js', () => ({ probeMedia: state.mediaProbe, invalidateMediaProbe: vi.fn() }));
vi.mock('../proxy.js', () => ({ websharePool: {
  get enabled() { return state.enabled; }, getWarmCandidates: state.candidates,
  getAllCandidates: state.candidates, getProxy: state.getProxy,
  markOk: state.markOk, markReachable: state.markReachable, markBad: state.markBad,
} }));
import { getInnertube, resolveBothWithMeta, resetInnertube } from '../innertube.js';

const proxy = { id: 'test-exit', url: 'http://u:p@proxy.example.com:8000', address: 'proxy.example.com', port: 8000, countryCode: 'US' };
const unavailable = { playability_status: { status: 'ERROR', reason: 'Unavailable' } };
let sequence = 0;
const videoId = () => `only${String(sequence++).padStart(7, '0')}`;

beforeEach(() => {
  resetInnertube();
  vi.resetAllMocks();
  state.enabled = true;
  state.candidates.mockReturnValue([proxy]);
  state.getProxy.mockResolvedValue(null);
  state.player.mockResolvedValue(unavailable);
  state.create.mockResolvedValue({ session: { player: {} }, getBasicInfo: state.player });
  state.proxyFetch.mockResolvedValue(new Response('{}'));
  state.mediaProbe.mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected direct extraction request'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetInnertube(); });

it('sends both bootstrap and player requests through Webshare on an ordinary extraction', async () => {
  const media = 'https://rr1.googlevideo.com/videoplayback?test=proxy-only';
  state.create.mockImplementation(async (options: { fetch: typeof fetch }) => {
    await options.fetch('https://www.youtube.com/bootstrap');
    return { session: { player: {} }, getBasicInfo: async () => {
      await options.fetch('https://www.youtube.com/youtubei/v1/player');
      return { playability_status: { status: 'OK' }, chooseFormat: () => ({ decipher: async () => media }) };
    } };
  });
  expect(await resolveBothWithMeta(videoId())).toEqual({ urls: [media, media], proxyUrl: null });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(state.proxyFetch).toHaveBeenCalledTimes(2);
  for (const call of state.proxyFetch.mock.calls) expect(call[1].dispatcher.proxy).toBe(proxy.url);
  expect(state.mediaProbe).toHaveBeenCalledWith(media, expect.objectContaining({ proxyUrl: null }));
});

it('bootstraps metadata/related sessions through Webshare too', async () => {
  state.create.mockImplementation(async (options: { fetch: typeof fetch }) => {
    await options.fetch('https://www.youtube.com/bootstrap');
    return { getBasicInfo: state.player };
  });
  await getInnertube();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(state.proxyFetch.mock.calls[0][1].dispatcher.proxy).toBe(proxy.url);
});

it('tries another Webshare exit when session bootstrap fails', async () => {
  state.candidates.mockReturnValue([proxy, { ...proxy, id: 'second-exit', url: 'http://u:p@second.example.com:8000' }]);
  state.create.mockRejectedValueOnce(new Error('ECONNRESET'));
  await getInnertube();
  expect(state.create).toHaveBeenCalledTimes(2);
  expect(state.markBad).toHaveBeenCalledWith(proxy.id, proxy.url);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([false, true])('does not extract directly when Webshare is disabled (recovery=%s)', async recovery => {
  state.enabled = false;
  expect(await resolveBothWithMeta(videoId(), 'audio', { forceProxy: recovery })).toEqual({ urls: [null, null], proxyUrl: null });
  expect(state.create).not.toHaveBeenCalled();
  expect(state.proxyFetch).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await expect(getInnertube()).rejects.toThrow(/Webshare/);
});

it('does not extract directly when the Webshare pool is empty', async () => {
  state.candidates.mockReturnValue([]);
  expect(await resolveBothWithMeta(videoId())).toEqual({ urls: [null, null], proxyUrl: null });
  expect(state.create).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('does not fall back to direct extraction when every proxy fails', async () => {
  state.player.mockRejectedValue(new Error('fetch failed: ECONNRESET'));
  expect(await resolveBothWithMeta(videoId())).toEqual({ urls: [null, null], proxyUrl: null });
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(state.markBad).toHaveBeenCalledWith(proxy.id, proxy.url);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('advances to the next client when a proxied player request never settles', async () => {
  vi.useFakeTimers();
  state.player.mockImplementationOnce(() => new Promise(() => {}));
  const pending = resolveBothWithMeta(videoId());
  await vi.advanceTimersByTimeAsync(8_001);
  expect(await pending).toEqual({ urls: [null, null], proxyUrl: null });
  expect(state.player.mock.calls.length).toBeGreaterThan(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('aborts proxied transports at the extraction deadline without trying a direct connection', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  state.proxyFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  state.create.mockImplementation(async (options: { fetch: typeof fetch }) => ({
    getBasicInfo: () => options.fetch('https://www.youtube.com/youtubei/v1/player'),
  }));
  const pending = resolveBothWithMeta(videoId());
  await vi.advanceTimersByTimeAsync(35_001);
  expect(await pending).toEqual({ urls: [null, null], proxyUrl: null });
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
