import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StreamJobRedis } from './helpers/streamJobRedis.js';
const state = vi.hoisted(() => ({ redis: null as unknown as StreamJobRedis, audio: vi.fn(), video: vi.fn() }));
vi.mock('../redis.js', () => ({ redis: () => state.redis }));
vi.mock('../cacheManager.js', () => ({ PROXY_STREAM_TTL_S: 3600, getStream: (...args: unknown[]) => state.audio(...args), getVideoStream: (...args: unknown[]) => state.video(...args), invalidate: async () => {} }));
import { ensureStreamJob, awaitStreamJob, encodeStreamId, resetJobState, refreshStreamUrl } from '../streamJobs.js';
const target = 'https://www.youtube.com/watch?v=abcdefghijk';
const media = 'https://rr1.googlevideo.com/videoplayback?fresh=1';
const drain = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
beforeEach(() => {
  state.redis = new StreamJobRedis(); state.audio.mockReset().mockResolvedValue({ url: media, proxyUrl: null }); state.video.mockReset().mockResolvedValue(null); resetJobState();
});
afterEach(() => { vi.useRealTimers(); resetJobState(); });
it('waits for a valid extraction completing after the old 45-second resolver cutoff', async () => {
  vi.useFakeTimers(); let finish!: (x: unknown) => void;
  state.audio.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const cap = await ensureStreamJob(target, 'audio'); let settled = false;
  const waiting = awaitStreamJob(cap).then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(60_000);
  const settledEarly = settled;
  finish({ url: media, proxyUrl: null }); await vi.advanceTimersByTimeAsync(0);
  expect(settledEarly).toBe(false); expect((await waiting)?.job.extracted_url).toBe(media);
});
it('lazily replaces an old ready job while preserving its issued capability', async () => {
  const id = encodeStreamId(target, 'audio'), secret = 'existing-secret';
  state.redis.store.set('stream_job:' + id, JSON.stringify({ url: target, mode: 'audio', secret, extracted_url: 'https://rr1.googlevideo.com/old', extracted_time: 1 }));
  const result = await awaitStreamJob(id + '.' + secret);
  expect(result?.job.extracted_url).toBe(media); expect(result?.job.secret).toBe(secret);
  expect(state.audio).toHaveBeenCalledTimes(1);
});
it('never publishes audio as a successful video job', async () => {
  vi.useFakeTimers();
  const cap = await ensureStreamJob(target, 'video'); await vi.advanceTimersByTimeAsync(1100);
  expect(state.audio).not.toHaveBeenCalled();
  const resolved = await awaitStreamJob(cap, 0); expect(resolved?.job.failed).toBe(true); expect(resolved?.job.extracted_url).toBeNull();
});
it('preserves HLS source type through the job publication boundary', async () => {
  state.audio.mockResolvedValue({ url: media, proxyUrl: null, streamType: 'hls' });
  const cap = await ensureStreamJob(target, 'audio');
  expect((await awaitStreamJob(cap))?.job).toMatchObject({ stream_type: 'hls' });
});
it('cancels a disconnected resolver wait without cancelling the shared extraction', async () => {
  let finish!: (x: unknown) => void;
  state.audio.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const cap = await ensureStreamJob(target, 'audio'); const ctl = new AbortController();
  const waiting = awaitStreamJob(cap, 105, ctl.signal); void waiting.catch(() => {}); await drain();
  ctl.abort(new Error('client disconnected'));
  const rejection = expect(waiting).rejects.toThrow('client disconnected');
  finish({ url: media, proxyUrl: null }); await rejection; await drain();
  expect((await awaitStreamJob(cap, 0))?.job.extracted_url).toBe(media);
});
it('recovers an abandoned pending lease through the existing resolver capability', async () => {
  const id = encodeStreamId(target, 'audio'), secret = 'existing-secret';
  state.redis.store.set('stream_job:' + id, JSON.stringify({ url: target, mode: 'audio', secret, extracted_url: null, extracted_time: null }));
  const result = await awaitStreamJob(id + '.' + secret);
  expect(result?.job.extracted_url).toBe(media); expect(result?.job.secret).toBe(secret);
  expect(state.audio).toHaveBeenCalledTimes(1);
});

it('lets a disconnected refresh waiter leave while another caller still owns extraction', async () => {
  const cap = await ensureStreamJob(target, 'audio'); const resolved = (await awaitStreamJob(cap))!;
  let finish!: (x: unknown) => void;
  state.audio.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = refreshStreamUrl(resolved.streamId, resolved.job);
  await drain();
  const ctl = new AbortController(); const second = refreshStreamUrl(resolved.streamId, resolved.job, 105, ctl.signal);
  void second.catch(() => {}); await drain(); ctl.abort(new Error('refresh player disconnected'));
  await expect(second).rejects.toThrow('refresh player disconnected');
  finish({ url: media + '&replacement=1', proxyUrl: null });
  expect((await first)?.extracted_url).toContain('replacement=1');
});
