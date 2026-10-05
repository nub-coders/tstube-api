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
import { resolveWithMeta as innertubeResolveMeta } from './innertube.js';
import { redis } from './redis.js';
import { getLogger } from './logger.js';
import { detectProvider, resolveToPlayableStream } from './platformResolvers.js';
import { fetchResults as scrapeSearch } from './searchService.js';

const log = getLogger('ytube_api.Stream');

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.cache');

/**
 * Proxy-bound stream URLs are pinned to one Webshare exit, and Webshare can
 * auto-replace exits at any time (407 no_proxies_allocated). Cap their cache
 * lifetime well below the 4h googlevideo expiry so a stale pin costs at most
 * an hour of occasional re-extraction instead of half a day of 407-recovery
 * stalls.
 */
export const PROXY_STREAM_TTL_S = 3600;

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

export interface CachedStream {
  url: string;
  /** Webshare proxy URL the stream is IP-locked to, when resolved via the geo-bypass tier. */
  proxyUrl: string | null;
}

/**
 * Cache envelope. New entries are JSON `{u, p}` so the proxy binding travels
 * with the URL through Redis and the file cache across replicas; pre-envelope
 * entries (plain URL strings) read back as direct streams.
 */
export function encodeCached(value: CachedStream): string {
  return JSON.stringify(value.proxyUrl ? { u: value.url, p: value.proxyUrl } : { u: value.url });
}

export function decodeCached(raw: string): CachedStream | null {
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw) as { u?: unknown; p?: unknown };
      if (typeof o.u === 'string' && o.u) {
        return { url: o.u, proxyUrl: typeof o.p === 'string' && o.p ? o.p : null };
      }
    } catch {
      return null;
    }
    return null;
  }
  return raw ? { url: raw, proxyUrl: null } : null;
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

/** Read cache, returning (url, remainingTtl, proxyUrl). TTL -1 means expired/missing. */
function readCache(url: string, prefix: string): [string | null, number, string | null] {
  const path = cachePath(url, prefix);
  if (!existsSync(path)) return [null, -1, null];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { url?: string; expire?: number; proxy?: string };
    const expire = data.expire ?? 0;
    const remaining = expire - Date.now() / 1000;
    if (remaining > 15) {
      log.debug(`[CACHE HIT] ${prefix}${url.slice(0, 80)}...`);
      return [data.url ?? null, Math.floor(remaining), data.proxy ?? null];
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
  return [null, -1, null];
}

function writeCache(
  url: string,
  streamUrl: string,
  prefix: string,
  proxyUrl: string | null = null,
  maxTtlSec?: number,
): void {
  let expire = extractExpire(streamUrl);
  if (!expire) {
    log.warning(`[CACHE SKIP] No expire found in stream URL for ${url.slice(0, 80)}`);
    return;
  }
  if (maxTtlSec) expire = Math.min(expire, Math.floor(Date.now() / 1000) + maxTtlSec);
  ensureCacheDir();
  try {
    writeFileSync(
      cachePath(url, prefix),
      JSON.stringify(proxyUrl ? { url: streamUrl, expire, proxy: proxyUrl } : { url: streamUrl, expire }),
    );
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
): Promise<CachedStream | null> {
  try {
    const res = await innertubeResolveMeta(url, kind, cookies);
    if (res.url) {
      log.info(`[INNERTUBE] ✅ ${kind} ${url.slice(0, 80)}`);
      return { url: res.url, proxyUrl: res.proxyUrl };
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
): Promise<CachedStream | null> {
  // 1. Redis
  try {
    const cached = await redis().get(`cache:${prefix}${url}`);
    if (cached) {
      const decoded = decodeCached(cached);
      if (decoded) {
        log.info(`[REDIS CACHE HIT] ${prefix}${url.slice(0, 80)}...`);
        return decoded;
      }
    }
  } catch (e) {
    log.error(`[REDIS GET ERROR] ${String(e)}`);
  }

  // 2. Local file cache
  const [fileUrl, remaining, fileProxy] = readCache(url, prefix);
  if (fileUrl) {
    const entry: CachedStream = { url: fileUrl, proxyUrl: fileProxy };
    try {
      await redis().setex(`cache:${prefix}${url}`, remaining, encodeCached(entry));
    } catch {
      /* ignore */
    }
    return entry;
  }

  // 3. Resolve target & stream URL
  const [targetUrl, isDirect] = await resolveTargetUrl(url);
  const stream = isDirect
    ? ({ url: targetUrl, proxyUrl: null } as CachedStream)
    : await resolveUrl(targetUrl, kind, formatSelector, cookies);
  if (stream) {
    const maxTtl = stream.proxyUrl ? PROXY_STREAM_TTL_S : undefined;
    writeCache(url, stream.url, prefix, stream.proxyUrl, maxTtl);
    const expire = extractExpire(stream.url);
    if (expire) {
      let ttl = Math.floor(expire - Date.now() / 1000);
      if (maxTtl) ttl = Math.min(ttl, maxTtl);
      if (ttl > 0) {
        try {
          await redis().setex(`cache:${prefix}${url}`, ttl, encodeCached(stream));
        } catch {
          /* ignore */
        }
      }
    }
  }
  return stream;
}

export function getStream(url: string, cookies: string | null = null): Promise<CachedStream | null> {
  return getStreamFor(url, 'audio:', 'audio', '251/250/140/bestaudio[ext=m4a]/bestaudio/best', cookies);
}

export function getVideoStream(
  url: string,
  cookies: string | null = null,
): Promise<CachedStream | null> {
  return getStreamFor(url, 'video:', 'muxed', 'best[ext=mp4]/22/18/best', cookies);
}

/** Test/ops hook to point the file cache at a temp dir. */
export function _cacheDirOverride(): string {
  return CACHE_DIR;
}
