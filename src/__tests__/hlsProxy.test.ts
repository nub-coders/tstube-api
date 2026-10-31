import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createCipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const state = vi.hoisted(() => ({
  store: new Map<string, { value: string; expiresAt: number }>(),
  writes: [] as { key: string; ttl: number }[],
  failWrites: false,
  hostsAllowed: true,
  blockWrites: false,
  writeStarted: undefined as (() => void) | undefined,
}));

vi.mock('../redis.js', () => ({ redis: () => ({
  get: async (key: string) => {
    const entry = state.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) { state.store.delete(key); return null; }
    return entry.value;
  },
  set: async (key: string, value: string, ex: string, ttl: number, xx?: string) => {
    if (state.failWrites) throw new Error('Redis unavailable');
    if (state.blockWrites) { state.writeStarted?.(); await new Promise(() => {}); }
    if (ex !== 'EX') throw new Error('expected bounded EX');
    const old = state.store.get(key);
    if (xx === 'XX' && (!old || old.expiresAt <= Date.now())) return null;
    state.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    state.writes.push({ key, ttl });
    return 'OK';
  },
}) }));

vi.mock('../urlValidation.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../urlValidation.js')>(),
  isPublicHost: async () => state.hostsAllowed,
  isSafeProxyUrlSync: () => true,
}));

import {
  HLS_MANIFEST_MAX_BYTES, HLS_MANIFEST_MAX_CHILDREN, HLS_RESOURCE_TTL_S,
  probeHls, proxyHlsManifest, resolveHlsResource,
} from '../hlsProxy.js';
import { invalidateMediaProbe } from '../mediaProbe.js';

async function bodyOf(result: { body: Readable | null }): Promise<string> {
  let text = '';
  if (result.body) for await (const chunk of result.body) text += chunk.toString();
  return text;
}

const childUrl = (token: string): string => `/stream/proxy/${token}`;
const tokensOf = (text: string): string[] => text.match(/hls_[A-Za-z0-9_-]{43}/g) ?? [];
const tsBytes = Buffer.alloc(376, 0);
tsBytes[0] = 0x47;
tsBytes[188] = 0x47;
// Small, playable H.264/AAC fMP4 fixtures generated with FFmpeg (4s, 32x32, 2fps).
const fixture = {
  "part0.m4s": "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",
  "init.mp4": "H4sIAAAAAAAC/61TMU/bQBR+5yQMCImAEsoQiVQKqENAMdBMDFFZMnSrQKra5ZJzGgtfbPkuFjAgj/wERraqWzdWBqYO/QHdqqoS/4K+OzvN2UqiIvXZ53fP97179977DgBqA3kRuMJ/DWCB0jjaPDi0AUpN7vsRAHg8GjLISOFRK6LfqZAsKm93YKFY+DZlSM9w/lGe6ZiFBbs/L249HQAth0mB+pXjCTmNDfETSsZXz8kNZy5V3pzl65BkdPKg1e6QeeFkJXKZYyJP0fa7dMQ8R2HIMXdHA5xUIq43NcM2WLJWY6EzMI6yMg69elr2gpA9D+d3QgpmYD7TqG/PLVgdny7q7gRRfYv49v6ebe/ZrVbdc3vn++1Dw2MTS4KpIeqYvLlffvoJG59Q/9j+uqa6Q9SnuLq+c0ugOPx+FCO4HFARpOHVqPRkmNZ59TYZUBZS92AiaIu+YVfQvswdHjF932jOrwVcsWaxhDyfo42UKzWDKyTHjw/z+bHVmccP4Y9HJvId2szgx1LKj7LgmU3/gRvwLeXGVY4bI7zYdEYS5elRoe0IphtTiON4G+tYRP2iU/2bzlanhH9K1evT37CEM2JlW5xg/k+Locsj51yVVoZag0GrDK+NdWvGOh0zqTJ/zx05qcBLsx3YwpAGgWc6Nd2k540v0vd1yal21pvjvRngvTlQ1+YPTvjh40gFAAA=",
  "part1.m4s": "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"
};
const initBytes = gunzipSync(Buffer.from(fixture['init.mp4'], 'base64'));
const liveBytes = [fixture['part0.m4s'], fixture['part1.m4s']].map(value => gunzipSync(Buffer.from(value, 'base64')));
const encryptionKey = Buffer.alloc(16, 1);
const encryptionIv = Buffer.alloc(16);
function encrypt(bytes: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', encryptionKey, encryptionIv);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
const encryptedInit = encrypt(initBytes);
const encryptedLive = liveBytes.map(encrypt);
const aacBytes = Buffer.from('fff16c40039ffcde02004c61766335392e33372e313030000230400efff16c40017ffc01182007', 'hex');

describe('HLS capability relay', () => {
  let server: http.Server;
  let baseUrl: string;
  let sequence = 100;
  let closedSlow = false;
  let slowStarted: (() => void) | undefined;
  const requests: { url: string; range?: string; proxyAuth?: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const requested = req.url ?? '/';
      const path = requested.startsWith('http:') ? new URL(requested).pathname + new URL(requested).search : requested;
      requests.push({ url: path, range: req.headers.range, proxyAuth: req.headers['proxy-authorization'] });
      if (path === '/root') {
        res.writeHead(302, { location: '/signed/master.m3u8?sig=MASTER' }).end();
      } else if (path.startsWith('/signed/master.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'public,max-age=900' });
        res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio/list?sig=AUDIO,comma"\n' +
          '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=20000,URI="../iframe?sig=IFRAME"\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.42001e,mp4a.40.2",AUDIO="audio"\nvideo/playlist?sig=VIDEO\n');
      } else if (path === '/audio-only') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\nsigned/audio/list?sig=AUDIO\n');
      } else if (path === '/video-inband' || path === '/video-inband-no-audio') {
        const codecs = path === '/video-inband' ? 'avc1.42001e,mp4a.40.2' : 'avc1.42001e';
        res.writeHead(200).end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="inband",NAME="English",DEFAULT=YES\n' +
          `#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="${codecs}",AUDIO="inband"\n/signed/video/playlist?sig=VIDEO\n`);
      } else if (path === '/video-missing-audio-group' || path === '/video-dead-audio-group') {
        const rendition = path === '/video-dead-audio-group'
          ? '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="/dead-segment"\n' : '';
        res.writeHead(200).end('#EXTM3U\n' + rendition +
          '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.42001e,mp4a.40.2",AUDIO="audio"\n/signed/video/playlist?sig=VIDEO\n');
      } else if (path === '/dead-segment') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/missing-segment\n');
      } else if (path === '/all-attributes') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n' +
          '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="/key?sig=SESSION,comma"\n' +
          '#EXT-X-PART:DURATION=0.5,URI="/segment/100?sig=PART"\n' +
          '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="/segment/101?sig=NEXT"\n' +
          '#EXT-X-RENDITION-REPORT:URI="/signed/video/playlist?sig=REPORT",LAST-MSN=100\n' +
          '#EXT-X-SESSION-DATA:DATA-ID="info",URI="/metadata?sig=DATA"\n' +
          '#EXTINF:2,\n/segment/100?sig=TSSEGMENT\n');
      } else if (path === '/quoted-name') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="English,URI=unused",GROUP-ID="a",URI="/signed/audio/list?sig=AUDIO"\n');
      } else if (path === '/malformed-attribute') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="/key" https://leak.test/key?sig=LEAK\n#EXTINF:2,\n/segment/100\n');
      } else if (path === '/interstitial') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-DATERANGE:ID="ad",X-ASSET-URI="https://leak.test/ad?sig=LEAK"\n#EXTINF:2,\n/segment/100\n');
      } else if (path === '/prefetch') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/segment/100\n#EXT-X-PREFETCH:https://leak.test/next?sig=LEAK\n');
      } else if (path === '/hint') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/segment/100?sig=HINT\n#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="/future-unavailable-map"\n');
      } else if (path.startsWith('/signed/video/playlist')) {
        const segmentBytes = encryptedLive[(sequence - 100) % encryptedLive.length];
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n` +
          '#EXT-X-KEY:METHOD=AES-128,URI="../../key?sig=KEY,comma",IV=0x00000000000000000000000000000000\n#EXT-X-MAP:URI="../../init?sig=INIT"\n' +
          `#EXT-X-BYTERANGE:${segmentBytes.length}@0\n#EXTINF:2,\n../../segment/${sequence}?sig=SEGMENT\n`);
      } else if (path.startsWith('/signed/audio/list')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n../../segment/${sequence}?sig=AUDIOSEGMENT\n`);
      } else if (path.startsWith('/segment/')) {
        const bytes = path.includes('sig=SEGMENT') ? encryptedLive[(Number(/\/segment\/(\d+)/.exec(path)![1]) - 100) % encryptedLive.length]
          : path.includes('AUDIOSEGMENT') ? aacBytes : tsBytes;
        const hasRange = !!req.headers.range;
        res.writeHead(hasRange ? 206 : 200, {
          'content-type': path.includes('AUDIOSEGMENT') ? 'audio/aac' : 'video/mp4', 'content-length': String(bytes.length),
          ...(hasRange ? { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` } : {}),
        }).end(bytes);
      } else if (path.startsWith('/key')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(16, 1));
      } else if (path.startsWith('/init')) {
        res.writeHead(200, { 'content-type': 'video/mp4' }).end(encryptedInit);
      } else if (path === '/oversize') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n' + 'x'.repeat(HLS_MANIFEST_MAX_BYTES));
      } else if (path === '/too-many') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n' + Array.from({ length: HLS_MANIFEST_MAX_CHILDREN + 1 }, (_, i) => `#EXTINF:2,\n/segment/${i}\n`).join(''));
      } else if (path === '/invalid') {
        res.writeHead(200).end('<html>upstream error</html>');
      } else if (path === '/unsafe') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfile:///etc/passwd\n');
      } else if (path === '/variables') {
        res.writeHead(200).end('#EXTM3U\n#EXT-X-DEFINE:NAME="secret",VALUE="signed-url"\n#EXTINF:2,\nsegment/{$secret}\n');
      } else if (path === '/slow') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.write('#EXTM3U\n#EXT-X-TARGETDURATION:2\n');
        res.once('close', () => { closedSlow = true; });
        slowStarted?.();
      } else res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    state.store.clear(); state.writes.length = 0; state.failWrites = false; state.hostsAllowed = true;
    state.blockWrites = false; state.writeStarted = undefined;
    requests.length = 0; sequence = 100; closedSlow = false; slowStarted = undefined;
    invalidateMediaProbe(`${baseUrl}/segment/100?sig=AUDIOSEGMENT`);
  });

  it('rewrites extensionless playlist lines and quoted URI attributes against the redirected origin', async () => {
    const result = await proxyHlsManifest(`${baseUrl}/root`, { scope: 'parent.random-secret', childUrl });
    const text = await bodyOf(result);
    expect(result.status).toBe(200);
    expect(text).not.toMatch(/sig=|127\.0\.0\.1|MASTER|AUDIO,comma|VIDEO|IFRAME/);
    expect(tokensOf(text)).toHaveLength(2);
    expect(result.headers).toEqual({ 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(text)) });
    const stored = [...state.store.values()].map(entry => JSON.parse(entry.value));
    expect(stored.map(entry => entry.url)).toEqual(expect.arrayContaining([
      `${baseUrl}/signed/audio/list?sig=AUDIO,comma`, `${baseUrl}/signed/video/playlist?sig=VIDEO`,
    ]));
    expect(stored.every(entry => entry.kind === 'manifest')).toBe(true);
    expect(state.writes.every(write => write.ttl > 0 && write.ttl <= 14400)).toBe(true);
  });

  it('keeps polling the same media capability while sequence and segment tokens advance', async () => {
    const master = await proxyHlsManifest(`${baseUrl}/root`, { scope: 'parent.secret', childUrl });
    const masterText = await bodyOf(master);
    const videoToken = tokensOf(masterText)[1];
    const first = await resolveHlsResource(videoToken, { childUrl, rangeHeader: 'bytes=0-5' });
    const firstText = await bodyOf(first!);
    expect(firstText).toContain('#EXT-X-MEDIA-SEQUENCE:100');
    expect(firstText).toContain(`#EXT-X-BYTERANGE:${encryptedLive[0].length}@0`);
    expect(firstText).not.toContain('sig=');
    expect(tokensOf(firstText)).toHaveLength(3); // key, map, segment
    expect(requests.find(request => request.url.startsWith('/signed/video/playlist'))?.range).toBeUndefined();
    sequence++;
    const second = await resolveHlsResource(videoToken, { childUrl });
    const secondText = await bodyOf(second!);
    expect(secondText).toContain('#EXT-X-MEDIA-SEQUENCE:101');
    expect(tokensOf(secondText).slice(0, 2)).toEqual(tokensOf(firstText).slice(0, 2));
    expect(tokensOf(secondText)[2]).not.toBe(tokensOf(firstText)[2]);
  });

  it('preserves pinned proxy credentials server-side and forwards segment ranges', async () => {
    const proxyUrl = `http://account:private-password@127.0.0.1:${(server.address() as AddressInfo).port}`;
    const playlist = await proxyHlsManifest(`${baseUrl}/signed/video/playlist?sig=VIDEO`, { scope: 'parent.secret', proxyUrl, childUrl });
    const text = await bodyOf(playlist);
    expect(text).not.toMatch(/private-password|sig=|127\.0\.0\.1/);
    requests.length = 0;
    const segment = await resolveHlsResource(tokensOf(text)[2], { childUrl, rangeHeader: `bytes=0-${encryptedLive[0].length - 1}`, proxyUrl: null });
    expect(segment?.status).toBe(206);
    expect(Buffer.byteLength(await bodyOf(segment!))).toBeGreaterThan(0);
    const fetched = requests.find(request => request.url.startsWith('/segment/'));
    expect(fetched?.range).toBe(`bytes=0-${encryptedLive[0].length - 1}`);
    expect(fetched?.proxyAuth).toBe(`Basic ${Buffer.from('account:private-password').toString('base64')}`);
  });

  it('rewrites low-latency parts, hints, session resources, and rendition reports', async () => {
    const result = await proxyHlsManifest(`${baseUrl}/all-attributes`, { scope: 'parent.secret', childUrl });
    const text = await bodyOf(result);
    expect(result.status).toBe(200);
    expect(text).not.toContain('sig=');
    expect(tokensOf(text)).toHaveLength(5);
    const stored = [...state.store.values()].map(entry => JSON.parse(entry.value));
    expect(stored.filter(entry => entry.kind === 'manifest')).toHaveLength(0);
    expect(stored.filter(entry => entry.kind === 'segment')).toHaveLength(5);
    expect(state.writes.filter(write => !JSON.parse(state.store.get(write.key)!.value).sessionKey).every(write => write.ttl <= HLS_RESOURCE_TTL_S)).toBe(true);
  });

  it('parses attribute commas inside quoted display names without inventing URI fields', async () => {
    const result = await proxyHlsManifest(`${baseUrl}/quoted-name`, { scope: 'parent.secret', mode: 'audio', childUrl });
    const text = await bodyOf(result);
    expect(result.status).toBe(200);
    expect(text).toContain('#EXTINF:2,');
    expect(tokensOf(text)).toHaveLength(1);
    expect(text).not.toContain('sig=AUDIO');
  });

  it('streams successive live segments and can switch to a previously unused variant after five minutes', async () => {
    const masterText = await bodyOf(await proxyHlsManifest(`${baseUrl}/root`, { scope: 'parent.secret', childUrl }));
    const [audioToken, videoToken] = tokensOf(masterText);
    const firstText = await bodyOf((await resolveHlsResource(videoToken, { childUrl }))!);
    const firstSegment = await resolveHlsResource(tokensOf(firstText)[2], { childUrl });
    expect(await bodyOf(firstSegment!)).toBe(encryptedLive[0].toString());
    const advanced = Date.now() + 310_000;
    const date = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      sequence = 101;
      const secondText = await bodyOf((await resolveHlsResource(videoToken, { childUrl }))!);
      expect(secondText).toContain('#EXT-X-MEDIA-SEQUENCE:101');
      const secondSegment = await resolveHlsResource(tokensOf(secondText)[2], { childUrl });
      expect(await bodyOf(secondSegment!)).toBe(encryptedLive[1].toString());
      const alternate = await resolveHlsResource(audioToken, { childUrl });
      expect(alternate?.status).toBe(200);
      const alternateText = await bodyOf(alternate!);
      expect(await bodyOf((await resolveHlsResource(tokensOf(alternateText)[0], { childUrl }))!)).toBe(aacBytes.toString());
      expect(requests.filter(request => request.url.startsWith('/segment/')).map(request => request.url)).toEqual(expect.arrayContaining([
        '/segment/100?sig=SEGMENT', '/segment/101?sig=SEGMENT', '/segment/101?sig=AUDIOSEGMENT',
      ]));
    } finally { date.mockRestore(); }
  });

  it('reuses capabilities with a fixed authority deadline and does not renew a lookup', async () => {
    const expiresAt = Date.now() + 600_000;
    const options = { scope: 'parent.secret', expiresAt, childUrl };
    const first = await bodyOf(await proxyHlsManifest(`${baseUrl}/root`, options));
    const second = await bodyOf(await proxyHlsManifest(`${baseUrl}/root`, options));
    expect(tokensOf(second)).toEqual(tokensOf(first));
    const token = tokensOf(first)[1];
    const entry = state.store.get(`hls_resource:${token}`)!;
    entry.expiresAt = Date.now() + 10_000;
    await bodyOf((await resolveHlsResource(token, { childUrl }))!);
    expect(state.store.get(`hls_resource:${token}`)!.expiresAt).toBe(entry.expiresAt);
    expect(JSON.parse(state.store.get(`hls_resource:${token}`)!.value).expiresAt).toBe(expiresAt);
    const resource = JSON.parse(state.store.get(`hls_resource:${token}`)!.value);
    resource.expiresAt = Date.now() - 1;
    state.store.set(`hls_resource:${token}`, { value: JSON.stringify(resource), expiresAt: Date.now() + 5000 });
    expect(await resolveHlsResource(token, { childUrl })).toBeNull();
  });

  it('rejects forged or expired tokens without dialing a caller-controlled URL', async () => {
    expect(await resolveHlsResource(`hls_${'a'.repeat(43)}`, { childUrl })).toBeNull();
    expect(await resolveHlsResource(`${baseUrl}/segment/100`, { childUrl })).toBeNull();
    const text = await bodyOf(await proxyHlsManifest(`${baseUrl}/root`, { scope: 'parent.secret', childUrl }));
    const token = tokensOf(text)[1];
    state.store.get(`hls_resource:${token}`)!.expiresAt = Date.now() - 1;
    requests.length = 0;
    expect(await resolveHlsResource(token, { childUrl })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it.each(['/oversize', '/too-many', '/invalid', '/unsafe', '/variables', '/malformed-attribute', '/interstitial', '/prefetch'])('fails closed for %s without issuing child tokens', async path => {
    const result = await proxyHlsManifest(baseUrl + path, { scope: 'parent.secret', childUrl });
    expect(result.status).toBe(502);
    expect(result.body).toBeNull();
    expect(state.store.size).toBe(0);
  });

  it('never returns an unrewritten playlist when registry writes fail', async () => {
    state.failWrites = true;
    const result = await proxyHlsManifest(`${baseUrl}/root`, { scope: 'parent.secret', childUrl });
    expect(result.status).toBe(502);
    expect(result.body).toBeNull();
    expect(JSON.stringify(result.error)).not.toContain('sig=');
  });

  it('cancels an unfinished manifest and closes its upstream connection', async () => {
    const controller = new AbortController();
    const started = new Promise<void>(resolve => { slowStarted = resolve; });
    const pending = proxyHlsManifest(`${baseUrl}/slow`, { scope: 'parent.secret', signal: controller.signal, childUrl });
    await started;
    controller.abort();
    expect((await pending).status).toBe(499);
    await vi.waitFor(() => expect(closedSlow).toBe(true));
    expect(state.store.size).toBe(0);
  });

  it('returns promptly on cancellation while a Redis mint is pending', async () => {
    state.blockWrites = true;
    const started = new Promise<void>(resolve => { state.writeStarted = resolve; });
    const controller = new AbortController();
    const pending = proxyHlsManifest(`${baseUrl}/root`, { scope: 'parent.secret', signal: controller.signal, childUrl });
    await started;
    controller.abort();
    expect((await pending).status).toBe(499);
  });

  it('probes an audio rendition and a real segment without needing Redis resources', async () => {
    expect(await probeHls(`${baseUrl}/root`, { mode: 'audio' })).toBe(true);
    expect(requests.some(request => request.url.startsWith('/signed/audio/list'))).toBe(true);
    expect(requests.some(request => request.url.startsWith('/segment/'))).toBe(true);
    expect(state.store.size).toBe(0);
  });

  it('rejects audio-only masters for video mode and verifies an actual video variant', async () => {
    expect(await probeHls(`${baseUrl}/audio-only`, { mode: 'video' })).toBe(false);
    expect(requests.some(request => request.url.startsWith('/segment/'))).toBe(false);
    expect(await probeHls(`${baseUrl}/root`, { mode: 'video' })).toBe(true);
    expect(requests.some(request => request.url.startsWith('/signed/video/playlist'))).toBe(true);
  });

  it('returns the selected audio-only media playlist directly', async () => {
    const result = await proxyHlsManifest(`${baseUrl}/audio-only`, { scope: 'parent.secret', mode: 'audio', childUrl });
    const text = await bodyOf(result);
    expect(result.status).toBe(200);
    expect(text).toContain('#EXTINF:2,');
    expect(text).not.toMatch(/#EXT-X-(?:STREAM-INF|MEDIA):|sig=/);
    expect(tokensOf(text)).toHaveLength(1);
    expect(await bodyOf((await resolveHlsResource(tokensOf(text)[0], { childUrl }))!)).toBe(aacBytes.toString());
  });

  it('requires audio codec evidence when the selected audio group is in-band', async () => {
    expect(await probeHls(`${baseUrl}/video-inband-no-audio`, { mode: 'video' })).toBe(false);
    const rejected = await proxyHlsManifest(`${baseUrl}/video-inband-no-audio`, { scope: 'parent.secret', childUrl });
    expect(rejected.status).toBe(502);
    expect(state.store.size).toBe(0);
    expect(requests.some(request => request.url.startsWith('/signed/video/playlist'))).toBe(false);

    expect(await probeHls(`${baseUrl}/video-inband`, { mode: 'video' })).toBe(true);
    const accepted = await proxyHlsManifest(`${baseUrl}/video-inband`, { scope: 'parent.secret', childUrl });
    expect(accepted.status).toBe(200);
    expect(tokensOf(await bodyOf(accepted))).toHaveLength(1);
  });

  it.each(['/video-missing-audio-group', '/video-dead-audio-group'])('rejects %s when the required audio group cannot play', async path => {
    expect(await probeHls(baseUrl + path, { mode: 'video' })).toBe(false);
    const result = await proxyHlsManifest(baseUrl + path, { scope: 'parent.secret', childUrl });
    expect(result.status).toBe(502);
    expect(state.store.size).toBe(0);
  });

  it('rejects a valid media playlist whose actual segment cannot be fetched', async () => {
    expect(await probeHls(`${baseUrl}/dead-segment`, { mode: 'audio' })).toBe(false);
    expect(state.store.size).toBe(0);
  });

  it('probes available media while ignoring an unavailable future preload hint', async () => {
    expect(await probeHls(`${baseUrl}/hint`, { mode: 'audio' })).toBe(true);
    expect(requests.some(request => request.url === '/future-unavailable-map')).toBe(false);
  });
});
