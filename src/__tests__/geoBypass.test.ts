/**
 * Geo-restriction targeting tests: classification of geo-block failures,
 * microformat country extraction, official Data API regionRestriction
 * parsing, and the WebsharePool country-matched proxy pickers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractGeoCountries, isGeoBlockedError } from '../innertube.js';
import { fetchRegionRestriction } from '../youtubeApi.js';
import { WebsharePool, type WebshareProxy } from '../proxy.js';

const state = vi.hoisted(() => ({ apiKeys: 'test-key-1,test-key-2' }));

vi.mock('../config.js', () => ({
  config: () => ({
    YOUTUBE_API_KEYS: state.apiKeys,
    WEBSHARE_API_KEY: 'ws-test-key',
    WEBSHARE_PROXY_COUNTRIES: '',
  }),
  isAdmin: () => false,
}));

let nextIp = 10;
const proxyRaw = (id: string, cc: string): Record<string, unknown> => ({
  id,
  username: 'u',
  password: 'p',
  proxy_address: `45.61.0.${nextIp++}`,
  port: 5868,
  valid: true,
  country_code: cc,
  last_verification: '2026-10-05T12:00:00Z',
});

const wsProxy = (id: string, cc: string): WebshareProxy => ({
  id,
  address: `proxy-${id}.example.com`,
  port: 8000,
  username: 'u',
  password: 'p',
  url: `http://u:p@proxy-${id}.example.com:8000`,
  countryCode: cc,
  city: '',
  lastVerification: 1,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isGeoBlockedError', () => {
  it.each([
    'UNPLAYABLE: The uploader has not made this video available in your country',
    'ERROR: This video is not available in your country.',
    'ERROR: This video contains content from SME, who has blocked it in your country on copyright grounds',
    'geo-restricted content',
  ])('classifies %j as a geo restriction', (e) => {
    expect(isGeoBlockedError(e)).toBe(true);
  });

  it.each([
    "LOGIN_REQUIRED: Sign in to confirm you're not a bot",
    'ERROR: This video is unavailable',
    'No stream formats returned',
    'ANDROID error: Request to youtubei/v1/player failed with status code 400',
  ])('does not classify %j as a geo restriction', (e) => {
    expect(isGeoBlockedError(e)).toBe(false);
  });
});

describe('extractGeoCountries', () => {
  it('reads available_countries from the player microformat', () => {
    expect(
      extractGeoCountries({ microformat: { available_countries: ['IN', 'us', 42, null, 'XX1'] } }),
    ).toEqual(['IN', 'US']);
  });

  it('returns empty when absent or malformed', () => {
    expect(extractGeoCountries(undefined)).toEqual([]);
    expect(extractGeoCountries({ microformat: {} })).toEqual([]);
    expect(extractGeoCountries({ microformat: { available_countries: 'IN' } })).toEqual([]);
  });
});

describe('fetchRegionRestriction (official Data API)', () => {
  it('parses the blocked list and normalizes codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ items: [{ contentDetails: { regionRestriction: { blocked: ['us', 'De', 42] } } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    expect(await fetchRegionRestriction('s2HYl12gmOY')).toEqual({
      allowed: undefined,
      blocked: ['US', 'DE'],
    });
  });

  it('returns null for unrestricted videos and when no API keys are configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ items: [{ contentDetails: {} }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    expect(await fetchRegionRestriction('s2HYl12gmOY')).toBeNull();

    state.apiKeys = '';
    const keyless = vi.fn();
    vi.stubGlobal('fetch', keyless);
    expect(await fetchRegionRestriction('s2HYl12gmOY')).toBeNull();
    expect(keyless).not.toHaveBeenCalled();
    state.apiKeys = 'test-key-1,test-key-2';
  });
});

describe('WebsharePool country targeting', () => {
  it('picks a proxy in an allowed country, in priority order, rotating within the set', async () => {
    const pool = new WebsharePool();
    pool._setCandidatesForTest([wsProxy('us1', 'US'), wsProxy('in1', 'IN'), wsProxy('de1', 'DE'), wsProxy('in2', 'IN')]);

    const first = await pool.getProxyForCountries(['IN', 'US']);
    const second = await pool.getProxyForCountries(['IN', 'US']);
    expect(first?.countryCode).toBe('IN');
    expect(second?.countryCode).toBe('IN');
    expect([first?.id, second?.id]).toEqual(['in1', 'in2']);

    const third = await pool.getProxyForCountries(['US']);
    expect(third?.id).toBe('us1');
  });

  it('avoids blocked countries for blacklist restrictions', () => {
    const pool = new WebsharePool();
    pool._setCandidatesForTest([wsProxy('us1', 'US'), wsProxy('de1', 'DE'), wsProxy('fr1', 'FR')]);

    const p = pool.getProxyNotInCountries(['US']);
    expect(p?.countryCode).not.toBe('US');
    expect(pool.getProxyNotInCountries(['US', 'DE', 'FR'])).toBeNull();
  });

  it('fetches a country-filtered list on demand when the pool lacks the country', async () => {
    const pool = new WebsharePool();
    pool._setCandidatesForTest([wsProxy('us1', 'US')]);

    const fetchMock = vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      const cc = url.includes('country_code=IN') ? 'IN' : 'US';
      return new Response(JSON.stringify({ results: [proxyRaw(`live-${cc.toLowerCase()}`, cc)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = await pool.getProxyForCountries(['in']);
    expect(p?.countryCode).toBe('IN');

    // Auth header + guarded allowlisted origin on the country fetch.
    const countryCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('country_code=IN'));
    expect(countryCalls).toHaveLength(1);
    expect(String(countryCalls[0]![0])).toContain('proxy.webshare.io');
    expect(countryCalls[0]![1]?.headers?.Authorization).toBe('Token ws-test-key');

    // Cached within the TTL: a repeat pick makes no new request.
    await pool.getProxyForCountries(['IN']);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('country_code=IN'))).toHaveLength(1);
  });

  it('returns null when nothing matches anywhere and the API has no exits either', async () => {
    const pool = new WebsharePool();
    pool._setCandidatesForTest([wsProxy('us1', 'US')]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    expect(await pool.getProxyForCountries(['JP'])).toBeNull();
  });
});
