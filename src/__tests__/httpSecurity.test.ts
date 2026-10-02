import http, { type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppServer, json, Router, streamResponse, type Handler } from '../httpServer.js';
import { HttpError } from '../httpError.js';
import * as metrics from '../metrics.js';

const { getUserByToken } = vi.hoisted(() => ({ getUserByToken: vi.fn() }));
vi.mock('../tools.js', () => ({
  getUserByToken,
  incrementUserRequests: vi.fn(async () => 1),
  incrementFailedRequests: vi.fn(),
}));
vi.mock('../config.js', () => ({ config: () => ({ DAILY_LIMIT: 1000 }), isAdmin: () => false }));

const servers: Server[] = [];
async function serve(routes: Array<[string, Handler]>): Promise<string> {
  const server = createAppServer({ routes });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  }));
  metrics.resetMetrics();
  vi.clearAllMocks();
});

describe('HTTP security boundaries', () => {
  it('classifies malformed path encoding as a client error', () => {
    const router = new Router();
    router.get('/stream/resolver/{id}', () => json(200, {}));
    expect(() => router.match('GET', '/stream/resolver/%')).toThrow(HttpError);
    try {
      router.match('GET', '/stream/resolver/%');
    } catch (error) {
      expect((error as HttpError).status).toBe(400);
    }
  });

  it('bounds metrics for unauthenticated unknown paths', async () => {
    const base = await serve([]);
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`${base}/random-${i}`);
      expect(response.status).toBe(401);
      await response.text();
    }
    const counters = metrics.render().split('\n').filter(line => line.startsWith('http_requests_total{'));
    expect(counters).toEqual(['http_requests_total{method="GET",path="unmatched",status="401"} 20']);
  });

  it('serves a client error for malformed encoding and stays healthy', async () => {
    const handler = vi.fn(() => json(200, {}));
    const base = await serve([
      ['/stream/resolver/{id}', handler],
      ['/health', () => json(200, { status: 'ok' })],
    ]);
    for (const path of ['%', '%E0%A4%A', '%FF']) {
      const response = await fetch(`${base}/stream/resolver/${path}`);
      expect(response.status).toBe(400);
      await response.text();
    }
    expect(handler).not.toHaveBeenCalled();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
  });

  it('aborts the handler signal when the client disconnects before headers', async () => {
    let enter!: () => void;
    let aborted!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const cancelled = new Promise<void>(resolve => { aborted = resolve; });
    const base = await serve([['/stream/proxy/test', async ctx => {
      enter();
      ctx.signal!.addEventListener('abort', () => aborted(), { once: true });
      await cancelled;
      return json(499, {});
    }]]);
    const request = http.get(`${base}/stream/proxy/test`);
    request.on('error', () => {});
    await entered;
    request.destroy();
    await cancelled;
  });

  it('does not reuse a revoked authentication result', async () => {
    getUserByToken.mockResolvedValueOnce(123).mockResolvedValueOnce(null);
    const base = await serve([['/info', () => json(200, {})]]);
    const init = { headers: { Authorization: 'Bearer audit-dummy-token' } };
    const first = await fetch(`${base}/info`, init);
    expect(first.status).toBe(200);
    await first.text();
    const second = await fetch(`${base}/info`, init);
    expect(second.status).toBe(401);
    await second.text();
  });

  it('destroys a streaming body when the player disconnects', async () => {
    const body = new PassThrough();
    const base = await serve([['/stream/proxy/test', () => streamResponse(200, {}, body)]]);
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`${base}/stream/proxy/test`, response => {
        response.once('data', () => { response.destroy(); resolve(); });
      });
      request.on('error', reject);
      setTimeout(() => body.write('first chunk'), 20);
    });
    await vi.waitFor(() => expect(body.destroyed).toBe(true), { timeout: 500 });
  });
});
