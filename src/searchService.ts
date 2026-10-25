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
const FETCH_TIMEOUT_MS = 3_500;

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

const SEARCH_CACHE_VERSION = 2;
interface CachedSearchResults {
  version: typeof SEARCH_CACHE_VERSION;
  results: SearchItem[];
}

// Cache the complete parsed page; response limits belong to each caller.
export const MEMORY_CACHE = new BoundedCache<SearchItem[]>(5000, 300);
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

async function fetchYtData(url: string, retries = 1): Promise<any | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        return null;
      }
      const text = await res.text();
      const m = YT_REGEX.exec(text);
      if (!m) return null;
      return JSON.parse(m[1]!);
    } catch (e) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      log.warning(`[SEARCH] YouTube HTML scrape failed: ${String(e)}`);
      return null;
    }
  }
  return null;
}

function parseYtData(rawData: any): SearchItem[] {
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
    }
  }
  return results;
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
  const tail = prev.then(() => gate);
  LOCKS.set(key, tail);
  return prev.then(fn).finally(() => {
    release();
    // Only remove if we are still the tail.
    if (LOCKS.get(key) === tail) LOCKS.delete(key);
  });
}

// ── Search ──────────────────────────────────────────────────────

function parseCachedResults(raw: string): SearchItem[] | null {
  try {
    const data = JSON.parse(raw) as Partial<CachedSearchResults> | null;
    if (data?.version !== SEARCH_CACHE_VERSION || !Array.isArray(data.results)) return null;
    const fields: Array<keyof SearchItem> = ['title', 'video_id', 'url', 'time', 'duration', 'channel', 'views', 'thumbnail'];
    if (!data.results.every((item) => item && fields.every((field) => typeof item[field] === 'string'))) return null;
    return data.results;
  } catch {
    return null;
  }
}

async function cachedResults(
  key: string,
  fetcher: () => Promise<SearchItem[]>,
  cacheEmpty = false,
): Promise<SearchItem[]> {
  const cached = MEMORY_CACHE.get(key);
  if (cached !== undefined) return cached;

  return withLock(key, async () => {
    const again = MEMORY_CACHE.get(key);
    if (again !== undefined) return again;

    const raw = await redisGet(key);
    const remote = raw ? parseCachedResults(raw) : null;
    if (remote !== null) {
      MEMORY_CACHE.set(key, remote);
      return remote;
    }

    const results = await fetcher();
    if (results.length || cacheEmpty) {
      MEMORY_CACHE.set(key, results);
      const payload: CachedSearchResults = { version: SEARCH_CACHE_VERSION, results };
      void redisSet(key, JSON.stringify(payload));
    }
    return results;
  });
}

async function searchResults(query: string): Promise<SearchItem[]> {
  if (!query) return [];
  // Legacy values contain a caller's truncated response and cannot safely be
  // upgraded into a complete page. New keys leave those values unused.
  const key = `search_v${SEARCH_CACHE_VERSION}_` + normalize(query);
  return cachedResults(key, async () => {
    const url = YOUTUBE_SEARCH_URL + encodeURIComponent(query).replace(/%20/g, '+');
    const rawData = await fetchYtData(url);
    let results = rawData ? parseYtData(rawData) : [];

    // If synthetic prefixes or strict matching returned empty results, try relaxing the query.
    if (!results.length) {
      const relaxed = query.replace(/^[a-zA-Z0-9]+-\d+\s+/, '').trim();
      if (relaxed && relaxed !== query) {
        const relaxedUrl = YOUTUBE_SEARCH_URL + encodeURIComponent(relaxed).replace(/%20/g, '+');
        const relaxedData = await fetchYtData(relaxedUrl, 0);
        if (relaxedData) results = parseYtData(relaxedData);
      }
    }
    return results;
  });
}

export async function fetchResults(query: string, limit = 1): Promise<SearchOutput> {
  const results = await searchResults(query);
  return {
    main_results: results.slice(0, limit),
    suggested: results.length > limit ? results.slice(limit, limit + 5) : results.slice(0, 5),
  };
}

export async function fetchTrending(limit = 10): Promise<SearchItem[]> {
  const results = await cachedResults(
    `trending_music_search_v${SEARCH_CACHE_VERSION}`,
    () => searchResults('music trending india'),
    true,
  );
  return results.slice(0, limit);
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
