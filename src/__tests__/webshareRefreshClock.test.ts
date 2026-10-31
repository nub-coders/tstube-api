import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebsharePool } from '../proxy.js';

vi.mock('../config.js', () => ({
  config: () => ({ WEBSHARE_API_KEY: 'mock-clock-key', WEBSHARE_PROXY_COUNTRIES: '', WEBSHARE_REFRESH_SEC: 60 }),
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(), readFileSync: vi.fn(() => '{}'), renameSync: vi.fn(), writeFileSync: vi.fn(),
}));

describe('Webshare refresh elapsed time', () => {
  let pool: WebsharePool;
  let wallTime: number;
  let elapsed: number;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    pool = new WebsharePool();
    wallTime = 1_800_000_000_000;
    elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => wallTime);
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    fetchMock = vi.fn<typeof fetch>(async () => Response.json({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await pool.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function listFetches(): number {
    return fetchMock.mock.calls.filter(([url]) => !new URL(String(url)).searchParams.has('country_code')).length;
  }

  it.each(['refresh', 'getProxy', 'getProxyForCountries'] as const)(
    'allows %s to refresh after 30 seconds despite a backward clock adjustment', async method => {
      await pool.refresh();
      expect(listFetches()).toBe(1);

      wallTime -= 5.5 * 60 * 60 * 1000;
      elapsed = 30_000;
      if (method === 'getProxyForCountries') await pool.getProxyForCountries(['US']);
      else await pool[method]();

      expect(listFetches()).toBe(2);
    },
  );

  it('keeps the 30-second rate limit despite a forward clock adjustment', async () => {
    await pool.refresh();
    wallTime += 5.5 * 60 * 60 * 1000;
    elapsed = 29_999;
    await pool.refresh();
    expect(listFetches()).toBe(1);

    elapsed = 30_000;
    await pool.refresh();
    expect(listFetches()).toBe(2);
  });

  it('refreshes immediately on startup and after close even at zero process elapsed time', async () => {
    await pool.refresh();
    expect(listFetches()).toBe(1);
    await pool.close();
    await pool.refresh();
    expect(listFetches()).toBe(2);
  });

  it('continues periodic refreshes after a backward clock adjustment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fetchMock.mockImplementation(async () => Response.json({ results: [{
      id: 'clock-exit', proxy_address: '38.154.227.167', port: 8080,
      username: 'u', password: 'p', country_code: 'US', valid: true,
    }] }));
    pool.init();
    await pool.refresh();
    expect(listFetches()).toBe(1);

    wallTime -= 5.5 * 60 * 60 * 1000;
    elapsed = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listFetches()).toBe(2);
  });
});
