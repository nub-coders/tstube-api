/**
 * Stream-job state — port of main.py's redis-backed job plumbing
 * (`stream_job:{id}` -> {url, mode, extracted_url, extracted_time}).
 *
 * Job state lives in Redis so /stream/redirect and /stream/resolver can land on
 * different replicas behind a non-sticky load balancer. TTL covers the 105s
 * resolver wait + buffer.
 *
 * Resolver URLs are bearer capabilities: "<coreId>.<secret>". The coreId is
 * sha256(mode:url) — derivable by anyone who knows the video URL — so the
 * random secret stored in the job is what keeps the unauthenticated resolver
 * endpoint from being an open stream for every known video. Only capability
 * URLs the API issued to an authenticated caller resolve.
 *
 * Two in-process caches coordinate completion and notification:
 *   _JOB_MEMO      completed or failed jobs (pending jobs remain authoritative)
 *   _JOB_EVENTS    wakes local waiters the instant extraction finishes
 */
import { createHash, randomBytes } from 'node:crypto';
import { BoundedCache } from './boundedCache.js';
import { redis } from './redis.js';
import { getStream, getVideoStream, invalidate, PROXY_STREAM_TTL_S } from './cacheManager.js';
import { validateYoutubeTarget } from './urlValidation.js';
import { getLogger } from './logger.js';
import type { ResolveOptions } from './innertube.js';
import { withRequestDeadline } from './requestDeadline.js';
import { invalidateMediaProbe } from './mediaProbe.js';
import { STREAM_VALIDATION_VERSION } from './streamPolicy.js';

const log = getLogger('ytube_api.stream');

/** 4 hours — matches YouTube stream URL lifetime. */
const STREAM_TTL = 14400;
const JOB_MEMO_TTL = 5.0;
const CROSS_REPLICA_POLL_S = 2.0;
// Leave time for the whole extraction deadline and publication before giving up.
export const AWAIT_TIMEOUT_S = 105.0;
export const EXTRACTION_TIMEOUT_MS = 100_000;
/** A crashed or stalled extractor must not hold a four-hour capability hostage. */
const EXTRACTION_LEASE_TTL_S = 120;

// The capability outlives individual extraction attempts. A separate random
// lease token fences both successful and failed results from expired workers.
const ENSURE_JOB_SCRIPT = `-- stream-job:ensure
local raw = redis.call('GET', KEYS[1])
local job = nil
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then job = decoded end
end
local pending = cjson.decode(ARGV[1])
if not job then
  job = pending
  redis.call('DEL', KEYS[2])
end
local backfill = not job.secret or job.secret == cjson.null
if backfill then job.secret = pending.secret end
local owner = ''
if (not job.extracted_url or job.extracted_url == cjson.null or job.validation_version ~= tonumber(ARGV[6])) and
    redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3], 'NX') then
  owner = ARGV[2]
  pending.secret = job.secret
  job = pending
  redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ARGV[4])
elseif not raw or backfill then
  local ttl = ARGV[4]
  if job.proxy_url and job.proxy_url ~= cjson.null then ttl = ARGV[5] end
  redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ttl)
end
return {cjson.encode(job), owner}
`;

const REFRESH_JOB_SCRIPT = `-- stream-job:refresh
local raw = redis.call('GET', KEYS[1])
if not raw then return {'', ''} end
local job = cjson.decode(raw)
if job.secret and job.secret ~= cjson.null and job.secret ~= ARGV[2] then
  return {'', ''}
end
local rejected = cjson.decode(ARGV[3])
if job.extracted_url and job.extracted_url ~= cjson.null and job.extracted_url ~= rejected then
  return {raw, ''}
end
if not redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[4], 'NX') then
  return {raw, ''}
end
job.secret = ARGV[2]
job.extracted_url = cjson.null
job.extracted_time = cjson.null
job.proxy_url = cjson.null
job.failed = false
local pending = cjson.encode(job)
redis.call('SET', KEYS[1], pending, 'EX', ARGV[5])
return {pending, ARGV[1]}
`;

const FINISH_JOB_SCRIPT = `-- stream-job:finish
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[1])
if not raw or cjson.decode(raw).secret ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
redis.call('DEL', KEYS[2])
return 1
`;

const RELEASE_LEASE_SCRIPT = `-- stream-job:release
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export interface StreamJob {
  url: string;
  mode: 'audio' | 'video';
  extracted_url: string | null;
  extracted_time: number | null;
  /** Webshare proxy URL the extracted stream is IP-locked to (null = direct). */
  proxy_url?: string | null;
  /**
   * Capability secret bound into resolver URLs ("<coreId>.<secret>"). Jobs are
   * keyed by sha256(mode:url), which anyone can compute, so this secret is
   * what makes a resolver URL unguessable. Absent only on jobs written by a
   * pre-capability replica; ensureStreamJob backfills those on first touch.
   */
  secret?: string;
  failed?: boolean;
  /** Cache policy applied when this source was selected. */
  validation_version?: number;
  stream_type?: 'hls';
}

const JOB_MEMO = new BoundedCache<StreamJob>(2048, JOB_MEMO_TTL);
const JOB_EVENTS = new BoundedCache<Signal>(4096);

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
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.flag) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter(w => w !== fn);
        signal?.removeEventListener('abort', aborted);
        if (error !== undefined) reject(error); else resolve();
      };
      const fn = () => finish();
      const aborted = () => finish(signal?.reason ?? new Error('Resolver cancelled'));
      const timer = setTimeout(fn, ms);
      this.waiters.push(fn);
      signal?.addEventListener('abort', aborted, { once: true });
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

function leaseKey(streamId: string): string {
  return `stream_job_lease:${streamId}`;
}

/** Stable stream id from mode+url: base64url(sha256("mode:url")) without padding. */
export function encodeStreamId(url: string, mode: string): string {
  const digest = createHash('sha256').update(`${mode}:${url}`).digest();
  return digest.toString('base64url');
}

/** 128-bit random capability secret, base64url (URL-safe, contains no dots). */
function newStreamSecret(): string {
  return randomBytes(16).toString('base64url');
}

/** The resolver URL token handed to clients: "<coreId>.<secret>". */
export function streamCapability(streamId: string, secret: string): string {
  return `${streamId}.${secret}`;
}

/**
 * Split a resolver token into its core id and secret. Both halves are
 * base64url (no dots), so the first dot is the separator; anything without
 * one — including pre-capability bare ids — is malformed.
 */
export function parseStreamCapability(token: string): { streamId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  return { streamId: token.slice(0, dot), secret: token.slice(dot + 1) };
}

/** Mirrors main._resolve_mode. */
export function resolveMode(mode: string): 'audio' | 'video' {
  return ['video', 'stream', 'muxed'].includes(String(mode).toLowerCase()) ? 'video' : 'audio';
}

/** Memo (completed/failed jobs), else Redis. Returns a copy for callers to mutate. */
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
 * Publish a fenced completion or failure to this process and wake its waiters.
 * Ownership must be confirmed by Redis first, even when extraction succeeds.
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
 * Atomically persist a result only while this attempt owns the lease and the
 * original capability still exists. An expired owner cannot replace a newer
 * completion, revive an expired capability, or release its successor's lease.
 */
async function finishExtraction(streamId: string, job: StreamJob, owner: string): Promise<boolean> {
  // Proxy-pinned jobs expire with the pinned exit (Webshare can replace it);
  // direct jobs keep the full googlevideo lifetime.
  const ttl = job.proxy_url ? Math.min(STREAM_TTL, PROXY_STREAM_TTL_S) : STREAM_TTL;
  const stored = await redis().eval(
    FINISH_JOB_SCRIPT, 2, jobKey(streamId), leaseKey(streamId),
    owner, job.secret!, JSON.stringify(job), ttl,
  );
  if (Number(stored) !== 1) return false;
  jobPublishLocal(streamId, job);
  return true;
}

async function releaseLease(streamId: string, owner: string): Promise<void> {
  await redis().eval(RELEASE_LEASE_SCRIPT, 1, leaseKey(streamId), owner);
}

function startBackgroundExtraction(
  streamId: string,
  url: string,
  mode: 'audio' | 'video',
  secret: string,
  owner: string,
  options?: ResolveOptions,
): void {
  void (async () => {
    let job: StreamJob;
    try {
      job = await withRequestDeadline(EXTRACTION_TIMEOUT_MS, 'stream extraction', async () => {
        let extracted =
          mode === 'video' ? await getVideoStream(url, options) : await getStream(url, options);
        if (!extracted?.url) {
          log.warning(`[STREAM_RESOLVER] Retrying stream extraction for ${streamId}`);
          await new Promise((r) => setTimeout(r, 1000));
          extracted = mode === 'video' ? await getVideoStream(url, options) : await getStream(url, options);
        }
        if (!extracted?.url) {
          log.error(`[STREAM_RESOLVER] Failed to extract ${mode} for ${streamId}`);
          return {
            url,
            mode,
            extracted_url: null,
            extracted_time: Date.now() / 1000,
            secret,
            failed: true,
          };
        } else {
          return {
            url,
            mode,
            extracted_url: extracted.url,
            extracted_time: Date.now() / 1000,
            proxy_url: extracted.proxyUrl ?? null,
            validation_version: STREAM_VALIDATION_VERSION,
            ...(extracted.streamType === 'hls' ? { stream_type: 'hls' as const } : {}),
            secret,
          };
        }
      });
    } catch (e) {
      log.error(`[STREAM_RESOLVER] Failed to extract ${mode}: ${String(e)}`);
      job = {
        url,
        mode,
        extracted_url: null,
        extracted_time: Date.now() / 1000,
        secret,
        failed: true,
      };
    }

    // Persistence failures are separate from extraction failures: attempting
    // another failing write in an extraction catch must never escape this task.
    try {
      if (await finishExtraction(streamId, job, owner)) {
        if (job.extracted_url) {
          log.info(`[STREAM_RESOLVER] Extracted ${mode} URL for ${streamId}: ${url} -> ${job.extracted_url}`);
        }
      } else {
        log.info(`[STREAM_RESOLVER] Job ${streamId} expired or its extraction lease changed`);
      }
    } catch (e) {
      log.error(`[STREAM_RESOLVER] Failed to persist ${mode} job ${streamId}: ${String(e)}`);
    } finally {
      try {
        await releaseLease(streamId, owner);
      } catch (e) {
        log.error(`[STREAM_RESOLVER] Failed to release extraction lease ${streamId}: ${String(e)}`);
      }
      // Also wake waiters after a rejected write. They reread authoritative
      // state instead of receiving an unconfirmed or stale local completion.
      jobEvent(streamId).set();
    }
  })().catch((e: unknown) => {
    // Last boundary for the detached runner, including errors while reporting
    // another error. No background rejection may terminate the HTTP process.
    log.error(`[STREAM_RESOLVER] Background extraction failed for ${streamId}: ${String(e)}`);
  });
}

/**
 * Atomically create/reuse the capability and acquire an extraction lease.
 * Pending jobs reuse active work; failed or abandoned jobs can acquire a new
 * attempt without rotating the capability handed to existing clients.
 */
export async function ensureStreamJob(url: string, mode: string): Promise<string> {
  validateYoutubeTarget(url); // SSRF guard: only valid YouTube targets reach resolver
  const resolvedMode = resolveMode(mode);
  const streamId = encodeStreamId(url, resolvedMode);
  const pending: StreamJob = {
    url, mode: resolvedMode, extracted_url: null, extracted_time: null, secret: newStreamSecret(),
    validation_version: STREAM_VALIDATION_VERSION,
  };
  const [raw, owner] = await redis().eval(
    ENSURE_JOB_SCRIPT, 2, jobKey(streamId), leaseKey(streamId),
    JSON.stringify(pending), newStreamSecret(), EXTRACTION_LEASE_TTL_S,
    STREAM_TTL, Math.min(STREAM_TTL, PROXY_STREAM_TTL_S), STREAM_VALIDATION_VERSION,
  ) as [string, string];
  const job = JSON.parse(raw) as StreamJob;
  if (owner) {
    jobForgetLocal(streamId);
    startBackgroundExtraction(streamId, url, resolvedMode, job.secret!, owner);
  } else if (job.extracted_url || job.failed) {
    jobPublishLocal(streamId, job);
  } else {
    jobForgetLocal(streamId);
  }
  return streamCapability(streamId, job.secret!);
}

/** Wait (up to `timeout` seconds) for a job with extracted_url or failure, or null if gone. */
export async function awaitExtracted(
  streamId: string,
  timeout = AWAIT_TIMEOUT_S,
  signal?: AbortSignal,
): Promise<StreamJob | null> {
  signal?.throwIfAborted();
  let job = await jobGet(streamId);
  if (job === null || isCurrentSource(job) || job.failed) return job;

  const event = jobEvent(streamId);
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await event.wait(Math.min(CROSS_REPLICA_POLL_S, remaining / 1000) * 1000, signal);
    signal?.throwIfAborted();
    job = await jobGet(streamId);
    if (job === null || isCurrentSource(job) || job.failed) break;
    // A local attempt may have finished after losing its lease or failing to
    // persist. Subsequent waits should poll at the normal interval, not spin.
    event.clear();
  }
  return job?.extracted_url && !isCurrentSource(job) ? { ...job, extracted_url: null, failed: false } : job;
}

function isCurrentSource(job: StreamJob): boolean {
  return Boolean(job.extracted_url) && job.validation_version === STREAM_VALIDATION_VERSION;
}

/**
 * Validate a resolver capability ("<coreId>.<secret>") and wait for its job.
 * Malformed tokens, unknown ids and wrong secrets all return null — the
 * resolver answers them identically, so job existence is not observable. The
 * secret is checked before the extraction wait, so forged tokens 404
 * immediately instead of holding the connection for the full timeout.
 */
export async function awaitStreamJob(
  capability: string,
  timeout = AWAIT_TIMEOUT_S,
  signal?: AbortSignal,
): Promise<{ streamId: string; job: StreamJob } | null> {
  signal?.throwIfAborted();
  const parsed = parseStreamCapability(capability);
  if (!parsed) return null;
  const known = await jobGet(parsed.streamId);
  signal?.throwIfAborted();
  if (known === null || known.secret !== parsed.secret) return null;
  if ((!known.extracted_url && !known.failed) || (known.extracted_url && !isCurrentSource(known))) {
    // Reuse live leases, recover abandoned work, or migrate an old source.
    // All three preserve the issued capability secret.
    const activeLease = await redis().get(leaseKey(parsed.streamId));
    signal?.throwIfAborted();
    if (!activeLease) await ensureStreamJob(known.url, known.mode);
  }
  const job = await awaitExtracted(parsed.streamId, timeout, signal);
  if (job === null || job.secret !== parsed.secret) return null;
  return { streamId: parsed.streamId, job };
}

/**
 * Drop a revoked stream URL and re-extract it. Clear the cache and pending job
 * before extraction, and carry the rejected route into recovery so a fresh
 * signed URL does not repeat the same failed direct connection or proxy exit.
 */
export async function refreshStreamUrl(
  streamId: string,
  job: StreamJob,
  timeout = AWAIT_TIMEOUT_S,
  signal?: AbortSignal,
): Promise<StreamJob | null> {
  signal?.throwIfAborted();
  const deadline = Date.now() + Math.max(0, timeout) * 1000;
  const { url, mode } = job;
  if (!url || !mode) return null;
  const deadUrl = job.extracted_url;
  if (deadUrl) invalidateMediaProbe(deadUrl, job.proxy_url);
  // Re-extractions keep the capability secret so the resolver URL issued for
  // the original job keeps working across refreshes.
  const secret = job.secret ?? newStreamSecret();

  // Redis owns refresh serialization across both local and remote callers.
  {
    // Redis decides ownership and checks the rejected URL. A replica's five-
    // second completion memo can still contain the pre-refresh result.
    const [raw, owner] = await redis().eval(
      REFRESH_JOB_SCRIPT, 2, jobKey(streamId), leaseKey(streamId),
      newStreamSecret(), secret, JSON.stringify(deadUrl), EXTRACTION_LEASE_TTL_S, STREAM_TTL,
    ) as [string, string];
    if (!raw) return null;
    const current = JSON.parse(raw) as StreamJob;
    if (current.extracted_url || current.failed) {
      jobPublishLocal(streamId, current);
      return current;
    }
    jobForgetLocal(streamId);

    if (owner) {
      try {
        await invalidate(url, mode === 'video' ? 'video:' : 'audio:');
      } catch (e) {
        log.error(`[STREAM_PROXY] Cache invalidation failed for ${streamId}: ${String(e)}`);
      }
      startBackgroundExtraction(streamId, url, mode, current.secret!, owner, {
        forceProxy: true,
        excludeProxyUrl: job.proxy_url ?? null,
      });
    }
    return awaitExtracted(streamId, Math.max(0, deadline - Date.now()) / 1000, signal);
  }
}

/** Test hook — drop all in-process job state. */
export function resetJobState(): void {
  JOB_MEMO.clear();
  JOB_EVENTS.clear();
}
