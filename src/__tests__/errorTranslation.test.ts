/**
 * Error-translation contract: client-facing failures keep their status and
 * message; internal faults answer a generic 500 and never leak exception
 * details (Redis endpoints, driver internals) into response bodies.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createAppServer, type RouteSpec } from '../httpServer.js';
import * as routes from '../apiRoutes.js';

const { mockGetUserByToken, mockExtractPlaylist, MockValueError } = vi.hoisted(() => {
  class ValueError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ValueError';
    }
  }
  return {
    mockGetUserByToken: vi.fn(),
    mockExtractPlaylist: vi.fn(),
    MockValueError: ValueError,
  };
});

vi.mock('../tools.js', () => ({
  getUserByToken: mockGetUserByToken,
  incrementUserRequests: vi.fn(async () => 1),
  incrementFailedRequests: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: () => ({ DAILY_LIMIT: 1000, ADMIN_LIMIT: 10000, ADMIN_IDS: [], ADMIN_ID_SET: new Set<number>() }),
  isAdmin: () => false,
}));

vi.mock('../playlistParser.js', () => ({
  ValueError: MockValueError,
  extractPlaylist: mockExtractPlaylist,
}));

let server: Server;
let base: string;

const routeTable: RouteSpec[] = [
  ['/playlist', routes.playlistSongs],
  // Non-HttpError throw straight through the pipeline boundary.
  ['/boom', () => { throw new Error('redis connection refused at 127.0.0.1:6379'); }],
];

beforeAll(async () => {
  mockGetUserByToken.mockResolvedValue(12345);
  server = createAppServer({ routes: routeTable });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('error translation', () => {
  it('keeps client-facing ValueError failures at 400 with their message', async () => {
    mockExtractPlaylist.mockRejectedValueOnce(new MockValueError('Invalid playlist link or ID'));
    const res = await fetch(`${base}/playlist?token=t1&url=BAD`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Invalid playlist link or ID');
    expect(body.time_taken).toBeDefined();
  });

  it('answers internal handler faults with a generic 500', async () => {
    mockExtractPlaylist.mockRejectedValueOnce(new Error('MONGO_HOST=db.internal:27017 connection refused'));
    const res = await fetch(`${base}/playlist?token=t2&url=PLabcdefghijklmnopqrstuvwxyz`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe('Internal Server Error');
    expect(text).not.toContain('MONGO_HOST');
  });

  it('keeps exception details out of unhandled pipeline errors', async () => {
    const res = await fetch(`${base}/boom?token=t3`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'Internal Server Error' });
    expect(text).not.toContain('127.0.0.1:6379');
  });
});
