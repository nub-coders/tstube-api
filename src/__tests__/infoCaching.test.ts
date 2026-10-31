import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  apiKeys: 'test-key', create: vi.fn(), player: vi.fn(), next: vi.fn(),
}));
vi.mock('../config.js', () => ({ config: () => ({ YOUTUBE_API_KEYS: state.apiKeys }) }));
vi.mock('youtubei.js', () => ({
  Innertube: { create: state.create }, Platform: { shim: {} },
  Parser: { addRuntimeParser() {}, setParserErrorHandler() {} }, Helpers: { YTNode: class {} },
}));
vi.mock('undici', () => ({ ProxyAgent: class {}, fetch: vi.fn() }));
vi.mock('../proxy.js', () => ({ websharePool: {
  enabled: true,
  getWarmCandidates: () => [{ id: 'test-exit', url: 'http://u:p@proxy.example.com:8000' }],
} }));

const videoId = 'abcdefghijk';
function details(title = 'Song') {
  return { items: [{
    id: videoId,
    snippet: { title, channelTitle: 'Artist', thumbnails: { high: { url: 'https://img.example.com/song.jpg' } } },
    contentDetails: { duration: 'PT3M20S' }, statistics: { viewCount: '12345' },
  }] };
}
function nextPage(count = 8) {
  return { data: { contents: { twoColumnWatchNextResults: { secondaryResults: { secondaryResults: {
    results: Array.from({ length: count }, (_, index) => ({ compactVideoRenderer: {
      videoId: `related000${index}`, title: { simpleText: `Related ${index}` },
      lengthText: { simpleText: '3:20' }, longBylineText: { runs: [{ text: 'Artist' }] },
    } })),
  } } } } } };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  state.apiKeys = 'test-key';
  state.create.mockResolvedValue({ session: { player: {} }, getBasicInfo: state.player, actions: { execute: state.next } });
  state.next.mockResolvedValue(nextPage());
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(details())));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('video metadata caching', () => {
  it('shares concurrent lookups and serves repeat requests without another upstream call', async () => {
    const { getVideoById } = await import('../youtubeApi.js');
    const responses = await Promise.all(Array.from({ length: 10 }, () => getVideoById(videoId)));
    expect(responses.every(info => info.title === 'Song')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    responses[0].title = 'Changed by caller';
    expect((await getVideoById(videoId)).title).toBe('Song');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes after five minutes and keeps different video identities separate', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { getVideoById } = await import('../youtubeApi.js');
    await getVideoById(videoId);
    await getVideoById('lmnopqrstuv');
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 300_001;
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(details('Updated title')));
    expect((await getVideoById(videoId)).title).toBe('Updated title');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([200, 503])('does not cache an empty or failed response (HTTP %s)', async status => {
    const { getVideoById } = await import('../youtubeApi.js');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ items: [] }, { status }));
    expect(await getVideoById(videoId)).toEqual({});
    expect((await getVideoById(videoId)).title).toBe('Song');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('also coalesces the Innertube fallback when no Data API keys are configured', async () => {
    state.apiKeys = '';
    state.player.mockResolvedValue({ basic_info: { title: 'Fallback song', duration: 200 } });
    const { getVideoById } = await import('../youtubeApi.js');
    const responses = await Promise.all(Array.from({ length: 10 }, () => getVideoById(videoId)));
    expect(responses.every(info => info.title === 'Fallback song')).toBe(true);
    expect(state.player).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('related video caching', () => {
  it('shares one full recommendation list across concurrent callers and differing limits', async () => {
    const { related } = await import('../innertube.js');
    const [small, large] = await Promise.all([related(videoId, 1), related(`https://youtu.be/${videoId}`, 7)]);
    expect(small).toHaveLength(1);
    expect(large).toHaveLength(7);
    expect(state.next).toHaveBeenCalledTimes(1);
    small[0].title = 'Changed by caller';
    const warm = await related(videoId, 5);
    expect(warm).toHaveLength(5);
    expect(warm[0].title).toBe('Related 0');
    expect(state.next).toHaveBeenCalledTimes(1);
  });

  it('refreshes recommendations after five minutes', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { related } = await import('../innertube.js');
    await related(videoId);
    await related(videoId);
    expect(state.next).toHaveBeenCalledTimes(1);
    now += 300_001;
    await related(videoId);
    expect(state.next).toHaveBeenCalledTimes(2);
  });

  it('shares a failure without preventing a later request from recovering', async () => {
    const { related } = await import('../innertube.js');
    state.next.mockRejectedValueOnce(new Error('upstream unavailable'));
    expect(await Promise.all([related(videoId), related(videoId)])).toEqual([[], []]);
    expect(state.next).toHaveBeenCalledTimes(1);
    expect(await related(videoId)).toHaveLength(5);
    expect(state.next).toHaveBeenCalledTimes(2);
  });
});
