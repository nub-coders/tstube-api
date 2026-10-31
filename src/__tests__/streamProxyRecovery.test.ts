import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getEventListeners, once } from 'node:events';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../urlValidation.js', () => ({ isPublicHost: async () => true, isSafeProxyUrlSync: () => true }));
vi.mock('../proxy.js', () => ({ websharePool: { evictByUrl: () => false } }));

import { proxyPlayback, proxyStream } from '../streamProxy.js';

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
const bodies: Readable[] = [];
const nativeRequest = https.request;
const nativeConnect = tls.connect;
const chunk = Buffer.alloc(64 * 1024, 0x5a);

function mediaUrl(origin: string, length: number) {
  const url = new URL('/videoplayback', origin);
  url.hostname = 'r1.googlevideo.com';
  for (const [key, value] of Object.entries({ id: 'fixture', itag: '18', source: 'youtube',
    clen: String(length), lmt: '1700000000000000', sig: 'fixture-signature', sparams: 'id,itag,clen,lmt' })) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

function intervalHeaders(start: number, end: number, total: number) {
  return { 'content-type': 'video/mp4', 'content-length': String(end - start + 1),
    'content-range': `bytes ${start}-${end}/${total}` };
}

function resetWithPrefix(response: http.ServerResponse, headers: http.OutgoingHttpHeaders, status = 200) {
  response.writeHead(status, headers);
  response.write(chunk);
  setTimeout(() => response.socket?.destroy(), 10);
}

async function listen(handler: http.RequestListener): Promise<string> {
  const server = https.createServer({
    key: readFileSync(new URL('./fixtures/audit-key.pem', import.meta.url)),
    cert: readFileSync(new URL('./fixtures/audit-cert.pem', import.meta.url)),
  }, handler);
  servers.push(server);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `https://localhost:${(server.address() as net.AddressInfo).port}`;
}

async function consume(body: Readable) {
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const part of body) { bytes += part.length; digest.update(part); }
    return { bytes, digest: digest.digest('hex'), ended: true, code: undefined };
  } catch (error) {
    return { bytes, digest: digest.digest('hex'), ended: false, code: (error as NodeJS.ErrnoException).code };
  }
}

function nativeGet(url: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, resolve);
    request.once('error', reject);
  });
}

beforeEach(() => {
  // Keep real TLS/socket behavior, while routing synthetic Googlevideo names
  // only to the controlled loopback origin and trusting its test certificate.
  vi.spyOn(https, 'request').mockImplementation(((url: URL, options: https.RequestOptions,
    callback: (response: http.IncomingMessage) => void) => nativeRequest(url, {
      ...options, rejectUnauthorized: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }] as never);
        else callback(null, '127.0.0.1', 4);
      },
    }, callback)) as typeof https.request);
});

afterEach(async () => {
  for (const body of bodies.splice(0)) body.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

describe('native HTTPS and proxyStream under controlled socket behavior', () => {
  it('both complete the same response beyond the historical reset size', async () => {
    const length = 34 * 1024 * 1024;
    const origin = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(length) });
      void (async () => {
        for (let written = 0; written < length; written += chunk.length) {
          if (!response.write(chunk)) await once(response, 'drain');
        }
        response.end();
      })();
    });
    const native = await consume(await nativeGet(origin));
    const upstream = await proxyStream(origin);
    const proxied = await consume(upstream.body!);
    expect(native.ended).toBe(true);
    expect(proxied).toEqual(native);
    expect(proxied.bytes).toBe(length);
  });

  it('both expose an origin reset instead of reporting a complete body', async () => {
    const origin = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(1024 * 1024) });
      response.write(chunk);
      setTimeout(() => response.socket?.destroy(), 10);
    });
    const native = await consume(await nativeGet(origin));
    const upstream = await proxyStream(origin);
    const proxied = await consume(upstream.body!);
    expect(native.ended).toBe(false);
    expect(native.code).toBe('ECONNRESET');
    expect(proxied).toEqual(native);
    expect(proxied.bytes).toBe(chunk.length);
  });
});

describe('finite signed media playback recovery', () => {
  it('resumes a reset ordinary GET at the exact accepted byte offset', async () => {
    const length = chunk.length * 3;
    const remaining = Buffer.concat([Buffer.alloc(chunk.length, 0x11), Buffer.alloc(chunk.length, 0x22)]);
    const ranges: Array<string | undefined> = [];
    const origin = await listen((request, response) => {
      ranges.push(request.headers.range);
      if (ranges.length === 1) resetWithPrefix(response, { 'content-type': 'video/mp4', 'content-length': String(length) });
      else { response.writeHead(206, intervalHeaders(chunk.length, length - 1, length)); response.end(remaining); }
    });
    const result = await proxyPlayback(mediaUrl(origin, length));
    const received = await consume(result.body!);
    expect(received.ended).toBe(true);
    expect(received.bytes).toBe(length);
    expect(received.digest).toBe(createHash('sha256').update(Buffer.concat([chunk, remaining])).digest('hex'));
    expect(result.status).toBe(200);
    expect(result.headers['content-length']).toBe(String(length));
    expect(ranges).toEqual([undefined, `bytes=${chunk.length}-${length - 1}`]);
  });

  it('resumes an idle-read timeout at the exact accepted byte offset', async () => {
    // Keep the real request/socket timeout path without waiting two minutes.
    const nativeSetTimeout = http.ClientRequest.prototype.setTimeout;
    vi.spyOn(http.ClientRequest.prototype, 'setTimeout').mockImplementation(function (
      this: http.ClientRequest, timeout: number, callback?: () => void,
    ) {
      return nativeSetTimeout.call(this, timeout === 120_000 ? 25 : timeout, callback);
    });
    const length = chunk.length * 3;
    const remaining = Buffer.concat([Buffer.alloc(chunk.length, 0x11), Buffer.alloc(chunk.length, 0x22)]);
    const ranges: Array<string | undefined> = [];
    const origin = await listen((request, response) => {
      ranges.push(request.headers.range);
      if (ranges.length === 1) {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(length) });
        response.write(chunk);
      } else {
        response.writeHead(206, intervalHeaders(chunk.length, length - 1, length));
        response.end(remaining);
      }
    });
    const result = await proxyPlayback(mediaUrl(origin, length));
    const received = await consume(result.body!);
    expect(received.ended).toBe(true);
    expect(received.bytes).toBe(length);
    expect(received.digest).toBe(createHash('sha256').update(Buffer.concat([chunk, remaining])).digest('hex'));
    expect(ranges).toEqual([undefined, `bytes=${chunk.length}-${length - 1}`]);
  });

  it('preserves the original bounded nonzero range when resuming', async () => {
    const total = chunk.length * 5, start = chunk.length, end = chunk.length * 4 - 1;
    const remaining = Buffer.concat([Buffer.alloc(chunk.length, 0x33), Buffer.alloc(chunk.length, 0x44)]);
    const ranges: Array<string | undefined> = [];
    const origin = await listen((request, response) => {
      ranges.push(request.headers.range);
      if (ranges.length === 1) resetWithPrefix(response, intervalHeaders(start, end, total), 206);
      else { response.writeHead(206, intervalHeaders(start + chunk.length, end, total)); response.end(remaining); }
    });
    const result = await proxyPlayback(mediaUrl(origin, total), { rangeHeader: `bytes=${start}-${end}` });
    const received = await consume(result.body!);
    expect(received.ended).toBe(true);
    expect(received.bytes).toBe(end - start + 1);
    expect(received.digest).toBe(createHash('sha256').update(Buffer.concat([chunk, remaining])).digest('hex'));
    expect(result.status).toBe(206);
    expect(result.headers['content-range']).toBe(`bytes ${start}-${end}/${total}`);
    expect(ranges).toEqual([`bytes=${start}-${end}`, `bytes=${start + chunk.length}-${end}`]);
  });

  it.each(['ignored_range', 'wrong_start', 'wrong_end', 'wrong_total', 'wrong_length', 'changed_mime', 'encoded', 'changed_representation'])(
    'errors without forwarding replacement bytes for %s', async fault => {
      const length = chunk.length * 3;
      let requests = 0;
      const origin = await listen((request, response) => {
        requests++;
        if (requests === 1) { resetWithPrefix(response, { 'content-type': 'video/mp4', 'content-length': String(length) }); return; }
        const headers: Record<string, string> = intervalHeaders(chunk.length, length - 1, length);
        if (fault === 'wrong_start') headers['content-range'] = `bytes ${chunk.length + 1}-${length - 1}/${length}`;
        if (fault === 'wrong_end') headers['content-range'] = `bytes ${chunk.length}-${length - 2}/${length}`;
        if (fault === 'wrong_total') headers['content-range'] = `bytes ${chunk.length}-${length - 1}/${length + 1}`;
        if (fault === 'wrong_length') headers['content-length'] = String(length - chunk.length + 1);
        if (fault === 'changed_mime') headers['content-type'] = 'audio/mp4';
        if (fault === 'encoded') headers['content-encoding'] = 'gzip';
        if (fault === 'changed_representation' && requests === 2) {
          const changed = new URL(request.url!, origin); changed.searchParams.set('lmt', '1700000000000001');
          response.writeHead(302, { location: changed.href }); response.end(); return;
        }
        response.writeHead(fault === 'ignored_range' ? 200 : 206, headers);
        response.end(Buffer.concat([chunk, chunk]));
      });
      const result = await proxyPlayback(mediaUrl(origin, length));
      const received = await consume(result.body!);
      expect(received.ended).toBe(false);
      expect(received.bytes).toBe(chunk.length);
      expect(requests).toBe(fault === 'changed_representation' ? 3 : 2);
    },
  );

  it('limits repeated resets to two resume requests and errors the output', async () => {
    const length = chunk.length * 5;
    const ranges: Array<string | undefined> = [];
    const origin = await listen((request, response) => {
      ranges.push(request.headers.range);
      const offset = (ranges.length - 1) * chunk.length;
      resetWithPrefix(response, offset ? intervalHeaders(offset, length - 1, length)
        : { 'content-type': 'video/mp4', 'content-length': String(length) }, offset ? 206 : 200);
    });
    const result = await proxyPlayback(mediaUrl(origin, length));
    const received = await consume(result.body!);
    expect(received.ended).toBe(false);
    expect(received.bytes).toBe(chunk.length * 3);
    expect(ranges).toEqual([undefined, `bytes=${chunk.length}-${length - 1}`, `bytes=${chunk.length * 2}-${length - 1}`]);
  });

  it.each(['live', 'sequence', 'unsigned', 'wrong_length', 'other_host'])(
    'does not resume ineligible %s responses', async reason => {
      const length = chunk.length * 3;
      let requests = 0;
      const origin = await listen((_request, response) => {
        requests++;
        resetWithPrefix(response, { 'content-type': 'video/mp4', 'content-length': String(length) });
      });
      const url = new URL(mediaUrl(origin, length));
      if (reason === 'live') url.searchParams.set('source', 'yt_live_broadcast');
      if (reason === 'sequence') url.searchParams.set('sq', '10');
      if (reason === 'unsigned') url.searchParams.delete('sig');
      if (reason === 'wrong_length') url.searchParams.set('clen', String(length + 1));
      if (reason === 'other_host') url.hostname = 'localhost';
      const result = await proxyPlayback(url.href);
      expect((await consume(result.body!)).ended).toBe(false);
      expect(requests).toBe(1);
    },
  );

  it('cancels a resumed dial waiting for response headers', async () => {
    const length = chunk.length * 3;
    let requests = 0, closed = false;
    const origin = await listen((_request, response) => {
      requests++;
      if (requests === 1) resetWithPrefix(response, { 'content-type': 'video/mp4', 'content-length': String(length) });
      else response.once('close', () => { closed = true; });
    });
    const controller = new AbortController();
    const result = await proxyPlayback(mediaUrl(origin, length), { signal: controller.signal });
    bodies.push(result.body!); result.body!.resume();
    await vi.waitFor(() => expect(requests).toBe(2));
    controller.abort();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(result.body!.destroyed).toBe(true);
    expect(requests).toBe(2);
  });

  it('bounds buffered output and stops the origin when a paused player destroys it', async () => {
    const length = 8 * 1024 * 1024;
    let requests = 0, closed = false;
    const origin = await listen((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(length) });
      const write = () => {
        while (!response.destroyed && response.write(chunk)) { /* wait for downstream backpressure */ }
        if (!response.destroyed) response.once('drain', write);
      };
      response.once('close', () => { closed = true; });
      write();
    });
    const result = await proxyPlayback(mediaUrl(origin, length));
    bodies.push(result.body!);
    await vi.waitFor(() => expect(result.body!.readableLength).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(result.body!.readableLength).toBeLessThanOrEqual(256 * 1024);
    result.body!.destroy();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(requests).toBe(1);
  });

  it('keeps queued output bytes across a reset while the player is paused', async () => {
    const payload = Buffer.alloc(chunk.length * 9);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
    const ranges: Array<string | undefined> = [];
    const origin = await listen((request, response) => {
      ranges.push(request.headers.range);
      if (ranges.length === 1) {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.length) });
        response.write(payload.subarray(0, chunk.length * 6));
        setTimeout(() => response.socket?.destroy(), 10);
      } else {
        const start = Number(/^bytes=(\d+)-/.exec(request.headers.range!)![1]);
        response.writeHead(206, intervalHeaders(start, payload.length - 1, payload.length));
        response.end(payload.subarray(start));
      }
    });
    const result = await proxyPlayback(mediaUrl(origin, payload.length));
    bodies.push(result.body!);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(ranges).toHaveLength(1);
    const received = await consume(result.body!);
    expect(received.ended).toBe(true);
    expect(received.bytes).toBe(payload.length);
    expect(received.digest).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(ranges).toHaveLength(2);
  });

  it('cancels the replacement body without starting another resume', async () => {
    const length = chunk.length * 10;
    let requests = 0, closed = false, received = 0;
    const origin = await listen((_request, response) => {
      requests++;
      if (requests === 1) resetWithPrefix(response, { 'content-type': 'video/mp4', 'content-length': String(length) });
      else {
        response.writeHead(206, intervalHeaders(chunk.length, length - 1, length));
        const timer = setInterval(() => response.write(Buffer.alloc(8192)), 5);
        response.once('close', () => { closed = true; clearInterval(timer); });
      }
    });
    const controller = new AbortController();
    const result = await proxyPlayback(mediaUrl(origin, length), { signal: controller.signal });
    bodies.push(result.body!);
    result.body!.on('data', part => { received += part.length; });
    await vi.waitFor(() => expect(received).toBeGreaterThan(chunk.length));
    controller.abort();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(requests).toBe(2);
  });

  it('reuses healthy source connections and exposes the final redirect URL', async () => {
    const usedSockets: net.Socket[] = [];
    const origin = await listen((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: '/done' }); response.end(); return; }
      usedSockets.push(request.socket);
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(chunk.length) });
      response.end(chunk);
    });
    for (let index = 0; index < 2; index++) {
      const result = await proxyPlayback(mediaUrl(origin, chunk.length));
      expect((await consume(result.body!)).ended).toBe(true);
    }
    expect(usedSockets[0]).toBe(usedSockets[1]);
    const redirected = await proxyStream(origin + '/redirect');
    expect(redirected.finalUrl).toBe(origin + '/done');
    expect((await consume(redirected.body!)).bytes).toBe(chunk.length);
  });

  it('keeps completed queued bytes cancellable until the player consumes them', async () => {
    const length = 1024;
    const origin = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(length) });
      response.end(Buffer.alloc(length));
    });
    const controller = new AbortController();
    const result = await proxyPlayback(mediaUrl(origin, length), { signal: controller.signal });
    bodies.push(result.body!);
    await vi.waitFor(() => expect(result.body!.writableFinished).toBe(true));
    expect(result.body!.readableLength).toBe(length);
    controller.abort();
    await vi.waitFor(() => expect(result.body!.destroyed).toBe(true));
    let laterBytes = 0;
    result.body!.on('data', part => { laterBytes += part.length; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(laterBytes).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes the caller abort hook after the complete output is consumed', async () => {
    const length = 1024;
    const origin = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(length) });
      response.end(Buffer.alloc(length));
    });
    const controller = new AbortController();
    const result = await proxyPlayback(mediaUrl(origin, length), { signal: controller.signal });
    expect((await consume(result.body!)).ended).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('resumes through the same pinned CONNECT proxy', async () => {
    const length = chunk.length * 2;
    let requests = 0, tunnels = 0;
    const origin = await listen((_request, response) => {
      requests++;
      if (requests === 1) resetWithPrefix(response, { 'content-type': 'video/mp4', 'content-length': String(length) });
      else { response.writeHead(206, intervalHeaders(chunk.length, length - 1, length)); response.end(chunk); }
    });
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) =>
      nativeConnect({ ...options, rejectUnauthorized: false })) as typeof tls.connect);
    const proxy = http.createServer();
    servers.push(proxy);
    proxy.on('connect', (_request, client, head) => {
      tunnels++;
      sockets.add(client); client.on('error', () => {});
      const upstream = net.connect({ host: '127.0.0.1', port: Number(new URL(origin).port) });
      sockets.add(upstream); upstream.on('error', () => client.destroy());
      upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
      client.once('close', () => { sockets.delete(client); upstream.destroy(); });
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    const result = await proxyPlayback(mediaUrl(origin, length), { proxyUrl });
    expect((await consume(result.body!)).bytes).toBe(length);
    expect(requests).toBe(2);
    expect(tunnels).toBe(2);
  });
});
