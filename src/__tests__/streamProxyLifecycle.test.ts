import http from 'node:http';
import net from 'node:net';
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  target: '',
  proxyUrl: null as string | null,
  evictByUrl: vi.fn(async () => false),
}));

// Only the network guard and extraction are substituted: all HTTP requests,
// response streams, redirects and CONNECT sockets use real loopback servers.
vi.mock('../urlValidation.js', async importOriginal => ({
  ...await importOriginal<typeof import('../urlValidation.js')>(),
  isPublicHost: async () => true,
  isSafeProxyUrlSync: () => true,
}));
vi.mock('../streamJobs.js', () => ({
  AWAIT_TIMEOUT_S: 105,
  ensureStreamJob: vi.fn(),
  resolveMode: vi.fn(),
  refreshStreamUrl: vi.fn(),
  awaitStreamJob: async () => ({
    streamId: 'loopback',
    job: { url: 'https://youtube.com/watch?v=abcdefghijk', extracted_url: state.target, proxy_url: state.proxyUrl },
  }),
}));
vi.mock('../proxy.js', () => ({ websharePool: { evictByUrl: state.evictByUrl } }));

import { streamResolver } from '../apiRoutes.js';
import { createAppServer } from '../httpServer.js';
import { proxyStream } from '../streamProxy.js';
import * as metrics from '../metrics.js';

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function listen(server: net.Server): Promise<string> {
  servers.push(server);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

async function api(): Promise<string> {
  return `${await listen(createAppServer({ routes: [['/stream/resolver/{stream_id}', streamResolver]] }))}/stream/resolver/loopback.secret`;
}

function get(url: string, options: http.RequestOptions = {}): Promise<{ response: http.IncomingMessage; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, options, response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.once('end', () => resolve({ response, body }));
      response.once('error', reject);
    });
    request.once('error', reject);
  });
}

beforeEach(() => {
  state.target = '';
  state.proxyUrl = null;
  vi.clearAllMocks();
  metrics.resetMetrics();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  // Let errors/aborts caused by teardown finish before resetting metrics for
  // the next test, including request callbacks scheduled by socket closure.
  await new Promise<void>(resolve => setImmediate(resolve));
});

describe('client → API → origin stream lifecycle', () => {
  it('cancels an origin waiting for headers when the client disconnects', async () => {
    const entered = deferred();
    let closed = false;
    state.target = await listen(http.createServer((_request, response) => {
      response.once('close', () => { closed = true; });
      entered.resolve();
    }));
    const request = http.get(await api());
    request.on('error', () => {});
    await entered.promise;
    request.destroy();

    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    expect(metrics.render()).toContain('stream_active 0\n');
    expect(metrics.render()).not.toContain('stream_errors_total{code="connect"}');
  });

  it('closes the origin and stops byte accounting after the player disconnects', async () => {
    let closed = false;
    let chunks = 0;
    state.target = await listen(http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/webm' });
      response.write('first chunk');
      const timer = setInterval(() => { chunks++; response.write('more bytes'); }, 5);
      response.once('close', () => { closed = true; clearInterval(timer); });
    }));
    const url = await api();
    await new Promise<void>((resolve, reject) => {
      const request = http.get(url, response => {
        response.once('data', () => { response.destroy(); resolve(); });
      });
      request.on('error', reject);
    });

    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    const chunksAtClose = chunks;
    const bytesAtClose = metrics.render().match(/^stream_bytes_total \d+$/m)![0];
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(chunks).toBe(chunksAtClose);
    expect(metrics.render()).toContain(`${bytesAtClose}\n`);
    expect(metrics.render()).toContain('stream_active 0\n');
    expect(metrics.render()).not.toContain('stream_errors_total{code="transfer"}');

  });

  it('releases an ongoing origin body for HEAD while preserving its headers', async () => {
    let closed = false;
    state.target = await listen(http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/webm', 'content-length': '999999' });
      response.write('bytes');
      response.once('close', () => { closed = true; });
    }));
    const result = await get(await api(), { method: 'HEAD' });
    expect(result.response.statusCode).toBe(200);
    expect(result.response.headers['content-length']).toBe('999999');
    expect(result.body).toBe('');
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    expect(metrics.render()).toContain('stream_active 0\n');
  });

  it('cancels a redirected dial that has not received final headers', async () => {
    const entered = deferred();
    let closed = false;
    const origin = await listen(http.createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/waiting' });
        response.end();
      } else {
        response.once('close', () => { closed = true; });
        entered.resolve();
      }
    }));
    state.target = `${origin}/redirect`;
    const request = http.get(await api());
    request.on('error', () => {});
    await entered.promise;
    request.destroy();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
  });

  it('keeps completed range responses reusable on the origin connection', async () => {
    const originSockets: net.Socket[] = [];
    const ranges: Array<string | undefined> = [];
    state.target = await listen(http.createServer((request, response) => {
      originSockets.push(request.socket);
      ranges.push(request.headers.range);
      response.writeHead(206, {
        'content-type': 'audio/webm', 'content-length': '4', 'content-range': 'bytes 0-3/12',
        'accept-ranges': 'bytes', 'content-encoding': 'identity',
      });
      response.end('data');
    }));
    const url = await api();
    for (let i = 0; i < 2; i++) {
      const result = await get(url, { headers: { range: 'bytes=0-3' } });
      expect(result.response.statusCode).toBe(206);
      expect(result.response.headers['content-range']).toBe('bytes 0-3/12');
      expect(result.response.headers['content-encoding']).toBe('identity');
      expect(result.body).toBe('data');
    }
    expect(ranges).toEqual(['bytes=0-3', 'bytes=0-3']);
    expect(originSockets[1]).toBe(originSockets[0]);
    expect(metrics.render()).toContain('stream_active 0\n');
    expect(metrics.render()).toContain('stream_bytes_total 8\n');
    expect(metrics.render()).toContain('stream_upstream_connect_seconds_count 2\n');
  });

  it('does not dial an origin for an already aborted signal', async () => {
    let requests = 0;
    const origin = await listen(http.createServer((_request, response) => { requests++; response.end(); }));
    const controller = new AbortController();
    controller.abort();
    const result = await proxyStream(origin, { signal: controller.signal });
    expect(result.status).toBe(499);
    expect(result.body).toBeNull();
    expect(requests).toBe(0);
  });

  it('closes the origin when the returned body is destroyed without an abort signal', async () => {
    let closed = false;
    const origin = await listen(http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'audio/webm' });
      response.write('first bytes');
      response.once('close', () => { closed = true; });
    }));
    const result = await proxyStream(origin);
    expect(metrics.render()).toContain('stream_active 1\n');
    result.body!.destroy();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    expect(metrics.render()).toContain('stream_active 0\n');
  });

  it('removes cancellation listeners after a response finishes normally', async () => {
    const origin = await listen(http.createServer((_request, response) => response.end('data')));
    const controller = new AbortController();
    const result = await proxyStream(origin, { signal: controller.signal });
    for await (const _chunk of result.body!) { /* consume the full response */ }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(metrics.render()).toContain('stream_active 0\n');
  });

  it('closes the API response when the origin body fails in the headers packet', async () => {
    state.target = await listen(net.createServer(socket => {
      socket.once('data', () => socket.end(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nBOGUS\r\n',
      ));
    }));
    await expect(get(await api())).rejects.toThrow();
    expect(metrics.render()).toContain('stream_active 0\n');
    expect(metrics.render()).toContain('stream_errors_total{code="transfer"} 1\n');
    expect(metrics.render()).not.toContain('stream_errors_total{code="connect"}');
  });

  it('leaves no dial timeout behind when request header validation throws', async () => {
    const origin = await listen(http.createServer((_request, response) => response.end()));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await expect(proxyStream(origin, { userAgent: 'invalid\nheader' })).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15_001);
  });
});

describe('client → API → CONNECT tunnel lifecycle', () => {
  it('closes a proxy stalled after TCP connect when the player disconnects', async () => {
    const entered = deferred();
    let closed = false;
    state.proxyUrl = await listen(net.createServer(socket => {
      socket.once('data', bytes => { expect(bytes.toString()).toContain('CONNECT media.test:443'); entered.resolve(); });
      socket.once('close', () => { closed = true; });
    }));
    state.target = 'https://media.test/stream';
    const request = http.get(await api());
    request.on('error', () => {});
    await entered.promise;
    request.destroy();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    expect(state.evictByUrl).not.toHaveBeenCalled();
    expect(metrics.render()).not.toContain('stream_errors_total{code="connect"}');
  });

  it('cancels a tunnel waiting for the TLS handshake after CONNECT succeeds', async () => {
    const entered = deferred();
    let closed = false;
    state.proxyUrl = await listen(net.createServer(socket => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.once('data', () => entered.resolve()); // Real TLS ClientHello.
      });
      socket.once('close', () => { closed = true; });
    }));
    state.target = 'https://media.test/stream';
    const request = http.get(await api());
    request.on('error', () => {});
    await entered.promise;
    request.destroy();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    expect(state.evictByUrl).not.toHaveBeenCalled();
  });

  it('uses the queued player\'s signal when replacing a cancelled shared tunnel', async () => {
    const connections: Array<{ socket: net.Socket; handshake: boolean; closed: boolean }> = [];
    state.proxyUrl = await listen(net.createServer(socket => {
      const connection = { socket, handshake: false, closed: false };
      connections.push(connection);
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.once('data', () => { connection.handshake = true; });
      });
      socket.once('close', () => { connection.closed = true; });
    }));
    state.target = 'https://media.test/stream';
    let entered = 0;
    const url = `${await listen(createAppServer({ routes: [['/stream/resolver/{stream_id}', ctx => {
      entered++;
      return streamResolver(ctx);
    }]] }))}/stream/resolver/loopback.secret`;
    const requests = Array.from({ length: 16 }, () => {
      const request = http.get(url);
      request.on('error', () => {});
      return request;
    });
    await vi.waitFor(() => {
      expect(entered).toBe(16);
      expect(connections).toHaveLength(16);
      expect(connections.every(connection => connection.handshake)).toBe(true);
    }, { timeout: 1000 });
    const queued = http.get(url);
    queued.on('error', () => {});
    requests.push(queued);
    await vi.waitFor(() => expect(entered).toBe(17), { timeout: 1000 });
    expect(connections).toHaveLength(16);

    // Node creates the queued request's socket using options from this old
    // connection. Its aborted signal must not be inherited by the new dial.
    requests[0]!.destroy();
    await vi.waitFor(() => {
      expect(connections).toHaveLength(17);
      expect(connections[16]!.handshake).toBe(true);
    }, { timeout: 1000 });
    requests[16]!.destroy();
    await vi.waitFor(() => expect(connections[16]!.closed).toBe(true), { timeout: 1000 });
    for (const request of requests) request.destroy();
    await vi.waitFor(() => expect(connections.every(connection => connection.closed)).toBe(true), { timeout: 1000 });
    expect(state.evictByUrl).not.toHaveBeenCalled();
    expect(metrics.render()).not.toContain('stream_errors_total{code="connect"}');
  });

  it('times out a CONNECT response stall and closes the proxy socket', async () => {
    const entered = deferred();
    let closed = false;
    state.proxyUrl = await listen(net.createServer(socket => {
      socket.once('data', () => entered.resolve());
      socket.once('close', () => { closed = true; });
    }));
    state.target = 'https://media.test/stream';
    const url = await api();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = get(url);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(15_001);
    vi.useRealTimers();
    const result = await response;
    expect(result.response.statusCode).toBe(502);
    expect(JSON.parse(result.body)).toEqual(expect.objectContaining({ retriable: true }));
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    expect(state.evictByUrl).toHaveBeenCalledWith(state.proxyUrl);
    expect(metrics.render()).toContain('stream_errors_total{code="connect"} 1\n');
  });
});
