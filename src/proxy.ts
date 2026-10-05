/**
 * Webshare proxy pool — the geo-bypass fallback tier.
 *
 * When the cookie pool (and the default instance) cannot resolve a video —
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
const FETCH_TIMEOUT_MS = 15_000;
/** Consecutive failed resolutions before a proxy is pulled from rotation. */
const MAX_FAILURES_PER_PROXY = 3;
/** Never re-fetch more often than this (rate-limit headroom for the API). */
const MIN_REFRESH_INTERVAL_MS = 30_000;

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

export interface ParsedProxyList {
  proxies: WebshareProxy[];
  droppedInvalid: number;
  droppedUnsafe: number;
  droppedCountry: number;
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
 * Round-robin pool of Webshare proxies with live API refresh.
 * `getProxy()` hands out exits one by one; `markBad()` rotates and eventually
 * evicts repeatedly-failing proxies; `refresh()` re-reads the account's list.
 */
export class WebsharePool {
  private candidates: WebshareProxy[] = [];
  private rrIndex = 0;
  private failures = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private refreshInflight: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private initialized = false;

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
    this.initialized = false;
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

    let apiKey: string | null = null;
    let countries = '';
    try {
      apiKey = config().WEBSHARE_API_KEY;
      countries = config().WEBSHARE_PROXY_COUNTRIES;
    } catch {
      apiKey = process.env.WEBSHARE_API_KEY || null;
      countries = (process.env.WEBSHARE_PROXY_COUNTRIES || '').toUpperCase();
    }
    if (!apiKey) return;

    // Guard the outbound request per policy: https + allowlisted host only.
    // The URL is a compile-time constant, so an explicit allowlist is both
    // stricter and more reliable than a runtime DNS check — a transient
    // resolver failure at container boot must not disable the tier.
    let apiUrl: URL;
    try {
      apiUrl = new URL(API_URL);
    } catch {
      log.error('[WEBSHARE] API URL is not parseable — refresh skipped');
      return;
    }
    if (apiUrl.protocol !== 'https:' || apiUrl.hostname !== 'proxy.webshare.io') {
      log.error('[WEBSHARE] API URL failed the allowlist check — refresh skipped');
      return;
    }

    try {
      const resp = await fetch(API_URL, {
        headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
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
      const before = this.candidates.length;
      this.candidates = this.candidates.filter((p) => p.id !== id);
      if (this.candidates.length < before) {
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
    const before = this.candidates.length;
    this.candidates = this.candidates.filter((p) => p.url !== proxyUrl);
    if (this.candidates.length < before) {
      log.warning(
        `[WEBSHARE] Evicting replaced/stale proxy after 407 — ${this.candidates.length} left in pool, refreshing list`,
      );
      void this.refresh().catch(() => {});
      return true;
    }
    return false;
  }

  /** Test hook — replace the candidate list without touching the API. */
  _setCandidatesForTest(proxies: WebshareProxy[]): void {
    this.candidates = proxies;
    this.rrIndex = 0;
    this.failures.clear();
  }

  /** Operational snapshot (no credentials). */
  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      pool_size: this.candidates.length,
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
