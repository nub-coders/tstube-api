/**
 * Tests for the Webshare geo-bypass proxy pool — parsing, safety guards,
 * and rotation semantics. All pure / offline; no network calls.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  buildProxyUrl,
  parseProxyList,
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
});
