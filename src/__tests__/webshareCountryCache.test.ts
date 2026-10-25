import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebsharePool, buildProxyUrl } from '../proxy.js';

vi.mock('../config.js', () => ({
  config: () => ({ WEBSHARE_API_KEY: 'mock-country-key', WEBSHARE_PROXY_COUNTRIES: '' }),
}));

function rawProxy(id: string, countryCode = 'IN', port = 8080) {
  return {
    id,
    username: 'u',
    password: 'p',
    proxy_address: '38.154.227.167',
    port,
    valid: true,
    country_code: countryCode,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Webshare country discovery cache', () => {
  let pool: WebsharePool;
  let countryFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    pool = new WebsharePool();
    countryFetch = vi.fn<typeof fetch>(async () => Response.json({ results: [] }));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://proxy.webshare.io');
      if (url.searchParams.has('country_code')) return countryFetch(input, init);
      return Promise.resolve(Response.json({ results: [] }));
    }));
    // Start with a completed, empty pool refresh, avoiding incidental refreshes
    // while controlling country discovery promises separately.
    await pool.refresh();
  });

  afterEach(async () => {
    await pool.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shares an unfinished lookup instead of returning a cached null placeholder', async () => {
    const response = deferred<Response>();
    countryFetch.mockReturnValueOnce(response.promise);

    const first = pool.getProxyForCountries(['in']);
    const second = pool.getProxyForCountries([' IN ']);
    const secondSettled = vi.fn();
    void second.then(secondSettled);
    await Promise.resolve();

    expect(countryFetch).toHaveBeenCalledTimes(1);
    expect(secondSettled).not.toHaveBeenCalled();
    response.resolve(Response.json({ results: [rawProxy('shared')] }));
    const [a, b] = await Promise.all([first, second]);
    expect(a?.id).toBe('shared');
    expect(b).toBe(a);
    expect((await pool.getProxyForCountries(['IN']))?.id).toBe('shared');
    expect(countryFetch).toHaveBeenCalledTimes(1);
  });

  it('shares completed negative results and expires them from completion time', async () => {
    const clock = vi.spyOn(Date, 'now');
    const start = Date.now();
    const response = deferred<Response>();
    countryFetch.mockReturnValueOnce(response.promise);
    clock.mockReturnValue(start);
    const first = pool.getProxyForCountries(['IN']);
    const second = pool.getProxyForCountries(['IN']);

    clock.mockReturnValue(start + 60_000);
    response.resolve(Response.json({ results: [] }));
    expect(await Promise.all([first, second])).toEqual([null, null]);
    clock.mockReturnValue(start + 5 * 60_000);
    expect(await pool.getProxyForCountries(['IN'])).toBeNull();
    expect(countryFetch).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(start + 6 * 60_000);
    countryFetch.mockResolvedValueOnce(Response.json({ results: [rawProxy('after-expiry')] }));
    expect((await pool.getProxyForCountries(['IN']))?.id).toBe('after-expiry');
    expect(countryFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['markBad', 'evictByUrl'] as const)('invalidates country-only exits through %s', async (method) => {
    countryFetch.mockResolvedValueOnce(Response.json({ results: [rawProxy('gone')] }));
    const gone = (await pool.getProxyForCountries(['IN']))!;
    expect(pool.size).toBe(0);

    if (method === 'markBad') {
      pool.markBad(gone.id);
      pool.markBad(gone.id);
      expect((await pool.getProxyForCountries(['IN']))?.id).toBe('gone');
      pool.markBad(gone.id);
    } else {
      expect(pool.evictByUrl(gone.url)).toBe(true);
      expect(pool.evictByUrl(gone.url)).toBe(false);
    }

    countryFetch.mockResolvedValueOnce(Response.json({ results: [rawProxy('replacement', 'IN', 8081)] }));
    expect((await pool.getProxyForCountries(['IN']))?.id).toBe('replacement');
    expect(countryFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['markBad', 'evictByUrl'] as const)('does not publish an exit invalidated during discovery through %s', async (method) => {
    const response = deferred<Response>();
    countryFetch.mockReturnValueOnce(response.promise);
    const first = pool.getProxyForCountries(['IN']);
    const second = pool.getProxyForCountries(['IN']);

    if (method === 'markBad') {
      pool.markBad('stale');
      pool.markBad('stale');
      pool.markBad('stale');
    } else {
      pool.evictByUrl(buildProxyUrl('u', 'p', '38.154.227.167', 8080));
    }
    response.resolve(Response.json({ results: [rawProxy('stale')] }));
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(await pool.getProxyForCountries(['IN'])).toBeNull();
    expect(countryFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps healthy discovered alternatives when the first exit was evicted during the fetch', async () => {
    const response = deferred<Response>();
    countryFetch.mockReturnValueOnce(response.promise);
    const lookup = pool.getProxyForCountries(['IN']);
    pool.evictByUrl(buildProxyUrl('u', 'p', '38.154.227.167', 8080));
    response.resolve(Response.json({ results: [rawProxy('stale'), rawProxy('healthy', 'IN', 8081)] }));
    expect((await lookup)?.id).toBe('healthy');
    expect((await pool.getProxyForCountries(['IN']))?.id).toBe('healthy');
  });

  it('does not let a lookup completed after close overwrite a newer lookup', async () => {
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    countryFetch.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const oldLookup = pool.getProxyForCountries(['IN']);
    await pool.close();
    const newLookup = pool.getProxyForCountries(['IN']);

    oldResponse.resolve(Response.json({ results: [rawProxy('old')] }));
    expect(await oldLookup).toBeNull();
    const concurrent = pool.getProxyForCountries(['IN']);
    expect(countryFetch).toHaveBeenCalledTimes(2);
    newResponse.resolve(Response.json({ results: [rawProxy('new')] }));
    const [newProxy, concurrentProxy] = await Promise.all([newLookup, concurrent]);
    expect(newProxy?.id).toBe('new');
    expect(concurrentProxy).toBe(newProxy);
    expect((await pool.getProxyForCountries(['IN']))?.id).toBe('new');
  });

  it('does not discover malformed country codes', async () => {
    expect(await pool.getProxyForCountries(['', 'IND', '123', '../../'])).toBeNull();
    expect(countryFetch).not.toHaveBeenCalled();
  });
});
