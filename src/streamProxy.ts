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
import net from 'node:net';
import tls from 'node:tls';
import { Readable, PassThrough, type Duplex } from 'node:stream';
import { getLogger } from './logger.js';
import { isSafeProxyUrlSync, isPublicHost } from './urlValidation.js';
import { websharePool } from './proxy.js';
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
  error?: {
    error: string;
    message?: string;
    /** The Webshare proxy refused the dial (e.g. 407 replaced proxy). */
    proxyRefused?: boolean;
    /** The pinned exit is dead/slow (refusal or connect stall) — safe to re-extract through a fresh one. */
    retriable?: boolean;
  };
}

export interface ProxyOptions {
  rangeHeader?: string | null;
  userAgent?: string | null;
  /** Epoch milliseconds when the client request started (for TTFB). */
  startedMs?: number;
  /** Cancel pending dials and the body when the player disconnects. */
  signal?: AbortSignal;
  /**
   * HTTP proxy URL (with credentials) the target is reachable through — set
   * for geo-bypass streams whose googlevideo URL is IP-locked to the proxy
   * exit that resolved it. HTTPS targets are tunneled via CONNECT.
   */
  proxyUrl?: string | null;
}

// ── HTTP-proxy tunneling (geo-bypass streams) ──────────────────────

interface ParsedProxy {
  host: string;
  port: number;
  /** Pre-rendered Proxy-Authorization header value, or null. */
  authHeader: string | null;
}

interface TunnelOptions extends http.RequestOptions {
  tunnelSignal?: AbortSignal;
}

// These Agent hooks exist in Node, but are not exposed by @types/node.
const agentHooks = https.Agent.prototype as unknown as {
  addRequest(req: http.ClientRequest, options: TunnelOptions): void;
  createSocket(
    req: http.ClientRequest,
    options: TunnelOptions,
    callback: (err: Error | null, socket?: Duplex) => void,
  ): void;
};

function parseProxy(proxyUrl: string): ParsedProxy | null {
  if (!isSafeProxyUrlSync(proxyUrl)) return null;
  try {
    const parsed = new URL(proxyUrl);
    const user = decodeURIComponent(parsed.username);
    const pass = decodeURIComponent(parsed.password);
    const authHeader = user
      ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
      : null;
    return { host: parsed.hostname, port: Number(parsed.port || 80), authHeader };
  } catch {
    return null;
  }
}

/**
 * https.Agent that reaches its targets through an HTTP proxy: establishes a
 * CONNECT tunnel to host:port, then layers TLS over the tunnel. googlevideo
 * URLs resolved through a Webshare proxy only play from that proxy's exit IP,
 * so proxied streams must dial back through it.
 */
class TunnelAgent extends https.Agent {
  private readonly signals = new WeakMap<http.ClientRequest, AbortSignal>();

  constructor(private readonly proxy: ParsedProxy) {
    super({ keepAlive: true, maxSockets: 16 });
  }

  addRequest(req: http.ClientRequest, options: TunnelOptions): void {
    if (options.tunnelSignal) this.signals.set(req, options.tunnelSignal);
    agentHooks.addRequest.call(this, req, options);
  }

  createSocket(
    req: http.ClientRequest,
    options: TunnelOptions,
    callback: (err: Error | null, socket?: Duplex) => void,
  ): void {
    // A queued request can inherit connection options from the previous
    // socket. Always recover its own signal rather than that socket's signal.
    agentHooks.createSocket.call(this, req, { ...options, tunnelSignal: this.signals.get(req) }, callback);
  }

  override createConnection(
    options: TunnelOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const cb = callback
      ? (err: Error | null, stream?: Duplex) => {
          callback(err, stream!);
        }
      : null;
    if (!cb) return null;
    const host = typeof options.host === 'string' ? options.host : '';
    const port = Number(options.port ?? 443);
    if (!host) {
      cb(new Error('tunnel: missing target host'));
      return null;
    }

    const proxySocket = net.connect({ host: this.proxy.host, port: this.proxy.port });
    let settled = false;
    let onData: ((chunk: Buffer) => void) | undefined;
    const onClose = () => fail(new Error('tunnel: proxy closed connection early'));
    const onAbort = () => fail(new Error('tunnel: request cancelled'));
    // Bound the entire CONNECT exchange, including proxies that accept TCP
    // and then never send their response headers.
    const timer = setTimeout(() => fail(new Error('tunnel: proxy connect timeout')), CONNECT_TIMEOUT_MS);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      options.tunnelSignal?.removeEventListener('abort', onAbort);
      proxySocket.off('error', fail);
      proxySocket.off('close', onClose);
      if (onData) proxySocket.off('data', onData);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      proxySocket.destroy();
      cb(err);
    };
    proxySocket.once('error', fail);
    proxySocket.once('close', onClose);
    options.tunnelSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.tunnelSignal?.aborted) {
      onAbort();
      return undefined;
    }

    proxySocket.once('connect', () => {
      let head = '';
      onData = (chunk: Buffer): void => {
        head += chunk.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) {
          if (head.length > 16 * 1024) {
            fail(new Error('tunnel: oversized proxy response'));
          }
          return;
        }
        const statusLine = head.slice(0, head.indexOf('\r\n'));
        const statusCode = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);
        if (statusCode !== 200) {
          if (statusCode === 407) {
            // no_proxies_allocated: Webshare replaced this proxy; the cached
            // address (and often credentials) is dead until the list refreshes.
            fail(new Error('tunnel: proxy no longer allocated (HTTP 407)'));
            return;
          }
          fail(new Error(`tunnel: proxy refused CONNECT (HTTP ${statusCode || '?'})`));
          return;
        }
        settled = true;
        cleanup();
        // Bytes past the header (if any) belong to the TLS stream.
        const leftover = head.slice(end + 4);
        if (leftover) proxySocket.unshift(Buffer.from(leftover, 'latin1'));
        const servername =
          typeof (options as { servername?: unknown }).servername === 'string'
            ? (options as { servername: string }).servername
            : host;
        cb(null, tls.connect({ socket: proxySocket, servername }));
      };
      proxySocket.on('data', onData);

      let request = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (this.proxy.authHeader) request += `Proxy-Authorization: ${this.proxy.authHeader}\r\n`;
      request += '\r\n';
      proxySocket.write(request);
    });
    return undefined;
  }
}

// One agent per proxy exit so keep-alive tunnels are reused across streams.
const TUNNEL_AGENTS = new Map<string, https.Agent>();
const TUNNEL_AGENT_MAX = 8;

function tunnelAgentFor(proxy: ParsedProxy): https.Agent {
  const key = `${proxy.host}:${proxy.port}`;
  const existing = TUNNEL_AGENTS.get(key);
  if (existing) return existing;
  const agent = new TunnelAgent(proxy);
  if (TUNNEL_AGENTS.size >= TUNNEL_AGENT_MAX) {
    const oldestKey = TUNNEL_AGENTS.keys().next().value;
    if (oldestKey !== undefined) {
      TUNNEL_AGENTS.get(oldestKey)?.destroy();
      TUNNEL_AGENTS.delete(oldestKey);
    }
  }
  TUNNEL_AGENTS.set(key, agent);
  return agent;
}

const MAX_REDIRECTS = 5;

function cancelledResult(): ProxyUpstream {
  return {
    status: 499,
    headers: { 'content-type': 'application/json' },
    body: null,
    error: { error: 'Client Closed Request' },
  };
}

export function proxyStream(
  targetUrl: string,
  opts: ProxyOptions = {},
  redirectCount = 0,
): Promise<ProxyUpstream> {
  if (opts.signal?.aborted) return Promise.resolve(cancelledResult());
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.resolve({
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: null,
      error: { error: 'Bad Gateway', message: 'Too many redirects from stream source' },
    });
  }

  const startedMs = opts.startedMs ?? Date.now();

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return Promise.resolve({
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: null,
      error: { error: 'Bad Gateway', message: `Invalid upstream URL: ${String(e)}` },
    });
  }

  // SSRF guard: the stream dial is server-side — only public http/https
  // hosts are reachable, whatever the upstream URL claims to be.
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(cancelledResult());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    void isPublicHost(parsed.hostname).then((hostOk) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) return;
      if (!hostOk || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        log.error(`[STREAM_PROXY] upstream host rejected by safety check: ${parsed.hostname}`);
        resolve({
          status: 502,
          headers: { 'content-type': 'application/json' },
          body: null,
          error: { error: 'Bad Gateway', message: 'Upstream host is not a permitted public address' },
        });
        return;
      }
      resolve(dialStream(parsed, opts, startedMs, redirectCount));
    }, (err: unknown) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (!cancelled) reject(err);
    });
  });
}

function dialStream(
  parsed: URL,
  opts: ProxyOptions,
  startedMs: number,
  redirectCount = 0,
): Promise<ProxyUpstream> {
  return new Promise<ProxyUpstream>((resolve) => {
    const proxy = opts.proxyUrl ? parseProxy(opts.proxyUrl) : null;
    if (opts.proxyUrl && !proxy) {
      log.error('[STREAM_PROXY] invalid proxy URL — refusing to dial');
      resolve({
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: null,
        error: { error: 'Bad Gateway', message: 'Invalid proxy configuration' },
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
    const tunnelController = new AbortController();
    let upstreamBody: http.IncomingMessage | undefined;
    let out: PassThrough | undefined;
    let headersReceived = false;
    let first = true;
    let active = false;
    let finished = false;
    let cancelled = false;
    let req: http.ClientRequest;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup(): void {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      req.off('timeout', onReadTimeout);
      req.setTimeout(0);
      upstreamBody?.off('data', onData);
      upstreamBody?.off('end', onEnd);
      out?.off('close', onOutputClose);
      if (active) metrics.streamFinished();
    }

    function stopUpstream(): void {
      if (out) upstreamBody?.unpipe(out);
      upstreamBody?.destroy();
      req.destroy();
      tunnelController.abort();
    }

    function onAbort(): void {
      if (finished) return;
      cancelled = true;
      cleanup();
      stopUpstream();
      out?.destroy();
      resolve(cancelledResult());
    }

    function onOutputClose(): void {
      if (finished) return;
      cleanup();
      stopUpstream();
    }

    function onData(chunk: Buffer): void {
      if (first) {
        metrics.recordStreamTtfb((Date.now() - startedMs) / 1000);
        first = false;
      }
      metrics.recordStreamBytes(chunk.length);
    }

    function onEnd(): void {
      // Let pipe end the output normally. Destroying the completed request
      // here would discard a healthy keep-alive connection.
      cleanup();
    }

    function onUpstreamError(err: Error): void {
      if (finished) return;
      metrics.recordStreamError('transfer');
      log.debug(`[STREAM_PROXY] Stream disconnected: ${String(err)}`);
      cleanup();
      stopUpstream();
      out?.destroy(err);
    }

    function onUpstreamClose(): void {
      upstreamBody?.off('error', onUpstreamError);
      if (!finished) onUpstreamError(new Error('upstream closed before stream completed'));
    }

    function onReadTimeout(): void {
      req.destroy(new Error('read timeout'));
    }

    if (proxy && isHttps) {
      const requestOptions: TunnelOptions = {
        method: 'GET', headers, agent: tunnelAgentFor(proxy), tunnelSignal: tunnelController.signal,
      };
      req = https.request(parsed, requestOptions, (upstream) => {
        void handleUpstream(upstream);
      });
    } else if (proxy) {
      // Plain-HTTP target through a forward proxy: absolute-form request line.
      const viaProxyHeaders: Record<string, string> = { ...headers, host: parsed.host };
      if (proxy.authHeader) viaProxyHeaders['proxy-authorization'] = proxy.authHeader;
      req = http.request(
        { host: proxy.host, port: proxy.port, path: parsed.href, method: 'GET', headers: viaProxyHeaders },
        (upstream) => {
          void handleUpstream(upstream);
        },
      );
    } else {
      req = transport.request(parsed, { method: 'GET', headers }, (upstream) => {
        void handleUpstream(upstream);
      });
    }

    // Construct the request before starting its timer: header validation can
    // throw synchronously, leaving no request for a timeout to destroy.
    connectTimer = setTimeout(() => {
      req.destroy(new Error('connect timeout'));
      tunnelController.abort();
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref();

    function handleUpstream(upstream: http.IncomingMessage): void {
      if (finished) {
        upstream.destroy();
        return;
      }
      headersReceived = true;
      clearTimeout(connectTimer);
      metrics.recordUpstreamConnect((Date.now() - connectStarted) / 1000);

      const status = upstream.statusCode ?? 502;

      // Handle HTTP redirects (301, 302, 303, 307, 308).
      // Googlevideo frequently issues 302 redirects to specific edge CDN clusters (rr*.googlevideo.com).
      // node:http does not follow them automatically, so we must follow them here.
      if ([301, 302, 303, 307, 308].includes(status) && upstream.headers.location) {
        log.info(`[STREAM_PROXY] Upstream ${status} redirect to: ${upstream.headers.location.slice(0, 100)}`);
        cleanup();
        upstream.destroy();
        req.destroy();
        try {
          const nextUrl = new URL(upstream.headers.location, parsed).href;
          resolve(proxyStream(nextUrl, opts, redirectCount + 1));
        } catch (e) {
          resolve({
            status: 502,
            headers: { 'content-type': 'application/json' },
            body: null,
            error: { error: 'Bad Gateway', message: `Invalid redirect location: ${String(e)}` },
          });
        }
        return;
      }

      if (status >= 400) {
        metrics.recordStreamError(status);
        log.error(`[STREAM_PROXY] upstream ${status} (expired or IP-locked URL)`);
        cleanup();
        upstream.destroy();
        req.destroy();
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
      upstreamBody = upstream;
      out = new PassThrough();
      // A source can fail in the same packet as its headers, before the
      // awaiting caller can attach its own error handler. Retain the error on
      // the stream without letting that handoff window crash the process.
      out.on('error', () => {});
      active = true;
      metrics.streamStarted();
      upstream.on('data', onData);
      upstream.once('end', onEnd);
      upstream.once('close', onUpstreamClose);
      upstream.on('error', onUpstreamError);
      out.once('close', onOutputClose);
      req.setTimeout(READ_TIMEOUT_MS);
      upstream.pipe(out);

      resolve({ status, headers: respHeaders, body: out });
    }

    // Request-owned timeout listeners are removed at completion, rather than
    // accumulating on sockets reused by the keep-alive agent.
    req.on('timeout', onReadTimeout);
    req.on('error', (e) => {
      if (cancelled || finished) return;
      if (headersReceived) {
        onUpstreamError(e);
        return;
      }
      cleanup();
      tunnelController.abort();
      metrics.recordUpstreamConnect((Date.now() - connectStarted) / 1000);
      metrics.recordStreamError('connect');
      log.error(`[STREAM_PROXY] Upstream connection error: ${String(e)}`);
      const msg = String(e);
      const refused = isHttps && Boolean(proxy) && /no longer allocated|HTTP 407/i.test(msg);
      // A connect/tunnel timeout or reset through a pinned exit means the exit
      // is dead or too slow, not that the URL is gone: evict it so the caller
      // can re-extract through a fresh exit, same recovery as a 407 refusal.
      const proxyStalled =
        Boolean(proxy) &&
        /connect timeout|tunnel: |ECONNRESET|ETIMEDOUT|EHOSTUNREACH|socket hang up/i.test(msg);
      if ((refused || proxyStalled) && opts.proxyUrl) {
        void websharePool.evictByUrl(opts.proxyUrl);
      }
      resolve({
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: null,
        error: {
          error: 'Bad Gateway',
          message: `Failed to connect to stream source: ${msg}`,
          ...(refused ? { proxyRefused: true } : {}),
          ...(refused || proxyStalled ? { retriable: true } : {}),
        },
      });
    });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    req.end();
  });
}

export { CHUNK };
