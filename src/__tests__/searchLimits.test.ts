import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchItem } from '../searchService.js';

const state = vi.hoisted(() => ({ remote: false }));
vi.mock('../config.js', () => ({
  config: () => ({
    UPSTASH_REDIS_REST_URL: state.remote ? 'https://cache.example.test' : null,
    UPSTASH_REDIS_REST_TOKEN: 'mock-token',
  }),
}));

function resultItems(count: number): SearchItem[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `Song ${i}`,
    video_id: `vid${i}aaaaaaa`,
    url: `https://www.youtube.com/watch?v=vid${i}aaaaaaa`,
    time: '3:10',
    duration: '3:10',
    channel: `Channel ${i}`,
    views: String(1000 + i),
    thumbnail: `https://i.ytimg.com/vi/vid${i}aaaaaaa/hqdefault.jpg`,
  }));
}

function resultsPage(items: SearchItem[]): string {
  const videos = items.map((item) => ({
    videoRenderer: {
      videoId: item.video_id,
      title: { runs: [{ text: item.title }] },
      lengthText: { simpleText: item.duration },
      ownerText: { runs: [{ text: item.channel }] },
      viewCountText: { simpleText: `${item.views} views` },
    },
  }));
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: videos } }] },
        },
      },
    },
  };
  return `<script>ytInitialData = ${JSON.stringify(data)};</script>`;
}

async function fresh(): Promise<typeof import('../searchService.js')> {
  vi.resetModules();
  return import('../searchService.js');
}

describe('search result limit caches', () => {
  let remote: Map<string, string>;
  let upstreamCalls: number;
  let cacheReads: string[];
  let items: SearchItem[];

  beforeEach(() => {
    state.remote = false;
    remote = new Map();
    upstreamCalls = 0;
    cacheReads = [];
    items = resultItems(30);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://www.youtube.com') {
        upstreamCalls++;
        return new Response(resultsPage(items));
      }
      if (url.origin !== 'https://cache.example.test') throw new Error('Unexpected network request');
      const key = decodeURIComponent(url.pathname.slice('/get/'.length));
      if (url.pathname.startsWith('/get/')) {
        cacheReads.push(key);
        return Response.json({ result: remote.get(key) ?? null });
      }
      if (url.pathname.startsWith('/set/')) {
        const body = JSON.parse(String(init?.body)) as { value: string };
        remote.set(key, body.value);
        return Response.json({ result: 'OK' });
      }
      throw new Error('Unexpected cache operation');
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['memory', 'remote'] as const)('shapes ascending and descending search limits from the %s cache', async (cache) => {
    state.remote = cache === 'remote';
    const svc = await fresh();
    for (const limit of [2, 20, 5, 8, 1]) {
      const output = await svc.fetchResults('  Some SONG  ', limit);
      expect(output.main_results).toEqual(items.slice(0, limit));
      expect(output.suggested).toEqual(items.slice(limit, limit + 5));
      if (state.remote) svc.MEMORY_CACHE.clear();
    }
    expect(upstreamCalls).toBe(1);
  });

  it.each(['memory', 'remote'] as const)('shapes suggestion responses for every limit from the %s cache', async (cache) => {
    state.remote = cache === 'remote';
    const svc = await fresh();
    await svc.fetchResults('some song', 1);
    if (state.remote) svc.MEMORY_CACHE.clear();
    for (const limit of [5, 2, 20]) {
      expect(await svc.fetchSuggestions(' Some   SONG ', limit)).toEqual({
        results: items.slice(0, limit),
        suggested: items.slice(limit, limit + 5),
      });
      if (state.remote) svc.MEMORY_CACHE.clear();
    }
    expect(upstreamCalls).toBe(1);
  });

  it.each(['memory', 'remote'] as const)('keeps complete trending results in the %s cache when search was seeded with a small limit', async (cache) => {
    state.remote = cache === 'remote';
    const svc = await fresh();
    await svc.fetchResults('music trending india', 1);
    if (state.remote) svc.MEMORY_CACHE.clear();
    for (const limit of [2, 20, 5]) {
      expect(await svc.fetchTrending(limit)).toEqual(items.slice(0, limit));
      if (state.remote) svc.MEMORY_CACHE.clear();
    }
    expect(upstreamCalls).toBe(1);
  });

  it('preserves the suggestion fallback when the page has fewer results than the requested limit', async () => {
    const svc = await fresh();
    items = resultItems(3);
    for (const limit of [5, 1, 3]) {
      const output = await svc.fetchResults('some song', limit);
      expect(output.main_results).toEqual(items.slice(0, limit));
      expect(output.suggested).toEqual(items.length > limit ? items.slice(limit, limit + 5) : items.slice(0, 5));
    }
    expect(upstreamCalls).toBe(1);
  });

  it('ignores legacy truncated Redis keys and writes full, versioned replacements', async () => {
    state.remote = true;
    const svc = await fresh();
    remote.set('search_some song', JSON.stringify({ main_results: items.slice(0, 2), suggested: items.slice(2, 7) }));
    remote.set('search_music trending india', JSON.stringify({ main_results: items.slice(0, 1), suggested: items.slice(1, 6) }));
    remote.set('trending_music_search', JSON.stringify(items.slice(0, 2)));

    expect((await svc.fetchResults('some song', 20)).main_results).toEqual(items.slice(0, 20));
    expect(await svc.fetchTrending(20)).toEqual(items.slice(0, 20));
    expect(cacheReads).not.toContain('search_some song');
    expect(cacheReads).not.toContain('search_music trending india');
    expect(cacheReads).not.toContain('trending_music_search');
    const replacements = [...remote.entries()].filter(([key]) => !['search_some song', 'search_music trending india', 'trending_music_search'].includes(key));
    expect(replacements).toHaveLength(3);
    for (const [, payload] of replacements) {
      expect(JSON.parse(payload)).toEqual({ version: 2, results: items });
    }
    expect(upstreamCalls).toBe(2);
  });

  it('treats stale or malformed payloads at the new key as misses', async () => {
    state.remote = true;
    const svc = await fresh();
    await svc.fetchResults('some song', 2);
    const key = cacheReads[0]!;
    for (const invalid of [{ version: 1, results: items.slice(0, 2) }, { version: 2, results: {} }, { main_results: items.slice(0, 2), suggested: [] }]) {
      svc.MEMORY_CACHE.clear();
      remote.set(key, JSON.stringify(invalid));
      expect((await svc.fetchResults('some song', 20)).main_results).toEqual(items.slice(0, 20));
    }
    expect(upstreamCalls).toBe(4);
  });

  it('coalesces simultaneous requests with different limits against one complete page', async () => {
    const svc = await fresh();
    const results = await Promise.all([svc.fetchResults('some song', 1), svc.fetchResults('some song', 20), svc.fetchSuggestions('Some Song', 5)]);
    expect(results[0].main_results).toEqual(items.slice(0, 1));
    expect(results[1].main_results).toEqual(items.slice(0, 20));
    expect(results[2].results).toEqual(items.slice(0, 5));
    expect(results[2].suggested).toEqual(items.slice(5, 10));
    expect(upstreamCalls).toBe(1);
  });

  it('shares an empty result with concurrent callers and retries on the next request', async () => {
    const svc = await fresh();
    items = [];
    const results = await Promise.all([
      svc.fetchResults('missing song', 1),
      svc.fetchResults(' Missing  SONG ', 20),
      svc.fetchSuggestions('missing song', 5),
    ]);
    expect(results[0].main_results).toEqual([]);
    expect(results[1].main_results).toEqual([]);
    expect(results[2].results).toEqual([]);
    expect(upstreamCalls).toBe(1);

    items = resultItems(3);
    expect((await svc.fetchResults('missing song', 2)).main_results).toHaveLength(2);
    expect(upstreamCalls).toBe(2);
  });

  it('shares one retry budget during an upstream outage instead of queuing retries per caller', async () => {
    const svc = await fresh();
    vi.useFakeTimers();
    const failingFetch = vi.fn<typeof fetch>(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return new Response('Unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', failingFetch);
    const started = Date.now();
    const calls = Promise.all(Array.from({ length: 6 }, () => svc.fetchResults('some song')));
    await vi.runAllTimersAsync();
    expect((await calls).every(result => result.main_results.length === 0)).toBe(true);
    expect(failingFetch).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBe(400);
  });
});
