import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, expect, it, describe, vi } from 'vitest';
import { nextPacificMidnightEpoch } from '../quota.js';
const state = vi.hoisted(() => ({
  client: null as Redis | null,
  cfg: { YOUTUBE_SEARCH_DAILY_BUDGET: 5000, YOUTUBE_SEARCH_REQUESTS_PER_MINUTE: 100, YOUTUBE_SEARCH_MAX_CONCURRENCY: 4 },
}));
vi.mock('../redis.js', () => ({ redis: () => state.client }));
vi.mock('../config.js', () => ({ config: () => state.cfg }));
import { withSearchSlot } from '../youtubeSearchBudget.js';
const keys = ['youtube_search:active', 'youtube_search:starts', `youtube_search:budget:${nextPacificMidnightEpoch()}`];

describe.skipIf(!process.env.TEST_REDIS_URL)('shared Data API search admission (isolated Redis)', () => {
  beforeAll(async () => { state.client = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 }); await state.client.ping(); });
  beforeEach(async () => {
    await state.client!.del(...keys);
    Object.assign(state.cfg, { YOUTUBE_SEARCH_DAILY_BUDGET: 5000, YOUTUBE_SEARCH_REQUESTS_PER_MINUTE: 100, YOUTUBE_SEARCH_MAX_CONCURRENCY: 4 });
  });
  afterAll(async () => { await state.client?.del(...keys); await state.client?.quit(); });

  it('atomically reserves a daily allowance across independent workers', async () => {
    state.cfg.YOUTUBE_SEARCH_DAILY_BUDGET = 202;
    state.cfg.YOUTUBE_SEARCH_MAX_CONCURRENCY = 20;
    vi.resetModules();
    const other = await import('../youtubeSearchBudget.js');
    const call = vi.fn(async () => 'ok');
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? other.withSearchSlot : withSearchSlot)(call)));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(2);
    expect(call).toHaveBeenCalledTimes(2);
    expect(await state.client!.get(keys[2])).toBe('202');
    expect(Number(await state.client!.call('EXPIRETIME', keys[2]))).toBe(nextPacificMidnightEpoch());
  });

  it('limits simultaneous outbound calls and frees slots on completion', async () => {
    state.cfg.YOUTUBE_SEARCH_MAX_CONCURRENCY = 1;
    let release!: () => void;
    const first = withSearchSlot(() => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(withSearchSlot(async () => 'blocked')).rejects.toMatchObject({ status: 429 });
    release(); await first;
    await expect(withSearchSlot(async () => 'ok')).resolves.toBe('ok');
    expect(await state.client!.zcard(keys[0])).toBe(0);
  });

  it('enforces a rolling minute limit and expires old starts', async () => {
    state.cfg.YOUTUBE_SEARCH_REQUESTS_PER_MINUTE = 1;
    await withSearchSlot(async () => 'ok');
    await expect(withSearchSlot(async () => 'blocked')).rejects.toMatchObject({ status: 429 });
    const members = await state.client!.zrange(keys[1], 0, -1);
    const [seconds] = await state.client!.time();
    for (const member of members) await state.client!.zadd(keys[1], Number(seconds) * 1000 - 61000, member);
    await expect(withSearchSlot(async () => 'ok')).resolves.toBe('ok');
  });

  it('reclaims crashed owners and releases the current lease when the upstream throws', async () => {
    const [seconds] = await state.client!.time();
    await state.client!.zadd(keys[0], Number(seconds) * 1000 - 1, 'crashed');
    await expect(withSearchSlot(async () => { throw new Error('network'); })).rejects.toThrow('network');
    expect(await state.client!.zcard(keys[0])).toBe(0);
    expect(await state.client!.get(keys[2])).toBe('101');
  });

  it('fails closed before contacting Google when Redis admission is unavailable', async () => {
    const fail = vi.spyOn(state.client!, 'eval').mockRejectedValueOnce(new Error('Redis unavailable'));
    const call = vi.fn();
    await expect(withSearchSlot(call)).rejects.toMatchObject({ status: 503 });
    expect(call).not.toHaveBeenCalled();
    fail.mockRestore();
  });
});
