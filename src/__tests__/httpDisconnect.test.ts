import http, { type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { createAppServer, json, type Handler } from '../httpServer.js';
import { setupJsonLogging } from '../logger.js';
import * as metrics from '../metrics.js';

const servers: Server[] = [];
let stderr: ReturnType<typeof captureStderr>;

function captureStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

async function serve(handler: Handler): Promise<{ server: Server; url: string }> {
  const server = createAppServer({ routes: [['/stream/resolver/{id}', handler]] });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/stream/resolver/test.secret`,
  };
}

function httpErrors(): Array<{ msg: string; err: string }> {
  return stderr.mock.calls.flatMap(([chunk]) => {
    try {
      const entry = JSON.parse(String(chunk));
      return entry.logger === 'ytube_api.http' && entry.level === 'error' ? [entry] : [];
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  metrics.resetMetrics();
  setupJsonLogging({ TESTING: false } as Config);
  stderr = captureStderr();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  }));
  await new Promise<void>(resolve => setImmediate(resolve));
  setupJsonLogging({ TESTING: true } as Config);
  vi.restoreAllMocks();
  metrics.resetMetrics();
});

describe('HTTP disconnect classification', () => {
  it('counts a disconnected resolver wait as 499 without writing or logging a server error', async () => {
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const { server, url } = await serve(async ctx => {
      enter();
      await new Promise<never>((_resolve, reject) => {
        ctx.signal!.addEventListener('abort', () => reject(ctx.signal!.reason), { once: true });
      });
      return json(200, {});
    });
    let response: ServerResponse | undefined;
    server.once('request', (_request, outgoing) => { response = outgoing; });
    const receivedResponse = vi.fn();
    const request = http.get(url, receivedResponse);
    request.on('error', () => {});
    await entered;
    request.destroy();

    await vi.waitFor(() => expect(metrics.render()).toContain('http_requests_total{'), { timeout: 1000 });
    expect(metrics.render()).toContain('http_requests_total{method="GET",path="/stream/resolver/{id}",status="499"} 1');
    expect(metrics.render()).not.toContain('status="500"');
    expect(httpErrors()).toEqual([]);
    expect(response?.headersSent).toBe(false);
    expect(receivedResponse).not.toHaveBeenCalled();
  });

  it.each([
    new Error('resolver fault'),
    new DOMException('unrelated operation aborted', 'AbortError'),
  ])('serves, logs and counts a connected handler failure as 500: %s', async error => {
    const { url } = await serve(ctx => {
      expect(ctx.signal?.aborted).toBe(false);
      throw error;
    });
    const response = await fetch(url);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
    expect(metrics.render()).toContain('http_requests_total{method="GET",path="/stream/resolver/{id}",status="500"} 1');
    expect(metrics.render()).not.toContain('status="499"');
    expect(httpErrors()).toEqual([expect.objectContaining({
      msg: '[HTTP] unhandled error for GET /stream/resolver/test.secret',
      err: String(error),
    })]);
  });

  it('keeps a normal completed response counted as 200', async () => {
    let signal: AbortSignal | undefined;
    const { url } = await serve(ctx => {
      signal = ctx.signal;
      return json(200, { status: 'ok' });
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(metrics.render()).toContain('http_requests_total{method="GET",path="/stream/resolver/{id}",status="200"} 1');
    expect(metrics.render()).not.toContain('status="499"');
    expect(httpErrors()).toEqual([]);
  });
});
