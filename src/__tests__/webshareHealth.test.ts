import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebsharePool, buildProxyUrl, type WebshareProxy } from '../proxy.js';

vi.mock('../config.js', () => ({
  config: () => ({ WEBSHARE_API_KEY: 'mock-health-key', WEBSHARE_PROXY_COUNTRIES: '', WEBSHARE_REFRESH_SEC: 60 }),
}));

// Health fixtures must not overwrite the snapshot used by persistence tests.
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(), readFileSync: vi.fn(() => '{}'), renameSync: vi.fn(), writeFileSync: vi.fn(),
}));

function proxy(id: string, port: number, countryCode = 'US', password = 'p'): WebshareProxy {
  return {
    id, address: '38.154.227.167', port, username: 'u', password,
    url: buildProxyUrl('u', password, '38.154.227.167', port),
    countryCode, city: '', lastVerification: 0,
  };
}

function payload(proxies: WebshareProxy[]) {
  return { results: proxies.map((p) => ({
    id: p.id, proxy_address: p.address, port: p.port, username: p.username,
    password: p.password, country_code: p.countryCode, valid: true,
  })) };
}

function reject(pool: WebsharePool, p: WebshareProxy) {
  pool.markBad(p.id, p.url);
  pool.markBad(p.id, p.url);
  pool.markBad(p.id, p.url);
}

describe('Webshare extraction health', () => {
  let pool: WebsharePool;
  let now: number;
  let inventory: WebshareProxy[];
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    pool = new WebsharePool();
    now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(performance, 'now').mockImplementation(() => now - 1_800_000_000_000);
    inventory = [];
    fetchMock = vi.fn<typeof fetch>(async () => Response.json(payload(inventory)));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await pool.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps rejected exits out of every selector after a normal refresh', async () => {
    const bad = proxy('rejected', 8000);
    const good = proxy('healthy', 8001);
    inventory = [bad, good];
    await pool.refresh();
    reject(pool, bad);
    now += 30_000;
    await pool.refresh();

    expect(pool.size).toBe(1);
    expect(pool.getWarmCandidates(3, () => true).map((p) => p.id)).toEqual(['healthy']);
    expect(pool.getGeoCandidates({ allowed: ['US'] }).map((p) => p.id)).toEqual(['healthy']);
    expect(pool.getGeoCandidates({ blocked: ['IN'] }).map((p) => p.id)).toEqual(['healthy']);
    expect(pool.getSomeProxies().map((p) => p.id)).toEqual(['healthy']);
    expect(pool.getAllCandidates().map((p) => p.id)).toEqual(['healthy']);
    expect((await pool.getProxy())?.id).toBe('healthy');
    expect((await pool.getProxyForCountries(['US']))?.id).toBe('healthy');
    expect(pool.getProxyNotInCountries(['IN'])?.id).toBe('healthy');
  });

  it('preserves consecutive failure history across refresh and retries after cooldown expiry', async () => {
    const bad = proxy('retry', 8000);
    inventory = [bad];
    await pool.refresh();
    pool.markBad(bad.id, bad.url);
    pool.markBad(bad.id, bad.url);
    now += 30_000;
    await pool.refresh();
    pool.markBad(bad.id, bad.url);
    expect(pool.getAllCandidates()).toEqual([]);

    const countBeforeRecovery = fetchMock.mock.calls.length;
    now += 5 * 60_000;
    expect(pool.getAllCandidates().map((p) => p.id)).toEqual(['retry']);
    expect(fetchMock).toHaveBeenCalledTimes(countBeforeRecovery);
    pool.markBad(bad.id, bad.url);
    expect(pool.size).toBe(1);
  });

  it('binds failures recorded before discovery to the first observed credentials', async () => {
    const first = proxy('discovered', 8000);
    pool.markBad(first.id);
    pool.markBad(first.id);
    inventory = [first];
    await pool.refresh();
    pool.markBad(first.id);
    expect(pool.size).toBe(0);
    inventory = [proxy(first.id, first.port, first.countryCode, 'replacement-password')];
    now += 30_000;
    await pool.refresh();
    expect(pool.size).toBe(1);
  });

  it('does not restore a rejected exit when an already running refresh completes', async () => {
    const bad = proxy('inflight', 8000);
    pool._setCandidatesForTest([bad]);
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const refresh = pool.refresh();
    reject(pool, bad);
    finish(Response.json(payload([bad])));
    await refresh;
    expect(pool.getAllCandidates()).toEqual([]);
  });

  it('does not let a refresh completed after close overwrite a newer refresh', async () => {
    let finishOld!: (response: Response) => void;
    let finishNew!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishNew = resolve; }));
    const oldRefresh = pool.refresh();
    await pool.close();
    const newRefresh = pool.refresh();
    finishOld(Response.json(payload([proxy('old', 8000)])));
    await oldRefresh;
    expect(pool.getAllCandidates()).toEqual([]);
    const concurrentRefresh = pool.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    finishNew(Response.json(payload([proxy('new', 8001)])));
    await Promise.all([newRefresh, concurrentRefresh]);
    expect(pool.getAllCandidates().map((p) => p.id)).toEqual(['new']);
  });

  it('does not run an already scheduled boot retry after close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    pool.init();
    await pool.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    await pool.close();
    inventory = [proxy('should-not-refresh', 8000)];
    now += 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
  });

  it('does not let stale failures or successes affect rotated credentials with the same ID', async () => {
    const old = proxy('rotated', 8000);
    const replacement = proxy('rotated', 8000, 'US', 'new-password');
    const warm = proxy('warm-only', 8001);
    inventory = [old, warm];
    await pool.refresh();
    reject(pool, old);
    inventory = [replacement, warm];
    now += 30_000;
    await pool.refresh();
    pool.markBad(old.id, old.url);
    pool.markOk(old.id, old.url);
    pool.evictByUrl(old.url);

    expect(pool.size).toBe(2);
    expect(pool.getWarmCandidates(1, (url) => url === warm.url)[0]?.url).toBe(warm.url);
    expect(pool.getAllCandidates().some((p) => p.url === replacement.url)).toBe(true);
  });

  it('prefers actual extraction successes ahead of warm sessions while keeping that preference across rotation', () => {
    const unknown = proxy('warm-only', 8000);
    const proven = proxy('proven', 8001);
    pool._setCandidatesForTest([unknown, proven]);
    pool.markOk(proven.id, proven.url);
    pool.markReachable(unknown.id, unknown.url);
    const isWarm = (url: string) => url === unknown.url;
    for (let i = 0; i < 3; i++) {
      expect(pool.getWarmCandidates(1, isWarm)[0]?.id).toBe('proven');
    }
  });

  it('preserves allowed-country priority and ranks proven exits inside each country', () => {
    const inWarm = proxy('in-warm', 8000, 'IN');
    const inProven = proxy('in-proven', 8001, 'IN');
    const sgProven = proxy('sg-proven', 8002, 'SG');
    pool._setCandidatesForTest([inWarm, sgProven, inProven]);
    pool.markOk(inProven.id, inProven.url);
    pool.markOk(sgProven.id, sgProven.url);
    expect(pool.getGeoCandidates({ allowed: ['IN', 'SG'] }, 3, () => true).map((p) => p.id))
      .toEqual(['in-proven', 'in-warm', 'sg-proven']);
  });

  it('does not promote reachable but unavailable content into extraction-success preference', () => {
    const reachable = proxy('reachable', 8000);
    const warm = proxy('warm', 8001);
    pool._setCandidatesForTest([reachable, warm]);
    pool.markBad(reachable.id, reachable.url);
    pool.markBad(reachable.id, reachable.url);
    pool.markReachable(reachable.id, reachable.url);
    pool.markBad(reachable.id, reachable.url);
    expect(pool.size).toBe(2);
    pool.markReachable(reachable.id, reachable.url);
    expect(pool.getWarmCandidates(1, (url) => url === warm.url)[0]?.id).toBe('warm');
  });

  it('does not let a late content-unavailable response undo a proxy cooldown', async () => {
    const p = proxy('cooled', 8000);
    inventory = [p];
    await pool.refresh();
    pool.evictByUrl(p.url);
    pool.markReachable(p.id, p.url);
    expect(pool.getAllCandidates()).toEqual([]);
    pool.markOk(p.id, p.url);
    expect(pool.getAllCandidates().map((candidate) => candidate.id)).toEqual(['cooled']);
  });

  it('forgets stale success preference after the bounded history TTL', () => {
    const proven = proxy('proven', 8000);
    const warm = proxy('warm', 8001);
    pool._setCandidatesForTest([proven, warm]);
    pool.markOk(proven.id, proven.url);
    now += 29 * 60_000;
    pool.markReachable(proven.id, proven.url);
    now += 2 * 60_000;
    expect(pool.getWarmCandidates(1, (url) => url === warm.url)[0]?.id).toBe('warm');
  });

  it('does not indefinitely retain departed proxy credentials in health history', async () => {
    const retired = Array.from({ length: 2_100 }, (_, i) => proxy(`retired-${i}`, 8000 + i));
    for (const p of retired) reject(pool, p);
    inventory = [retired[0]!, retired.at(-1)!];
    await pool.refresh();
    expect(pool.getAllCandidates().map((p) => p.id)).toEqual(['retired-0']);
  });

  it('applies the same cooldown to country discovery and allows its cached identity to recover on time', async () => {
    const bad = proxy('country-only', 8000, 'IN');
    const warm = proxy('other', 8001, 'US');
    inventory = [warm];
    await pool.refresh();
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      return Response.json(payload(url.searchParams.has('country_code') ? [bad] : inventory));
    });
    expect((await pool.getProxyForCountries(['IN']))?.id).toBe('country-only');
    reject(pool, bad);
    now += 60_000;
    expect(await pool.getProxyForCountries(['IN'])).toBeNull();
    now += 4 * 60_000;
    expect((await pool.getProxyForCountries(['IN']))?.id).toBe('country-only');
  });

  it('retains country inventory invalidated during discovery so cooldown expiry is authoritative', async () => {
    const p = proxy('country-inflight', 8000, 'IN');
    await pool.refresh();
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const lookup = pool.getProxyForCountries(['IN']);
    pool.evictByUrl(p.url);
    now += 60_000;
    finish(Response.json(payload([p])));
    expect(await lookup).toBeNull();
    now += 4 * 60_000;
    expect((await pool.getProxyForCountries(['IN']))?.id).toBe('country-inflight');
  });
});
