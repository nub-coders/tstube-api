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
  constructor(private readonly proxy: ParsedProxy) {
    super({ keepAlive: true, maxSockets: 16 });
  }

  override createConnection(
    options: http.RequestOptions,
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
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      proxySocket.destroy();
      cb(err);
    };
    proxySocket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('tunnel: proxy connect timeout')));
    proxySocket.once('error', fail);
    proxySocket.once('close', () => {
      if (!settled) fail(new Error('tunnel: proxy closed connection early'));
    });

    proxySocket.once('connect', () => {
      proxySocket.setTimeout(0);
      let head = '';
      const onData = (chunk: Buffer): void => {
        head += chunk.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) {
          if (head.length > 16 * 1024) {
            proxySocket.removeListener('data', onData);
            fail(new Error('tunnel: oversized proxy response'));
          }
          return;
        }
        proxySocket.removeListener('data', onData);
        const statusLine = head.slice(0, head.indexOf('\r\n'));
        const statusCode = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);
        if (statusCode !== 200) {
          fail(new Error(`tunnel: proxy refused CONNECT (HTTP ${statusCode || '?'})`));
          return;
        }
        settled = true;
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

export function proxyStream(targetUrl: string, opts: ProxyOptions = {}): Promise<ProxyUpstream> {
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
  return isPublicHost(parsed.hostname).then((hostOk) => {
    if (!hostOk || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      log.error(`[STREAM_PROXY] upstream host rejected by safety check: ${parsed.hostname}`);
      return {
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: null,
        error: { error: 'Bad Gateway', message: 'Upstream host is not a permitted public address' },
      } as ProxyUpstream;
    }
    return dialStream(parsed, opts, startedMs);
  });
}

function dialStream(parsed: URL, opts: ProxyOptions, startedMs: number): Promise<ProxyUpstream> {
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
    let req: http.ClientRequest;
    if (proxy && isHttps) {
      req = https.request(parsed, { method: 'GET', headers, agent: tunnelAgentFor(proxy) }, (upstream) => {
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

    function handleUpstream(upstream: http.IncomingMessage): void {
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
    }

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
