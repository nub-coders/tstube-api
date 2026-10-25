/**
 * Webshare proxy pool — the geo-bypass fallback tier.
 *
 * When the direct resolver cannot resolve a video —
 * typically publisher geo-blocks — the resolver retries through a Webshare
 * datacenter proxy in another region. The pool is fetched live from the
 * Webshare API so burnt IPs are replaced without a redeploy.
 *
 * Disabled entirely when WEBSHARE_API_KEY is unset; every failure path is
 * contained so the proxy tier can never take the main resolver down.
 */
import { config } from './config.js';
import { getLogger } from './logger.js';
import { isPrivateAddress, looksLocalHostname } from './urlValidation.js';
import net from 'node:net';

const log = getLogger('ytube_api.webshare');

const API_URL = 'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100';
const STATS_AGGREGATE_API_URL = 'https://proxy.webshare.io/api/v2/stats/aggregate/';
const STATS_LIST_API_URL = 'https://proxy.webshare.io/api/v2/stats/';
const PLAN_API_URL = 'https://proxy.webshare.io/api/v2/subscription/plan/';
const FETCH_TIMEOUT_MS = 15_000;
/** Consecutive failed resolutions before a proxy is pulled from rotation. */
const MAX_FAILURES_PER_PROXY = 3;
/** Never re-fetch more often than this (rate-limit headroom for the API). */
const MIN_REFRESH_INTERVAL_MS = 30_000;
/** How long an on-demand country-filtered fetch stays authoritative. */
const COUNTRY_FETCH_TTL_MS = 5 * 60_000;
/** Bandwidth stats cache TTL (60s). */
const STATS_CACHE_TTL_MS = 60_000;

export interface WebshareProxy {
  id: string;
  address: string;
  port: number;
  username: string;
  password: string;
  /** Ready-to-use http:// URL with encoded credentials. */
  url: string;
  countryCode: string;
  city: string;
  /** Epoch seconds of Webshare's last connectivity check; 0 when unknown. */
  lastVerification: number;
}

interface PendingCountryFetch {
  state: 'pending';
  inflight: Promise<WebshareProxy | null>;
  invalidatedIds: Set<string>;
  invalidatedUrls: Set<string>;
}

type CountryFetchEntry = PendingCountryFetch | {
  state: 'complete';
  at: number;
  proxy: WebshareProxy | null;
};

export interface ParsedProxyList {
  proxies: WebshareProxy[];
  droppedInvalid: number;
  droppedUnsafe: number;
  droppedCountry: number;
}

export interface WebshareBandwidthStats {
  enabled: boolean;
  usedBytes: number;
  usedFormatted: string;
  limitBytes: number | null;
  limitGb: number | null;
  limitFormatted: string;
  remainingBytes: number | null;
  remainingFormatted: string;
  percentUsed: number | null;
  percentRemaining: number | null;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  countriesUsed: Record<string, number>;
  activePlan: {
    id: number;
    proxyType: string;
    proxyCount: number;
    status: string;
  } | null;
  lastUpdatedAt: number;
  error?: string;
}

export interface WebsharePublicHealth {
  enabled: boolean;
  operational: boolean;
  bandwidthReached: boolean;
  statusBadge: string;
  notice?: string;
}

/** Format a raw byte count into a human-readable string (e.g. "12.34 GB", "500 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const idx = Math.min(units.length - 1, Math.max(0, i));
  const val = bytes / Math.pow(1024, idx);
  const formatted = val >= 100 || idx === 0 ? Math.round(val).toString() : Number(val.toFixed(2)).toString();
  return `${formatted} ${units[idx]}`;
}

/** Percent-encode credentials and assemble the proxy URL. */
export function buildProxyUrl(
  username: string,
  password: string,
  address: string,
  port: number,
): string {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${address}:${port}`;
}

function toEpoch(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t / 1000;
}

function apiKey(): string | null {
  try {
    return config().WEBSHARE_API_KEY || null;
  } catch {
    return process.env.WEBSHARE_API_KEY || null;
  }
}

/**
 * The compile-time API URL, re-validated per request: https + the allowlisted
 * host only (SSRF guard). Only query params may vary between calls (e.g. the
 * country filter); the origin may not.
 */
export function guardedWebshareUrl(target: string): URL | null {
  try {
    const url = new URL(target);
    if (url.protocol === 'https:' && url.hostname === 'proxy.webshare.io') return url;
  } catch {
    /* fall through */
  }
  return null;
}

function guardedApiUrl(): URL | null {
  return guardedWebshareUrl(API_URL);
}

/** A proxy exit must be a public host — never an internal address. */
function isSafeProxyHost(address: string): boolean {
  const h = address.trim().toLowerCase();
  if (!h || looksLocalHostname(h)) return false;
  if (net.isIP(h)) return !isPrivateAddress(h);
  return true; // hostname — DNS-checked asynchronously before use
}

/**
 * Parse a Webshare proxy/list response into usable proxies:
 * - drops entries flagged invalid by Webshare or with unsafe/missing addresses
 * - applies the WEBSHARE_PROXY_COUNTRIES filter when set
 * - sorts by last_verification descending (freshest exits first)
 */
export function parseProxyList(
  payload: unknown,
  opts: { countries?: string } = {},
): ParsedProxyList {
  const result: ParsedProxyList = {
    proxies: [],
    droppedInvalid: 0,
    droppedUnsafe: 0,
    droppedCountry: 0,
  };

  const results = (payload as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(results)) return result;

  const countries = (opts.countries ?? '')
    .split(/[,\s]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

  for (const raw of results) {
    const item = raw as Record<string, unknown>;
    const address = typeof item.proxy_address === 'string' ? item.proxy_address.trim() : '';
    const port = Number(item.port);
    const username = typeof item.username === 'string' ? item.username : '';
    const password = typeof item.password === 'string' ? item.password : '';

    if (item.valid === false || !address || !Number.isInteger(port) || port <= 0 || port > 65535) {
      result.droppedInvalid++;
      continue;
    }
    if (!isSafeProxyHost(address)) {
      result.droppedUnsafe++;
      continue;
    }
    const countryCode = typeof item.country_code === 'string' ? item.country_code.toUpperCase() : '';
    if (countries.length && !countries.includes(countryCode)) {
      result.droppedCountry++;
      continue;
    }

    result.proxies.push({
      id: String(item.id ?? `${address}:${port}`),
      address,
      port,
      username,
      password,
      url: buildProxyUrl(username, password, address, port),
      countryCode,
      city: typeof item.city_name === 'string' ? item.city_name : '',
      lastVerification: toEpoch(item.last_verification),
    });
  }

  result.proxies.sort((a, b) => b.lastVerification - a.lastVerification);
  return result;
}

/**
 * Parse Webshare proxy stats and subscription plan payloads into a unified
 * bandwidth usage and quota status object.
 *
 * Supports both /stats/aggregate/ (single object) and /stats/ (hourly list).
 */
export function parseWebshareStats(
  statsPayload: unknown,
  planPayload: unknown,
): WebshareBandwidthStats {
  let usedBytes = 0;
  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;
  const countriesUsed: Record<string, number> = {};

  if (statsPayload && typeof statsPayload === 'object') {
    const list = Array.isArray(statsPayload)
      ? statsPayload
      : Array.isArray((statsPayload as Record<string, unknown>).results)
        ? ((statsPayload as Record<string, unknown>).results as unknown[])
        : null;

    if (list) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        if (row.is_projected === true) continue;
        if (typeof row.bandwidth_total === 'number') usedBytes += row.bandwidth_total;
        if (typeof row.requests_total === 'number') totalRequests += row.requests_total;
        if (typeof row.requests_successful === 'number') successfulRequests += row.requests_successful;
        if (typeof row.requests_failed === 'number') failedRequests += row.requests_failed;
        if (row.countries_used && typeof row.countries_used === 'object') {
          for (const [cc, cnt] of Object.entries(row.countries_used as Record<string, unknown>)) {
            countriesUsed[cc] = (countriesUsed[cc] ?? 0) + (Number(cnt) || 0);
          }
        }
      }
    } else {
      const obj = statsPayload as Record<string, unknown>;
      if (typeof obj.bandwidth_total === 'number') usedBytes = obj.bandwidth_total;
      if (typeof obj.requests_total === 'number') totalRequests = obj.requests_total;
      if (typeof obj.requests_successful === 'number') successfulRequests = obj.requests_successful;
      if (typeof obj.requests_failed === 'number') failedRequests = obj.requests_failed;
      if (obj.countries_used && typeof obj.countries_used === 'object') {
        for (const [cc, cnt] of Object.entries(obj.countries_used as Record<string, unknown>)) {
          countriesUsed[cc] = (countriesUsed[cc] ?? 0) + (Number(cnt) || 0);
        }
      }
    }
  }

  let activePlan: { id: number; proxyType: string; proxyCount: number; status: string } | null = null;
  let bandwidthLimitGb: number | null = null;

  if (planPayload && typeof planPayload === 'object') {
    const pObj = planPayload as Record<string, unknown>;
    let planCandidate: Record<string, unknown> | null = null;
    if (Array.isArray(pObj.results)) {
      const plans = pObj.results as Array<Record<string, unknown>>;
      planCandidate = plans.find((p) => p && p.status === 'active') ?? plans[0] ?? null;
    } else if (pObj.id !== undefined || pObj.bandwidth_limit !== undefined) {
      planCandidate = pObj;
    }

    if (planCandidate) {
      if (typeof planCandidate.bandwidth_limit === 'number') {
        bandwidthLimitGb = planCandidate.bandwidth_limit;
      }
      activePlan = {
        id: Number(planCandidate.id) || 0,
        proxyType: typeof planCandidate.proxy_type === 'string' ? planCandidate.proxy_type : 'unknown',
        proxyCount: typeof planCandidate.proxy_count === 'number' ? planCandidate.proxy_count : 0,
        status: typeof planCandidate.status === 'string' ? planCandidate.status : 'active',
      };
    }
  }

  let limitBytes: number | null = null;
  let limitFormatted = 'Unknown';
  let remainingBytes: number | null = null;
  let remainingFormatted = 'Unknown';
  let percentUsed: number | null = null;
  let percentRemaining: number | null = null;

  if (bandwidthLimitGb !== null) {
    if (bandwidthLimitGb === 0) {
      limitBytes = 0;
      limitFormatted = 'Unlimited';
      remainingBytes = null;
      remainingFormatted = 'Unlimited';
    } else if (bandwidthLimitGb > 0) {
      limitBytes = Math.round(bandwidthLimitGb * 1024 * 1024 * 1024);
      limitFormatted = formatBytes(limitBytes);
      remainingBytes = Math.max(0, limitBytes - usedBytes);
      percentUsed = Math.min(100, Math.max(0, Number(((usedBytes / limitBytes) * 100).toFixed(1))));
      percentRemaining = Math.max(0, Number((100 - percentUsed).toFixed(1)));
      remainingFormatted = `${formatBytes(remainingBytes)} (${percentRemaining}% remaining)`;
    }
  }

  return {
    enabled: true,
    usedBytes,
    usedFormatted: formatBytes(usedBytes),
    limitBytes,
    limitGb: bandwidthLimitGb,
    limitFormatted,
    remainingBytes,
    remainingFormatted,
    percentUsed,
    percentRemaining,
    totalRequests,
    successfulRequests,
    failedRequests,
    countriesUsed,
    activePlan,
    lastUpdatedAt: Date.now(),
  };
}

/**
 * Round-robin pool of Webshare proxies with live API refresh.
 * `getProxy()` hands out exits one by one; `markBad()` rotates and eventually
 * evicts repeatedly-failing proxies; `refresh()` re-reads the account's list.
 */
export class WebsharePool {
  private candidates: WebshareProxy[] = [];
  private rrIndex = 0;
  private warmIndex = 0;
  private failures = new Map<string, number>();
  private countryFetches = new Map<string, CountryFetchEntry>();
  private timer: NodeJS.Timeout | null = null;
  private refreshInflight: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private initialized = false;
  private cachedStats: WebshareBandwidthStats | null = null;
  private statsFetchInflight: Promise<WebshareBandwidthStats> | null = null;
  private lastStatsFetchAt = 0;

  get enabled(): boolean {
    try {
      return Boolean(config().WEBSHARE_API_KEY);
    } catch {
      return Boolean(process.env.WEBSHARE_API_KEY);
    }
  }

  get size(): number {
    return this.candidates.length;
  }

  /** Start the periodic refresh; disabled pools stay inert. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.enabled) {
      log.info('[WEBSHARE] WEBSHARE_API_KEY not set — proxy fallback tier disabled');
      return;
    }
    void this.refresh();
    // A transient failure (e.g. container DNS not ready at boot) must not
    // leave the tier empty until the next 10-minute timer tick.
    const retryBoot = (attempt: number): void => {
      if (!this.initialized || this.candidates.length || attempt >= 5) return;
      const t = setTimeout(() => {
        void this.refresh().then(() => retryBoot(attempt + 1));
      }, 30_000 * (attempt + 1));
      t.unref?.();
    };
    setTimeout(() => retryBoot(0), 30_000).unref?.();

    const intervalMs = Math.max(60, config().WEBSHARE_REFRESH_SEC) * 1000;
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.candidates = [];
    this.countryFetches.clear();
    this.initialized = false;
    this.cachedStats = null;
    this.statsFetchInflight = null;
    this.lastStatsFetchAt = 0;
  }

  /** Fetch the account's proxy list (single-flight; keeps old list on failure). */
  async refresh(): Promise<void> {
    if (this.refreshInflight) return this.refreshInflight;
    this.refreshInflight = this.doRefresh().finally(() => {
      this.refreshInflight = null;
    });
    return this.refreshInflight;
  }

  private async doRefresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return;
    this.lastRefreshAt = now;

    const apiKeyValue = apiKey();
    if (!apiKeyValue) return;

    let countries = '';
    try {
      countries = config().WEBSHARE_PROXY_COUNTRIES;
    } catch {
      countries = (process.env.WEBSHARE_PROXY_COUNTRIES || '').toUpperCase();
    }

    // Guard the outbound request per policy: https + allowlisted host only.
    // The URL is a compile-time constant, so an explicit allowlist is both
    // stricter and more reliable than a runtime DNS check — a transient
    // resolver failure at container boot must not disable the tier.
    const apiUrl = guardedApiUrl();
    if (!apiUrl) {
      log.error('[WEBSHARE] API URL failed the allowlist check — refresh skipped');
      return;
    }

    try {
      const resp = await fetch(apiUrl, {
        headers: { Authorization: `Token ${apiKeyValue}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        log.error(`[WEBSHARE] Proxy list fetch failed: HTTP ${resp.status} ${body.slice(0, 200)}`);
        return;
      }
      const payload = (await resp.json()) as unknown;
      const parsed = parseProxyList(payload, { countries });
      this.candidates = parsed.proxies;
      this.rrIndex = 0;
      log.info(
        `[WEBSHARE] Refreshed proxy pool: ${parsed.proxies.length} usable` +
          (parsed.proxies.length
            ? ` (${summary(parsed.proxies)})`
            : ` — dropped ${parsed.droppedInvalid} invalid, ${parsed.droppedUnsafe} unsafe, ${parsed.droppedCountry} country-filtered`),
      );
    } catch (e) {
      log.warning(`[WEBSHARE] Proxy list refresh failed: ${String(e)}`);
    }
  }

  /** Next proxy in rotation; triggers one on-demand refresh when the pool is empty. */
  async getProxy(): Promise<WebshareProxy | null> {
    if (!this.enabled) return null;
    if (!this.candidates.length) {
      if (Date.now() - this.lastRefreshAt >= MIN_REFRESH_INTERVAL_MS) {
        await this.refresh().catch(() => {});
      }
      if (!this.candidates.length) return null;
    }
    const proxy = this.candidates[this.rrIndex % this.candidates.length]!;
    this.rrIndex = (this.rrIndex + 1) % this.candidates.length;
    return proxy;
  }

  /**
   * Up to `limit` distinct pool exits for geo-targeted resolution,
   * priority-ordered: for a whitelist, every allowed country keeps its place
   * in the priority order and exits rotate within each country across calls;
   * for a blacklist, the first `limit` exits outside the blocked set. Pool-only
   * (no API calls) — callers fall back to on-demand country fetches when this
   * returns empty. Webshare's country labels often disagree with Google's
   * geo-IP view of datacenter IPs, so callers must be prepared to try more
   * than one candidate.
   */
  getGeoCandidates(
    codes: { allowed?: string[]; blocked?: string[] },
    limit = 3,
    isWarm?: (url: string) => boolean,
  ): WebshareProxy[] {
    const out: WebshareProxy[] = [];
    const push = (p: WebshareProxy): void => {
      if (out.length < limit && !out.some((q) => q.id === p.id)) out.push(p);
    };

    if (codes.allowed?.length) {
      const wanted = [...new Set(
        codes.allowed.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
      )];
      for (const code of wanted) {
        if (out.length >= limit) break;
        const matches = this.candidates.filter((p) => p.countryCode === code);
        if (!matches.length) continue;
        const sorted = isWarm
          ? [...matches].sort((a, b) => (isWarm(b.url) ? 1 : 0) - (isWarm(a.url) ? 1 : 0))
          : matches;
        // Rotate within the country so repeated jobs lead with different exits.
        const start = isWarm ? 0 : this.rrIndex % sorted.length;
        for (const p of [...sorted.slice(start), ...sorted.slice(0, start)]) {
          push(p);
          if (out.length >= limit) break;
        }
      }
      if (out.length) this.rrIndex = (this.rrIndex + 1) % Math.max(1, this.candidates.length);
      return out;
    }

    if (codes.blocked?.length) {
      const blocked = new Set(codes.blocked.map((c) => c.trim().toUpperCase()));
      const matches = this.candidates.filter((p) => !blocked.has(p.countryCode));
      const sorted = isWarm
        ? [...matches].sort((a, b) => (isWarm(b.url) ? 1 : 0) - (isWarm(a.url) ? 1 : 0))
        : matches;
      const start = isWarm ? 0 : (sorted.length ? this.rrIndex % sorted.length : 0);
      for (const p of [...sorted.slice(start), ...sorted.slice(0, start)]) {
        push(p);
        if (out.length >= limit) break;
      }
      if (matches.length) this.rrIndex = (this.rrIndex + 1) % Math.max(1, this.candidates.length);
    }
    return out;
  }

  /**
   * Return candidate proxies, prioritizing warm ones (if predicate matches).
   * Falls back to round-robin.
   */
  getWarmCandidates(
    limit = 3,
    isWarm?: (url: string) => boolean,
  ): WebshareProxy[] {
    const out: WebshareProxy[] = [];
    const push = (p: WebshareProxy): void => {
      if (out.length < limit && !out.some((q) => q.id === p.id)) out.push(p);
    };

    if (isWarm && this.candidates.length > 0) {
      const warmList = this.candidates.filter((p) => isWarm(p.url));
      if (warmList.length > 0) {
        const start = this.warmIndex % warmList.length;
        for (let i = 0; i < warmList.length && out.length < limit; i++) {
          push(warmList[(start + i) % warmList.length]!);
        }
        this.warmIndex = (this.warmIndex + Math.min(limit, warmList.length)) % warmList.length;
      }
    }

    if (this.candidates.length > 0 && out.length < limit) {
      const start = this.rrIndex % this.candidates.length;
      for (let i = 0; i < this.candidates.length && out.length < limit; i++) {
        const p = this.candidates[(start + i) % this.candidates.length]!;
        push(p);
      }
      this.rrIndex = (this.rrIndex + limit) % this.candidates.length;
    }

    return out;
  }

  getSomeProxies(count = 3): WebshareProxy[] {
    return this.candidates.slice(0, count);
  }

  getAllCandidates(): WebshareProxy[] {
    return [...this.candidates];
  }

  /**
   * A proxy in one of `codes` — for videos geo-restricted to specific
   * countries. Order: cached pool → one list refresh → on-demand
   * country-filtered API fetch. null when nothing matches; callers fall
   * back to plain rotation.
   */
  async getProxyForCountries(codes: string[]): Promise<WebshareProxy | null> {    const wanted = [...new Set(
      codes.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    )];
    if (!this.enabled || !wanted.length) return null;

    const direct = this.pickForCountries(wanted);
    if (direct) return direct;

    if (Date.now() - this.lastRefreshAt >= MIN_REFRESH_INTERVAL_MS) {
      await this.refresh().catch(() => {});
      const refreshed = this.pickForCountries(wanted);
      if (refreshed) return refreshed;
    }

    for (const code of wanted) {
      const proxy = await this.fetchCountryProxy(code);
      if (proxy) return proxy;
    }
    return null;
  }

  /**
   * A cached exit NOT in `codes` — for blacklist-style restrictions
   * (Data API regionRestriction.blocked). Pool-only: the API cannot
   * enumerate the complement of a blocked list.
   */
  getProxyNotInCountries(codes: string[]): WebshareProxy | null {
    const blocked = new Set(codes.map((c) => c.trim().toUpperCase()));
    const matches = this.candidates.filter((p) => !blocked.has(p.countryCode));
    if (!matches.length) return null;
    const proxy = matches[this.rrIndex % matches.length]!;
    this.rrIndex = (this.rrIndex + 1) % matches.length;
    return proxy;
  }

  /** Rotate within the cached candidates restricted to `codes` (priority order). */
  private pickForCountries(codes: string[]): WebshareProxy | null {
    for (const code of codes) {
      const matches = this.candidates.filter((p) => p.countryCode === code);
      if (matches.length) {
        const proxy = matches[this.rrIndex % matches.length]!;
        this.rrIndex = (this.rrIndex + 1) % matches.length;
        return proxy;
      }
    }
    return null;
  }

  /** Country-filtered on-demand fetch (5-min cache, single-flight per country). */
  private async fetchCountryProxy(code: string): Promise<WebshareProxy | null> {
    // The normalized two-letter key space bounds the cache to 26² entries.
    if (!/^[A-Z]{2}$/.test(code)) return null;
    const now = Date.now();
    for (const [cachedCode, cached] of this.countryFetches) {
      if (cached.state === 'complete' && now - cached.at >= COUNTRY_FETCH_TTL_MS) {
        this.countryFetches.delete(cachedCode);
      }
    }
    const entry = this.countryFetches.get(code);
    if (entry?.state === 'pending') return entry.inflight;
    if (entry?.state === 'complete') return entry.proxy;

    let pending: PendingCountryFetch;
    const inflight = this.doCountryFetch(code).then((proxies) => {
      // A close/reset or replacement lookup invalidates this writer, including
      // its result for callers still waiting on the old promise.
      if (this.countryFetches.get(code) !== pending) return null;
      const proxy = proxies.find((candidate) =>
        !pending.invalidatedIds.has(candidate.id) && !pending.invalidatedUrls.has(candidate.url),
      ) ?? null;
      this.countryFetches.set(code, { state: 'complete', at: Date.now(), proxy });
      return proxy;
    });
    pending = { state: 'pending', inflight, invalidatedIds: new Set(), invalidatedUrls: new Set() };
    this.countryFetches.set(code, pending);
    return inflight;
  }

  private async doCountryFetch(code: string): Promise<WebshareProxy[]> {
    const key = apiKey();
    const base = guardedApiUrl();
    if (!key || !base) return [];
    // Same guarded origin as the pool refresh; only the country filter varies.
    base.searchParams.set('country_code', code);
    try {
      const resp = await fetch(base, {
        headers: { Authorization: `Token ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        log.warning(`[WEBSHARE] Country fetch ${code} failed: HTTP ${resp.status}`);
        return [];
      }
      const parsed = parseProxyList(await resp.json(), { countries: code });
      const proxy = parsed.proxies[0] ?? null;
      log.info(
        `[WEBSHARE] Country fetch ${code}: ${parsed.proxies.length} proxy(ies)` +
          (proxy ? ` — ${proxy.address}` : ''),
      );
      return parsed.proxies;
    } catch (e) {
      log.warning(`[WEBSHARE] Country fetch ${code} failed: ${String(e)}`);
      return [];
    }
  }

  /** Remove an exit from every selector and prevent pending fetches restoring it. */
  private evictProxy(selector: { id: string } | { url: string }): boolean {
    const matches = (proxy: WebshareProxy): boolean =>
      'id' in selector ? proxy.id === selector.id : proxy.url === selector.url;
    const before = this.candidates.length;
    this.candidates = this.candidates.filter((proxy) => !matches(proxy));
    let removed = this.candidates.length < before;
    for (const [code, entry] of this.countryFetches) {
      if (entry.state === 'pending') {
        // A pending result's identity is not known yet. Retain exclusions only
        // for the lifetime of that fetch; completion discards these sets.
        if ('id' in selector) entry.invalidatedIds.add(selector.id);
        else entry.invalidatedUrls.add(selector.url);
      } else if (entry.proxy && matches(entry.proxy)) {
        this.countryFetches.delete(code);
        removed = true;
      }
    }
    return removed;
  }

  /** A resolution succeeded through this proxy — clear its failure count. */
  markOk(id: string): void {
    this.failures.delete(id);
  }

  /** A resolution failed through this proxy — rotate; evict after repeated failures. */
  markBad(id: string): void {
    const count = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, count);
    if (count >= MAX_FAILURES_PER_PROXY) {
      this.failures.delete(id);
      if (this.evictProxy({ id })) {
        log.warning(
          `[WEBSHARE] Evicting proxy after ${count} consecutive failures — ${this.candidates.length} left in pool`,
        );
      }
    }
  }

  /**
   * Remove a proxy from rotation immediately — for HTTP 407
   * `no_proxies_allocated`, i.e. Webshare auto-replaced it and our cached
   * address is dead. Re-fetches the list in the background (rate-limited by
   * the normal refresh guard) so rotation hands out only live exits.
   */
  evictByUrl(proxyUrl: string): boolean {
    if (this.evictProxy({ url: proxyUrl })) {
      log.warning(
        `[WEBSHARE] Evicting replaced/stale proxy after 407 — ${this.candidates.length} left in pool, refreshing list`,
      );
      void this.refresh().catch(() => {});
      return true;
    }
    return false;
  }

  /** Country summary of active pool candidates (e.g. "US×10, FR×2"). */
  summary(): string {
    return summary(this.candidates);
  }

  /** Test hook — replace the candidate list without touching the API. */
  _setCandidatesForTest(proxies: WebshareProxy[]): void {
    this.candidates = proxies;
    this.rrIndex = 0;
    this.failures.clear();
    this.countryFetches.clear();
  }

  /** Test hook — inject bandwidth stats without making API requests. */
  _setStatsForTest(stats: WebshareBandwidthStats | null): void {
    this.cachedStats = stats;
    this.lastStatsFetchAt = stats ? Date.now() : 0;
  }

  /**
   * Fetch current bandwidth usage and remaining allocation from the Webshare API.
   * Caches responses for STATS_CACHE_TTL_MS (60s) to respect API rate limits.
   */
  async getBandwidthStats(forceRefresh = false): Promise<WebshareBandwidthStats> {
    if (!this.enabled) {
      return {
        enabled: false,
        usedBytes: 0,
        usedFormatted: '0 B',
        limitBytes: null,
        limitGb: null,
        limitFormatted: 'N/A',
        remainingBytes: null,
        remainingFormatted: 'N/A',
        percentUsed: null,
        percentRemaining: null,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        countriesUsed: {},
        activePlan: null,
        lastUpdatedAt: Date.now(),
      };
    }

    const now = Date.now();
    if (!forceRefresh && this.cachedStats && now - this.lastStatsFetchAt < STATS_CACHE_TTL_MS) {
      return this.cachedStats;
    }

    if (this.statsFetchInflight) return this.statsFetchInflight;

    this.statsFetchInflight = this.doFetchStats().finally(() => {
      this.statsFetchInflight = null;
    });
    return this.statsFetchInflight;
  }

  private async doFetchStats(): Promise<WebshareBandwidthStats> {
    const apiKeyValue = apiKey();
    if (!apiKeyValue) {
      return {
        enabled: false,
        usedBytes: 0,
        usedFormatted: '0 B',
        limitBytes: null,
        limitGb: null,
        limitFormatted: 'N/A',
        remainingBytes: null,
        remainingFormatted: 'N/A',
        percentUsed: null,
        percentRemaining: null,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        countriesUsed: {},
        activePlan: null,
        lastUpdatedAt: Date.now(),
      };
    }

    try {
      const headers = {
        Authorization: `Token ${apiKeyValue}`,
        Accept: 'application/json',
      };

      // 1. Fetch bandwidth statistics: try aggregate endpoint, fallback to hourly list
      let statsPayload: unknown = null;
      const aggUrl = guardedWebshareUrl(STATS_AGGREGATE_API_URL);
      if (aggUrl) {
        try {
          const resp = await fetch(aggUrl, {
            headers,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (resp.ok) {
            statsPayload = await resp.json();
          }
        } catch {
          /* fallback to list */
        }
      }

      if (!statsPayload) {
        const listUrl = guardedWebshareUrl(STATS_LIST_API_URL);
        if (listUrl) {
          try {
            const resp = await fetch(listUrl, {
              headers,
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (resp.ok) {
              statsPayload = await resp.json();
            } else {
              const body = await resp.text().catch(() => '');
              log.warning(`[WEBSHARE] Stats fetch failed: HTTP ${resp.status} ${body.slice(0, 100)}`);
            }
          } catch (e) {
            log.warning(`[WEBSHARE] Stats list fetch error: ${String(e)}`);
          }
        }
      }

      // 2. Fetch subscription plan to determine bandwidth quota
      let planPayload: unknown = null;
      const planUrl = guardedWebshareUrl(PLAN_API_URL);
      if (planUrl) {
        try {
          const resp = await fetch(planUrl, {
            headers,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (resp.ok) {
            planPayload = await resp.json();
          } else {
            const body = await resp.text().catch(() => '');
            log.warning(`[WEBSHARE] Plan fetch failed: HTTP ${resp.status} ${body.slice(0, 100)}`);
          }
        } catch (e) {
          log.warning(`[WEBSHARE] Plan fetch error: ${String(e)}`);
        }
      }

      const parsed = parseWebshareStats(statsPayload, planPayload);
      this.cachedStats = parsed;
      this.lastStatsFetchAt = Date.now();
      return parsed;
    } catch (e) {
      log.warning(`[WEBSHARE] Failed to fetch proxy stats: ${String(e)}`);
      return {
        enabled: true,
        usedBytes: this.cachedStats?.usedBytes ?? 0,
        usedFormatted: this.cachedStats?.usedFormatted ?? '0 B',
        limitBytes: this.cachedStats?.limitBytes ?? null,
        limitGb: this.cachedStats?.limitGb ?? null,
        limitFormatted: this.cachedStats?.limitFormatted ?? 'Unknown',
        remainingBytes: this.cachedStats?.remainingBytes ?? null,
        remainingFormatted: this.cachedStats?.remainingFormatted ?? 'Unknown',
        percentUsed: this.cachedStats?.percentUsed ?? null,
        percentRemaining: this.cachedStats?.percentRemaining ?? null,
        totalRequests: this.cachedStats?.totalRequests ?? 0,
        successfulRequests: this.cachedStats?.successfulRequests ?? 0,
        failedRequests: this.cachedStats?.failedRequests ?? 0,
        countriesUsed: this.cachedStats?.countriesUsed ?? {},
        activePlan: this.cachedStats?.activePlan ?? null,
        lastUpdatedAt: Date.now(),
        error: String(e),
      };
    }
  }

  /**
   * High-level operational health for public status boards and normal user dashboards.
   * Never leaks internal credentials, IPs, or billing numbers.
   */
  async getPublicHealth(): Promise<WebsharePublicHealth> {
    if (!this.enabled) {
      return {
        enabled: false,
        operational: true,
        bandwidthReached: false,
        statusBadge: '⚪ Direct (No Proxy Tier)',
      };
    }

    try {
      const stats = await this.getBandwidthStats().catch(() => null);
      const isBandwidthReached =
        !!stats &&
        ((stats.remainingBytes !== null && stats.remainingBytes <= 0) ||
          (stats.percentUsed !== null && stats.percentUsed >= 100));

      if (isBandwidthReached) {
        return {
          enabled: true,
          operational: false,
          bandwidthReached: true,
          statusBadge: '🔴 Bandwidth Limit Reached',
          notice:
            '⚠️ <b>Service Alert:</b> Proxy bandwidth quota has been reached. Geo-restricted video extraction and fallback bypasses may be temporarily degraded until quota reset.',
        };
      }

      if (stats?.percentUsed !== null && stats?.percentUsed !== undefined && stats.percentUsed >= 95) {
        return {
          enabled: true,
          operational: true,
          bandwidthReached: false,
          statusBadge: '🟡 Bandwidth Low',
          notice:
            '⚠️ <b>Service Notice:</b> Proxy bandwidth is near monthly capacity (>95% used).',
        };
      }

      if (this.candidates.length === 0) {
        return {
          enabled: true,
          operational: false,
          bandwidthReached: false,
          statusBadge: '🟠 Degraded (Proxy Pool Empty)',
          notice: '⚠️ <b>Service Notice:</b> Proxy pool is currently initializing or unavailable.',
        };
      }

      return {
        enabled: true,
        operational: true,
        bandwidthReached: false,
        statusBadge: '🟢 Operational',
      };
    } catch {
      return {
        enabled: true,
        operational: true,
        bandwidthReached: false,
        statusBadge: '🟢 Operational',
      };
    }
  }

  /** Operational snapshot (no credentials). */
  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      pool_size: this.candidates.length,
      bandwidth: this.cachedStats
        ? {
            used: this.cachedStats.usedFormatted,
            used_bytes: this.cachedStats.usedBytes,
            limit: this.cachedStats.limitFormatted,
            limit_bytes: this.cachedStats.limitBytes,
            remaining: this.cachedStats.remainingFormatted,
            remaining_bytes: this.cachedStats.remainingBytes,
            percent_used: this.cachedStats.percentUsed,
            percent_remaining: this.cachedStats.percentRemaining,
            total_requests: this.cachedStats.totalRequests,
            last_updated: new Date(this.cachedStats.lastUpdatedAt).toISOString(),
          }
        : null,
      proxies: this.candidates.map((p) => ({
        address: p.address,
        port: p.port,
        country: p.countryCode,
        city: p.city,
        last_verification: p.lastVerification ? new Date(p.lastVerification * 1000).toISOString() : null,
        consecutive_failures: this.failures.get(p.id) ?? 0,
      })),
    };
  }
}

function summary(proxies: WebshareProxy[]): string {
  const byCountry = new Map<string, number>();
  for (const p of proxies) {
    const key = p.countryCode || '??';
    byCountry.set(key, (byCountry.get(key) ?? 0) + 1);
  }
  return [...byCountry.entries()].map(([c, n]) => `${c}×${n}`).join(', ');
}

export const websharePool = new WebsharePool();
