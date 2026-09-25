import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createAppServer, metricsHandler, type Handler } from '../httpServer.js';
import * as routes from '../apiRoutes.js';

let server: Server;
let base: string;

const routeTable: Array<[string, Handler]> = [
  ['/', routes.root],
  ['/search', routes.searchSongs],
  ['/health', routes.health],
  ['/metrics', metricsHandler],
  ['/favicon.ico', routes.faviconIco],
  ['/favicon.svg', routes.faviconSvg],
];

beforeAll(async () => {
  server = createAppServer({ routes: routeTable });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('free endpoints', () => {
  it('GET / returns the welcome envelope with Python key order', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'name',
      'version',
      'supported_platforms',
      'endpoints',
      'free_endpoints',
      'auth',
      'redirect_note',
    ]);
    expect(body.name).toBe('ytube_api API');
    expect(body.version).toBe('2026.3.12');
    expect(body.supported_platforms).toEqual([
      'YouTube',
      'Apple Music',
      'Amazon Music',
      'SoundCloud',
      'JioSaavn',
      'Spotify',
    ]);
    expect(Object.keys(body.endpoints as object)).toEqual([
      '/search',
      '/trending',
      '/suggest',
      '/stream',
      '/stream/redirect',
      '/info',
      '/playlist',
      '/health',
      '/rate-limit-status',
    ]);
  });

  it('GET /health returns {status:"ok"}', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /metrics serves the Prometheus text content type', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(await res.text()).toContain('http_requests_total');
  });

  it('serves favicons with the right media types', async () => {
    const ico = await fetch(`${base}/favicon.ico`);
    expect(ico.status).toBe(200);
    expect(ico.headers.get('content-type')).toBe('image/x-icon');

    const svg = await fetch(`${base}/favicon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('HEAD /health returns headers with no body', async () => {
    const res = await fetch(`${base}/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBeDefined();
    expect(await res.text()).toBe('');
  });
});

describe('routing and auth middleware', () => {
  it('returns 405 for a method mismatch on a free route', async () => {
    const res = await fetch(`${base}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ detail: 'Method Not Allowed' });
  });

  it('returns the middleware 401 for an unauthenticated protected path', async () => {
    const res = await fetch(`${base}/info?q=dQw4w9WgXcQ`);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text))).toEqual([
      'error',
      'message',
      'required_arguments',
      'optional_arguments',
    ]);
    const body = JSON.parse(text);
    expect(body.error).toBe('Token required');
    expect(body.message).toBe('Get your token from @ytdlp_nub_bot using /start');
    // Auth runs before routing, so even an unknown path 401s (never 404).
    const unknown = await fetch(`${base}/does-not-exist`);
    expect(unknown.status).toBe(401);
  });

  it('returns 422 with the FastAPI validation envelope for a free route', async () => {
    const res = await fetch(`${base}/search`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'error',
      'message',
      'details',
      'endpoint',
      'required_arguments',
      'optional_arguments',
    ]);
    expect(body.error).toBe('Validation Error');
    expect(body.endpoint).toBe('/search');
    expect(body.details).toEqual([
      { type: 'missing', loc: ['query', 'q'], msg: 'Field required', input: null },
    ]);
    expect((body.required_arguments as Record<string, unknown>).q).toEqual({
      type: 'string',
      in: 'query',
      description: 'Search query',
    });
  });

  it('returns 422 for an out-of-range integer', async () => {
    const res = await fetch(`${base}/search?q=x&limit=0`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details: unknown[] };
    expect(body.details).toEqual([
      {
        type: 'greater_than_equal',
        loc: ['query', 'limit'],
        msg: 'Input should be greater than or equal to 1',
        input: '0',
        ctx: { ge: 1 },
      },
    ]);
  });
});
