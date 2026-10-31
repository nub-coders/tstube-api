import { createHash } from 'node:crypto';
import { BoundedCache } from './boundedCache.js';
import { redis } from './redis.js';
import { HttpError } from './httpError.js';
import { fetchResults as search, getAvailableKeys } from './youtubeApi.js';
import type { ProcessedVideo } from './formatters.js';

const results = new BoundedCache<ProcessedVideo[]>(512, 300);
const pending = new Map<string, Promise<ProcessedVideo[]>>();

/** Cache successful public searches without mixing callers' requested result limits. */
export async function fetchResults(query: string, limit = 1): Promise<ProcessedVideo[]> {
  if (!getAvailableKeys().length) return [];
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const key = `youtube_search:cache:${createHash('sha256').update(JSON.stringify([normalized, limit])).digest('hex')}`;
  const cached = results.get(key);
  if (cached) return cached;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  if (pending.size >= 128) throw new HttpError(429, { error: 'YouTube search is busy', retry_after: 1 });

  const task = (async () => {
    try {
      const raw = await redis().get(key);
      const cached: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(cached) && cached.length && cached.length <= limit && cached.every(item =>
        item && typeof item.video_id === 'string' && typeof item.url === 'string' && typeof item.title === 'string')) {
        results.set(key, cached);
        return cached as ProcessedVideo[];
      }
    } catch { /* The admission gate still fails closed if Redis is unavailable. */ }
    const found = await search(query, limit);
    if (found.length) {
      results.set(key, found);
      try { await redis().setex(key, 300, JSON.stringify(found)); } catch { /* local cache remains usable */ }
    }
    return found;
  })();
  pending.set(key, task);
  try { return await task; }
  finally { pending.delete(key); }
}
