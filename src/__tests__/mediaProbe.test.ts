import { PassThrough, Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const upstream = vi.hoisted(() => vi.fn());
vi.mock('../streamProxy.js', () => ({ proxyStream: upstream }));
import { invalidateMediaProbe, MEDIA_PROBE_BYTES, MEDIA_PROBE_CONCURRENCY, MEDIA_PROBE_TIMEOUT_MS, probeMedia } from '../mediaProbe.js';
import { withRequestDeadline } from '../requestDeadline.js';

const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
let sequence = 0;
const url = () => `https://cdn.example.com/${sequence++}`;
function response(bytes: Buffer | string = mp4, type = 'video/mp4') {
  return { status: 200, headers: { 'content-type': type }, body: Readable.from([bytes]) };
}
afterEach(() => { vi.useRealTimers(); upstream.mockReset(); });

it.each([
  ['MP4', mp4, 'video/mp4'],
  ['M4A', mp4, 'audio/mp4; codecs="mp4a.40.2"'],
  ['WebM', Buffer.from('1a45dfa39f4286810142f7810142f28104', 'hex'), 'audio/webm'],
  ['MP3', Buffer.from('49443304000000000000000000000000', 'hex'), 'audio/mpeg'],
  ['MPEG audio frame', Buffer.from('fffb9064000000000000000000000000', 'hex'), 'audio/mpeg'],
  ['AAC', Buffer.from('fff1508001bffc000000000000000000', 'hex'), 'audio/aac'],
  ['Ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)]), 'application/ogg'],
  ['FLAC', Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(40)]), 'audio/flac'],
  ['WAV', Buffer.from('RIFF1234WAVEfmt '), 'audio/wav'],
  ['MPEG TS', Buffer.concat([Buffer.from([0x47]), Buffer.alloc(187), Buffer.from([0x47]), Buffer.alloc(187)]), 'video/mp2t'],
  ['generic binary', mp4, 'application/octet-stream'],
  ['missing type', mp4, ''],
  ['HLS live media', '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment.ts\n', 'application/vnd.apple.mpegurl'],
  ['HLS master', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nvariant.m3u8\n', 'application/x-mpegurl'],
  ['HLS plain text', '\uFEFF#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nvariant.m3u8\n', 'text/plain'],
])('accepts a %s prefix', async (_name, bytes, type) => {
  const result = response(bytes, type);
  upstream.mockResolvedValue(result);
  expect(await probeMedia(url())).toBe(true);
  expect(result.body.destroyed).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(1); // No manifest/segment traversal.
});

it.each([
  ['HTML', '<html>Access denied</html>', 'text/html'],
  ['JSON', '{"error":"expired"}', 'application/json'],
  ['mislabeled HTML', '<html>Access denied</html>', 'video/mp4'],
  ['mislabeled JSON', '{"error":"expired"}', 'audio/mpeg'],
  ['one byte', Buffer.from([1]), 'video/mp4'],
  ['empty', Buffer.alloc(0), 'video/mp4'],
  ['unrecognized binary', Buffer.alloc(100), 'video/mp4'],
  ['wrong MIME', mp4, 'text/html'],
  ['empty HLS', '#EXTM3U\n', 'application/x-mpegurl'],
  ['HLS without a URI', '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n', 'application/x-mpegurl'],
  ['HLS without stream tags', '#EXTM3U\nrandom.mp3\n', 'audio/mpegurl'],
  ['HLS with invalid URI', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\njavascript:bad\n', 'application/x-mpegurl'],
])('rejects %s', async (_name, bytes, type) => {
  const result = response(bytes, type);
  upstream.mockResolvedValue(result);
  expect(await probeMedia(url())).toBe(false);
  expect(result.body.destroyed).toBe(true);
});

it.each([204, 302, 403, 404, 410, 416, 500])('rejects HTTP %s and closes its body', async status => {
  const result = { ...response(), status };
  upstream.mockResolvedValue(result);
  expect(await probeMedia(url())).toBe(false);
  expect(result.body.destroyed).toBe(true);
});

it.each(['', 'bytes 10-33/100', 'bytes 0-23/23', 'bytes 0-16384/*', 'bytes 0-100/1000', 'garbage'])('rejects an invalid or unfulfilled partial range: %s', async range => {
  upstream.mockResolvedValue({ ...response(), status: 206, headers: { 'content-type': 'video/mp4', 'content-range': range } });
  expect(await probeMedia(url())).toBe(false);
});

it('accepts a valid partial response and forwards the exact proxy binding', async () => {
  const target = url();
  upstream.mockResolvedValue({ ...response(), status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-23/1000', 'content-length': '24' } });
  expect(await probeMedia(target, { proxyUrl: 'https://u:p@proxy.example.com:8000' })).toBe(true);
  expect(upstream).toHaveBeenCalledWith(target, expect.objectContaining({ proxyUrl: 'https://u:p@proxy.example.com:8000', rangeHeader: 'bytes=0-16383' }));
});

it.each([{ 'content-length': '100' }, { 'content-length': '0' }, { 'content-encoding': 'gzip' }])('rejects truncated or encoded content: %j', async headers => {
  upstream.mockResolvedValue({ ...response(), headers: { 'content-type': 'video/mp4', ...headers } });
  expect(await probeMedia(url())).toBe(false);
});

it('stops at the byte limit when Range is ignored', async () => {
  const body = new PassThrough();
  upstream.mockResolvedValue({ ...response(), body });
  const pending = probeMedia(url());
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
  body.write(Buffer.concat([mp4, Buffer.alloc(MEDIA_PROBE_BYTES * 8)]));
  expect(await pending).toBe(true);
  expect(body.destroyed).toBe(true);
  expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
});

it('bounds stalled headers and body reads, leaving failures uncached', async () => {
  vi.useFakeTimers();
  const target = url();
  let signal!: AbortSignal;
  upstream.mockImplementationOnce((_url, options) => new Promise(resolve => {
    signal = options.signal;
    signal.addEventListener('abort', () => resolve({ status: 499, headers: {}, body: null }), { once: true });
  }));
  const headers = probeMedia(target);
  await vi.advanceTimersByTimeAsync(MEDIA_PROBE_TIMEOUT_MS);
  expect(await headers).toBe(false);
  expect(signal.aborted).toBe(true);
  const body = new PassThrough();
  upstream.mockResolvedValueOnce({ ...response(), body });
  const stalled = probeMedia(target);
  await vi.advanceTimersByTimeAsync(1);
  body.write(mp4); // Even a signature cannot turn an unfinished short read into success.
  await vi.advanceTimersByTimeAsync(MEDIA_PROBE_TIMEOUT_MS);
  expect(await stalled).toBe(false);
  expect(body.destroyed).toBe(true);
  upstream.mockImplementation(async () => response());
  expect(await probeMedia(target)).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(3);
});

it('caches successes for five minutes with separate URL and proxy identities', async () => {
  vi.useFakeTimers();
  const target = url();
  upstream.mockImplementation(async () => response());
  expect(await probeMedia(target)).toBe(true);
  expect(await probeMedia(target)).toBe(true);
  for (const proxyUrl of ['http://a:b@exit.example.com', 'https://a:b@exit.example.com', 'http://a:c@exit.example.com']) {
    expect(await probeMedia(target, { proxyUrl })).toBe(true);
    expect(await probeMedia(target, { proxyUrl })).toBe(true);
  }
  expect(upstream).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(300_001);
  expect(await probeMedia(target)).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(5);
});

it('expires successful checks at the signed URL expiry when earlier', async () => {
  vi.useFakeTimers();
  const target = `${url()}?expire=${Math.floor(Date.now() / 1000) + 2}`;
  upstream.mockImplementation(async () => response());
  expect(await probeMedia(target)).toBe(true);
  await vi.advanceTimersByTimeAsync(2_001);
  upstream.mockResolvedValue({ status: 403, headers: {}, body: null });
  expect(await probeMedia(target)).toBe(false);
  expect(upstream).toHaveBeenCalledTimes(2);
});

it('coalesces duplicates without letting one caller cancel another', async () => {
  const target = url();
  const controller = new AbortController();
  const body = new PassThrough();
  upstream.mockResolvedValue({ ...response(), body });
  const first = probeMedia(target, { signal: controller.signal });
  const second = probeMedia(target);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
  controller.abort();
  expect(await first).toBe(false);
  expect(upstream.mock.calls[0][1].signal.aborted).toBe(false);
  body.end(mp4);
  expect(await second).toBe(true);
  expect(await probeMedia(target)).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it('cancels the transport when its last subscriber leaves and allows a fresh probe', async () => {
  const target = url();
  const controller = new AbortController();
  const body = new PassThrough();
  upstream.mockResolvedValueOnce({ ...response(), body });
  const pending = probeMedia(target, { signal: controller.signal });
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
  controller.abort();
  expect(await pending).toBe(false);
  expect(body.destroyed).toBe(true);
  upstream.mockImplementation(async () => response());
  expect(await probeMedia(target)).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(2);
});

it('honors the extraction deadline and removes queued work without opening a connection', async () => {
  vi.useFakeTimers();
  const bodies: PassThrough[] = [];
  upstream.mockImplementation(async () => {
    const body = new PassThrough(); bodies.push(body);
    return { ...response(), body };
  });
  const pending = Array.from({ length: 10 }, () => probeMedia(url()));
  const queued = withRequestDeadline(100, 'probe scope', () => probeMedia(url())).catch(() => false);
  await vi.advanceTimersByTimeAsync(101);
  expect(await queued).toBe(false);
  expect(upstream).toHaveBeenCalledTimes(MEDIA_PROBE_CONCURRENCY);
  await vi.advanceTimersByTimeAsync(MEDIA_PROBE_TIMEOUT_MS);
  expect(await Promise.all(pending)).toEqual(Array(10).fill(false));
  expect(upstream).toHaveBeenCalledTimes(MEDIA_PROBE_CONCURRENCY);
  expect(bodies.every(body => body.destroyed)).toBe(true);
  upstream.mockImplementation(async () => response());
  expect(await probeMedia(url())).toBe(true);
});

it('limits concurrency and starts queued probes as capacity becomes available', async () => {
  const bodies: PassThrough[] = [];
  upstream.mockImplementation(async () => {
    const body = new PassThrough(); bodies.push(body);
    return { ...response(), body };
  });
  const pending = Array.from({ length: 9 }, () => probeMedia(url()));
  await vi.waitFor(() => expect(bodies).toHaveLength(MEDIA_PROBE_CONCURRENCY));
  bodies[0].end(mp4);
  await vi.waitFor(() => expect(bodies).toHaveLength(MEDIA_PROBE_CONCURRENCY + 1));
  expect(bodies.filter(body => !body.destroyed)).toHaveLength(MEDIA_PROBE_CONCURRENCY);
  for (let index = 1; index < pending.length; index++) {
    await vi.waitFor(() => expect(bodies[index]).toBeDefined());
    bodies[index].end(mp4);
  }
  expect(await Promise.all(pending)).toEqual(Array(9).fill(true));
});

it('bounds the pending queue and rejects excess distinct routes immediately', async () => {
  vi.useFakeTimers();
  upstream.mockImplementation(async () => ({ ...response(), body: new PassThrough() }));
  const pending = Array.from({ length: 80 }, () => probeMedia(url()));
  expect(await pending[64]).toBe(false);
  await vi.advanceTimersByTimeAsync(MEDIA_PROBE_TIMEOUT_MS);
  expect(await Promise.all(pending)).toEqual(Array(80).fill(false));
  expect(upstream).toHaveBeenCalledTimes(MEDIA_PROBE_CONCURRENCY);
});

it('does not cache a body that fails mid-transfer', async () => {
  const target = url();
  const body = new PassThrough();
  upstream.mockResolvedValueOnce({ ...response(), body });
  const pending = probeMedia(target);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
  body.write(mp4);
  body.destroy(new Error('connection reset'));
  expect(await pending).toBe(false);
  upstream.mockImplementation(async () => response());
  expect(await probeMedia(target)).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(2);
});

it('invalidates cached and in-flight successes without allowing stale publication', async () => {
  const target = url();
  upstream.mockImplementation(async () => response());
  expect(await probeMedia(target)).toBe(true);
  invalidateMediaProbe(target);
  const body = new PassThrough();
  upstream.mockResolvedValueOnce({ ...response(), body });
  const pending = probeMedia(target);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2));
  invalidateMediaProbe(target);
  body.end(mp4);
  expect(await pending).toBe(false);
  expect(await probeMedia(target)).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(3);
});
