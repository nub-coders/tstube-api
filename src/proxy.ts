/**
 * Webshare proxy pool for YouTube extraction, with country-aware retries.
 * The pool is fetched live from the Webshare API so burnt IPs are replaced
 * without a redeploy. Fresh YouTube extraction requires a usable exit;
 * media transfer can use the server's direct connection after verification.
 */
import { config } from './config.js';
import { getLogger } from './logger.js';
import { isPrivateAddress, looksLocalHostname } from './urlValidation.js';
import net from 'node:net';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = getLogger('ytube_api.webshare');

const API_URL = 'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100';
const STATS_AGGREGATE_API_URL = 'https://proxy.webshare.io/api/v2/stats/aggregate/';
const STATS_LIST_API_URL = 'https://proxy.webshare.io/api/v2/stats/';
const PLAN_API_URL = 'https://proxy.webshare.io/api/v2/subscription/plan/';
const FETCH_TIMEOUT_MS = 15_000;
/** Consecutive failed resolutions before a proxy is pulled from rotation. */
const MAX_FAILURES_PER_PROXY = 3;
/** Rejected exits get a bounded recovery window, including after API refresh. */
const PROXY_COOLDOWN_MS = 5 * 60_000;
/** Recent extraction results are useful; departed credentials must age out. */
const PROXY_HEALTH_TTL_MS = 30 * 60_000;
const MAX_PROXY_HEALTH_ENTRIES = 2_000;
/** Never re-fetch more often than this (rate-limit headroom for the API). */
const MIN_REFRESH_INTERVAL_MS = 30_000;
/** How long an on-demand country-filtered fetch stays authoritative. */
const COUNTRY_FETCH_TTL_MS = 5 * 60_000;
/** Bandwidth stats cache TTL (60s). */
const STATS_CACHE_TTL_MS = 60_000;
/** Last-known-good pool snapshot, restored at boot before the API is reachable. */
export const POOL_STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'webshare-pool.json');
/** Persisted exits older than this are not trusted at boot. */
const POOL_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
}

type CountryFetchEntry = PendingCountryFetch | {
  state: 'complete';
  at: number;
  proxies: WebshareProxy[];
};

interface ProxyHealth {
  failures: number;
  lastSuccessAt: number;
  touchedAt: number;
  cooldownUntil: number;
}

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
 * Persist the last-known-good pool so a restart (e.g. container DNS not yet
 * ready) can serve requests before the Webshare API is reachable. Atomic
 * tmp+rename; credentials are kept to mode 0600, container-local.
 */
export function writePoolState(proxies: WebshareProxy[]): void {
  try {
    mkdirSync(dirname(POOL_STATE_FILE), { recursive: true });
    const tmp = `${POOL_STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), proxies }), { mode: 0o600 });
    renameSync(tmp, POOL_STATE_FILE);
  } catch {
    /* best-effort — the live refresh remains the source of truth */
  }
}

/**
 * Load a persisted pool; null when missing, corrupt, or older than
 * POOL_STATE_MAX_AGE_MS. Entries are re-validated with the same safety
 * filter as live API data (invalid/unsafe hosts dropped).
 */
export function readPoolState(): WebshareProxy[] | null {
  try {
    const raw = readFileSync(POOL_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { savedAt?: unknown; proxies?: unknown };
    if (typeof parsed.savedAt !== 'number' || !Array.isArray(parsed.proxies)) return null;
    if (Date.now() - parsed.savedAt > POOL_STATE_MAX_AGE_MS) return null;

    const proxies: WebshareProxy[] = [];
    for (const item of parsed.proxies as Array<Record<string, unknown>>) {
      const address = typeof item?.address === 'string' ? item.address.trim() : '';
      const port = Number(item?.port);
      const username = typeof item?.username === 'string' ? item.username : '';
      const password = typeof item?.password === 'string' ? item.password : '';
      if (!address || !Number.isInteger(port) || port <= 0 || port > 65535 || !username || !password) continue;
      if (!isSafeProxyHost(address)) continue;
      proxies.push({
        id: typeof item?.id === 'string' ? item.id : `${address}:${port}`,
        address,
        port,
        username,
        password,
        url: buildProxyUrl(username, password, address, port),
        countryCode: typeof item?.countryCode === 'string' ? item.countryCode.toUpperCase() : '',
        city: typeof item?.city === 'string' ? item.city : '',
        lastVerification: typeof item?.lastVerification === 'number' ? item.lastVerification : 0,
      });
    }
    proxies.sort((a, b) => b.lastVerification - a.lastVerification);
    return proxies;
  } catch {
    return null;
  }
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
 * Selectors rotate within health tiers; repeated failures start a cooldown
 * that survives `refresh()`. The API list describes inventory, while local
 * extraction results decide which of those exits are currently usable.
 */
export class WebsharePool {
  private candidates: WebshareProxy[] = [];
  private rrIndex = 0;
  private health = new Map<string, ProxyHealth>();
  private countryFetches = new Map<string, CountryFetchEntry>();
  private timer: NodeJS.Timeout | null = null;
  private refreshInflight: Promise<void> | null = null;
  private generation = 0;
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
    return this.availableCandidates().length;
  }

  private pruneHealth(now = Date.now()): void {
    for (const [identity, health] of this.health) {
      if (now - health.touchedAt >= PROXY_HEALTH_TTL_MS ||
          (health.cooldownUntil > 0 && now >= health.cooldownUntil)) {
        this.health.delete(identity);
      }
    }
  }

  private proxyHealth(proxy: WebshareProxy): ProxyHealth | undefined {
    return this.health.get(proxy.url) ?? this.health.get(`id:${proxy.id}`);
  }

  private availableCandidates(proxies = this.candidates): WebshareProxy[] {
    this.pruneHealth();
    return proxies.filter((proxy) => !this.proxyHealth(proxy)?.cooldownUntil);
  }

  /** Prefer proven extraction, then warm sessions; rotate only within a tier. */
  private orderedCandidates(
    proxies: WebshareProxy[],
    isWarm?: (url: string) => boolean,
    index = this.rrIndex,
  ): WebshareProxy[] {
    const tiers = new Map<number, WebshareProxy[]>();
    const now = Date.now();
    for (const proxy of this.availableCandidates(proxies)) {
      const health = this.proxyHealth(proxy);
      const proven = !!health?.lastSuccessAt && now - health.lastSuccessAt < PROXY_HEALTH_TTL_MS;
      const tier = (health?.failures ? 2 : proven ? 0 : 1) * 2 +
        (isWarm && !isWarm(proxy.url) ? 1 : 0);
      const group = tiers.get(tier) ?? [];
      group.push(proxy);
      tiers.set(tier, group);
    }
    return [...tiers.keys()].sort((a, b) => a - b).flatMap((tier) => {
      const group = tiers.get(tier)!;
      const start = index % group.length;
      return [...group.slice(start), ...group.slice(0, start)];
    });
  }

  /** URL identity includes credentials, so late results cannot poison a replacement. */
  private healthIdentity(id: string, proxyUrl?: string): string {
    if (proxyUrl) {
      this.bindHealthIdentity(id, proxyUrl);
      return proxyUrl;
    }
    const proxy = this.candidates.find((candidate) => candidate.id === id) ??
      [...this.countryFetches.values()].flatMap((entry) =>
        entry.state === 'complete' ? entry.proxies : [],
      ).find((candidate) => candidate.id === id);
    // Backwards-compatible id-only notifications can also invalidate pending
    // discovery before that exit's URL is known.
    if (proxy) this.bindHealthIdentity(proxy.id, proxy.url);
    return proxy?.url ?? `id:${id}`;
  }

  /** Bind reports received before discovery to their first observed credentials. */
  private bindHealthIdentity(id: string, proxyUrl: string): void {
    const fallback = this.health.get(`id:${id}`);
    if (!fallback) return;
    this.health.delete(`id:${id}`);
    if (!this.health.has(proxyUrl)) this.recordHealth(proxyUrl, fallback);
  }

  private recordHealth(identity: string, health: ProxyHealth): void {
    this.health.delete(identity);
    this.health.set(identity, health);
    while (this.health.size > MAX_PROXY_HEALTH_ENTRIES) {
      this.health.delete(this.health.keys().next().value!);
    }
  }

  /** Start the periodic refresh; disabled pools stay inert. */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.enabled) {
      log.info('[WEBSHARE] WEBSHARE_API_KEY not set — fresh YouTube extraction unavailable');
      return;
    }
    // Serve the last-known-good pool immediately; a boot-time API failure
    // (e.g. container DNS not yet ready) then degrades to stale exits instead
    // of an empty tier until the network heals.
    const saved = readPoolState();
    if (saved?.length) {
      this.candidates = saved;
      log.info(`[WEBSHARE] Restored ${saved.length} persisted proxy(ies) from pool state`);
    }
    void this.refresh();
    const generation = this.generation;
    // A transient boot failure must not leave the tier empty until the next
    // 10-minute timer tick — retry with exponential backoff (30s → 300s cap)
    // for as long as the pool stays empty.
    const retryBoot = (backoffMs: number): void => {
      if (generation !== this.generation || !this.initialized || this.size) return;
      const t = setTimeout(() => {
        if (generation !== this.generation || !this.initialized || this.size) return;
        void this.refresh().then(() => retryBoot(Math.min(backoffMs * 2, 300_000)));
      }, backoffMs);
      t.unref?.();
    };
    setTimeout(() => retryBoot(30_000), 30_000).unref?.();

    const intervalMs = Math.max(60, config().WEBSHARE_REFRESH_SEC) * 1000;
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.candidates = [];
    this.health.clear();
    this.countryFetches.clear();
    this.initialized = false;
    this.refreshInflight = null;
    this.lastRefreshAt = 0;
    this.cachedStats = null;
    this.statsFetchInflight = null;
    this.lastStatsFetchAt = 0;
  }

  /** Fetch the account's proxy list (single-flight; keeps old list on failure). */
  async refresh(): Promise<void> {
    if (this.refreshInflight) return this.refreshInflight;
    const inflight = this.doRefresh().finally(() => {
      if (this.refreshInflight === inflight) this.refreshInflight = null;
    });
    this.refreshInflight = inflight;
    return inflight;
  }

  private async doRefresh(): Promise<void> {
    const generation = this.generation;
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
      if (generation !== this.generation) return;
      const parsed = parseProxyList(payload, { countries });
      for (const proxy of parsed.proxies) this.bindHealthIdentity(proxy.id, proxy.url);
      this.candidates = parsed.proxies;
      if (parsed.proxies.length) writePoolState(parsed.proxies);
      this.rrIndex = 0;
      const usable = this.availableCandidates();
      log.info(
        `[WEBSHARE] Refreshed proxy pool: ${usable.length} usable` +
          (usable.length
            ? ` (${summary(usable)})`
            : ` — dropped ${parsed.droppedInvalid} invalid, ${parsed.droppedUnsafe} unsafe, ${parsed.droppedCountry} country-filtered`),
      );
    } catch (e) {
      log.warning(`[WEBSHARE] Proxy list refresh failed: ${String(e)}`);
    }
  }

  /** Next proxy in rotation; triggers one on-demand refresh when the pool is empty. */
  async getProxy(): Promise<WebshareProxy | null> {
    if (!this.enabled) return null;
    if (!this.availableCandidates().length) {
      if (Date.now() - this.lastRefreshAt >= MIN_REFRESH_INTERVAL_MS) {
        await this.refresh().catch(() => {});
      }
      if (!this.availableCandidates().length) return null;
    }
    const proxy = this.orderedCandidates(this.candidates)[0]!;
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
        const matches = this.availableCandidates().filter((p) => p.countryCode === code);
        if (!matches.length) continue;
        for (const p of this.orderedCandidates(matches, isWarm)) {
          push(p);
          if (out.length >= limit) break;
        }
      }
      if (out.length) this.rrIndex = (this.rrIndex + 1) % Math.max(1, this.candidates.length);
      return out;
    }

    if (codes.blocked?.length) {
      const blocked = new Set(codes.blocked.map((c) => c.trim().toUpperCase()));
      const matches = this.availableCandidates().filter((p) => !blocked.has(p.countryCode));
      for (const p of this.orderedCandidates(matches, isWarm)) {
        push(p);
        if (out.length >= limit) break;
      }
      if (matches.length) this.rrIndex = (this.rrIndex + 1) % Math.max(1, this.candidates.length);
    }
    return out;
  }

  /**
   * Return usable candidates, prioritizing extraction success ahead of session
   * warmth. Rotate within each priority tier to spread requests across exits.
   */
  getWarmCandidates(
    limit = 3,
    isWarm?: (url: string) => boolean,
  ): WebshareProxy[] {
    const out: WebshareProxy[] = [];
    const push = (p: WebshareProxy): void => {
      if (out.length < limit && !out.some((q) => q.id === p.id)) out.push(p);
    };

    for (const proxy of this.orderedCandidates(this.candidates, isWarm)) {
      push(proxy);
      if (out.length >= limit) break;
    }
    if (out.length) this.rrIndex = (this.rrIndex + out.length) % Math.max(1, this.candidates.length);
    return out;
  }

  getSomeProxies(count = 3): WebshareProxy[] {
    return this.orderedCandidates(this.candidates, undefined, 0).slice(0, count);
  }

  getAllCandidates(): WebshareProxy[] {
    return this.orderedCandidates(this.candidates, undefined, 0);
  }

  /**
   * A proxy in one of `codes` — for videos geo-restricted to specific
   * countries. Order: cached pool → one list refresh → on-demand
   * country-filtered API fetch. null when nothing matches; callers fall
   * back to plain rotation.
   */
  async getProxyForCountries(codes: string[]): Promise<WebshareProxy | null> {
    const wanted = [...new Set(
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
    const matches = this.availableCandidates().filter((p) => !blocked.has(p.countryCode));
    if (!matches.length) return null;
    const proxy = this.orderedCandidates(matches)[0]!;
    this.rrIndex = (this.rrIndex + 1) % matches.length;
    return proxy;
  }

  /** Rotate within the cached candidates restricted to `codes` (priority order). */
  private pickForCountries(codes: string[]): WebshareProxy | null {
    for (const code of codes) {
      const matches = this.availableCandidates().filter((p) => p.countryCode === code);
      if (matches.length) {
        const proxy = this.orderedCandidates(matches)[0]!;
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
    if (entry?.state === 'complete') return this.orderedCandidates(entry.proxies, undefined, 0)[0] ?? null;

    let pending: PendingCountryFetch;
    const inflight = this.doCountryFetch(code).then((proxies) => {
      // A close/reset or replacement lookup invalidates this writer, including
      // its result for callers still waiting on the old promise.
      if (this.countryFetches.get(code) !== pending) return null;
      for (const proxy of proxies) this.bindHealthIdentity(proxy.id, proxy.url);
      // Keep inventory even when every exit is cooling down, so the completed
      // country cache cannot extend a cooldown by caching a null placeholder.
      this.countryFetches.set(code, { state: 'complete', at: Date.now(), proxies });
      return this.orderedCandidates(proxies, undefined, 0)[0] ?? null;
    });
    pending = { state: 'pending', inflight };
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

  /** Invalidate country lookups; health filters retain account inventory for recovery. */
  private evictProxy(selector: { id: string } | { url: string }): boolean {
    const matches = (proxy: WebshareProxy): boolean =>
      'id' in selector ? proxy.id === selector.id : proxy.url === selector.url;
    let removed = this.availableCandidates().some(matches);
    for (const [code, entry] of this.countryFetches) {
      if (entry.state === 'complete' && entry.proxies.some(matches)) {
        this.countryFetches.delete(code);
        removed = true;
      }
    }
    return removed;
  }

  /** Extraction produced usable media through this identity. */
  markOk(id: string, proxyUrl?: string): void {
    this.pruneHealth();
    const now = Date.now();
    this.recordHealth(this.healthIdentity(id, proxyUrl), {
      failures: 0, lastSuccessAt: now, touchedAt: now, cooldownUntil: 0,
    });
  }

  /** Reachable content failure clears transport failures without proving extraction. */
  markReachable(id: string, proxyUrl?: string): void {
    this.pruneHealth();
    const identity = this.healthIdentity(id, proxyUrl);
    const health = this.health.get(identity);
    // A late content response is weaker evidence than usable extraction and
    // must not undo a cooldown established by concurrent proxy failures.
    if (health?.cooldownUntil) return;
    this.recordHealth(identity, {
      failures: 0, lastSuccessAt: health?.lastSuccessAt ?? 0,
      touchedAt: Date.now(), cooldownUntil: 0,
    });
  }

  /** A proxy failure demotes this identity; repeated failures start a cooldown. */
  markBad(id: string, proxyUrl?: string): void {
    this.pruneHealth();
    const identity = this.healthIdentity(id, proxyUrl);
    const health = this.health.get(identity);
    // Late failures from the same concurrent batch do not extend quarantine.
    if (health?.cooldownUntil) return;
    const count = (health?.failures ?? 0) + 1;
    if (count >= MAX_FAILURES_PER_PROXY) {
      const removed = this.evictProxy(proxyUrl ? { url: proxyUrl } : { id });
      this.recordHealth(identity, {
        failures: count, lastSuccessAt: 0, touchedAt: Date.now(),
        cooldownUntil: Date.now() + PROXY_COOLDOWN_MS,
      });
      if (removed) {
        log.warning(
          `[WEBSHARE] Cooling down proxy after ${count} consecutive failures — ${this.size} left in pool`,
        );
      }
    } else {
      this.recordHealth(identity, {
        failures: count, lastSuccessAt: health?.lastSuccessAt ?? 0,
        touchedAt: Date.now(), cooldownUntil: 0,
      });
    }
  }

  /**
   * Remove a proxy from rotation immediately — for HTTP 407
   * `no_proxies_allocated`, i.e. Webshare auto-replaced it and our cached
   * address is dead. Re-fetches the list in the background (rate-limited by
   * the normal refresh guard) so rotation hands out only live exits.
   */
  evictByUrl(proxyUrl: string): boolean {
    this.pruneHealth();
    const removed = this.evictProxy({ url: proxyUrl });
    if (!this.health.get(proxyUrl)?.cooldownUntil) {
      this.recordHealth(proxyUrl, {
        failures: MAX_FAILURES_PER_PROXY, lastSuccessAt: 0,
        touchedAt: Date.now(), cooldownUntil: Date.now() + PROXY_COOLDOWN_MS,
      });
    }
    if (removed) {
      log.warning(
        `[WEBSHARE] Evicting replaced/stale proxy after 407 — ${this.size} left in pool, refreshing list`,
      );
      void this.refresh().catch(() => {});
      return true;
    }
    return false;
  }

  /** Country summary of active pool candidates (e.g. "US×10, FR×2"). */
  summary(): string {
    return summary(this.availableCandidates());
  }

  /** Test hook — replace the candidate list without touching the API. */
  _setCandidatesForTest(proxies: WebshareProxy[]): void {
    this.candidates = proxies;
    this.rrIndex = 0;
    this.health.clear();
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

      if (this.size === 0) {
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
    const candidates = this.availableCandidates();
    return {
      enabled: this.enabled,
      pool_size: candidates.length,
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
      proxies: candidates.map((p) => ({
        address: p.address,
        port: p.port,
        country: p.countryCode,
        city: p.city,
        last_verification: p.lastVerification ? new Date(p.lastVerification * 1000).toISOString() : null,
        consecutive_failures: this.proxyHealth(p)?.failures ?? 0,
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
