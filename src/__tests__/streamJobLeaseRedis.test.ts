import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Extracted { url: string; proxyUrl: string | null }
const state = vi.hoisted(() => ({
  client: null as Redis | null,
  extract: vi.fn<() => Promise<Extracted>>(),
  invalidate: vi.fn<() => Promise<void>>(),
}));
vi.mock('../redis.js', () => ({ redis: () => state.client }));
vi.mock('../cacheManager.js', () => ({
  PROXY_STREAM_TTL_S: 3600,
  getStream: () => state.extract(),
  getVideoStream: () => state.extract(),
  invalidate: () => state.invalidate(),
}));

type Jobs = typeof import('../streamJobs.js');
const newUrl = 'https://rr1.googlevideo.com/videoplayback?new=1';
const oldUrl = 'https://rr1.googlevideo.com/videoplayback?old=1';
let replicas: Jobs[] = [];
let completions: Array<(result: Extracted) => void> = [];
let keys: string[] = [];
let url: string;

async function replica(): Promise<Jobs> {
  vi.resetModules();
  const jobs = await import('../streamJobs.js');
  replicas.push(jobs);
  return jobs;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Redis stream-job state did not settle');
}

describe.skipIf(!process.env.TEST_REDIS_URL)('extraction leases (isolated Redis)', () => {
  beforeAll(async () => {
    state.client = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    await state.client.ping();
  });

  afterAll(async () => { await state.client?.quit(); });

  beforeEach(async () => {
    replicas = [];
    completions = [];
    state.extract.mockReset().mockImplementation(() => new Promise(resolve => completions.push(resolve)));
    state.invalidate.mockReset().mockResolvedValue();
    url = `https://www.youtube.com/watch?v=${randomBytes(9).toString('base64url').slice(0, 11)}`;
    const first = await replica();
    const id = first.encodeStreamId(url, 'audio');
    keys = [`stream_job:${id}`, `stream_job_lease:${id}`];
  });

  afterEach(async () => {
    for (const complete of completions) complete({ url: oldUrl, proxyUrl: null });
    await drain();
    await state.client?.del(...keys);
    for (const jobs of replicas) jobs.resetJobState();
  });

  it('acquires one owner for concurrent independent workers', async () => {
    const first = replicas[0]!;
    const second = await replica();
    const capabilities = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? first : second).ensureStreamJob(url, 'audio')));
    expect(new Set(capabilities).size).toBe(1);
    expect(state.extract).toHaveBeenCalledTimes(1);
    expect(await state.client!.ttl(keys[1]!)).toBeGreaterThan(0);
    completions[0]!({ url: newUrl, proxyUrl: null });
    await waitFor(async () => !(await state.client!.exists(keys[1]!)));
    expect((await second.awaitStreamJob(capabilities[0]!, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('recovers lease expiry and rejects stale completion and release', async () => {
    const first = replicas[0]!;
    const second = await replica();
    const capability = await first.ensureStreamJob(url, 'audio');
    await state.client!.pexpire(keys[1]!, 1);
    await waitFor(async () => !(await state.client!.exists(keys[1]!)));
    expect(await second.ensureStreamJob(url, 'audio')).toBe(capability);
    const successor = await state.client!.get(keys[1]!);
    completions[0]!({ url: oldUrl, proxyUrl: null });
    await drain();
    expect(await state.client!.get(keys[1]!)).toBe(successor);
    expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBeNull();
    completions[1]!({ url: newUrl, proxyUrl: null });
    await waitFor(async () => !(await state.client!.exists(keys[1]!)));
    expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('coalesces capability-preserving refresh against authoritative state', async () => {
    const first = replicas[0]!;
    const second = await replica();
    const capability = await first.ensureStreamJob(url, 'audio');
    completions[0]!({ url: oldUrl, proxyUrl: null });
    await waitFor(async () => !(await state.client!.exists(keys[1]!)));
    const resolved = (await first.awaitStreamJob(capability, 0))!;
    await second.awaitStreamJob(capability, 0);
    const refreshes = [first.refreshStreamUrl(resolved.streamId, resolved.job), second.refreshStreamUrl(resolved.streamId, resolved.job)];
    await waitFor(() => state.extract.mock.calls.length === 2);
    expect(state.invalidate).toHaveBeenCalledTimes(1);
    completions[1]!({ url: newUrl, proxyUrl: null });
    const results = await Promise.all(refreshes);
    expect(results.map(job => job?.extracted_url)).toEqual([newUrl, newUrl]);
    expect(results.every(job => job?.secret === resolved.job.secret)).toBe(true);
    expect((await second.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(newUrl);
  });

  it('backfills one legacy secret across concurrent workers', async () => {
    const first = replicas[0]!;
    const second = await replica();
    await state.client!.set(keys[0]!, JSON.stringify({
      url, mode: 'audio', extracted_url: oldUrl, extracted_time: 1,
    }), 'EX', 60);
    const capabilities = await Promise.all([first.ensureStreamJob(url, 'audio'), second.ensureStreamJob(url, 'audio')]);
    expect(new Set(capabilities).size).toBe(1);
    expect(state.extract).not.toHaveBeenCalled();
    expect((await second.awaitStreamJob(capabilities[0]!, 0))?.job.extracted_url).toBe(oldUrl);
  });
});
