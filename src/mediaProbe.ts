import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { BoundedCache } from './boundedCache.js';
import { requestDeadline, requestSignal } from './requestDeadline.js';
import { proxyStream } from './streamProxy.js';

export const MEDIA_PROBE_BYTES = 16 * 1024;
export const MEDIA_PROBE_TIMEOUT_MS = 5_000;
export const MEDIA_PROBE_CONCURRENCY = 4;
const MAX_PENDING = 64;
const SUCCESS_TTL_MS = 5 * 60_000;
const successes = new BoundedCache<number>(2048, SUCCESS_TTL_MS / 1000);

interface ProbeTask {
  controller: AbortController;
  promise: Promise<boolean>;
  waiters: number;
  settled: boolean;
}
const pending = new Map<string, ProbeTask>();
const queue = new Set<() => void>();
let active = 0;

function keyFor(url: string, proxyUrl?: string | null): string {
  // Include credentials and protocol: these can select different egress IPs.
  return createHash('sha256').update(JSON.stringify([url, proxyUrl || null])).digest('hex');
}

function acquire(signal: AbortSignal, expires: number): Promise<(() => void) | null> {
  return new Promise(resolve => {
    const cancelled = () => {
      queue.delete(start);
      signal.removeEventListener('abort', cancelled);
      resolve(null);
    };
    const start = () => {
      queue.delete(start);
      signal.removeEventListener('abort', cancelled);
      if (signal.aborted || Date.now() >= expires) { resolve(null); return; }
      active++;
      resolve(() => {
        active--;
        while (active < MEDIA_PROBE_CONCURRENCY && queue.size) queue.values().next().value!();
      });
    };
    if (signal.aborted || Date.now() >= expires) { resolve(null); return; }
    if (active < MEDIA_PROBE_CONCURRENCY) start();
    else {
      queue.add(start);
      signal.addEventListener('abort', cancelled, { once: true });
    }
  });
}

/** Retain at most the requested prefix, even if the origin ignores Range. */
function readPrefix(body: Readable, signal: AbortSignal): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      body.off('data', data).off('end', end).off('error', fail).off('close', fail);
      signal.removeEventListener('abort', fail);
      body.destroy();
      resolve(ok && length ? Buffer.concat(chunks, length) : null);
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const part = bytes.subarray(0, MEDIA_PROBE_BYTES - length);
      chunks.push(Buffer.from(part));
      length += part.length;
      if (length === MEDIA_PROBE_BYTES) finish(true);
    };
    const end = () => finish(true);
    const fail = () => finish(false);
    if (signal.aborted || body.destroyed) { finish(false); return; }
    body.on('data', data).once('end', end).once('error', fail).once('close', fail);
    signal.addEventListener('abort', fail, { once: true });
  });
}

function isHls(bytes: Buffer): boolean {
  const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  // A bounded prefix may end halfway through a URI or tag.
  if (bytes.length === MEDIA_PROBE_BYTES) lines.pop();
  if (lines.shift()?.trim() !== '#EXTM3U') return false;
  let expectsUri = false;
  const targetDuration = lines.some(line => /^#EXT-X-TARGETDURATION:\s*[1-9]\d*\s*$/.test(line.trim()));
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#EXT-X-STREAM-INF:.+/.test(line) || (targetDuration && /^#EXTINF:\s*\d+(?:\.\d+)?\s*,/.test(line))) {
      expectsUri = true;
    } else if (line && !line.startsWith('#') && expectsUri) {
      try {
        return ['https:', 'http:'].includes(new URL(line, 'https://media.invalid/').protocol);
      } catch { return false; }
    }
  }
  return false;
}

/** Header/signature check only; this does not decode or play the sample. */
function isMedia(bytes: Buffer, mime: string): boolean {
  const hlsMime = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(mime);
  if (isHls(bytes)) return hlsMime || !mime || mime === 'text/plain' || mime === 'application/octet-stream';
  if (hlsMime || (mime && !/^(audio|video)\//.test(mime) && !['application/octet-stream', 'application/ogg', 'application/mp4'].includes(mime))) return false;
  if (bytes.length < 12) return false;
  const magic = bytes.toString('ascii', 0, 4);
  const box = bytes.toString('ascii', 4, 8);
  if (['ftyp', 'styp'].includes(box) && bytes.readUInt32BE(0) >= 16 && bytes.length >= 16) return true;
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return true; // WebM/Matroska EBML
  if (magic === 'OggS' && bytes.length >= 27 && bytes[4] === 0) return true;
  if (magic === 'fLaC') return true;
  if (magic === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return true;
  if (bytes.toString('ascii', 0, 3) === 'ID3' && bytes[3] >= 2 && bytes[3] <= 4 && bytes.subarray(6, 10).every(b => b < 128)) return true;
  // MPEG audio frame or ADTS AAC sync word, excluding reserved header values.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const mpeg = (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0 &&
      (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0xf0) !== 0 && (bytes[2] & 0x0c) !== 0x0c;
    const adts = (bytes[1] & 0xf6) === 0xf0 && ((bytes[2] >> 2) & 0x0f) < 13;
    if (mpeg || adts) return true;
  }
  return bytes.length >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47; // MPEG-TS
}

async function checkSample(url: string, proxyUrl: string | null | undefined, signal: AbortSignal, rangeHeader: string | null): Promise<boolean> {
  let body: Readable | null = null;
  try {
    if (signal.aborted) return false;
    const response = await proxyStream(url, { proxyUrl, rangeHeader, signal });
    body = response.body;
    if (signal.aborted || !body || response.error || ![200, 206].includes(response.status)) return false;
    const encoding = response.headers['content-encoding']?.trim().toLowerCase();
    if (encoding && encoding !== 'identity') return false;
    let expected: number | undefined;
    if (response.status === 206) {
      const range = /^bytes 0-(\d+)\/(\d+|\*)$/i.exec(response.headers['content-range'] ?? '');
      if (!range) return false;
      const end = Number(range[1]);
      if (!Number.isSafeInteger(end) || end >= MEDIA_PROBE_BYTES || (range[2] !== '*' && Number(range[2]) <= end)) return false;
      expected = end + 1;
    }
    const length = response.headers['content-length'];
    if (length !== undefined) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) <= 0) return false;
      if (expected !== undefined && expected !== Number(length)) return false;
      expected = Math.min(Number(length), MEDIA_PROBE_BYTES);
    }
    const bytes = await readPrefix(body, signal);
    return !signal.aborted && !!bytes && (expected === undefined || bytes.length === expected) &&
      isMedia(bytes, (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase());
  } catch {
    return false;
  } finally {
    body?.destroy();
  }
}

async function check(url: string, proxyUrl: string | null | undefined, signal: AbortSignal, expires: number): Promise<boolean> {
  const release = await acquire(signal, expires);
  if (!release) return false;
  try {
    const host = new URL(url).hostname;
    if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) {
      // A successful tiny range does not establish normal playback: some
      // signed CDN URLs serve that range but deny ordinary GETs with 403/404.
      // Match the resolver's ordinary GET first, with the same bounded read.
      if (!await checkSample(url, proxyUrl, signal, null)) return false;
    }
    return await checkSample(url, proxyUrl, signal, `bytes=0-${MEDIA_PROBE_BYTES - 1}`);
  } catch {
    return false;
  } finally {
    release();
  }
}

/** Forget both a successful check and any check still in flight for this route. */
export function invalidateMediaProbe(url: string, proxyUrl?: string | null): void {
  const key = keyFor(url, proxyUrl);
  successes.delete(key);
  const task = pending.get(key);
  pending.delete(key);
  task?.controller.abort();
}

export function probeMedia(
  url: string,
  options: { proxyUrl?: string | null; signal?: AbortSignal; deadline?: number } = {},
): Promise<boolean> {
  const parent = requestSignal();
  const signal = options.signal && parent ? AbortSignal.any([options.signal, parent]) : options.signal ?? parent;
  const deadline = Math.min(options.deadline ?? Infinity, requestDeadline());
  if (signal?.aborted || deadline <= Date.now()) return Promise.resolve(false);
  const key = keyFor(url, options.proxyUrl);
  if ((successes.get(key) ?? 0) > Date.now()) return Promise.resolve(true);
  let task = pending.get(key);
  if (!task) {
    if (pending.size >= MAX_PENDING) return Promise.resolve(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_PROBE_TIMEOUT_MS);
    task = { controller, waiters: 0, settled: false, promise: Promise.resolve(false) };
    const current = task;
    pending.set(key, current);
    // Only the explicit shared signal owns the transport. A caller leaving its
    // request scope must not cancel another caller's coalesced probe.
    current.promise = check(url, options.proxyUrl, controller.signal, Date.now() + MEDIA_PROBE_TIMEOUT_MS).then(ok => {
      const usable = ok && !controller.signal.aborted && pending.get(key) === current;
      if (usable && current.waiters) {
        let expires = Date.now() + SUCCESS_TTL_MS;
        try {
          const signedExpiry = Number(new URL(url).searchParams.get('expire')) * 1000;
          if (signedExpiry > 0) expires = Math.min(expires, signedExpiry);
        } catch { /* proxyStream already validates the target */ }
        successes.set(key, expires);
      }
      return usable;
    }).finally(() => {
      current.settled = true;
      clearTimeout(timer);
      controller.abort();
      if (pending.get(key) === current) pending.delete(key);
    });
  }
  const current = task;
  current.waiters++;
  return new Promise(resolve => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      if (--current.waiters === 0 && !current.settled) {
        if (pending.get(key) === current) pending.delete(key);
        current.controller.abort();
      }
      resolve(ok);
    };
    const cancelled = () => finish(false);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (Number.isFinite(deadline)) timer = setTimeout(cancelled, Math.max(0, deadline - Date.now()));
    void current.promise.then(finish, cancelled);
    if (signal?.aborted) cancelled();
  });
}
