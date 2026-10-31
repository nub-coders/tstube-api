import http from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../urlValidation.js', async original => ({
  ...await original<typeof import('../urlValidation.js')>(),
  isPublicHost: async () => true,
  isSafeProxyUrlSync: () => true,
}));
vi.mock('../proxy.js', () => ({ websharePool: { evictByUrl: vi.fn() } }));
import { probeMedia, MEDIA_PROBE_BYTES } from '../mediaProbe.js';

const data = Buffer.alloc(MEDIA_PROBE_BYTES);
Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex').copy(data);
const servers: http.Server[] = [];
const sockets = new Set<Socket>();
const lookup = http.globalAgent.options.lookup;
beforeEach(() => {
  http.globalAgent.options.lookup = ((_host: string, opts: any, callback: any) => {
    if (opts.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  }) as typeof lookup;
});
afterEach(async () => {
  http.globalAgent.options.lookup = lookup;
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function serve(handler: http.RequestListener, cdn = true): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return `http://${cdn ? 'rr1.googlevideo.com' : '127.0.0.1'}:${port}/videoplayback`;
}
function media(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.headers.range) {
    res.writeHead(206, { 'content-type': 'audio/mp4', 'content-length': String(data.length), 'content-range': `bytes 0-${data.length-1}/1000000` });
  } else {
    res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': String(data.length) });
  }
  res.end(data);
}

it.each([403, 404])('rejects a URL whose sample works but whose ordinary GET returns %s', async status => {
  const url = await serve((req, res) => {
    if (req.headers.range) media(req, res);
    else { res.writeHead(status); res.end(); }
  });
  expect(await probeMedia(url)).toBe(false);
});

it('requires and coalesces both ordinary GET and range checks for a valid source', async () => {
  const ranges: Array<string | undefined> = [];
  const url = await serve((req, res) => { ranges.push(req.headers.range); media(req, res); });
  expect(await Promise.all([probeMedia(url), probeMedia(url)])).toEqual([true, true]);
  expect(ranges).toEqual([undefined, 'bytes=0-16383']);
  expect(await probeMedia(url)).toBe(true);
  expect(ranges).toHaveLength(2);
});

it('still rejects a bad range response after an ordinary GET passes', async () => {
  const url = await serve((req, res) => {
    if (req.headers.range) { res.writeHead(416); res.end(); }
    else media(req, res);
  });
  expect(await probeMedia(url)).toBe(false);
});

it('uses the same proxy credentials for both playback checks', async () => {
  const ranges: Array<string | undefined> = [];
  const auth: Array<string | undefined> = [];
  const proxy = new URL(await serve((req, res) => {
    expect(req.url).toBe('http://rr1.googlevideo.com/videoplayback');
    ranges.push(req.headers.range);
    auth.push(req.headers['proxy-authorization']);
    media(req, res);
  }, false));
  const proxyUrl = `http://probe:secret@${proxy.host}`;
  expect(await probeMedia('http://rr1.googlevideo.com/videoplayback', { proxyUrl })).toBe(true);
  expect(ranges).toEqual([undefined, 'bytes=0-16383']);
  expect(auth).toEqual(Array(2).fill('Basic ' + Buffer.from('probe:secret').toString('base64')));
});

it('bounds an ongoing ordinary GET and closes it before requesting a range', async () => {
  let closed = false;
  const url = await serve((req, res) => {
    if (req.headers.range) { media(req, res); return; }
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.write(data);
    res.once('close', () => { closed = true; });
  });
  expect(await probeMedia(url)).toBe(true);
  await vi.waitFor(() => expect(closed).toBe(true));
});

it('honors the caller deadline during the ordinary GET and never starts the range', async () => {
  let requests = 0;
  let closed = false;
  const url = await serve((_req, res) => {
    requests++;
    res.once('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.write(data.subarray(0, 24));
  });
  expect(await probeMedia(url, { deadline: Date.now() + 150 })).toBe(false);
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(requests).toBe(1);
});
