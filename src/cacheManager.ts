/**
 * Stream URL cache — port of utils/cache_manager.py.
 *
 * Two layers: Redis (shared, authoritative) and a container-local file cache
 * that survives a Redis flush. Both key off the `expire` stamped into the
 * googlevideo URL.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as innertubeResolve } from './innertube.js';
import { redis } from './redis.js';
import { getLogger } from './logger.js';
import { detectProvider, resolveToPlayableStream } from './platformResolvers.js';
import { fetchResults as scrapeSearch } from './searchService.js';

const log = getLogger('ytube_api.Stream');

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.cache');

function ensureCacheDir(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    /* best effort */
  }
}

export function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

function cachePath(url: string, prefix: string): string {
  return join(CACHE_DIR, md5(prefix + url) + '.json');
}

export function extractExpire(streamUrl: string): number | null {
  try {
    const parsed = new URL(streamUrl);
    const expire = Number.parseInt(parsed.searchParams.get('expire') ?? '0', 10);
    return expire > Math.floor(Date.now() / 1000) ? expire : null;
  } catch {
    return null;
  }
}

/** Read cache, returning (url, remainingTtl). TTL -1 means expired/missing. */
function readCache(url: string, prefix: string): [string | null, number] {
  const path = cachePath(url, prefix);
  if (!existsSync(path)) return [null, -1];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { url?: string; expire?: number };
    const expire = data.expire ?? 0;
    const remaining = expire - Date.now() / 1000;
    if (remaining > 15) {
      log.debug(`[CACHE HIT] ${prefix}${url.slice(0, 80)}...`);
      return [data.url ?? null, Math.floor(remaining)];
    }
    try {
      rmSync(path);
    } catch {
      /* ignore */
    }
  } catch {
    try {
      rmSync(path);
    } catch {
      /* ignore */
    }
  }
  return [null, -1];
}

function writeCache(url: string, streamUrl: string, prefix: string): void {
  const expire = extractExpire(streamUrl);
  if (!expire) {
    log.warning(`[CACHE SKIP] No expire found in stream URL for ${url.slice(0, 80)}`);
    return;
  }
  ensureCacheDir();
  try {
    writeFileSync(cachePath(url, prefix), JSON.stringify({ url: streamUrl, expire }));
    log.info(
      `[CACHE WRITE] ${prefix}${url.slice(0, 80)}... (expires in ${Math.floor(expire - Date.now() / 1000)}s)`,
    );
  } catch (e) {
    log.error(`[CACHE WRITE ERROR] ${String(e)}`);
  }
}

/**
 * Forget a cached stream URL so the next resolve re-extracts. googlevideo can
 * revoke a URL (403/410) long before its `expire`, and both layers key off that
 * stamp — so both must be dropped or an already-dead URL keeps being served.
 */
export async function invalidate(url: string, prefix = ''): Promise<void> {
  try {
    rmSync(cachePath(url, prefix));
  } catch {
    /* not found */
  }
  try {
    await redis().del(`cache:${prefix}${url}`);
  } catch (e) {
    log.error(`[CACHE INVALIDATE] redis delete failed: ${String(e)}`);
  }
  log.info(`[CACHE INVALIDATE] ${prefix}${url.slice(0, 80)}`);
}

export async function resolveTargetUrl(url: string): Promise<[string, boolean]> {
  try {
    const provider = detectProvider(url);
    if (['apple_music', 'amazon_music', 'jiosaavn', 'soundcloud', 'spotify'].includes(provider)) {
      const res = await resolveToPlayableStream(url);
      if (res?.stream_url && provider === 'jiosaavn') {
        return [res.stream_url, true];
      }
      if (provider === 'soundcloud') {
        return [url, false];
      }
      if (res?.stream_url && (res.stream_url.includes('youtube.com') || res.stream_url.includes('youtu.be'))) {
        return [res.stream_url, false];
      }
      const searchQuery = res?.search_query;
      if (searchQuery) {
        const searchRes = await scrapeSearch(searchQuery, 1);
        const results = searchRes?.main_results ?? [];
        if (results.length > 0 && results[0].url) {
          return [results[0].url, false];
        } else if (results.length > 0 && results[0].video_id) {
          return [`https://www.youtube.com/watch?v=${results[0].video_id}`, false];
        }
        return [`ytsearch:${searchQuery}`, false];
      }
    }
  } catch (e) {
    log.warning(`[PLATFORM RESOLVE ERROR] ${url.slice(0, 80)}: ${String(e)}`);
  }
  return [url, false];
}

async function resolveUrl(
  url: string,
  kind: 'audio' | 'muxed',
  _formatSelector: string,
  cookies: string | null,
): Promise<string | null> {
  try {
    const itUrl = await innertubeResolve(url, kind, cookies);
    if (itUrl) {
      log.info(`[INNERTUBE] ✅ ${kind} ${url.slice(0, 80)}`);
      return itUrl;
    }
  } catch (e) {
    log.warning(`[INNERTUBE] Resolution failed: ${String(e)}`);
  }
  return null;
}

async function getStreamFor(
  url: string,
  prefix: string,
  kind: 'audio' | 'muxed',
  formatSelector: string,
  cookies: string | null,
): Promise<string | null> {
  // 1. Redis
  try {
    const cached = await redis().get(`cache:${prefix}${url}`);
    if (cached) {
      log.info(`[REDIS CACHE HIT] ${prefix}${url.slice(0, 80)}...`);
      return cached;
    }
  } catch (e) {
    log.error(`[REDIS GET ERROR] ${String(e)}`);
  }

  // 2. Local file cache
  const [fileUrl, remaining] = readCache(url, prefix);
  if (fileUrl) {
    try {
      await redis().setex(`cache:${prefix}${url}`, remaining, fileUrl);
    } catch {
      /* ignore */
    }
    return fileUrl;
  }

  // 3. Resolve target & stream URL
  const [targetUrl, isDirect] = await resolveTargetUrl(url);
  const streamUrl = isDirect ? targetUrl : await resolveUrl(targetUrl, kind, formatSelector, cookies);
  if (streamUrl) {
    writeCache(url, streamUrl, prefix);
    const expire = extractExpire(streamUrl);
    if (expire) {
      const ttl = Math.floor(expire - Date.now() / 1000);
      if (ttl > 0) {
        try {
          await redis().setex(`cache:${prefix}${url}`, ttl, streamUrl);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return streamUrl;
}

export function getStream(url: string, cookies: string | null = null): Promise<string | null> {
  return getStreamFor(url, 'audio:', 'audio', '251/250/140/bestaudio[ext=m4a]/bestaudio/best', cookies);
}

export function getVideoStream(
  url: string,
  cookies: string | null = null,
): Promise<string | null> {
  return getStreamFor(url, 'video:', 'muxed', 'best[ext=mp4]/22/18/best', cookies);
}

/** Test/ops hook to point the file cache at a temp dir. */
export function _cacheDirOverride(): string {
  return CACHE_DIR;
}
