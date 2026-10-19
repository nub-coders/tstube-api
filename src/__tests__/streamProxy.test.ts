import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../urlValidation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../urlValidation.js')>();
  return {
    ...actual,
    isPublicHost: async () => true, // allow test localhost server in tests
  };
});

import { proxyStream } from '../streamProxy.js';

describe('proxyStream redirect handling', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect-once') {
        res.writeHead(302, { Location: `${baseUrl}/final-data` });
        res.end();
      } else if (req.url === '/redirect-loop') {
        res.writeHead(302, { Location: `${baseUrl}/redirect-loop` });
        res.end();
      } else if (req.url === '/final-data') {
        res.writeHead(200, {
          'content-type': 'audio/webm',
          'content-length': '12',
          'accept-ranges': 'bytes',
        });
        res.end('stream-bytes');
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('follows HTTP 302 redirect transparently and streams content', async () => {
    const upstream = await proxyStream(`${baseUrl}/redirect-once`);
    expect(upstream.status).toBe(200);
    expect(upstream.headers['content-type']).toBe('audio/webm');
    expect(upstream.headers['content-length']).toBe('12');

    let body = '';
    for await (const chunk of upstream.body!) {
      body += chunk.toString();
    }
    expect(body).toBe('stream-bytes');
  });

  it('fails with 502 when redirect loop exceeds limit', async () => {
    const upstream = await proxyStream(`${baseUrl}/redirect-loop`);
    expect(upstream.status).toBe(502);
    expect(upstream.error).toEqual(
      expect.objectContaining({ message: 'Too many redirects from stream source' }),
    );
  });
});
