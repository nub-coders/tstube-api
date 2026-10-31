import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamJobRedis } from './helpers/streamJobRedis.js';

interface Extracted { url: string; proxyUrl: string | null }
const state = vi.hoisted(() => ({
  redis: null as unknown as StreamJobRedis,
  extract: vi.fn<() => Promise<Extracted | null>>(),
  invalidate: vi.fn<() => Promise<void>>(),
}));

vi.mock('../redis.js', () => ({ redis: () => state.redis }));
vi.mock('../cacheManager.js', () => ({
  PROXY_STREAM_TTL_S: 3600,
  getStream: () => state.extract(),
  getVideoStream: () => state.extract(),
  invalidate: () => state.invalidate(),
}));

type Jobs = typeof import('../streamJobs.js');
const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const oldUrl = 'https://rr1.googlevideo.com/videoplayback?old=1';
const newUrl = 'https://rr1.googlevideo.com/videoplayback?new=1';
let replicas: Jobs[] = [];
let completions: Array<(result: Extracted | null) => void> = [];

async function replica(): Promise<Jobs> {
  vi.resetModules();
  const jobs = await import('../streamJobs.js');
  replicas.push(jobs);
  return jobs;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

beforeEach(() => {
  replicas = [];
  completions = [];
  state.redis = new StreamJobRedis();
  state.extract.mockReset().mockImplementation(() => new Promise(resolve => completions.push(resolve)));
  state.invalidate.mockReset().mockResolvedValue();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const complete of completions) complete({ url: oldUrl, proxyUrl: null });
  await drain();
  for (const jobs of replicas) jobs.resetJobState();
});

describe('distributed extraction ownership', () => {
  it('publishes a failure before lease expiry when extraction never completes', async () => {
    vi.useFakeTimers();
    const jobs = await replica();
    const capability = await jobs.ensureStreamJob(url, 'video');
    await vi.advanceTimersByTimeAsync(100_001);
    const resolved = await jobs.awaitStreamJob(capability, 0);
    expect(resolved?.job.failed).toBe(true);
    expect(resolved?.job.extracted_url).toBeNull();
    expect(state.redis.store.has(`stream_job_lease:${jobs.encodeStreamId(url, 'video')}`)).toBe(false);
    // A transport that ignores cancellation cannot publish a late completion.
    completions[0]!({ url: newUrl, proxyUrl: null });
    await vi.advanceTimersByTimeAsync(0);
    expect((await jobs.awaitStreamJob(capability, 0))?.job.failed).toBe(true);
  });

  it('coalesces pending work across independent module instances', async () => {
    const first = await replica();
    const second = await replica();
    const capabilities = await Promise.all([
      first.ensureStreamJob(url, 'audio'), second.ensureStreamJob(url, 'audio'),
      second.ensureStreamJob(url, 'audio'),
    ]);
    expect(new Set(capabilities).size).toBe(1);
    expect(state.extract).toHaveBeenCalledTimes(1);
    completions[0]!({ url: newUrl, proxyUrl: null });
    await drain();
    expect((await second.awaitStreamJob(capabilities[0]!, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('recovers an expired lease without changing the capability or accepting its old owner', async () => {
    const first = await replica();
    const second = await replica();
    const capability = await first.ensureStreamJob(url, 'audio');
    const id = first.encodeStreamId(url, 'audio');
    const leaseKey = `stream_job_lease:${id}`;
    const leaseExpiry = state.redis.expires.get(leaseKey);
    expect(leaseExpiry).toBeGreaterThan(0);
    state.redis.advance(leaseExpiry! + 1);

    expect(await second.ensureStreamJob(url, 'audio')).toBe(capability);
    const successor = state.redis.store.get(leaseKey);
    expect(state.extract).toHaveBeenCalledTimes(2);

    completions[0]!({ url: oldUrl, proxyUrl: null });
    await drain();
    expect(state.redis.store.get(leaseKey)).toBe(successor);
    expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBeNull();

    completions[1]!({ url: newUrl, proxyUrl: null });
    await drain();
    expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(newUrl);
    expect(state.redis.store.has(leaseKey)).toBe(false);
  });

  it('does not let an expired owner overwrite a completed successor with a failure', async () => {
    const first = await replica();
    const second = await replica();
    const capability = await first.ensureStreamJob(url, 'audio');
    const id = first.encodeStreamId(url, 'audio');
    state.redis.advance(state.redis.expires.get(`stream_job_lease:${id}`)! + 1);
    await second.ensureStreamJob(url, 'audio');
    completions[1]!({ url: newUrl, proxyUrl: null });
    await drain();
    // Throwing inside extraction takes the failure-persistence path.
    state.extract.mockRejectedValue(new Error('stale extraction failed'));
    completions[0]!(null);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await drain();
    expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('contains completion persistence and release rejections, then recovers the abandoned attempt', async () => {
    const jobs = await replica();
    const capability = await jobs.ensureStreamJob(url, 'audio');
    state.redis.failWrites = true;
    completions[0]!({ url: newUrl, proxyUrl: null });
    await drain();
    // Vitest reports any detached rejection as a test failure.
    expect((await jobs.awaitStreamJob(capability, 0))?.job.extracted_url).toBeNull();
    state.redis.failWrites = false;
    const id = jobs.encodeStreamId(url, 'audio');
    state.redis.advance(state.redis.expires.get(`stream_job_lease:${id}`)! + 1);
    expect(await jobs.ensureStreamJob(url, 'audio')).toBe(capability);
    completions[1]!({ url: newUrl, proxyUrl: null });
    await drain();
    expect((await jobs.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('contains persistence rejection while reporting an extraction failure', async () => {
    const jobs = await replica();
    let rejectExtraction!: (error: Error) => void;
    state.extract.mockImplementationOnce(() => new Promise((_, reject) => { rejectExtraction = reject; }));
    const capability = await jobs.ensureStreamJob(url, 'audio');
    state.redis.failWrites = true;
    rejectExtraction(new Error('player connection failed'));
    await drain();
    expect((await jobs.awaitStreamJob(capability, 0))?.job.extracted_url).toBeNull();
  });

  it('retries a recorded extraction failure once across replicas', async () => {
    const first = await replica();
    const second = await replica();
    state.extract.mockRejectedValueOnce(new Error('temporary player failure'));
    const capability = await first.ensureStreamJob(url, 'audio');
    await drain();
    expect((await second.awaitStreamJob(capability, 0))?.job.failed).toBe(true);
    const issued = await Promise.all([first.ensureStreamJob(url, 'audio'), second.ensureStreamJob(url, 'audio')]);
    expect(issued).toEqual([capability, capability]);
    expect(state.extract).toHaveBeenCalledTimes(2);
    completions[0]!({ url: newUrl, proxyUrl: null });
    await drain();
    expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('coalesces refresh across replicas and preserves the resolver capability', async () => {
    const first = await replica();
    const second = await replica();
    const capability = await first.ensureStreamJob(url, 'audio');
    completions[0]!({ url: oldUrl, proxyUrl: null });
    await drain();
    const resolved = (await first.awaitStreamJob(capability, 0))!;
    // The second process also remembers the old completion before refresh.
    await second.awaitStreamJob(capability, 0);
    const refreshes = [first.refreshStreamUrl(resolved.streamId, resolved.job), second.refreshStreamUrl(resolved.streamId, resolved.job)];
    await drain();
    expect(state.invalidate).toHaveBeenCalledTimes(1);
    expect(state.extract).toHaveBeenCalledTimes(2);
    completions[1]!({ url: newUrl, proxyUrl: null });
    await drain();
    const refreshed = await Promise.all(refreshes);
    expect(refreshed.map(job => job?.extracted_url)).toEqual([newUrl, newUrl]);
    expect(refreshed.every(job => job?.secret === resolved.job.secret)).toBe(true);
    expect((await second.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('retires an expired capability and fences its extractor from the replacement generation', async () => {
    const first = await replica();
    const second = await replica();
    const expired = await first.ensureStreamJob(url, 'audio');
    const id = first.encodeStreamId(url, 'audio');
    state.redis.advance(state.redis.expires.get(`stream_job:${id}`)! + 1);
    const replacement = await second.ensureStreamJob(url, 'audio');
    expect(replacement).not.toBe(expired);
    completions[1]!({ url: newUrl, proxyUrl: null });
    await drain();
    completions[0]!({ url: oldUrl, proxyUrl: null });
    await drain();
    expect(await first.awaitStreamJob(expired, 0)).toBeNull();
    expect((await first.awaitStreamJob(replacement, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('backfills one shared capability atomically for a legacy completed job', async () => {
    const first = await replica();
    const second = await replica();
    const id = first.encodeStreamId(url, 'audio');
    state.redis.store.set(`stream_job:${id}`, JSON.stringify({
      url, mode: 'audio', extracted_url: oldUrl, extracted_time: 1,
    }));
    const capabilities = await Promise.all([first.ensureStreamJob(url, 'audio'), second.ensureStreamJob(url, 'audio')]);
    expect(new Set(capabilities).size).toBe(1);
    expect(state.extract).toHaveBeenCalledTimes(1);
    completions[0]!({ url: newUrl, proxyUrl: null });
    await drain();
    expect((await first.awaitStreamJob(capabilities[0]!, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('keeps proxy-pinned results bounded by the exit lifetime', async () => {
    const jobs = await replica();
    const capability = await jobs.ensureStreamJob(url, 'audio');
    const id = jobs.encodeStreamId(url, 'audio');
    completions[0]!({ url: newUrl, proxyUrl: 'http://proxy.example:8080' });
    await drain();
    expect(state.redis.expires.get(`stream_job:${id}`)).toBe(3600 * 1000);
    expect((await jobs.awaitStreamJob(capability, 0))?.job.proxy_url).toBe('http://proxy.example:8080');
  });
});
