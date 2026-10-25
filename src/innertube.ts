/**
 * Fast YouTube resolver powered by youtubei.js (ytjs).
 */
import { Innertube, Platform, Parser, Helpers } from 'youtubei.js';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { extractArtist, formatInd } from './formatters.js';
import { getLogger } from './logger.js';
import { BoundedCache } from './boundedCache.js';
import { websharePool } from './proxy.js';
import { fetchRegionRestriction } from './youtubeApi.js';
import type { WebshareProxy } from './proxy.js';

(Platform.shim as any).eval = async (d: any) => new Function(d.output)();

const log = getLogger('ytube_api.innertube');

// Runtime parsers for YouTube nodes not yet in upstream youtubei.js
class InterstitialView extends Helpers.YTNode {
  static override readonly type = 'InterstitialView';

  title?: {
    content?: string;
  };
  description?: {
    content?: string;
  };
  primary_button?: any;
  secondary_button?: any;
  logging_directives?: any;
  icon?: any;

  constructor(data: any) {
    super();
    this.title = {
      content: data?.title?.content,
    };
    this.description = {
      content: data?.description?.content,
    };
    this.primary_button = Parser.parseItem(data?.primaryButton);
    this.secondary_button = Parser.parseItem(data?.secondaryButton);
    this.logging_directives = {
      tracking_params: data?.loggingDirectives?.trackingParams,
      visibility: {
        types: data?.loggingDirectives?.visibility?.types,
      },
    };
    if (data?.icon) {
      this.icon = data.icon;
    }
  }
}

class PlayerInterstitial extends Helpers.YTNode {
  static override readonly type = 'PlayerInterstitial';

  content?: any;
  state_entity_store_key?: string;

  constructor(data: any) {
    super();
    this.content = Parser.parseItem(data?.content);
    this.state_entity_store_key = data?.stateEntityStoreKey;
  }
}

Parser.addRuntimeParser('InterstitialView', InterstitialView as any);
Parser.addRuntimeParser('PlayerInterstitial', PlayerInterstitial as any);

// Silence verbose multi-line JIT dumps for any other unmapped YouTube nodes
Parser.setParserErrorHandler((error) => {
  if (error.error_type === 'class_not_found') {
    log.warning(`[YTJS] Unregistered parser node: ${error.classname}`);
    return;
  }
  if (error.error_type === 'class_changed') {
    log.warning(`[YTJS] Node structure changed: ${error.classname}`);
    return;
  }
});

const ID_RE = /(?:v=|\/shorts\/|youtu\.be\/|\/embed\/|\/v\/|\/live\/)([A-Za-z0-9_-]{11})/;
const BARE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// INFO_CACHE: caches getBasicInfo results for 1 hour.
const INFO_CACHE = new BoundedCache<any>(2048, 3600);
type Json = Record<string, any>;

export interface InnertubeStreamingData {
  formats?: Json[];
  adaptiveFormats?: Json[];
  adaptive_formats?: Json[];
}

export interface InnertubeMetadata {
  title: string;
  url: string;
  artist_name: string;
  channel_name: string;
  views: string;
  duration: string;
  thumbnail: string;
  video_id: string;
}

export interface RelatedItem {
  title: string;
  video_id: string;
  url: string;
  time: string;
  duration: string;
  channel: string;
  views: string;
  thumbnail: string;
}

export function extractId(value: string): string | null {
  const m = ID_RE.exec(value);
  if (m) return m[1]!;
  const v = value.trim();
  return BARE_ID_RE.test(v) ? v : null;
}

let ytPromise: Promise<Innertube> | null = null;

export function resetInnertube(): void {
  ytPromise = null;
}

// Innertube instances whose HTTP traffic is bound to one Webshare exit — one
// per proxy URL, so the googlevideo URLs they return stay playable through it.
const PROXIED_INNERTUBE_POOL = new BoundedCache<Innertube>(50, 3600);

function makeProxiedFetch(agent: ProxyAgent): typeof fetch {
  const proxied = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let url: string | URL = input as any;
    let reqInit: Record<string, unknown> = { ...(init ?? {}) };
    if (input instanceof URL) {
      url = input.href;
    } else if (typeof input === 'object' && input !== null && 'url' in input) {
      const req = input as Request;
      url = req.url;
      const inputHeaders = Object.fromEntries(req.headers?.entries?.() ?? []);
      const initHeaders =
        init?.headers
          ? typeof (init.headers as any)?.entries === 'function'
            ? Object.fromEntries((init.headers as any).entries())
            : (init.headers as Record<string, string>)
          : {};
      reqInit = {
        method: req.method,
        body: req.body,
        ...init,
        headers: { ...inputHeaders, ...initHeaders },
      };
    } else if (init?.headers) {
      reqInit.headers =
        typeof (init.headers as any)?.entries === 'function'
          ? Object.fromEntries((init.headers as any).entries())
          : init.headers;
    }
    if (reqInit.method === 'GET' || reqInit.method === 'HEAD') {
      delete reqInit.body;
    }
    if (reqInit.body != null) {
      (reqInit as any).duplex = 'half';
    }
    return undiciFetch(url as any, { ...reqInit, dispatcher: agent } as any);
  };
  return proxied as unknown as typeof fetch;
}

async function getProxiedInnertube(proxyUrl: string): Promise<Innertube> {
  const cached = PROXIED_INNERTUBE_POOL.get(proxyUrl);
  if (cached) return cached;
  const instance = await Innertube.create({
    fetch: makeProxiedFetch(new ProxyAgent(proxyUrl)),
  });
  PROXIED_INNERTUBE_POOL.set(proxyUrl, instance);
  return instance;
}

/** Pre-warm Webshare exits in the background so initial requests have warm sessions ready. */
export function prewarmProxiedInnertube(count = 10): void {
  if (!websharePool.enabled) return;
  void (async () => {
    for (let i = 0; i < 20; i++) {
      if (websharePool.size > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const proxies = websharePool.getSomeProxies(count);
    const queue = [...proxies];
    const workers = Array.from({ length: 3 }, async () => {
      while (queue.length > 0) {
        const p = queue.shift();
        if (!p) break;
        if (!isProxiedInnertubeWarm(p.url)) {
          try {
            await withTimeout(getProxiedInnertube(p.url), PROXY_BOOTSTRAP_TIMEOUT_MS, 'prewarm');
            log.info(`[YTJS] Pre-warmed Webshare exit ${p.address}:${p.port}`);
          } catch {
            /* ignore bootstrap failure on boot */
          }
        }
      }
    });
    await Promise.all(workers);
  })();
}

/** A warm exit already has a session cached, so it skips the cold bootstrap. */
function isProxiedInnertubeWarm(proxyUrl: string): boolean {
  return PROXIED_INNERTUBE_POOL.has(proxyUrl);
}

export async function getInnertube(): Promise<Innertube> {
  if (!ytPromise) {
    ytPromise = (async () => {
      const instance = await Innertube.create({});
      log.info('[YTJS] Innertube instance initialized');
      return instance;
    })().catch((err) => {
      ytPromise = null;
      log.error('[YTJS] Failed initializing Innertube instance', { err: String(err) });
      throw err;
    });
  }
  return ytPromise;
}

function byItag(fmts: Json[], itag: number): string | null {
  for (const f of fmts) if (f.itag === itag && f.url) return f.url as string;
  return null;
}

export function pickAudio(sd: InnertubeStreamingData): string | null {
  const adaptive = (sd.adaptiveFormats ?? sd.adaptive_formats ?? []).filter((f) => f.url);
  for (const itag of [251, 250, 140]) {
    const u = byItag(adaptive, itag);
    if (u) return u;
  }
  const audio = adaptive.filter((f) => (f.mimeType ?? f.mime_type ?? '').startsWith('audio/'));
  if (!audio.length) return null;
  const m4a = audio.filter((f) => (f.mimeType ?? f.mime_type ?? '').includes('mp4'));
  const pick = (m4a.length ? m4a : audio).reduce((a, b) =>
    (b.bitrate ?? 0) > (a.bitrate ?? 0) ? b : a,
  );
  return (pick.url as string) || null;
}

export function pickMuxed(sd: InnertubeStreamingData): string | null {
  const formats = (sd.formats ?? []).filter((f) => f.url);
  for (const itag of [22, 18]) {
    const u = byItag(formats, itag);
    if (u) return u;
  }
  if (!formats.length) return null;
  const mp4 = formats.filter((f) => (f.mimeType ?? f.mime_type ?? '').includes('mp4'));
  const pick = (mp4.length ? mp4 : formats).reduce((a, b) =>
    (b.height ?? 0) > (a.height ?? 0) ? b : a,
  );
  return (pick.url as string) || null;
}

export interface ResolveMeta {
  urls: [string | null, string | null];
  /** Set when the URL was resolved through the Webshare geo-bypass proxy. */
  proxyUrl: string | null;
}

const RESOLVED_STREAM_CACHE = new BoundedCache<ResolveMeta>(2048, 1800);
const ACTIVE_STREAM_RESOLVES = new Map<string, Set<{ invalidated: boolean }>>();

/** Forget revoked URLs and prevent an older player request from restoring them. */
export function invalidateResolvedStream(urlOrId: string): void {
  const vid = extractId(urlOrId);
  if (!vid) return;
  RESOLVED_STREAM_CACHE.delete(vid);
  INFO_CACHE.delete(vid);
  for (const attempt of ACTIVE_STREAM_RESOLVES.get(vid) ?? []) attempt.invalidated = true;
}

async function fetchInfo(vid: string): Promise<any | null> {
  const cached = INFO_CACHE.get(vid);
  if (cached !== undefined) return cached;

  const yt = await getInnertube();
  // Working client ladder for metadata
  for (const client of ['TV_SIMPLY', 'MWEB', 'ANDROID', 'WEB', 'IOS'] as const) {
    try {
      const info = await yt.getBasicInfo(vid, { client });
      if (info.basic_info?.title || info.playability_status?.status === 'OK') {
        INFO_CACHE.set(vid, info);
        return info;
      }
      log.info(`[YTJS] ${vid} ${client} playability status: ${info.playability_status?.status} (${info.playability_status?.reason || 'no reason'})`);
    } catch (e) {
      log.warning(`[YTJS] ${vid} ${client} failed: ${String(e)}`);
    }
  }
  return null;
}

interface ResolveAttempt {
  urls: [string | null, string | null];
  lastError?: string;
  /** Set when a playability failure was classified as a geo-restriction. */
  geoBlocked?: boolean;
  /** availableCountries from the player microformat, when present. */
  microCountries?: string[];
}

type PlayerFailure = 'content' | 'proxy' | 'unknown';

function playabilityFailure(status: unknown, reason: unknown): PlayerFailure {
  if (typeof status !== 'string' || status === 'OK') return 'unknown';
  // Private, removed, age-limited and region-limited videos say nothing about
  // exit health. Bot challenges and rate/IP blocks do depend on the exit.
  return /(?:confirm|verify).{0,30}(?:not a bot|human)|unusual traffic|too many requests|rate.?limit|(?:ip|address).{0,30}block/i.test(String(reason ?? ''))
    ? 'proxy'
    : 'content';
}

function playerExceptionFailure(error: unknown): PlayerFailure {
  // youtubei.js throws for ERROR playability and retains the player status
  // in InnertubeError.info instead of returning a VideoInfo object.
  const info = (error as { info?: { status?: unknown; reason?: unknown } } | null)?.info;
  if (info?.status) return playabilityFailure(info.status, info.reason);
  const message = String(error);
  if (/video (?:is unavailable|is private|has been removed)|available in (?:your|this) country/i.test(message)) return 'content';
  return /timed? ?out|fetch failed|network|econn|enotfound|eai_again|socket|proxy|tls|certificate|status code (?:401|403|407|429|5\d\d)/i.test(message)
    ? 'proxy'
    : 'unknown';
}

interface ProxiedResolveAttempt {
  meta: ResolveMeta | null;
  failure: PlayerFailure;
}

/** Allowlist/blacklist of countries a video is playable in. */
interface GeoRestriction {
  allowed: string[];
  blocked: string[];
}

/**
 * True when a playability failure means the video is region-restricted from
 * this server's location — the one failure class where retrying through a
 * proxy in an allowed country is the fix rather than another attempt.
 * "available in your country" covers both "has not made this video available…"
 * and "is not available…" wordings; that phrase only ever appears in
 * region-availability errors.
 */
export function isGeoBlockedError(error: string): boolean {
  return /available in (?:your|this) country|blocked it in your country|geo-?restrict/i.test(error);
}

/** ISO codes where the video is playable, per the player microformat (often absent). */
export function extractGeoCountries(info: unknown): string[] {
  const mf = (info as { microformat?: { available_countries?: unknown } } | null)?.microformat;
  const raw = (mf as { available_countries?: unknown } | null | undefined)?.available_countries;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is string => typeof c === 'string' && /^[A-Za-z]{2}$/.test(c))
    .map((c) => c.toUpperCase());
}

/** Pull the best muxed + audio URLs out of resolved player info. */
async function extractStreamUrls(yt: Innertube, info: any): Promise<[string | null, string | null]> {
  let muxedUrl: string | null = null;
  let audioUrl: string | null = null;

  try {
    const f = info.chooseFormat({ type: 'video+audio', quality: 'best', format: 'any' });
    if (f) {
      muxedUrl = (await f.decipher(yt.session.player)) || f.url || null;
    }
  } catch {
    /* ignore */
  }

  try {
    const f = info.chooseFormat({ type: 'audio', quality: 'best' });
    if (f) {
      audioUrl = (await f.decipher(yt.session.player)) || f.url || null;
    }
  } catch {
    /* ignore */
  }

  const sd: InnertubeStreamingData = info.streaming_data ?? {};
  if (!muxedUrl) muxedUrl = pickMuxed(sd);
  if (!audioUrl) audioUrl = pickAudio(sd);
  if (!audioUrl && muxedUrl) audioUrl = muxedUrl;
  if (!muxedUrl && audioUrl) muxedUrl = audioUrl;
  return [muxedUrl, audioUrl];
}

// App clients (ANDROID/TV_SIMPLY/IOS) return stream URLs that don't require Web PO tokens.
const PROXY_CLIENT_LADDER = ['ANDROID', 'TV_SIMPLY', 'IOS', 'MWEB', 'WEB'] as const;

/**
 * Resolve through a proxied Innertube instance (stage A of the geo-bypass
 * tier). The instance is bootstrapped by the caller (on its own clock); here
 * each client in the ladder gets its own probe budget bounded by `deadline`,
 * so one slow or non-OK client can't starve the ones after it. Both URLs share
 * the same proxy binding, so both are returned.
 */
async function attemptResolveWithProxiedInnertube(
  vid: string,
  proxyUrl: string,
  yt: Innertube,
  deadline: number,
): Promise<ProxiedResolveAttempt> {
  let contentFailure = false;
  let proxyFailure = false;
  for (const client of PROXY_CLIENT_LADDER) {
    if (Date.now() >= deadline) break;
    try {
      const budget = Math.min(PROXY_PROBE_TIMEOUT_MS, Math.max(1_000, deadline - Date.now()));
      const info = await withTimeout(
        yt.getBasicInfo(vid, { client }),
        budget,
        'proxied getBasicInfo',
      );
      if (info.playability_status?.status !== 'OK') {
        const failure = playabilityFailure(info.playability_status?.status, info.playability_status?.reason);
        contentFailure ||= failure === 'content';
        proxyFailure ||= failure === 'proxy';
        continue;
      }
      contentFailure = true; // A playable player response proves this exit is reachable.
      const [muxedUrl, audioUrl] = await extractStreamUrls(yt, info);
      if (muxedUrl || audioUrl) {
        return { meta: { urls: [muxedUrl, audioUrl], proxyUrl }, failure: 'content' };
      }
    } catch (error) {
      const failure = playerExceptionFailure(error);
      contentFailure ||= failure === 'content';
      proxyFailure ||= failure === 'proxy';
    }
  }
  return { meta: null, failure: contentFailure ? 'content' : proxyFailure ? 'proxy' : 'unknown' };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Webshare geo-bypass:
 *   youtubei.js through a scoped proxy dispatcher (fast, ~seconds).
 * When the failure was classified as a geo-restriction, the proxy is targeted
 * at a country where the video is playable (whitelist) or at least outside
 * the blocked set (blacklist); everything else keeps plain round-robin.
 * Webshare's country labels often disagree with Google's geo-IP view of
 * datacenter IPs, so up to PROXY_CANDIDATES exits are tried under a time budget before giving up.
 * The result is pinned to one proxy exit and never written to
 * RESOLVED_STREAM_CACHE (which holds direct, server-locked URL pairs).
 */
const PROXY_CANDIDATES = 4;
const TIER_BUDGET_MS = 35_000;
// Cold Innertube bootstrap (homepage + player JS through the proxy) runs on its
// own clock, separate from the probe budget, so a cold session doesn't consume
// the time meant for getBasicInfo. A cached instance returns from this instantly.
const PROXY_BOOTSTRAP_TIMEOUT_MS = 20_000;
// One getBasicInfo round-trip through the proxy. Spent per client, not shared
// across the whole ladder, so a single slow probe no longer fails the candidate.
const PROXY_PROBE_TIMEOUT_MS = 8_000;

/** Resolve with the first task that yields a non-null value, else null once all settle. */
function raceUsable<T>(tasks: Promise<T | null>[]): Promise<T | null> {
  if (!tasks.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let remaining = tasks.length;
    let settled = false;
    const onDone = (v: T | null) => {
      if (settled) return;
      if (v !== null) {
        settled = true;
        resolve(v);
      } else if (--remaining === 0) {
        resolve(null);
      }
    };
    for (const t of tasks) void t.then(onDone, () => onDone(null));
  });
}

async function resolveViaProxyTier(
  vid: string,
  _kind: 'audio' | 'muxed',
  geo?: GeoRestriction,
): Promise<ResolveMeta | null> {
  if (!websharePool.enabled) return null;

  const deadline = Date.now() + TIER_BUDGET_MS;
  const tried = new Set<string>();

  if (geo) {
    log.info(
      `[YTJS] ${vid} Webshare tier — geo target [${geo.allowed?.join(',') || 'any'}], avoid [${geo.blocked?.join(',') || 'none'}]`,
    );
  }

  // One exit's full attempt: bootstrap (a cold exit pays session setup here, a
  // warm one returns instantly) then probe the client ladder. Never throws — a
  // content failure resolves to null while retaining the reachable exit.
  const attempt = async (proxy: WebshareProxy): Promise<ResolveMeta | null> => {
    log.info(
      `[YTJS] ${vid} Webshare exit ${proxy.address}:${proxy.port} (${proxy.countryCode || '??'})` +
        (isProxiedInnertubeWarm(proxy.url) ? ' [warm]' : ''),
    );
    try {
      const bootBudget = Math.min(PROXY_BOOTSTRAP_TIMEOUT_MS, Math.max(1_000, deadline - Date.now()));
      const yt = await withTimeout(getProxiedInnertube(proxy.url), bootBudget, 'proxied innertube bootstrap');
      const result = await attemptResolveWithProxiedInnertube(vid, proxy.url, yt, deadline);
      if (result.meta) {
        websharePool.markOk(proxy.id);
        log.info(`[YTJS] ✅ ${vid} resolved via Webshare proxy (youtubei.js)`);
        return result.meta;
      }
      if (result.failure === 'proxy') {
        PROXIED_INNERTUBE_POOL.delete(proxy.url);
        websharePool.markBad(proxy.id);
      } else if (result.failure === 'content') {
        websharePool.markOk(proxy.id);
      }
    } catch (e) {
      log.warning(`[YTJS] proxied innertube attempt failed: ${String(e)}`);
      if (playerExceptionFailure(e) === 'proxy') {
        PROXIED_INNERTUBE_POOL.delete(proxy.url);
        websharePool.markBad(proxy.id);
      }
    }
    return null;
  };

  while (Date.now() + 2_000 < deadline) {
    let candidates: WebshareProxy[] = [];
    if (geo?.allowed?.length) {
      candidates = websharePool.getGeoCandidates({ allowed: geo.allowed }, PROXY_CANDIDATES, isProxiedInnertubeWarm);
      if (!candidates.length) {
        const p = await websharePool.getProxyForCountries(geo.allowed).catch(() => null);
        if (p) candidates.push(p);
      }
    } else if (geo?.blocked?.length) {
      candidates = websharePool.getGeoCandidates({ blocked: geo.blocked }, PROXY_CANDIDATES, isProxiedInnertubeWarm);
    }
    if (!candidates.length) {
      candidates = websharePool.getWarmCandidates(PROXY_CANDIDATES, isProxiedInnertubeWarm);
    }

    let untried = candidates.filter((p) => !tried.has(p.id));
    if (!untried.length) {
      const all = websharePool.getAllCandidates().filter((p) => !tried.has(p.id));
      if (!all.length) break;
      untried = all.slice(0, PROXY_CANDIDATES);
    }
    for (const p of untried) tried.add(p.id);

    const warm = untried.filter((c) => isProxiedInnertubeWarm(c.url));
    const cold = untried.filter((c) => !isProxiedInnertubeWarm(c.url));
    for (const group of [warm, cold]) {
      if (!group.length || Date.now() >= deadline) continue;
      const meta = await raceUsable(group.map((p) => attempt(p)));
      if (meta) return meta;
    }
  }

  return null;
}

async function attemptResolve(vid: string, isCurrent: () => boolean): Promise<ResolveAttempt> {
  let yt: Innertube;
  try {
    yt = await getInnertube();
  } catch (e) {
    log.warning(`[YTJS] Failed initializing Innertube: ${String(e)}`);
    return { urls: [null, null], lastError: `Innertube init failed: ${String(e)}` };
  }

  const clients = ['ANDROID', 'TV_SIMPLY', 'IOS', 'MWEB', 'WEB'] as const;
  let lastError = 'No stream formats returned';
  let geoBlocked = false;
  let microCountries: string[] = [];

  for (const client of clients) {
    try {
      const info = await yt.getBasicInfo(vid, { client });
      if (info.playability_status?.status !== 'OK') {
        const st = info.playability_status?.status || 'STATUS_NOT_OK';
        const reason = info.playability_status?.reason || '';
        lastError = `${st}: ${reason}`.trim();
        // A geo restriction is server-IP dependent: once any client reports
        // it, a proxy from an allowed country is the targeted next step.
        if (!geoBlocked && isGeoBlockedError(lastError)) {
          geoBlocked = true;
          microCountries = extractGeoCountries(info);
        }
        continue;
      }

      const [muxedUrl, audioUrl] = await extractStreamUrls(yt, info);
      if (muxedUrl || audioUrl) {
        if (isCurrent()) INFO_CACHE.set(vid, info);
        return { urls: [muxedUrl, audioUrl] };
      }
    } catch (e) {
      lastError = `${client} error: ${String(e)}`;
      log.warning(`[YTJS] ${vid} ${client} resolution failed: ${String(e)}`);
    }
  }

  return { urls: [null, null], lastError, geoBlocked, microCountries };
}

/** First geo-classified failure fixes the restriction (allowlist + blacklist). */
function geoFromAttempt(attempt: ResolveAttempt): GeoRestriction | null {
  return attempt.geoBlocked
    ? { allowed: attempt.microCountries ?? [], blocked: [] }
    : null;
}

export async function resolveBothWithMeta(
  urlOrId: string,
  kind: 'audio' | 'muxed' = 'audio',
): Promise<ResolveMeta> {
  const vid = extractId(urlOrId);
  if (!vid) return { urls: [null, null], proxyUrl: null };

  const cached = RESOLVED_STREAM_CACHE.get(vid);
  if (cached) return cached;

  const active = { invalidated: false };
  const attempts = ACTIVE_STREAM_RESOLVES.get(vid) ?? new Set();
  attempts.add(active);
  ACTIVE_STREAM_RESOLVES.set(vid, attempts);
  try {
    const directAttempt = await attemptResolve(vid, () => !active.invalidated);
    let geo = geoFromAttempt(directAttempt);
    let result: ResolveMeta = { urls: directAttempt.urls, proxyUrl: null };

    if (geo) {
      const official = await fetchRegionRestriction(vid).catch(() => null);
      if (official) {
        geo = {
          allowed: [...new Set([...geo.allowed, ...(official.allowed ?? [])])],
          blocked: official.blocked ?? [],
        };
      }
      log.info(
        `[YTJS] ${vid} geo-restricted — targeting proxy in [${geo.allowed.join(',') || 'any'}], avoiding [${geo.blocked.join(',') || 'none'}]`,
      );
    }

    if (!(result.urls[0] || result.urls[1])) {
      // Webshare retries use an exit binding and stay outside the direct memo.
      const viaProxy = await resolveViaProxyTier(vid, kind, geo ?? undefined);
      if (viaProxy) result = viaProxy;
    }
    if (active.invalidated) return resolveBothWithMeta(urlOrId, kind);
    if (!result.proxyUrl && (result.urls[0] || result.urls[1])) RESOLVED_STREAM_CACHE.set(vid, result);
    return result;
  } finally {
    attempts.delete(active);
    if (!attempts.size) ACTIVE_STREAM_RESOLVES.delete(vid);
  }
}

export async function resolveBoth(
  urlOrId: string,
): Promise<[string | null, string | null]> {
  return (await resolveBothWithMeta(urlOrId)).urls;
}

/** Like `resolve`, but also reports the Webshare proxy the URL is locked to (null when direct). */
export async function resolveWithMeta(
  urlOrId: string,
  kind: 'audio' | 'muxed',
): Promise<{ url: string | null; proxyUrl: string | null }> {
  const vid = extractId(urlOrId);
  if (!vid) return { url: null, proxyUrl: null };
  const meta = await resolveBothWithMeta(urlOrId, kind);
  return { url: kind === 'audio' ? meta.urls[1] : meta.urls[0], proxyUrl: meta.proxyUrl };
}

export async function resolve(
  urlOrId: string,
  kind: 'audio' | 'muxed',
): Promise<string | null> {
  return (await resolveWithMeta(urlOrId, kind)).url;
}

export async function metadata(urlOrId: string): Promise<InnertubeMetadata | null> {
  const vid = extractId(urlOrId);
  if (!vid) return null;

  const info = await fetchInfo(vid);
  if (!info) return null;

  const b = info.basic_info ?? {};
  const title = b.title ?? '';
  if (!title) return null;

  const secs = b.duration ?? 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const channel: string = b.author ?? '';
  const thumbs = b.thumbnail ?? [];
  const bestThumb = thumbs.length ? thumbs[thumbs.length - 1]!.url : `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;

  return {
    title,
    url: `https://www.youtube.com/watch?v=${vid}`,
    artist_name: extractArtist(title) || channel,
    channel_name: channel,
    views: formatInd(b.view_count ?? 0),
    duration: h
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`,
    thumbnail: bestThumb,
    video_id: vid,
  };
}

function makeRelatedItem(vid: string, partial: Partial<RelatedItem>): RelatedItem {
  return {
    title: partial.title ?? '',
    video_id: vid,
    url: `https://www.youtube.com/watch?v=${vid}`,
    time: partial.time ?? '',
    duration: partial.duration ?? '',
    channel: partial.channel ?? '',
    views: partial.views ?? '',
    thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
  };
}

export async function related(urlOrId: string, limit = 5): Promise<RelatedItem[]> {
  const vid = extractId(urlOrId);
  if (!vid) return [];

  try {
    const yt = await getInnertube();
    const res = await yt.actions.execute('/next', { videoId: vid });
    const data = res.data as any;
    const secondary: Json[] =
      data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results ?? [];
    const contents: Json[] = secondary[0]?.itemSectionRenderer?.contents ?? secondary;

    const items: RelatedItem[] = [];
    for (const s of contents) {
      const lvm = s.lockupViewModel;
      if (lvm) {
        const candId: string | undefined = lvm.contentId;
        if (!candId || candId === vid) continue;
        const meta = lvm.metadata?.lockupMetadataViewModel ?? {};
        const title = meta.title?.content ?? '';
        const rows: Json[] = meta.metadata?.contentMetadataViewModel?.metadataRows ?? [];
        let channel = '';
        let views = '';
        let duration = '';
        if (rows.length > 0) {
          const parts = rows[0]!.metadataParts ?? [];
          if (parts.length) channel = parts[0]!.text?.content ?? '';
        }
        if (rows.length > 1) {
          const parts = rows[1]!.metadataParts ?? [];
          if (parts.length) views = parts[0]!.text?.content ?? '';
        }
        const overlays: Json[] = lvm.contentImage?.thumbnailViewModel?.overlays ?? [];
        for (const o of overlays) {
          for (const b of o.thumbnailBottomOverlayViewModel?.badges ?? []) {
            const badge = b.thumbnailBadgeViewModel ?? {};
            if (badge.text) duration = badge.text;
          }
          const timeTxt = o.thumbnailOverlayTimeStatusRenderer?.text?.runs?.[0]?.text;
          if (timeTxt) duration = timeTxt;
        }
        items.push(makeRelatedItem(candId, { title, channel, views, duration, time: duration }));
      } else if (s.compactVideoRenderer) {
        const cvr = s.compactVideoRenderer;
        const candId: string | undefined = cvr.videoId;
        if (!candId || candId === vid) continue;
        const title = cvr.title?.simpleText ?? cvr.title?.runs?.[0]?.text ?? '';
        const duration = cvr.lengthText?.simpleText ?? '';
        const channel = cvr.longBylineText?.runs?.[0]?.text ?? '';
        const views = cvr.viewCountText?.simpleText ?? '';
        items.push(makeRelatedItem(candId, { title, duration, time: duration, channel, views }));
      }
      if (items.length >= limit) break;
    }
    return items;
  } catch (e) {
    log.warning(`[YTJS] next endpoint failed for ${vid}`, { err: String(e) });
    return [];
  }
}
