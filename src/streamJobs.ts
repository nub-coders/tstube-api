/**
 * Stream-job state — port of main.py's redis-backed job plumbing
 * (`stream_job:{id}` -> {url, mode, extracted_url, extracted_time}).
 *
 * Job state lives in Redis so /stream/redirect and /stream/resolver can land on
 * different replicas behind a non-sticky load balancer. TTL covers the 45s
 * resolver wait + buffer.
 *
 * Three in-process caches mirror the Python globals:
 *   _JOB_MEMO      completed jobs only (a pending job is what waiters watch change)
 *   _JOB_EVENTS    wakes local waiters the instant extraction finishes
 *   _REFRESH_LOCKS coalesces concurrent 403 refreshes of the same id
 */
import { createHash } from 'node:crypto';
import { BoundedCache } from './boundedCache.js';
import { redis } from './redis.js';
import { getStream, getVideoStream, invalidate } from './cacheManager.js';
import { validateYoutubeTarget } from './urlValidation.js';
import { getLogger } from './logger.js';

const log = getLogger('ytube_api.stream');

/** 4 hours — matches YouTube stream URL lifetime. */
const STREAM_TTL = 14400;
const JOB_MEMO_TTL = 5.0;
const REFRESH_WAIT_S = 20.0;
const CROSS_REPLICA_POLL_S = 2.0;
export const AWAIT_TIMEOUT_S = 45.0;

export interface StreamJob {
  url: string;
  mode: 'audio' | 'video';
  extracted_url: string | null;
  extracted_time: number | null;
  /** Webshare proxy URL the extracted stream is IP-locked to (null = direct). */
  proxy_url?: string | null;
}

const JOB_MEMO = new BoundedCache<StreamJob>(2048, JOB_MEMO_TTL);
const JOB_EVENTS = new BoundedCache<Signal>(4096);
const REFRESH_LOCKS = new BoundedCache<Promise<void>>(1024);

/** One-shot broadcast, the JS stand-in for asyncio.Event. */
class Signal {
  private flag = false;
  private waiters: Array<() => void> = [];

  set(): void {
    this.flag = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  clear(): void {
    this.flag = false;
  }

  /** Resolve after `ms` at the latest; resolves immediately if already set. */
  wait(ms: number): Promise<void> {
    if (this.flag) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const fn = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Drop ourselves from the waiter list.
        this.waiters = this.waiters.filter((w) => w !== fn);
        resolve();
      };
      const timer = setTimeout(fn, ms);
      this.waiters.push(fn);
    });
  }
}

function jobEvent(streamId: string): Signal {
  let ev = JOB_EVENTS.get(streamId);
  if (ev === undefined) {
    ev = new Signal();
    JOB_EVENTS.set(streamId, ev);
  }
  return ev;
}

function jobKey(streamId: string): string {
  return `stream_job:${streamId}`;
}

/** Stable stream id from mode+url: base64url(sha256("mode:url")) without padding. */
export function encodeStreamId(url: string, mode: string): string {
  const digest = createHash('sha256').update(`${mode}:${url}`).digest();
  return digest.toString('base64url');
}

/** Mirrors main._resolve_mode. */
export function resolveMode(mode: string): 'audio' | 'video' {
  return ['video', 'stream', 'muxed'].includes(String(mode).toLowerCase()) ? 'video' : 'audio';
}

/** Memo (completed jobs only), else Redis. Returns a copy for callers to mutate. */
async function jobGet(streamId: string): Promise<StreamJob | null> {
  const cached = JOB_MEMO.get(streamId);
  if (cached !== undefined) return { ...cached };
  const raw = await redis().get(jobKey(streamId));
  if (!raw) return null;
  let job: StreamJob;
  try {
    job = JSON.parse(raw) as StreamJob;
  } catch {
    return null;
  }
  if (job.extracted_url) JOB_MEMO.set(streamId, { ...job });
  return job;
}

/**
 * Make a completed job visible to *this* process and wake its waiters, before
 * the ~250ms remote-Redis write. The extracted URL is already valid; Redis only
 * exists to share it with other replicas and later requests.
 */
function jobPublishLocal(streamId: string, job: StreamJob): void {
  JOB_MEMO.set(streamId, { ...job });
  jobEvent(streamId).set();
}

/** Drop local state for a job that is no longer complete. */
function jobForgetLocal(streamId: string): void {
  JOB_MEMO.delete(streamId);
  const ev = JOB_EVENTS.get(streamId);
  if (ev) ev.clear();
}

/**
 * Persist a job and keep local memo/waiters consistent.
 * `onlyIfExists` maps to SET XX so a job whose TTL lapsed mid-extraction is not
 * resurrected. Returns false when XX found no key.
 */
async function jobSet(streamId: string, job: StreamJob, onlyIfExists = false): Promise<boolean> {
  const payload = JSON.stringify(job);
  const stored = onlyIfExists
    ? await redis().set(jobKey(streamId), payload, 'EX', STREAM_TTL, 'XX')
    : await redis().set(jobKey(streamId), payload, 'EX', STREAM_TTL);
  if (onlyIfExists && stored === null) return false;
  if (job.extracted_url) jobPublishLocal(streamId, job);
  else jobForgetLocal(streamId);
  return true;
}

function startBackgroundExtraction(streamId: string, url: string, mode: 'audio' | 'video'): void {
  void (async () => {
    try {
      const extracted =
        mode === 'video' ? await getVideoStream(url) : await getStream(url);
      if (!extracted?.url) {
        log.error(`[STREAM_RESOLVER] Failed to extract ${mode} for ${streamId}`);
        return;
      }
      const job: StreamJob = {
        url,
        mode,
        extracted_url: extracted.url,
        extracted_time: Date.now() / 1000,
        proxy_url: extracted.proxyUrl ?? null,
      };
      // Wake local waiters first, then persist.
      jobPublishLocal(streamId, job);
      if (await jobSet(streamId, job, true)) {
        log.info(`[STREAM_RESOLVER] Extracted ${mode} URL for ${streamId}`);
      } else {
        log.info(`[STREAM_RESOLVER] Job ${streamId} expired before extraction finished`);
      }
    } catch (e) {
      log.error(`[STREAM_RESOLVER] Failed to extract ${mode}: ${String(e)}`);
    }
  })();
}

/**
 * Claim (SET NX) or reuse a job, starting background extraction when none is
 * running. Mirrors main._ensure_stream_job.
 */
export async function ensureStreamJob(url: string, mode: string): Promise<string> {
  validateYoutubeTarget(url); // SSRF guard: only YouTube targets reach yt-dlp
  const resolvedMode = resolveMode(mode);
  const streamId = encodeStreamId(url, resolvedMode);

  const pending: StreamJob = { url, mode: resolvedMode, extracted_url: null, extracted_time: null };
  const created = await redis().set(
    jobKey(streamId),
    JSON.stringify(pending),
    'EX',
    STREAM_TTL,
    'NX',
  );

  if (created) {
    // A fresh pending job supersedes anything this process remembers for that id.
    jobForgetLocal(streamId);
    startBackgroundExtraction(streamId, url, resolvedMode);
  } else {
    // A long TTL means a job whose extraction failed would otherwise stay dead
    // for hours. Retry it — repeat resolves are cheap, the cache serves them.
    const job = await jobGet(streamId);
    if (job !== null && job.extracted_url === null) {
      startBackgroundExtraction(streamId, url, resolvedMode);
    }
  }
  return streamId;
}

/** Wait (up to `timeout` seconds) for a job with extracted_url, or null if gone. */
export async function awaitExtracted(
  streamId: string,
  timeout = AWAIT_TIMEOUT_S,
): Promise<StreamJob | null> {
  let job = await jobGet(streamId);
  if (job === null || job.extracted_url) return job;

  const event = jobEvent(streamId);
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await event.wait(Math.min(CROSS_REPLICA_POLL_S, remaining / 1000) * 1000);
    job = await jobGet(streamId);
    if (job === null || job.extracted_url) break;
  }
  return job;
}

/** Serialize refreshes per stream id (Python's per-id asyncio.Lock). */
async function withRefreshLock<T>(streamId: string, fn: () => Promise<T>): Promise<T> {
  const prev = REFRESH_LOCKS.get(streamId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  REFRESH_LOCKS.set(streamId, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Drop a revoked stream URL and re-extract it. Recovering from a 403 needs all
 * three of: invalidate the cache (it keys expiry off `expire`, and googlevideo
 * revokes well before that), clear `extracted_url` BEFORE re-extracting so
 * awaitExtracted actually waits, then start extraction.
 */
export async function refreshStreamUrl(
  streamId: string,
  job: StreamJob,
): Promise<StreamJob | null> {
  const { url, mode } = job;
  if (!url || !mode) return null;
  const deadUrl = job.extracted_url;

  return withRefreshLock(streamId, async () => {
    // A concurrent request may have already refreshed this while we queued.
    const current = await jobGet(streamId);
    if (current && current.extracted_url !== null && current.extracted_url !== deadUrl) {
      return current;
    }

    try {
      await invalidate(url, mode === 'video' ? 'video:' : 'audio:');
    } catch (e) {
      log.error(`[STREAM_PROXY] Cache invalidation failed for ${streamId}: ${String(e)}`);
    }

    const pending: StreamJob = { ...job, extracted_url: null, extracted_time: null, proxy_url: null };
    await jobSet(streamId, pending);
    startBackgroundExtraction(streamId, url, mode);
    return awaitExtracted(streamId, REFRESH_WAIT_S);
  });
}

/** Test hook — drop all in-process job state. */
export function resetJobState(): void {
  JOB_MEMO.clear();
  JOB_EVENTS.clear();
  REFRESH_LOCKS.clear();
}
