import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { getUserByToken, setUserToken, revokeUserToken, incrementUserRequests, setUserRequestCount } from '../tools.js';
import { nextUtcMidnightEpoch } from '../quota.js';

const state = vi.hoisted(() => ({ client: null as Redis | null }));
vi.mock('../redis.js', () => ({ redis: () => state.client }));
const uid = randomInt(100_000_000_000, 999_999_999_999);
const tokens = Array.from({ length: 4 }, () => `audit-${randomUUID()}`);

describe.skipIf(!process.env.TEST_REDIS_URL)('atomic tokens and quota (isolated Redis)', () => {
  beforeAll(async () => {
    state.client = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    await state.client.ping();
  });
  afterAll(async () => {
    await state.client?.del(`user_token:${uid}`, `user_requests:${uid}`, ...tokens.map(token => `token_user:${token}`));
    await state.client?.quit();
  });

  it('only the current token authenticates after concurrent replacements', async () => {
    await Promise.all(tokens.map(token => setUserToken(uid, token)));
    const current = await state.client!.get(`user_token:${uid}`);
    for (const token of tokens) expect(await getUserByToken(token)).toBe(token === current ? uid : null);
    await revokeUserToken(uid);
    for (const token of tokens) expect(await getUserByToken(token)).toBeNull();
  });

  it('rejects and reconciles legacy orphan reverse mappings', async () => {
    await state.client!.set(`token_user:${tokens[0]}`, String(uid));
    expect(await getUserByToken(tokens[0])).toBeNull();
    expect(await state.client!.get(`token_user:${tokens[0]}`)).toBeNull();
  });

  it('atomically increments counts and expires them at the next UTC midnight', async () => {
    const counts = await Promise.all(Array.from({ length: 20 }, () => incrementUserRequests(uid)));
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(Number(await state.client!.call('EXPIRETIME', `user_requests:${uid}`))).toBe(nextUtcMidnightEpoch());
    await setUserRequestCount(uid, 5);
    expect(Number(await state.client!.call('EXPIRETIME', `user_requests:${uid}`))).toBe(nextUtcMidnightEpoch());
  });
});

it('computes UTC midnight independently of the process timezone', () => {
  expect(nextUtcMidnightEpoch(Date.parse('2026-09-26T23:59:00Z'))).toBe(Date.parse('2026-09-27T00:00:00Z') / 1000);
});
