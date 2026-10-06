/**
 * /trending limit tests: the cached list must be sliced to the caller's limit,
 * not the limit of whichever request seeded the cache (F2 — previously the
 * first request's limit won for the whole 5-minute TTL).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: () => ({ UPSTASH_REDIS_REST_URL: null, UPSTASH_REDIS_REST_TOKEN: null }),
}));

type Route = ((u: URL) => { status: number; body: unknown } | undefined) | null;

let route: Route;

function resultsPage(videoCount: number): string {
  const videos = Array.from({ length: videoCount }, (_, i) => ({
    videoRenderer: {
      videoId: `vid${i}aaaaaaa`,
      title: { runs: [{ text: `Song ${i}` }] },
      lengthText: { simpleText: `3:${String(10 + i).padStart(2, '0')}` },
      ownerText: { runs: [{ text: `Channel ${i}` }] },
      viewCountText: { simpleText: `${1000 + i} views` },
    },
  }));
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{ itemSectionRenderer: { contents: videos } }],
          },
        },
      },
    },
  };
  return `<html><script>ytInitialData = ${JSON.stringify(data)};</script></html>`;
}

async function fresh(): Promise<typeof import('../searchService.js')> {
  vi.resetModules();
  return await import('../searchService.js');
}

beforeEach(() => {
  route = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const u = new URL(String(input));
      const r = route?.(u);
      if (!r) throw new Error(`no route for ${u.host}${u.pathname}`);
      return { ok: r.status < 400, status: r.status, text: async () => String(r.body) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchTrending limit handling', () => {
  it('respects the caller limit on cold, warm and mixed requests', async () => {
    const svc = await fresh();
    route = (u) =>
      u.hostname === 'www.youtube.com' ? { status: 200, body: resultsPage(6) } : undefined;

    // Cold: seed the cache with 5 items (page has 6).
    const cold = await svc.fetchTrending(5);
    expect(cold).toHaveLength(5);

    // Warm: a smaller limit must slice the cached list (previously returned 5).
    const warm = await svc.fetchTrending(2);
    expect(warm).toHaveLength(2);
    expect(warm[0]!.title).toBe('Song 0');

    // Warm: a larger limit must not leak past what the cache holds either.
    const warmBig = await svc.fetchTrending(4);
    expect(warmBig).toHaveLength(4);
  });

  it('each warm response is a prefix of the cached list in stable order', async () => {
    const svc = await fresh();
    route = (u) =>
      u.hostname === 'www.youtube.com' ? { status: 200, body: resultsPage(8) } : undefined;

    const seeded = await svc.fetchTrending(6);
    expect(seeded).toHaveLength(6);
    const two = await svc.fetchTrending(2);
    expect(two.map((v) => v.video_id)).toEqual(seeded.slice(0, 2).map((v) => v.video_id));
  });
});
