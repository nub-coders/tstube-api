/**
 * Key-pool health tests: a quota-dead key is skipped until Pacific midnight and the
 * request retries through a live key; an invalid key is removed outright; when
 * every key is dead the pool short-circuits to empty without touching the
 * network; transient failures (5xx, network) mark nothing.
 *
 * Math.random is pinned to 0 so pickLiveKey deterministically chooses the first
 * live key (config order KEYA, KEYB, KEYC) — failure sequences are predictable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: () => ({ YOUTUBE_API_KEYS: 'KEYA,KEYB,KEYC' }),
  isAdmin: () => false,
  loadConfig: () => ({}),
}));

interface Call {
  path: string;
  key: string;
}

let calls: Call[] = [];
let route: ((u: URL) => { status: number; body: unknown } | undefined) | null = null;

const SEARCH_URL_PATH = '/youtube/v3/search';
const VIDEOS_URL_PATH = '/youtube/v3/videos';

const searchOk = {
  items: [{ id: { videoId: 'vid1' }, snippet: { title: 'Song', channelTitle: 'Chan' } }],
};
const detailsOk = {
  items: [
    {
      id: 'vid1',
      contentDetails: { duration: 'PT3M20S' },
      statistics: { viewCount: '12345' },
      snippet: { title: 'Song', channelTitle: 'Chan', thumbnails: { high: { url: 'http://t' } } },
    },
  ],
};

const successRoute = (u: URL) =>
  u.pathname.endsWith(SEARCH_URL_PATH)
    ? { status: 200, body: searchOk }
    : { status: 200, body: detailsOk };

const quotaError = {
  error: { code: 403, message: 'quota exceeded', errors: [{ reason: 'quotaExceeded' }] },
};
const invalidKeyError = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    errors: [{ reason: 'badRequest' }],
  },
};

async function fresh(): Promise<typeof import('../youtubeApi.js')> {
  vi.resetModules();
  return await import('../youtubeApi.js');
}

beforeEach(() => {
  calls = [];
  route = null;
  vi.spyOn(Math, 'random').mockReturnValue(0); // pickLiveKey → first live key
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const u = new URL(String(input));
      calls.push({ path: u.pathname, key: u.searchParams.get('key') ?? '' });
      const r = route?.(u);
      if (!r) throw new Error(`no route for ${u.pathname} key=${u.searchParams.get('key')}`);
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Data API key pool', () => {
  it('classifies key-level failures and leaves transient ones alone', async () => {
    const yt = await fresh();
    expect(yt.classifyKeyFailure('quotaExceeded', 'x')).toBe('quota-day');
    expect(yt.classifyKeyFailure('dailyLimitExceeded', 'x')).toBe('quota-day');
    expect(yt.classifyKeyFailure('keyInvalid', 'x')).toBe('removed');
    expect(yt.classifyKeyFailure('accessNotConfigured', 'x')).toBe('removed');
    expect(yt.classifyKeyFailure('badRequest', 'API key not valid. Please pass a valid API key.')).toBe('removed');
    // transient — must never touch key state
    expect(yt.classifyKeyFailure('badRequest', 'invalid filter parameter')).toBeNull();
    expect(yt.classifyKeyFailure('backendError', 'internal')).toBeNull();
    expect(yt.classifyKeyFailure('forbidden', 'not properly authorized')).toBeNull();
    expect(yt.classifyKeyFailure('', '')).toBeNull();
  });

  it('retries quota-dead keys through a live key and skips them afterwards', async () => {
    const yt = await fresh();
    route = (u) =>
      u.searchParams.get('key') === 'KEYC' ? successRoute(u) : { status: 403, body: quotaError };

    // Request 1: search walks KEYA → KEYB (both quota-marked) → KEYC succeeds;
    // details goes straight to KEYC.
    const results = await yt.fetchResults('song', 1);
    expect(results).toHaveLength(1);
    expect(calls.filter((c) => c.key === 'KEYA')).toHaveLength(1);
    expect(calls.filter((c) => c.key === 'KEYB')).toHaveLength(1);
    expect(calls.filter((c) => c.key === 'KEYC')).toHaveLength(2);

    // Request 2: dead keys skipped without probing.
    calls = [];
    await yt.fetchResults('song', 1);
    expect(calls.filter((c) => c.key === 'KEYA' || c.key === 'KEYB')).toHaveLength(0);
    expect(calls.filter((c) => c.key === 'KEYC')).toHaveLength(2);
  });

  it('removes an invalid key outright after a single attempt', async () => {
    const yt = await fresh();
    route = (u) =>
      u.searchParams.get('key') === 'KEYA'
        ? { status: 400, body: invalidKeyError }
        : successRoute(u);

    // Request 1: search tries KEYA (invalid → removed) then KEYB; details → KEYB.
    const results = await yt.fetchResults('song', 1);
    expect(results).toHaveLength(1);
    expect(calls.filter((c) => c.key === 'KEYA')).toHaveLength(1);
    expect(calls.filter((c) => c.key === 'KEYB')).toHaveLength(2);

    // Request 2: KEYA never touched again.
    calls = [];
    await yt.fetchResults('song', 1);
    expect(calls.filter((c) => c.key === 'KEYA')).toHaveLength(0);
    expect(calls.filter((c) => c.key === 'KEYB')).toHaveLength(2);
  });

  it('short-circuits to empty without network when every key is dead', async () => {
    const yt = await fresh();
    route = () => ({ status: 403, body: quotaError });

    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls).toHaveLength(3); // each key marked dead once inside the first request
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set(['KEYA', 'KEYB', 'KEYC']));

    calls = [];
    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls).toHaveLength(0); // no probes once the pool is dry
  });

  it.each([
    ['winter', '2026-01-31T23:30:00Z', '2026-02-01T08:00:00Z'],
    ['summer', '2026-06-30T23:30:00Z', '2026-07-01T07:00:00Z'],
    ['before spring transition', '2026-03-07T23:30:00Z', '2026-03-08T08:00:00Z'],
    ['spring transition day', '2026-03-08T23:30:00Z', '2026-03-09T07:00:00Z'],
    ['before fall transition', '2026-10-31T23:30:00Z', '2026-11-01T07:00:00Z'],
    ['fall transition day', '2026-11-01T23:30:00Z', '2026-11-02T08:00:00Z'],
    ['year boundary', '2026-12-31T23:30:00Z', '2027-01-01T08:00:00Z'],
  ])('suppresses UTC probes and revives at exact Pacific midnight: %s', async (_, exhaustedAt, resetAt) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(exhaustedAt));
    const yt = await fresh();
    route = () => ({ status: 403, body: quotaError });

    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls.map((c) => c.key)).toEqual(['KEYA', 'KEYB', 'KEYC']);

    calls = [];
    const utcMidnight = (Math.floor(Date.parse(exhaustedAt) / 86_400_000) + 1) * 86_400_000;
    clock.mockReturnValue(utcMidnight);
    // Google has not reset yet. Probing here would extend the old UTC cooldown
    // into the replenished Pacific quota day.
    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls).toHaveLength(0);

    route = successRoute;
    clock.mockReturnValue(Date.parse(resetAt) - 1);
    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls).toHaveLength(0);

    clock.mockReturnValue(Date.parse(resetAt));
    expect(await yt.fetchResults('song', 1)).toHaveLength(1);
    expect(calls.map((c) => c.key)).toEqual(['KEYA', 'KEYA']);
  });

  it.each([
    ['winter', '2026-01-15T00:01:00Z', '2026-01-15T08:00:00Z'],
    ['summer', '2026-10-25T00:01:00Z', '2026-10-25T07:00:00Z'],
  ])('revives keys exhausted after UTC midnight at the same-day Pacific reset: %s', async (_, exhaustedAt, resetAt) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(exhaustedAt));
    const yt = await fresh();
    route = () => ({ status: 403, body: quotaError });
    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls).toHaveLength(3);

    calls = [];
    route = successRoute;
    clock.mockReturnValue(Date.parse(resetAt) - 1);
    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls).toHaveLength(0);

    clock.mockReturnValue(Date.parse(resetAt));
    expect(await yt.fetchResults('song', 1)).toHaveLength(1);
    expect(calls.map((c) => c.key)).toEqual(['KEYA', 'KEYA']);
  });

  it('returns {} from getVideoById when all keys are dead', async () => {
    const yt = await fresh();
    route = () => ({ status: 403, body: quotaError });
    expect(await yt.getVideoById('dQw4w9WgXcQ')).toEqual({});
    expect(calls).toHaveLength(3);
  });

  it('does not mark keys on transient failures', async () => {
    const yt = await fresh();
    route = () => ({ status: 500, body: { error: { errors: [{ reason: 'backendError' }] } } });

    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls).toHaveLength(1); // transient failure: single attempt, no key retries

    route = successRoute;
    calls = [];
    expect(await yt.fetchResults('song', 1)).toHaveLength(1); // pool still fully live
    expect(calls.map((c) => c.key)).toEqual(['KEYA', 'KEYA']); // nothing marked: KEYA first for both calls
  });

  it('does not mark keys on network errors', async () => {
    const yt = await fresh();
    route = () => undefined; // stub throws → fetch rejects → status 0

    expect(await yt.fetchResults('song', 1)).toEqual([]);
    expect(calls).toHaveLength(1);

    route = successRoute;
    calls = [];
    expect(await yt.fetchResults('song', 1)).toHaveLength(1);
  });
});
