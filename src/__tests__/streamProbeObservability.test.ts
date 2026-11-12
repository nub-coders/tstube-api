import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createCipheriv } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  publicHost: true,
  logs: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  evict: vi.fn(async () => true),
  store: new Map<string, string>(),
}));
vi.mock('../logger.js', () => ({ getLogger: () => state.logs }));
vi.mock('../urlValidation.js', async original => ({
  ...await original<typeof import('../urlValidation.js')>(),
  isPublicHost: async () => state.publicHost,
  isSafeProxyUrlSync: () => true,
}));
vi.mock('../proxy.js', () => ({ websharePool: { evictByUrl: state.evict } }));
vi.mock('../redis.js', () => ({ redis: () => ({
  get: async (key: string) => state.store.get(key) ?? null,
  set: async (key: string, value: string) => { state.store.set(key, value); return 'OK'; },
}) }));

import * as metrics from '../metrics.js';
import { probeMedia, MEDIA_PROBE_BYTES } from '../mediaProbe.js';
import { probeHls, proxyHlsManifest } from '../hlsProxy.js';
import { proxyStream, type ProxyOptions, type ProxyUpstream } from '../streamProxy.js';

const probeOptions: ProxyOptions & { purpose: 'probe' } = { purpose: 'probe' };
const mp4 = Buffer.alloc(MEDIA_PROBE_BYTES);
Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex').copy(mp4);
const key = Buffer.alloc(16, 1);
function box(type: string): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(bytes.length);
  bytes.write(type, 4, 'ascii');
  return bytes;
}
function encrypted(bytes: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
const init = encrypted(Buffer.concat([box('ftyp'), box('moov')]));
const segment = encrypted(Buffer.concat([box('moof'), box('mdat')]));
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\n/leaf\n';
const leaf = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n' +
  '#EXT-X-KEY:METHOD=AES-128,URI="/key",IV=0x00000000000000000000000000000000\n' +
  '#EXT-X-MAP:URI="/init"\n#EXTINF:2,\n/segment\n';
let server: http.Server;
let base: string;
const sockets = new Set<Socket>();
const requests: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    requests.push(path);
    if (path.startsWith('/media-redirect')) {
      res.writeHead(302, { location: '/media' }).end();
    } else if (path === '/media') {
      res.writeHead(req.headers.range ? 206 : 200, {
        'content-type': 'audio/mp4', 'content-length': String(mp4.length),
        ...(req.headers.range ? { 'content-range': `bytes 0-${mp4.length - 1}/1000000` } : {}),
      }).end(mp4);
    } else if (path.startsWith('/denied')) {
      res.writeHead(403).end();
    } else if (path === '/master') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(master);
    } else if (path === '/leaf') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(leaf);
    } else if (path === '/dead-master') {
      res.writeHead(200).end(master.replace('/leaf', '/denied-child'));
    } else if (path === '/key' || path === '/init' || path === '/segment') {
      const bytes = path === '/key' ? key : path === '/init' ? init : segment;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }).end(bytes);
    } else if (path === '/stall') {
      res.writeHead(200, { 'content-type': 'audio/mp4' }).write(mp4.subarray(0, 24));
    } else if (path === '/broken') {
      res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': String(mp4.length) });
      res.write(mp4.subarray(0, 24));
      setImmediate(() => res.destroy());
    } else res.writeHead(404).end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  metrics.resetMetrics();
  vi.clearAllMocks();
  state.publicHost = true;
  state.store.clear();
  requests.length = 0;
});
function metric(name: string): number {
  const line = metrics.render().split('\n').find(value => value.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : 0;
}
function playbackMetrics(): Record<string, number> {
  return Object.fromEntries([
    'stream_bytes_total', 'stream_active', 'stream_ttfb_seconds_count',
    'stream_upstream_connect_seconds_count', 'stream_upstream_connect_slow_total',
    'stream_errors_total{code="403"}', 'stream_errors_total{code="connect"}', 'stream_errors_total{code="transfer"}',
  ].map(name => [name, metric(name)]));
}
async function consume(upstream: ProxyUpstream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (upstream.body) for await (const chunk of upstream.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

it('keeps successful redirected media validation out of playback telemetry', async () => {
  const before = playbackMetrics();
  expect(await probeMedia(`${base}/media-redirect?probe=success`)).toBe(true);
  expect(requests).toEqual(['/media-redirect?probe=success', '/media']);
  expect(playbackMetrics()).toEqual(before);
});

it('classifies both Googlevideo ordinary GET and range verification as probes', async () => {
  const before = playbackMetrics();
  const lookup = http.globalAgent.options.lookup;
  http.globalAgent.options.lookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  }) as typeof lookup;
  try {
    expect(await probeMedia(base.replace('127.0.0.1', 'rr1.googlevideo.com') + '/media')).toBe(true);
    expect(requests).toEqual(['/media', '/media']);
    expect(playbackMetrics()).toEqual(before);
  } finally {
    http.globalAgent.options.lookup = lookup;
  }
});

it('records rejected media validation separately and logs bounded probe context', async () => {
  const before = playbackMetrics();
  expect(await probeMedia(`${base}/denied?signature=private`)).toBe(false);
  expect(playbackMetrics()).toEqual(before);
  expect(metric('stream_probe_errors_total{code="403"}')).toBe(1);
  expect(state.logs.error).not.toHaveBeenCalled();
  expect(state.logs.debug).toHaveBeenCalledWith('[STREAM_PROBE] upstream rejected validation probe', {
    purpose: 'probe', status: 403, host: '127.0.0.1', range: true, proxied: false,
  });
  expect(JSON.stringify(state.logs.debug.mock.calls)).not.toContain('private');
});

it('preserves playback byte, connect, first-byte, and error reporting by default', async () => {
  expect(await consume(await proxyStream(`${base}/media`))).toEqual(mp4);
  expect(metric('stream_bytes_total')).toBe(mp4.length);
  expect(metric('stream_ttfb_seconds_count')).toBe(1);
  expect(metric('stream_upstream_connect_seconds_count')).toBe(1);
  expect(metric('stream_active')).toBe(0);
  expect((await proxyStream(`${base}/denied-playback`)).status).toBe(403);
  expect(metric('stream_errors_total{code="403"}')).toBe(1);
  expect(metric('stream_probe_errors_total{code="403"}')).toBe(0);
  expect(state.logs.error).toHaveBeenCalledWith('[STREAM_PROXY] upstream 403 (expired or IP-locked URL)');
});

it('propagates probe purpose through HLS master, child playlist, initialization, key, and segment', async () => {
  const before = playbackMetrics();
  expect(await probeHls(`${base}/master`, { mode: 'audio' })).toBe(true);
  expect(requests).toEqual(['/master', '/leaf', '/init', '/key', '/segment']);
  expect(playbackMetrics()).toEqual(before);
});

it('counts only the served HLS root playlist as playback while verifying child resources', async () => {
  const upstream = await proxyHlsManifest(`${base}/master`, {
    mode: 'audio', scope: 'test.scope', childUrl: token => `/stream/proxy/${token}`,
  });
  expect(upstream.status).toBe(200);
  expect((await consume(upstream)).toString()).toContain('hls_');
  expect(requests).toEqual(['/master', '/leaf', '/init', '/key', '/segment']);
  expect(metric('stream_upstream_connect_seconds_count')).toBe(1);
  expect(metric('stream_ttfb_seconds_count')).toBe(1);
  expect(metric('stream_bytes_total')).toBe(Buffer.byteLength(master));
  expect(metric('stream_active')).toBe(0);
});

it('classifies rejected HLS children as probe errors', async () => {
  const before = playbackMetrics();
  expect(await probeHls(`${base}/dead-master`, { mode: 'audio' })).toBe(false);
  expect(requests).toEqual(['/dead-master', '/denied-child']);
  expect(playbackMetrics()).toEqual(before);
  expect(metric('stream_probe_errors_total{code="403"}')).toBe(1);
  expect(state.logs.error).not.toHaveBeenCalled();
});

it('preserves cancellation and host safety checks for probes without playback telemetry', async () => {
  const before = playbackMetrics();
  const controller = new AbortController();
  const upstream = await proxyStream(`${base}/stall`, { ...probeOptions, signal: controller.signal });
  expect(metric('stream_active')).toBe(0);
  controller.abort();
  await vi.waitFor(() => expect(upstream.body?.destroyed).toBe(true));
  state.publicHost = false;
  expect((await proxyStream(`${base}/denied-safety`, probeOptions)).status).toBe(502);
  expect(requests).toEqual(['/stall']);
  expect(playbackMetrics()).toEqual(before);
  expect(state.logs.error).not.toHaveBeenCalled();
});

it('keeps proxy refusal recovery active while classifying the failed dial as a probe', async () => {
  const proxyUrl = base.replace('http://', 'http://fixture:password@');
  const before = playbackMetrics();
  const upstream = await proxyStream('https://media.example.invalid/play', { ...probeOptions, proxyUrl });
  expect(upstream.status).toBe(502);
  expect(upstream.error?.proxyRefused).toBe(true);
  expect(state.evict).toHaveBeenCalledWith(proxyUrl);
  expect(playbackMetrics()).toEqual(before);
  expect(metric('stream_probe_errors_total{code="connect"}')).toBe(1);
  expect(state.logs.error).not.toHaveBeenCalled();
});

it('reports interrupted validation bodies as probe transfer errors', async () => {
  const before = playbackMetrics();
  expect(await probeMedia(`${base}/broken`)).toBe(false);
  expect(playbackMetrics()).toEqual(before);
  expect(metric('stream_probe_errors_total{code="transfer"}')).toBe(1);
  expect(state.logs.error).not.toHaveBeenCalled();
});

it('limits probe error labels to HTTP error statuses and fixed error classes', () => {
  const record = (metrics as unknown as { recordStreamProbeError: (code: string | number) => void }).recordStreamProbeError;
  record(403);
  record('503');
  record('connect');
  record('transfer');
  record('https://private.invalid/signed?token=secret');
  record(200);
  record(999);
  expect(metric('stream_probe_errors_total{code="403"}')).toBe(1);
  expect(metric('stream_probe_errors_total{code="503"}')).toBe(1);
  expect(metric('stream_probe_errors_total{code="connect"}')).toBe(1);
  expect(metric('stream_probe_errors_total{code="transfer"}')).toBe(1);
  expect(metric('stream_probe_errors_total{code="other"}')).toBe(3);
  expect(metrics.render()).not.toMatch(/private\.invalid|secret|code="200"|code="999"/);
});
