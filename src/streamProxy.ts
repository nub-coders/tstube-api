/**
 * Byte-proxy for googlevideo URLs — port of utils/stream_proxy.py.
 *
 * googlevideo signs the extracting host's IP into the URL, so a link resolved
 * here plays only from here. This proxies the bytes so any client can play it;
 * `Range` is forwarded both ways so players can seek.
 *
 * Uses node:http (not fetch) on purpose: undici would transparently decompress
 * a gzip body while we forward `content-length` verbatim, corrupting the
 * stream. Raw bytes only, exactly like httpx `aiter_raw`.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable, PassThrough } from 'node:stream';
import { getLogger } from './logger.js';
import * as metrics from './metrics.js';

const log = getLogger('ytube_api.proxy');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Only headers a media player needs; hop-by-hop ones must not be copied.
// `content-encoding` is included because we forward the body verbatim.
const PASS_THROUGH = [
  'content-type',
  'content-length',
  'content-range',
  'content-encoding',
  'accept-ranges',
  'content-disposition',
  'cache-control',
] as const;

const CHUNK = 128 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 120_000;

export interface ProxyUpstream {
  /** Upstream status, mirrored to the client (403/404/410/... are meaningful). */
  status: number;
  headers: Record<string, string>;
  /** Instrumented body stream, or null when the response is a JSON error. */
  body: Readable | null;
  /** Present for proxy-generated errors (502, connect failure). */
  error?: { error: string; message?: string };
}

export interface ProxyOptions {
  rangeHeader?: string | null;
  userAgent?: string | null;
  /** Epoch milliseconds when the client request started (for TTFB). */
  startedMs?: number;
}

export function proxyStream(targetUrl: string, opts: ProxyOptions = {}): Promise<ProxyUpstream> {
  const startedMs = opts.startedMs ?? Date.now();

  return new Promise<ProxyUpstream>((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      resolve({
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: null,
        error: { error: 'Bad Gateway', message: `Invalid upstream URL: ${String(e)}` },
      });
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers: Record<string, string> = {
      'user-agent': opts.userAgent || DEFAULT_UA,
      // Never let the transport negotiate a transfer encoding it would decode.
      'accept-encoding': 'identity',
    };
    if (opts.rangeHeader) headers.range = opts.rangeHeader;

    const connectStarted = Date.now();
    const req = transport.request(
      parsed,
      { method: 'GET', headers },
      (upstream) => {
        metrics.recordUpstreamConnect((Date.now() - connectStarted) / 1000);

        const status = upstream.statusCode ?? 502;
        if (status >= 400) {
          metrics.recordStreamError(status);
          log.error(`[STREAM_PROXY] upstream ${status} (expired or IP-locked URL)`);
          upstream.resume(); // drain
          upstream.destroy();
          resolve({
            status,
            headers: { 'content-type': 'application/json' },
            body: null,
            error: { error: `Upstream returned HTTP ${status}` },
          });
          return;
        }

        const respHeaders: Record<string, string> = {};
        for (const h of PASS_THROUGH) {
          const v = upstream.headers[h];
          if (v !== undefined) respHeaders[h] = Array.isArray(v) ? v.join(', ') : v;
        }
        if (respHeaders['accept-ranges'] === undefined) respHeaders['accept-ranges'] = 'bytes';

        // Instrument the body: TTFB on first chunk, byte counter, active gauge.
        const out = new PassThrough();
        let first = true;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          metrics.streamFinished();
        };
        metrics.streamStarted();
        upstream.on('data', (chunk: Buffer) => {
          if (first) {
            metrics.recordStreamTtfb((Date.now() - startedMs) / 1000);
            first = false;
          }
          metrics.recordStreamBytes(chunk.length);
        });
        upstream.on('end', finish);
        upstream.on('close', finish);
        upstream.on('error', (err) => {
          metrics.recordStreamError('transfer');
          log.debug(`[STREAM_PROXY] Stream disconnected: ${String(err)}`);
          finish();
          out.destroy(err);
        });
        upstream.pipe(out);

        resolve({ status, headers: respHeaders, body: out });
      },
    );

    req.setTimeout(CONNECT_TIMEOUT_MS, () => {
      req.destroy(new Error('connect timeout'));
    });
    // After headers, allow long body reads but bound a dead socket.
    req.on('socket', (socket) => {
      socket.setTimeout(READ_TIMEOUT_MS, () => {
        socket.destroy(new Error('read timeout'));
      });
    });
    req.on('error', (e) => {
      metrics.recordUpstreamConnect((Date.now() - connectStarted) / 1000);
      metrics.recordStreamError('connect');
      log.error(`[STREAM_PROXY] Upstream connection error: ${String(e)}`);
      resolve({
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: null,
        error: {
          error: 'Bad Gateway',
          message: `Failed to connect to stream source: ${String(e)}`,
        },
      });
    });
    req.end();
  });
}

export { CHUNK };
