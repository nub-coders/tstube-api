import { Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Ctx } from '../httpServer.js';
const state = vi.hoisted(() => ({ awaitJob: vi.fn(), refresh: vi.fn(), playback: vi.fn(), manifest: vi.fn(), child: vi.fn() }));
vi.mock('../streamJobs.js', () => ({ AWAIT_TIMEOUT_S: 105, awaitStreamJob: (...a: unknown[]) => state.awaitJob(...a), refreshStreamUrl: (...a: unknown[]) => state.refresh(...a), ensureStreamJob: vi.fn(), resolveMode: (v: string) => v }));
vi.mock('../streamProxy.js', () => ({ proxyPlayback: (...a: unknown[]) => state.playback(...a) }));
vi.mock('../hlsProxy.js', () => ({ proxyHlsManifest: (...a: unknown[]) => state.manifest(...a), resolveHlsResource: (...a: unknown[]) => state.child(...a) }));
import { streamResolver } from '../apiRoutes.js';
const source = 'https://rr1.googlevideo.com/videoplayback?original=1';
const ctx = (): Ctx => ({ req: { headers: { range: 'bytes=0-100', 'user-agent': 'player' } }, params: { stream_id: 'id.secret' }, signal: new AbortController().signal } as unknown as Ctx);
const success = () => ({ status: 200, headers: { 'content-type': 'video/mp4' }, body: Readable.from([Buffer.from('media')]) });
beforeEach(() => {
  vi.clearAllMocks(); state.awaitJob.mockResolvedValue({ streamId: 'id', job: { url: 'abcdefghijk', mode: 'video', extracted_url: source, proxy_url: 'http://proxy.example:80' } });
  state.playback.mockReset().mockResolvedValue(success()); state.refresh.mockReset(); state.child.mockReset(); state.manifest.mockReset();
});
it('reports pending extraction with retry metadata rather than an extraction failure', async () => {
  state.awaitJob.mockResolvedValue({ streamId: 'id', job: { extracted_url: null, failed: false } });
  const c = ctx(); const r = await streamResolver(c);
  expect(r.status).toBe(202); expect(r.headers['retry-after']).toBe('2');
  expect(state.awaitJob).toHaveBeenCalledWith('id.secret',105,c.signal); expect(state.playback).not.toHaveBeenCalled();
});
it('distinguishes terminal upstream extraction failures', async () => {
  state.awaitJob.mockResolvedValue({ streamId: 'id', job: { extracted_url: null, failed: true } });
  expect((await streamResolver(ctx())).status).toBe(502);
});
it('refreshes a vanished CDN resource once and accepts a revalidated same URL', async () => {
  state.playback.mockResolvedValueOnce({ status: 404, headers: {}, body: null }).mockResolvedValueOnce(success());
  state.refresh.mockResolvedValue({ extracted_url: source, proxy_url: null });
  expect((await streamResolver(ctx())).status).toBe(200); expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(state.playback).toHaveBeenLastCalledWith(source, expect.objectContaining({ proxyUrl: null }));
});
it('does not perform a second extraction recovery after replacing a refused proxy', async () => {
  state.playback.mockResolvedValueOnce({ status: 502, headers: {}, body: null, error: { retriable: true } }).mockResolvedValueOnce({ status: 403, headers: {}, body: null });
  state.refresh.mockResolvedValue({ extracted_url: source + '&new=1', proxy_url: null });
  expect((await streamResolver(ctx())).status).toBe(403); expect(state.refresh).toHaveBeenCalledTimes(1);
});
it('routes explicit HLS jobs through manifest rewriting', async () => {
  state.awaitJob.mockResolvedValue({ streamId: 'id', job: { mode: 'audio', extracted_url: source, stream_type: 'hls', proxy_url: 'http://proxy.example:80' } });
  state.manifest.mockResolvedValue(success());
  expect((await streamResolver(ctx())).status).toBe(200); expect(state.playback).not.toHaveBeenCalled();
  const options = state.manifest.mock.calls[0]![1]; expect(options.mode).toBe('audio'); expect(options.proxyUrl).toBe('http://proxy.example:80'); expect(options.childUrl('hls_token')).toBe('/stream/proxy/hls_token');
});
it('routes opaque HLS child capabilities without invoking YouTube extraction', async () => {
  const c = ctx(); c.params.stream_id = 'hls_token'; state.child.mockResolvedValue(success());
  expect((await streamResolver(c)).status).toBe(200); expect(state.awaitJob).not.toHaveBeenCalled();
  expect(state.child).toHaveBeenCalledWith('hls_token',expect.objectContaining({ rangeHeader: 'bytes=0-100', signal: c.signal }));
});
