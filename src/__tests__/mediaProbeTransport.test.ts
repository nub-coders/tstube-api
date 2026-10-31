import http from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';

// Permit only these test fixtures to exercise real loopback HTTP transports.
vi.mock('../urlValidation.js', async original => ({
  ...await original<typeof import('../urlValidation.js')>(),
  isPublicHost: async () => true,
  isSafeProxyUrlSync: () => true,
}));
vi.mock('../proxy.js', () => ({ websharePool: { evictByUrl: vi.fn(async () => false) } }));
import { MEDIA_PROBE_BYTES, probeMedia } from '../mediaProbe.js';

const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const servers: http.Server[] = [];
const sockets = new Set<Socket>();
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

it('closes an ongoing origin download after the sample when Range is ignored', async () => {
  let closed = false;
  let range: string | undefined;
  let writes = 0;
  const target = await serve((request, response) => {
    range = request.headers.range;
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.write(Buffer.concat([mp4, Buffer.alloc(MEDIA_PROBE_BYTES - mp4.length)]));
    const timer = setInterval(() => { writes++; response.write(Buffer.alloc(MEDIA_PROBE_BYTES)); }, 20);
    response.once('close', () => { closed = true; clearInterval(timer); });
  });
  expect(await probeMedia(target)).toBe(true);
  expect(range).toBe('bytes=0-16383');
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(writes).toBeLessThan(5);
});

it.each(['headers', 'body'])('closes a real stalled %s request when its caller deadline expires', async stage => {
  let closed = false;
  const target = await serve((_request, response) => {
    response.once('close', () => { closed = true; });
    if (stage === 'body') {
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.write(mp4);
    }
  });
  expect(await probeMedia(target, { deadline: Date.now() + 150 })).toBe(false);
  await vi.waitFor(() => expect(closed).toBe(true));
});

it('uses the playback HTTP proxy and its credentials for the probe', async () => {
  const target = 'http://media.example.invalid/audio.m4a';
  let requestedUrl: string | undefined;
  let authorization: string | undefined;
  const proxy = new URL(await serve((request, response) => {
    requestedUrl = request.url;
    authorization = request.headers['proxy-authorization'];
    response.writeHead(206, { 'content-type': 'audio/mp4', 'content-range': 'bytes 0-23/1000', 'content-length': '24' });
    response.end(mp4);
  }));
  proxy.username = 'test-user';
  proxy.password = 'test-pass';
  expect(await probeMedia(target, { proxyUrl: proxy.href })).toBe(true);
  expect(requestedUrl).toBe(target);
  expect(authorization).toBe(`Basic ${Buffer.from('test-user:test-pass').toString('base64')}`);
});

it('validates the final body after a redirect instead of trusting the initial URL', async () => {
  const target = await serve((request, response) => {
    if (request.url === '/') {
      response.writeHead(302, { location: '/denied' });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'audio/mpeg' });
      response.end('<html>Access denied</html>');
    }
  });
  expect(await probeMedia(target)).toBe(false);
});
