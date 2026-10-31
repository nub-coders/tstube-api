import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../urlValidation.js', () => ({ isPublicHost: async () => true, isSafeProxyUrlSync: () => true }));
vi.mock('../proxy.js', () => ({ websharePool: { evictByUrl: () => false } }));

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
const streams: Readable[] = [];
const observedAuth: string[] = [];
const originalConnect = tls.connect;
let target: string;

async function listen(server: net.Server) {
  servers.push(server);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return (server.address() as net.AddressInfo).port;
}

async function proxy() {
  const server = http.createServer();
  server.on('connect', (req, client, head) => {
    observedAuth.push(String(req.headers['proxy-authorization']));
    const upstream = net.connect({ host: '127.0.0.1', port: Number(new URL(target).port) });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
    client.once('close', () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  return `http://127.0.0.1:${await listen(server)}`;
}

beforeEach(async () => {
  vi.resetModules();
  observedAuth.length = 0;
  // Test-only trust for this loopback server's ephemeral self-signed certificate.
  vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) =>
    originalConnect({ ...options, rejectUnauthorized: false })) as typeof tls.connect);
  const origin = https.createServer({
    key: readFileSync(new URL('./fixtures/audit-key.pem', import.meta.url)),
    cert: readFileSync(new URL('./fixtures/audit-cert.pem', import.meta.url)),
  }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/webm' });
    res.write('playing');
  });
  target = `https://localhost:${await listen(origin)}/media`;
});

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.destroy();
  for (const socket of sockets) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>(r => server.close(() => r()));
  vi.restoreAllMocks();
});

describe('proxy agent cache lifecycle', () => {
  it('keeps active playback alive when a ninth exit retires the first agent', async () => {
    const { proxyStream } = await import('../streamProxy.js');
    for (let n = 0; n < 9; n++) {
      const result = await proxyStream(target, { proxyUrl: await proxy() });
      expect(result.status).toBe(200);
      streams.push(result.body!);
      result.body!.resume();
      if (n === 7) expect(streams[0].destroyed).toBe(false);
    }
    await new Promise<void>(r => setTimeout(r, 30));
    expect(streams[0].destroyed).toBe(false);
    expect(streams[8].destroyed).toBe(false);
  });

  it('uses rotated credentials for new connections on the same exit', async () => {
    const { proxyStream } = await import('../streamProxy.js');
    const address = await proxy();
    const first = await proxyStream(target, { proxyUrl: address.replace('http://', 'http://user:old-password@') });
    expect(first.status).toBe(200);
    streams.push(first.body!);
    first.body!.destroy();
    await new Promise<void>(r => setTimeout(r, 15));
    const second = await proxyStream(target, { proxyUrl: address.replace('http://', 'http://user:new-password@') });
    expect(second.status).toBe(200);
    streams.push(second.body!);
    expect(observedAuth).toEqual([
      `Basic ${Buffer.from('user:old-password').toString('base64')}`,
      `Basic ${Buffer.from('user:new-password').toString('base64')}`,
    ]);
  });
});
