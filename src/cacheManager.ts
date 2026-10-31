/**
 * Stream URL cache — port of utils/cache_manager.py.
 *
 * Two layers: Redis (shared, authoritative) and a container-local file cache
 * that survives a Redis flush. Validated entries use the signed URL's expiry;
 * live manifests also have a short lifetime because their playback URLs rotate.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractId, invalidateResolvedStream, resolveWithMeta as innertubeResolveMeta, type ResolveOptions } from './innertube.js';
import { redis } from './redis.js';
import { getLogger } from './logger.js';
import { detectProvider, resolveToPlayableStream } from './platformResolvers.js';
import { fetchResults as scrapeSearch } from './searchService.js';
import { requestSignal } from './requestDeadline.js';
import { invalidateMediaProbe, probeMedia } from './mediaProbe.js';
import { HLS_STREAM_TTL_S, STREAM_VALIDATION_VERSION } from './streamPolicy.js';

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
  /** Resolved YouTube identity when the cache key is a platform page URL. */
  videoId?: string;
  /** Live HLS manifests require playlist handling and a bounded freshness window. */
  streamType?: 'hls';
}

interface StreamLookup {
  invalidated: boolean;
  videoId?: string;
  stream?: CachedStream;
  write?: Promise<unknown>;
}

const ACTIVE_LOOKUPS = new Map<string, Set<StreamLookup>>();
const INVALIDATIONS = new Map<string, Promise<void>>();

/**
 * The validation version prevents pre-policy URLs from bypassing playback
 * checks after deployment. Legacy decoding remains available for invalidation.
 */
export function encodeCached(value: CachedStream): string {
  return JSON.stringify({
    validationVersion: STREAM_VALIDATION_VERSION,
    u: value.url,
    ...(value.proxyUrl ? { p: value.proxyUrl } : {}),
    ...(value.videoId ? { v: value.videoId } : {}),
    ...(value.streamType === 'hls' ? { streamType: value.streamType } : {}),
  });
}

function decodeCacheValue(raw: string, requireCurrentValidation: boolean): CachedStream | null {
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw) as { u?: unknown; p?: unknown; v?: unknown; streamType?: unknown; validationVersion?: unknown };
      if (requireCurrentValidation && o.validationVersion !== STREAM_VALIDATION_VERSION) return null;
      if (typeof o.u === 'string' && o.u) {
        const videoId = typeof o.v === 'string' ? extractId(o.v) : null;
        return {
          url: o.u,
          proxyUrl: typeof o.p === 'string' && o.p ? o.p : null,
          ...(videoId ? { videoId } : {}),
          ...(o.streamType === 'hls' ? { streamType: 'hls' } : {}),
        };
      }
    } catch {
      return null;
    }
    return null;
  }
  return !requireCurrentValidation && raw ? { url: raw, proxyUrl: null } : null;
}

export function decodeCached(raw: string): CachedStream | null {
  return decodeCacheValue(raw, false);
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

/** Read only entries validated under the current playback policy. */
function readCache(url: string, prefix: string): [CachedStream | null, number] {
  const path = cachePath(url, prefix);
  if (!existsSync(path)) return [null, -1];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      url?: string; expire?: number; proxy?: string; videoId?: string; streamType?: unknown; validationVersion?: unknown;
    };
    const expire = data.expire ?? 0;
    const remaining = expire - Date.now() / 1000;
    if (data.validationVersion === STREAM_VALIDATION_VERSION && typeof data.url === 'string' && data.url && remaining > 15) {
      log.debug(`[CACHE HIT] ${prefix}${url}`);
      const videoId = extractId(data.videoId ?? '');
      return [{
        url: data.url,
        proxyUrl: typeof data.proxy === 'string' && data.proxy ? data.proxy : null,
        ...(videoId ? { videoId } : {}),
        ...(data.streamType === 'hls' ? { streamType: 'hls' } : {}),
      }, Math.floor(remaining)];
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

function streamExpire(stream: CachedStream): number | null {
  const now = Math.floor(Date.now() / 1000);
  let expire = extractExpire(stream.url);
  if (stream.streamType === 'hls') {
    // A missing expiry is normal for live manifests. An explicitly expired or
    // malformed signed expiry must not receive a new fallback lifetime.
    if (!expire) {
      try {
        if (new URL(stream.url).searchParams.has('expire')) return null;
      } catch { return null; }
      expire = now + HLS_STREAM_TTL_S;
    }
    expire = Math.min(expire, now + HLS_STREAM_TTL_S);
  }
  if (expire && stream.proxyUrl) expire = Math.min(expire, now + PROXY_STREAM_TTL_S);
  return expire;
}

function writeCache(url: string, stream: CachedStream, prefix: string, expire: number): void {
  ensureCacheDir();
  try {
    writeFileSync(
      cachePath(url, prefix),
      JSON.stringify({
        validationVersion: STREAM_VALIDATION_VERSION,
        url: stream.url,
        expire,
        ...(stream.proxyUrl ? { proxy: stream.proxyUrl } : {}),
        ...(stream.videoId ? { videoId: stream.videoId } : {}),
        ...(stream.streamType === 'hls' ? { streamType: stream.streamType } : {}),
      }),
    );
    log.info(
      `[CACHE WRITE] ${prefix}${url} (expires in ${Math.floor(expire - Date.now() / 1000)}s)`,
    );
  } catch (e) {
    log.error(`[CACHE WRITE ERROR] ${String(e)}`);
  }
}

/**
 * Forget a cached stream URL so the next resolve re-extracts. googlevideo can
 * revoke a URL (403/410) long before its `expire`. Invalidate Redis, the file
 * entry and the underlying Innertube memo, including active cache writers.
 */
export async function invalidate(url: string, prefix = ''): Promise<void> {
  const key = `${prefix}${url}`;
  const previous = INVALIDATIONS.get(key);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  INVALIDATIONS.set(key, barrier);
  const lookups = [...(ACTIVE_LOOKUPS.get(key) ?? [])];
  const videoIds = new Set<string>();
  const inputId = extractId(url);
  if (inputId) videoIds.add(inputId);
  for (const lookup of lookups) {
    lookup.invalidated = true;
    if (lookup.stream) invalidateMediaProbe(lookup.stream.url, lookup.stream.proxyUrl);
    if (lookup.videoId) videoIds.add(lookup.videoId);
  }
  for (const id of videoIds) invalidateResolvedStream(id);
  try {
    if (previous) await previous;
    // Drain writes already sent to Redis before deleting the key. New writes
    // from these lookups are suppressed by their invalidated flag.
    await Promise.allSettled(lookups.flatMap((lookup) => lookup.write ? [lookup.write] : []));
    try {
      const data = JSON.parse(readFileSync(cachePath(url, prefix), 'utf8')) as { videoId?: string; url?: string; proxy?: string };
      if (data.url) invalidateMediaProbe(data.url, data.proxy);
      const id = extractId(data.videoId ?? '');
      if (id) videoIds.add(id);
    } catch { /* absent or legacy file entry */ }
    try {
      const raw = await redis().get(`cache:${key}`);
      const cached = raw ? decodeCached(raw) : null;
      if (cached) invalidateMediaProbe(cached.url, cached.proxyUrl);
      const id = cached?.videoId;
      if (id) videoIds.add(id);
    } catch (e) {
      log.error(`[CACHE INVALIDATE] redis identity lookup failed: ${String(e)}`);
    }
    for (const id of videoIds) invalidateResolvedStream(id);
    try {
      rmSync(cachePath(url, prefix));
    } catch {
      /* not found */
    }
    try {
      await redis().del(`cache:${key}`);
    } catch (e) {
      log.error(`[CACHE INVALIDATE] redis delete failed: ${String(e)}`);
    }
    log.info(`[CACHE INVALIDATE] ${prefix}${url}`);
  } finally {
    release();
    if (INVALIDATIONS.get(key) === barrier) INVALIDATIONS.delete(key);
  }
}

export async function resolveTargetUrl(url: string): Promise<[string, boolean]> {
  try {
    const provider = detectProvider(url);
    if (['apple_music', 'amazon_music', 'jiosaavn', 'soundcloud', 'spotify'].includes(provider)) {
      const res = await resolveToPlayableStream(url);
      if (res?.stream_url && (provider === 'jiosaavn' || provider === 'soundcloud')) {
        return [res.stream_url, true];
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
    log.warning(`[PLATFORM RESOLVE ERROR] ${url}: ${String(e)}`);
  }
  return [url, false];
}

async function resolveUrl(
  url: string,
  kind: 'audio' | 'muxed',
  _formatSelector: string,
  options: ResolveOptions,
): Promise<CachedStream | null> {
  try {
    const res = await innertubeResolveMeta(url, kind, options);
    if (res.url) {
      log.info(`[INNERTUBE] ✅ ${kind} ${url}`);
      const videoId = extractId(url);
      return {
        url: res.url,
        proxyUrl: res.proxyUrl,
        ...(videoId ? { videoId } : {}),
        ...(res.streamType === 'hls' ? { streamType: 'hls' } : {}),
      };
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
  options: ResolveOptions,
): Promise<CachedStream | null> {
  requestSignal()?.throwIfAborted();
  const key = `${prefix}${url}`;
  // A lookup that overlaps invalidation must wait until both stores have
  // been cleared before it retries, including delayed Redis writes.
  while (INVALIDATIONS.has(key)) await INVALIDATIONS.get(key);
  const lookup: StreamLookup = { invalidated: false, videoId: extractId(url) ?? undefined };
  const active = ACTIVE_LOOKUPS.get(key) ?? new Set();
  active.add(lookup);
  ACTIVE_LOOKUPS.set(key, active);
  try {
    const result = await loadStreamFor(url, prefix, kind, formatSelector, lookup, options);
    requestSignal()?.throwIfAborted();
    if (lookup.invalidated) {
      if (result) invalidateMediaProbe(result.url, result.proxyUrl);
      return getStreamFor(url, prefix, kind, formatSelector, options);
    }
    return result;
  } finally {
    active.delete(lookup);
    if (!active.size) ACTIVE_LOOKUPS.delete(key);
  }
}

async function cacheRedis(key: string, ttl: number, stream: CachedStream, lookup: StreamLookup): Promise<void> {
  if (lookup.invalidated) return;
  const write = redis().setex(key, ttl, encodeCached(stream));
  lookup.write = write;
  try { await write; } finally { if (lookup.write === write) lookup.write = undefined; }
}

async function loadStreamFor(
  url: string,
  prefix: string,
  kind: 'audio' | 'muxed',
  formatSelector: string,
  lookup: StreamLookup,
  options: ResolveOptions,
): Promise<CachedStream | null> {
  // A concurrent normal lookup can repopulate a rejected route after refresh
  // invalidates it. Recovery must bypass every cache, not only the player memo.
  if (!options.forceProxy) {
    // 1. Redis
    try {
      const cached = await redis().get(`cache:${prefix}${url}`);
      if (cached) {
        const decoded = decodeCacheValue(cached, true);
        if (decoded) {
          log.info(`[REDIS CACHE HIT] ${prefix}${url}`);
          return decoded;
        }
      }
    } catch (e) {
      log.error(`[REDIS GET ERROR] ${String(e)}`);
    }

    // 2. Local file cache
    if (lookup.invalidated) return null;
    const [entry, remaining] = readCache(url, prefix);
    if (entry) {
      lookup.videoId = entry.videoId ?? lookup.videoId;
      try {
        await cacheRedis(`cache:${prefix}${url}`, remaining, entry, lookup);
      } catch {
        /* ignore */
      }
      return entry;
    }
  }

  // 3. Resolve target & stream URL
  const [targetUrl, isDirect] = await resolveTargetUrl(url);
  requestSignal()?.throwIfAborted();
  lookup.videoId = extractId(targetUrl) ?? undefined;
  if (lookup.invalidated) {
    if (lookup.videoId) invalidateResolvedStream(lookup.videoId);
    return null;
  }
  // The direct provider branch supplies SoundCloud/JioSaavn audio. Successful
  // media probing does not make those sources suitable for video playback.
  if (isDirect && kind === 'muxed') return null;
  const stream = isDirect
    ? ({ url: targetUrl, proxyUrl: null } as CachedStream)
    : await resolveUrl(targetUrl, kind, formatSelector, options);
  lookup.stream = stream ?? undefined;
  // YouTube checks candidates inside its fallback ladder. Direct provider
  // URLs need the same check here before either cache can publish them.
  if (stream && isDirect && !await probeMedia(stream.url, { proxyUrl: stream.proxyUrl })) return null;
  requestSignal()?.throwIfAborted();
  if (stream && !lookup.invalidated) {
    const expire = streamExpire(stream);
    if (expire) {
      writeCache(url, stream, prefix, expire);
      const ttl = Math.floor(expire - Date.now() / 1000);
      if (ttl > 0) {
        try {
          await cacheRedis(`cache:${prefix}${url}`, ttl, stream, lookup);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return stream;
}

export function getStream(url: string, options: ResolveOptions = {}): Promise<CachedStream | null> {
  return getStreamFor(url, 'audio:', 'audio', '251/250/140/bestaudio[ext=m4a]/bestaudio/best', options);
}

export function getVideoStream(url: string, options: ResolveOptions = {}): Promise<CachedStream | null> {
  return getStreamFor(url, 'video:', 'muxed', 'best[ext=mp4]/22/18/best', options);
}

/** Test/ops hook to point the file cache at a temp dir. */
export function _cacheDirOverride(): string {
  return CACHE_DIR;
}
