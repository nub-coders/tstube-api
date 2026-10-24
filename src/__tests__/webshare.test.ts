/**
 * Tests for the Webshare geo-bypass proxy pool — parsing, safety guards,
 * and rotation semantics. All pure / offline; no network calls.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  buildProxyUrl,
  formatBytes,
  parseProxyList,
  parseWebshareStats,
  WebsharePool,
  type WebshareProxy,
} from '../proxy.js';
import {
  isPrivateAddress,
  isSafeProxyUrlSync,
  looksLocalHostname,
} from '../urlValidation.js';

function proxy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    username: 'user',
    password: 'pass',
    proxy_address: '38.154.227.167',
    port: 5868,
    valid: true,
    country_code: 'US',
    city_name: 'Seattle',
    last_verification: '2026-10-05T12:00:00Z',
    ...overrides,
  };
}

describe('buildProxyUrl', () => {
  it('percent-encodes credentials', () => {
    expect(buildProxyUrl('user@x', 'p/ass w', '1.2.3.4', 8080)).toBe(
      'http://user%40x:p%2Fass%20w@1.2.3.4:8080',
    );
  });
});

describe('looksLocalHostname', () => {
  it.each(['localhost', 'foo.localhost', 'box.local', 'x.internal', 'a.home.arpa', ''])(
    'rejects %s',
    (h) => {
      expect(looksLocalHostname(h)).toBe(true);
    },
  );
  it('allows public names', () => {
    expect(looksLocalHostname('p.webshare.io')).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255', '192.0.2.9', '198.18.0.1'])(
    'rejects %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    },
  );
  it('allows public IPv4', () => {
    expect(isPrivateAddress('38.154.227.167')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
  it('rejects reserved IPv6', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fd12::1')).toBe(true);
    expect(isPrivateAddress('ff02::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
  });
  it('allows public IPv6', () => {
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });
  it('treats malformed input as unsafe', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('999.1.1.1')).toBe(true);
  });
});

describe('isSafeProxyUrlSync', () => {
  it('accepts a public http proxy URL', () => {
    expect(isSafeProxyUrlSync('http://user:pass@38.154.227.167:5868')).toBe(true);
  });
  it.each(['http://127.0.0.1:8080', 'http://user@10.0.0.1:8080', 'http://localhost:3128',
    'ftp://1.2.3.4', 'http://user:pass@192.168.0.14:80'])('rejects %s', (u) => {
    expect(isSafeProxyUrlSync(u)).toBe(false);
  });
  it('rejects malformed URLs', () => {
    expect(isSafeProxyUrlSync('not a url')).toBe(false);
  });
});

describe('parseProxyList', () => {
  it('builds encoded URLs and sorts freshest verification first', () => {
    const parsed = parseProxyList({
      results: [
        proxy({ id: 'old', last_verification: '2026-10-01T00:00:00Z' }),
        proxy({ id: 'new', last_verification: '2026-10-05T12:00:00Z' }),
        proxy({ id: 'never', last_verification: null }),
      ],
    });
    expect(parsed.proxies.map((p) => p.id)).toEqual(['new', 'old', 'never']);
    expect(parsed.proxies[0]!.url).toBe('http://user:pass@38.154.227.167:5868');
  });

  it('drops invalid and unsafe entries', () => {
    const parsed = parseProxyList({
      results: [
        proxy({ id: 'bad', valid: false }),
        proxy({ id: 'local', proxy_address: '127.0.0.1' }),
        proxy({ id: 'noport', port: 0 }),
        proxy({ id: 'ok' }),
      ],
    });
    expect(parsed.proxies.map((p) => p.id)).toEqual(['ok']);
    expect(parsed.droppedInvalid).toBe(2);
    expect(parsed.droppedUnsafe).toBe(1);
  });

  it('applies the country filter', () => {
    const parsed = parseProxyList(
      { results: [proxy({ id: 'us', country_code: 'US' }), proxy({ id: 'de', country_code: 'DE' })] },
      { countries: 'us' },
    );
    expect(parsed.proxies.map((p) => p.id)).toEqual(['us']);
    expect(parsed.droppedCountry).toBe(1);
  });

  it('tolerates malformed payloads', () => {
    expect(parseProxyList(null).proxies).toEqual([]);
    expect(parseProxyList({}).proxies).toEqual([]);
    expect(parseProxyList({ results: 'nope' }).proxies).toEqual([]);
  });
});

describe('WebsharePool rotation', () => {
  const pool = new WebsharePool();
  const list = (ids: string[]): WebshareProxy[] =>
    ids.map((id, i) => ({
      id,
      address: `38.0.0.${i + 1}`,
      port: 8080,
      username: 'u',
      password: 'p',
      url: buildProxyUrl('u', 'p', `38.0.0.${i + 1}`, 8080),
      countryCode: 'US',
      city: '',
      lastVerification: 0,
    }));

  beforeEach(() => {
    process.env.WEBSHARE_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.WEBSHARE_API_KEY;
  });

  it('round-robins across candidates', async () => {
    (pool as unknown as { _setCandidatesForTest: (l: WebshareProxy[]) => void })._setCandidatesForTest(
      list(['a', 'b']),
    );
    const first = await pool.getProxy();
    const second = await pool.getProxy();
    const third = await pool.getProxy();
    expect([first?.id, second?.id, third?.id]).toEqual(['a', 'b', 'a']);
  });

  it('evicts a proxy after three consecutive failures', async () => {
    (pool as unknown as { _setCandidatesForTest: (l: WebshareProxy[]) => void })._setCandidatesForTest(
      list(['x', 'y']),
    );
    pool.markBad('x');
    pool.markBad('x');
    pool.markBad('x');
    expect(pool.size).toBe(1);
    const next = await pool.getProxy();
    expect(next?.id).toBe('y');
  });

  it('clears failures on success', () => {
    (pool as unknown as { _setCandidatesForTest: (l: WebshareProxy[]) => void })._setCandidatesForTest(
      list(['k']),
    );
    pool.markBad('k');
    pool.markBad('k');
    pool.markOk('k');
    pool.markBad('k');
    expect(pool.size).toBe(1);
  });

  it('evictByUrl removes a replaced proxy immediately', async () => {
    (pool as unknown as { _setCandidatesForTest: (l: WebshareProxy[]) => void })._setCandidatesForTest(
      list(['gone', 'alive']),
    );
    const gone = (await pool.getProxy())!; // 'gone'
    expect(pool.evictByUrl(gone.url)).toBe(true);
    expect(pool.size).toBe(1);
    const next = await pool.getProxy();
    expect(next?.id).toBe('alive');
    // Unknown proxy URLs are a no-op.
    expect(pool.evictByUrl('http://u:p@0.0.0.1:1')).toBe(false);
  });

  it('status() exposes no credentials', () => {
    (pool as unknown as { _setCandidatesForTest: (l: WebshareProxy[]) => void })._setCandidatesForTest(
      list(['s']),
    );
    const s = JSON.stringify(pool.status());
    expect(s).not.toContain('password');
    expect(s).not.toContain('"p"');
  });

  it('returns disabled stats when WEBSHARE_API_KEY is unset', async () => {
    delete process.env.WEBSHARE_API_KEY;
    const disabledPool = new WebsharePool();
    const stats = await disabledPool.getBandwidthStats();
    expect(stats.enabled).toBe(false);
    expect(stats.usedFormatted).toBe('0 B');
    expect(stats.remainingFormatted).toBe('N/A');
  });

  it('summary() formats candidate country codes', () => {
    (pool as unknown as { _setCandidatesForTest: (l: WebshareProxy[]) => void })._setCandidatesForTest([
      { ...list(['c1'])[0]!, countryCode: 'US' },
      { ...list(['c2'])[0]!, countryCode: 'US' },
      { ...list(['c3'])[0]!, countryCode: 'DE' },
    ]);
    expect(pool.summary()).toBe('US×2, DE×1');
  });

  it('status() reflects cached bandwidth stats without leaking credentials', () => {
    (pool as unknown as { _setCandidatesForTest: (l: WebshareProxy[]) => void })._setCandidatesForTest(list(['s']));
    pool._setStatsForTest({
      enabled: true,
      usedBytes: 1024 * 1024 * 1024,
      usedFormatted: '1 GB',
      limitBytes: 10 * 1024 * 1024 * 1024,
      limitGb: 10,
      limitFormatted: '10 GB',
      remainingBytes: 9 * 1024 * 1024 * 1024,
      remainingFormatted: '9 GB (90% remaining)',
      percentUsed: 10,
      percentRemaining: 90,
      totalRequests: 50,
      successfulRequests: 48,
      failedRequests: 2,
      countriesUsed: { US: 50 },
      activePlan: { id: 1, proxyType: 'dc', proxyCount: 10, status: 'active' },
      lastUpdatedAt: 1729760000000,
    });
    const st = pool.status();
    expect(st.bandwidth).toEqual({
      used: '1 GB',
      used_bytes: 1024 * 1024 * 1024,
      limit: '10 GB',
      limit_bytes: 10 * 1024 * 1024 * 1024,
      remaining: '9 GB (90% remaining)',
      remaining_bytes: 9 * 1024 * 1024 * 1024,
      percent_used: 10,
      percent_remaining: 90,
      total_requests: 50,
      last_updated: expect.any(String),
    });
  });

  it('getPublicHealth reports operational and bandwidthReached correctly', async () => {
    delete process.env.WEBSHARE_API_KEY;
    const disabledPool = new WebsharePool();
    expect(await disabledPool.getPublicHealth()).toEqual({
      enabled: false,
      operational: true,
      bandwidthReached: false,
      statusBadge: '⚪ Direct (No Proxy Tier)',
    });

    process.env.WEBSHARE_API_KEY = 'test-key';
    const activePool = new WebsharePool();
    activePool._setCandidatesForTest(list(['p1']));

    // 1. Healthy bandwidth
    activePool._setStatsForTest({
      enabled: true,
      usedBytes: 10 * 1024 * 1024 * 1024,
      usedFormatted: '10 GB',
      limitBytes: 100 * 1024 * 1024 * 1024,
      limitGb: 100,
      limitFormatted: '100 GB',
      remainingBytes: 90 * 1024 * 1024 * 1024,
      remainingFormatted: '90 GB (90% remaining)',
      percentUsed: 10,
      percentRemaining: 90,
      totalRequests: 100,
      successfulRequests: 95,
      failedRequests: 5,
      countriesUsed: { US: 100 },
      activePlan: null,
      lastUpdatedAt: Date.now(),
    });
    const healthy = await activePool.getPublicHealth();
    expect(healthy.enabled).toBe(true);
    expect(healthy.operational).toBe(true);
    expect(healthy.bandwidthReached).toBe(false);
    expect(healthy.statusBadge).toBe('🟢 Operational');
    expect(healthy.notice).toBeUndefined();

    // 2. Near quota (>95%)
    activePool._setStatsForTest({
      enabled: true,
      usedBytes: 96 * 1024 * 1024 * 1024,
      usedFormatted: '96 GB',
      limitBytes: 100 * 1024 * 1024 * 1024,
      limitGb: 100,
      limitFormatted: '100 GB',
      remainingBytes: 4 * 1024 * 1024 * 1024,
      remainingFormatted: '4 GB (4% remaining)',
      percentUsed: 96,
      percentRemaining: 4,
      totalRequests: 100,
      successfulRequests: 95,
      failedRequests: 5,
      countriesUsed: { US: 100 },
      activePlan: null,
      lastUpdatedAt: Date.now(),
    });
    const low = await activePool.getPublicHealth();
    expect(low.statusBadge).toBe('🟡 Bandwidth Low');
    expect(low.notice).toContain('near monthly capacity');

    // 3. Bandwidth reached (0 remaining)
    activePool._setStatsForTest({
      enabled: true,
      usedBytes: 100 * 1024 * 1024 * 1024,
      usedFormatted: '100 GB',
      limitBytes: 100 * 1024 * 1024 * 1024,
      limitGb: 100,
      limitFormatted: '100 GB',
      remainingBytes: 0,
      remainingFormatted: '0 B (0% remaining)',
      percentUsed: 100,
      percentRemaining: 0,
      totalRequests: 200,
      successfulRequests: 180,
      failedRequests: 20,
      countriesUsed: { US: 200 },
      activePlan: null,
      lastUpdatedAt: Date.now(),
    });
    const reached = await activePool.getPublicHealth();
    expect(reached.operational).toBe(false);
    expect(reached.bandwidthReached).toBe(true);
    expect(reached.statusBadge).toBe('🔴 Bandwidth Limit Reached');
    expect(reached.notice).toContain('Proxy bandwidth quota has been reached');

    // 4. Empty candidate pool
    activePool._setCandidatesForTest([]);
    activePool._setStatsForTest(null);
    const empty = await activePool.getPublicHealth();
    expect(empty.operational).toBe(false);
    expect(empty.bandwidthReached).toBe(false);
    expect(empty.statusBadge).toContain('Proxy Pool Empty');
  });
});

describe('formatBytes', () => {
  it('formats 0 and negative bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-100)).toBe('0 B');
  });

  it('formats byte boundaries correctly', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 5)).toBe('5 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 2.5)).toBe('2.5 TB');
  });
});

describe('parseWebshareStats', () => {
  it('parses aggregate stats with a capped plan', () => {
    const statsPayload = {
      bandwidth_total: 25 * 1024 * 1024 * 1024,
      requests_total: 1000,
      requests_successful: 950,
      requests_failed: 50,
      countries_used: { US: 800, DE: 200 },
    };
    const planPayload = {
      results: [
        {
          id: 1234,
          proxy_type: 'datacenter',
          proxy_count: 10,
          bandwidth_limit: 100, // 100 GB
          status: 'active',
        },
      ],
    };

    const stats = parseWebshareStats(statsPayload, planPayload);
    expect(stats.enabled).toBe(true);
    expect(stats.usedBytes).toBe(25 * 1024 * 1024 * 1024);
    expect(stats.usedFormatted).toBe('25 GB');
    expect(stats.limitGb).toBe(100);
    expect(stats.limitFormatted).toBe('100 GB');
    expect(stats.remainingBytes).toBe(75 * 1024 * 1024 * 1024);
    expect(stats.remainingFormatted).toContain('75 GB');
    expect(stats.remainingFormatted).toContain('75% remaining');
    expect(stats.percentUsed).toBe(25);
    expect(stats.percentRemaining).toBe(75);
    expect(stats.totalRequests).toBe(1000);
    expect(stats.successfulRequests).toBe(950);
    expect(stats.failedRequests).toBe(50);
    expect(stats.countriesUsed).toEqual({ US: 800, DE: 200 });
    expect(stats.activePlan).toEqual({
      id: 1234,
      proxyType: 'datacenter',
      proxyCount: 10,
      status: 'active',
    });
  });

  it('parses unlimited plan (bandwidth_limit = 0)', () => {
    const statsPayload = {
      bandwidth_total: 500 * 1024 * 1024, // 500 MB
      requests_total: 200,
      requests_successful: 190,
      requests_failed: 10,
    };
    const planPayload = {
      bandwidth_limit: 0,
      proxy_type: 'residential',
      proxy_count: 50,
      status: 'active',
    };

    const stats = parseWebshareStats(statsPayload, planPayload);
    expect(stats.limitFormatted).toBe('Unlimited');
    expect(stats.remainingFormatted).toBe('Unlimited');
    expect(stats.remainingBytes).toBeNull();
    expect(stats.percentUsed).toBeNull();
    expect(stats.percentRemaining).toBeNull();
  });

  it('parses hourly stats list and filters out is_projected entries', () => {
    const listPayload = {
      results: [
        {
          timestamp: '2026-10-24T00:00:00Z',
          bandwidth_total: 1024 * 1024 * 100, // 100 MB
          requests_total: 50,
          requests_successful: 45,
          requests_failed: 5,
          is_projected: false,
          countries_used: { US: 50 },
        },
        {
          timestamp: '2026-10-24T01:00:00Z',
          bandwidth_total: 1024 * 1024 * 200, // 200 MB (projected / future forecast)
          requests_total: 100,
          requests_successful: 90,
          requests_failed: 10,
          is_projected: true,
          countries_used: { US: 100 },
        },
      ],
    };

    const stats = parseWebshareStats(listPayload, null);
    expect(stats.usedBytes).toBe(1024 * 1024 * 100);
    expect(stats.totalRequests).toBe(50);
    expect(stats.successfulRequests).toBe(45);
    expect(stats.failedRequests).toBe(5);
    expect(stats.countriesUsed).toEqual({ US: 50 });
    expect(stats.limitFormatted).toBe('Unknown');
    expect(stats.remainingFormatted).toBe('Unknown');
  });

  it('safely handles empty or malformed payloads', () => {
    const stats = parseWebshareStats(null, null);
    expect(stats.usedBytes).toBe(0);
    expect(stats.usedFormatted).toBe('0 B');
    expect(stats.limitFormatted).toBe('Unknown');
    expect(stats.remainingFormatted).toBe('Unknown');
    expect(stats.totalRequests).toBe(0);
  });
});
