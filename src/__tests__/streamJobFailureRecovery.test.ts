import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { StreamJobRedis } from './helpers/streamJobRedis.js';

interface Extracted { url: string; proxyUrl: string | null }
const state = vi.hoisted(() => ({
  redis: null as unknown as StreamJobRedis,
  client: null as Redis | null,
  extract: vi.fn<() => Promise<Extracted | null>>(),
}));

vi.mock('../redis.js', () => ({ redis: () => state.client ?? state.redis }));
vi.mock('../cacheManager.js', () => ({
  PROXY_STREAM_TTL_S: 3600,
  getStream: () => state.extract(),
  getVideoStream: () => state.extract(),
  invalidate: vi.fn(async () => {}),
}));

type Jobs = typeof import('../streamJobs.js');
const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const source = 'https://rr1.googlevideo.com/videoplayback?recovered=1';
let replicas: Jobs[];
let completions: Array<(result: Extracted | null) => void>;

async function replica(): Promise<Jobs> {
  vi.resetModules();
  const jobs = await import('../streamJobs.js');
  replicas.push(jobs);
  return jobs;
}

async function failedJob(jobs: Jobs): Promise<string> {
  state.extract.mockRejectedValueOnce(new Error('temporary player failure'));
  const capability = await jobs.ensureStreamJob(url, 'video');
  await vi.advanceTimersByTimeAsync(0);
  expect((await jobs.awaitStreamJob(capability, 0))?.job.failed).toBe(true);
  return capability;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
  state.redis = new StreamJobRedis();
  state.client = null;
  replicas = [];
  completions = [];
  state.extract.mockReset().mockImplementation(() => new Promise(resolve => completions.push(resolve)));
});

afterEach(async () => {
  for (const complete of completions) complete({ url: source, proxyUrl: null });
  await vi.advanceTimersByTimeAsync(0);
  for (const jobs of replicas) jobs.resetJobState();
  await state.client?.quit();
  state.client = null;
  vi.useRealTimers();
});

it('keeps a recent failure without another extraction or shortening its capability lifetime', async () => {
  const jobs = await replica();
  const capability = await failedJob(jobs);
  const key = `stream_job:${jobs.encodeStreamId(url, 'video')}`;
  const expires = state.redis.expires.get(key);
  await vi.advanceTimersByTimeAsync(29_999);
  expect((await jobs.awaitStreamJob(capability, 0))?.job.failed).toBe(true);
  expect(state.extract).toHaveBeenCalledTimes(1);
  expect(state.redis.expires.get(key)).toBe(expires);
  expect(expires).toBe(14_400_000);
});

it('retries an overdue failure once across replicas while keeping the original capability', async () => {
  const first = await replica();
  const second = await replica();
  const capability = await failedJob(first);
  await vi.advanceTimersByTimeAsync(30_000);
  const pending = await Promise.all([
    first.awaitStreamJob(capability, 0), second.awaitStreamJob(capability, 0),
    first.awaitStreamJob(capability, 0), second.awaitStreamJob(capability, 0),
  ]);
  expect(state.extract).toHaveBeenCalledTimes(2);
  expect(pending.every(result => result && !result.job.failed && !result.job.extracted_url)).toBe(true);
  expect(pending.every(result => result?.job.secret === capability.split('.')[1])).toBe(true);
  completions[0]!({ url: source, proxyUrl: null });
  await vi.advanceTimersByTimeAsync(0);
  expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(source);
  expect((await second.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(source);
});

it('follows another replica\'s retry instead of returning a locally remembered failure', async () => {
  const first = await replica();
  const second = await replica();
  const capability = await failedJob(first);
  expect(await second.ensureStreamJob(url, 'video')).toBe(capability);
  const pending = await first.awaitStreamJob(capability, 0);
  expect(pending?.job.failed).not.toBe(true);
  expect(pending?.job.extracted_url).toBeNull();
  expect(state.extract).toHaveBeenCalledTimes(2);
  completions[0]!({ url: source, proxyUrl: null });
  await vi.advanceTimersByTimeAsync(0);
  expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(source);
});

it('rejects a forged or cancelled capability before claiming a recovery lease', async () => {
  const jobs = await replica();
  const capability = await failedJob(jobs);
  await vi.advanceTimersByTimeAsync(30_000);
  const transaction = vi.spyOn(state.redis, 'eval');
  const read = vi.spyOn(state.redis, 'get');
  expect(await jobs.awaitStreamJob(`${capability.split('.')[0]}.forged`, 0)).toBeNull();
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(jobs.awaitStreamJob(capability, 0, controller.signal)).rejects.toThrow('cancelled');
  expect(transaction).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(`stream_job:${capability.split('.')[0]}`);
  expect(state.extract).toHaveBeenCalledTimes(1);
});

it.each([undefined, null, 'invalid', '1794486720'])('recovers a legacy failure with invalid completion time %s', async extractedTime => {
  const jobs = await replica();
  const id = jobs.encodeStreamId(url, 'video');
  state.redis.store.set(`stream_job:${id}`, JSON.stringify({
    url, mode: 'video', extracted_url: null, extracted_time: extractedTime, secret: 'legacy', failed: true,
  }));
  const pending = await jobs.awaitStreamJob(`${id}.legacy`, 0);
  expect(state.extract).toHaveBeenCalledTimes(1);
  expect(pending?.job.failed).not.toBe(true);
  expect(pending?.job.secret).toBe('legacy');
});

it('starts a new cooldown if the recovery attempt also fails', async () => {
  const jobs = await replica();
  const capability = await failedJob(jobs);
  await vi.advanceTimersByTimeAsync(30_000);
  state.extract.mockRejectedValueOnce(new Error('player still unavailable'));
  await jobs.awaitStreamJob(capability, 0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(29_999);
  const failed = await jobs.awaitStreamJob(capability, 0);
  expect(failed?.job.failed).toBe(true);
  expect(state.extract).toHaveBeenCalledTimes(2);
});

it('recovers a failed capability after a wall-clock rollback', async () => {
  const jobs = await replica();
  const capability = await failedJob(jobs);
  vi.setSystemTime(new Date(Date.now() - 5.5 * 60 * 60 * 1000));
  const pending = await jobs.awaitStreamJob(capability, 0);
  expect(state.extract).toHaveBeenCalledTimes(2);
  expect(pending?.job.failed).not.toBe(true);
  expect(pending?.job.secret).toBe(capability.split('.')[1]);
});

it('does not recreate an expired capability from a locally remembered failure', async () => {
  const jobs = await replica();
  const capability = await failedJob(jobs);
  state.redis.advance(14_400_001);
  expect(await jobs.awaitStreamJob(capability, 0)).toBeNull();
  expect(state.extract).toHaveBeenCalledTimes(1);
});

it('honors cooldown when pending work fails before the recovery transaction', async () => {
  const jobs = await replica();
  const id = jobs.encodeStreamId(url, 'video');
  const key = `stream_job:${id}`;
  const pending = { url, mode: 'video', extracted_url: null, extracted_time: null, secret: 'test-secret', failed: false };
  state.redis.store.set(key, JSON.stringify(pending));
  const evaluate = state.redis.eval.bind(state.redis);
  vi.spyOn(state.redis, 'eval').mockImplementationOnce(async (...args) => {
    state.redis.store.set(key, JSON.stringify({ ...pending, failed: true, extracted_time: Date.now() / 1000 }));
    return evaluate(...args);
  });
  expect((await jobs.awaitStreamJob(`${id}.test-secret`, 0))?.job.failed).toBe(true);
  expect(state.extract).not.toHaveBeenCalled();
  expect(await state.redis.get(`stream_job_lease:${id}`)).toBeNull();
});

async function realFailure() {
  // Keep socket timers real while controlling persisted failure timestamps.
  vi.useFakeTimers({ toFake: ['Date'] });
  state.client = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
  await state.client.ping();
  const first = await replica();
  const second = await replica();
  const target = `https://www.youtube.com/watch?v=${randomBytes(9).toString('base64url').slice(0, 11)}`;
  const id = first.encodeStreamId(target, 'video');
  const key = `stream_job:${id}`;
  const lease = `stream_job_lease:${id}`;
  const failed = { url: target, mode: 'video', extracted_url: null,
    extracted_time: Date.now() / 1000 - 31, secret: 'test-secret', failed: true };
  await state.client.set(key, JSON.stringify(failed), 'EX', 14_400);
  return { client: state.client, first, second, key, lease, failed, capability: `${id}.test-secret` };
}

it.skipIf(!process.env.TEST_REDIS_URL)('uses the real Redis lease to coalesce concurrent failure recovery', async () => {
  const { client, first, second, key, lease, capability } = await realFailure();
  try {
    const pending = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? first : second).awaitStreamJob(capability, 0)));
    expect(state.extract).toHaveBeenCalledTimes(1);
    expect(pending.every(result => result && !result.job.failed && result.job.secret === 'test-secret')).toBe(true);
    expect(await client.ttl(lease)).toBeGreaterThan(0);
    completions[0]!({ url: source, proxyUrl: null });
    for (let i = 0; i < 100 && await client.exists(lease); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await client.exists(lease)).toBe(0);
    expect((await first.awaitStreamJob(capability, 0))?.job.extracted_url).toBe(source);
  } finally { await client.del(key, lease); }
});

it.skipIf(!process.env.TEST_REDIS_URL)('honors a newer failure cooldown atomically when the job changes before lease acquisition', async () => {
  const { client, first, key, lease, failed, capability } = await realFailure();
  const evaluate = client.eval.bind(client);
  const transaction = vi.spyOn(client, 'eval').mockImplementationOnce(async (...args) => {
    await client.set(key, JSON.stringify({ ...failed, extracted_time: Date.now() / 1000 }), 'EX', 14_400);
    return evaluate(...args);
  });
  try {
    expect((await first.awaitStreamJob(capability, 0))?.job.failed).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(state.extract).not.toHaveBeenCalled();
    expect(await client.exists(lease)).toBe(0);
  } finally { transaction.mockRestore(); await client.del(key, lease); }
});

it.skipIf(!process.env.TEST_REDIS_URL)('recovers a future failure timestamp with the real Redis transaction', async () => {
  const { client, first, key, lease, failed, capability } = await realFailure();
  try {
    await client.set(key, JSON.stringify({ ...failed, extracted_time: Date.now() / 1000 + 5.5 * 60 * 60 }), 'EX', 14_400);
    const pending = await first.awaitStreamJob(capability, 0);
    expect(pending?.job.failed).not.toBe(true);
    expect(state.extract).toHaveBeenCalledTimes(1);
    expect(await client.exists(lease)).toBe(1);
  } finally { await client.del(key, lease); }
});

it.skipIf(!process.env.TEST_REDIS_URL)('honors a pending-to-failed cooldown race with the real Redis transaction', async () => {
  const { client, first, key, lease, failed, capability } = await realFailure();
  await client.set(key, JSON.stringify({ ...failed, extracted_time: null, failed: false }), 'EX', 14_400);
  const evaluate = client.eval.bind(client);
  const transaction = vi.spyOn(client, 'eval').mockImplementationOnce(async (...args) => {
    await client.set(key, JSON.stringify({ ...failed, extracted_time: Date.now() / 1000 }), 'EX', 14_400);
    return evaluate(...args);
  });
  try {
    expect((await first.awaitStreamJob(capability, 0))?.job.failed).toBe(true);
    expect(state.extract).not.toHaveBeenCalled();
    expect(await client.exists(lease)).toBe(0);
  } finally { transaction.mockRestore(); await client.del(key, lease); }
});

it.skipIf(!process.env.TEST_REDIS_URL).each(['expired', 'rotated'])('does not claim recovery when the capability is %s before the Redis transaction', async change => {
  const { client, first, key, lease, failed, capability } = await realFailure();
  const evaluate = client.eval.bind(client);
  const transaction = vi.spyOn(client, 'eval').mockImplementationOnce(async (...args) => {
    if (change === 'expired') await client.del(key);
    else await client.set(key, JSON.stringify({ ...failed, secret: 'replacement-secret' }), 'EX', 14_400);
    return evaluate(...args);
  });
  try {
    expect(await first.awaitStreamJob(capability, 0)).toBeNull();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(state.extract).not.toHaveBeenCalled();
    expect(await client.exists(lease)).toBe(0);
    if (change === 'expired') expect(await client.exists(key)).toBe(0);
    else expect(JSON.parse((await client.get(key))!).secret).toBe('replacement-secret');
  } finally { transaction.mockRestore(); await client.del(key, lease); }
});
