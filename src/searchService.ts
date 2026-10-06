/**
 * YouTube search scrape service — port of utils/search_service.py.
 *
 * Scrapes `ytInitialData` from the results page. Has an in-process bounded
 * cache, an optional Upstash REST cache, and per-key request coalescing.
 */
import { BoundedCache } from './boundedCache.js';
import { config } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('ytube_api.search');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept-Language': 'en-US,en;q=0.9',
};

const YOUTUBE_SEARCH_URL = 'https://www.youtube.com/results?search_query=';
const YT_REGEX = /ytInitialData\s*=\s*(\{.+?\});/s;

// Bounded like every other outbound fetch: a hung YouTube or Upstash response
// must not pin the handlers behind the free, unauthenticated endpoints.
const FETCH_TIMEOUT_MS = 10_000;

export interface SearchItem {
  title: string;
  video_id: string;
  url: string;
  time: string;
  duration: string;
  channel: string;
  views: string;
  thumbnail: string;
}

export interface SearchOutput {
  main_results: SearchItem[];
  suggested: SearchItem[];
}

export const MEMORY_CACHE = new BoundedCache<SearchOutput>(5000, 300);
export const LOCKS = new BoundedCache<Promise<void>>(5000);

function normalize(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

function stripViews(text: string): string {
  return text.replace(' views', '').replace(' view', '');
}

function extractChannelName(v: Record<string, any>): string {
  for (const key of ['ownerText', 'longBylineText', 'shortBylineText']) {
    const runs = v[key]?.runs;
    if (runs && runs.length) return runs[0]?.text ?? 'Unknown';
  }
  return 'Unknown';
}

function safeGet(obj: any, ...keys: string[]): any {
  for (const key of keys) {
    if (typeof obj !== 'object' || obj === null) return {};
    obj = obj[key] ?? {};
  }
  return obj;
}

async function fetchYtData(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  const m = YT_REGEX.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

// ── Upstash Redis helpers ───────────────────────────────────────

async function redisGet(key: string): Promise<string | null> {
  const cfg = config();
  if (!cfg.UPSTASH_REDIS_REST_URL) return null;
  try {
    const res = await fetch(
      `${cfg.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${cfg.UPSTASH_REDIS_REST_TOKEN ?? ''}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (res.status === 200) {
      const body = (await res.json()) as { result?: string | null };
      return body.result ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function redisSet(key: string, value: string): Promise<void> {
  const cfg = config();
  if (!cfg.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(`${cfg.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.UPSTASH_REDIS_REST_TOKEN ?? ''}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({ value }),
    });
  } catch {
    /* ignore */
  }
}

/** Minimal per-key async mutex (Python used asyncio.Lock per query). */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  LOCKS.set(key, prev.then(() => gate));
  return prev.then(fn).finally(() => {
    release();
    // Only remove if we are still the tail.
    if (LOCKS.get(key) === undefined) LOCKS.delete(key);
  });
}

// ── Search ──────────────────────────────────────────────────────

export async function fetchResults(query: string, limit = 1): Promise<SearchOutput> {
  if (!query) return { main_results: [], suggested: [] };

  const qkey = 'search_' + normalize(query);

  const cached = MEMORY_CACHE.get(qkey);
  if (cached !== undefined) return cached;

  const raw = await redisGet(qkey);
  if (raw) {
    try {
      const data = JSON.parse(raw) as SearchOutput;
      MEMORY_CACHE.set(qkey, data);
      return data;
    } catch {
      /* fall through */
    }
  }

  return withLock(qkey, async () => {
    const again = MEMORY_CACHE.get(qkey);
    if (again !== undefined) return again;

    try {
      const url = YOUTUBE_SEARCH_URL + encodeURIComponent(query).replace(/%20/g, '+');
      const rawData = await fetchYtData(url);
      if (!rawData) return { main_results: [], suggested: [] };

      const contents: any[] = safeGet(
        rawData,
        'contents',
        'twoColumnSearchResultsRenderer',
        'primaryContents',
        'sectionListRenderer',
        'contents',
      ) as any[];

      const results: SearchItem[] = [];
      for (const section of Array.isArray(contents) ? contents : []) {
        const items = safeGet(section, 'itemSectionRenderer', 'contents');
        for (const item of Array.isArray(items) ? items : []) {
          const v = item.videoRenderer;
          if (!v) continue;
          const videoId = v.videoId;
          if (!videoId) continue;
          const titleRuns = safeGet(v, 'title', 'runs');
          const title = titleRuns?.[0]?.text ?? 'Unknown';
          const durationStr = v.lengthText?.simpleText ?? 'LIVE';
          results.push({
            title,
            video_id: videoId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            time: durationStr,
            duration: durationStr,
            channel: extractChannelName(v),
            views: stripViews(v.viewCountText?.simpleText ?? '0 views'),
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          });
          if (results.length >= limit + 10) break;
        }
      }

      const output: SearchOutput = {
        main_results: results.slice(0, limit),
        suggested:
          results.length > limit ? results.slice(limit, limit + 5) : results.slice(0, 5),
      };
      MEMORY_CACHE.set(qkey, output);
      // Fire-and-forget Redis write.
      void redisSet(qkey, JSON.stringify(output));
      return output;
    } finally {
      LOCKS.delete(qkey);
    }
  });
}

export async function fetchTrending(limit = 10): Promise<SearchItem[]> {
  const key = 'trending_music_search';
  const cached = MEMORY_CACHE.get(key);
  if (cached !== undefined) return cached.main_results.slice(0, limit);

  const raw = await redisGet(key);
  if (raw) {
    try {
      const data = JSON.parse(raw) as SearchItem[];
      MEMORY_CACHE.set(key, { main_results: data, suggested: [] });
      return data.slice(0, limit);
    } catch {
      /* fall through */
    }
  }

  const data = await fetchResults('music trending india', limit);
  const results = [...data.main_results, ...data.suggested].slice(0, limit);
  MEMORY_CACHE.set(key, { main_results: results, suggested: [] });
  void redisSet(key, JSON.stringify(results));
  return results;
}

export async function fetchSuggestions(
  query: string,
  limit = 5,
): Promise<{ results: SearchItem[]; suggested: SearchItem[] }> {
  const data = await fetchResults(query, limit);
  return {
    results: data.main_results,
    suggested: data.suggested.slice(0, 5),
  };
}

export { log as _log };
