/**
 * Fast YouTube resolver powered by youtubei.js (ytjs).
 */
import { Innertube, Platform, Parser, Helpers } from 'youtubei.js';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { extractArtist, formatInd } from './formatters.js';
import { getLogger } from './logger.js';
import { config } from './config.js';
import { BoundedCache } from './boundedCache.js';
import { websharePool } from './proxy.js';
import { fetchRegionRestriction } from './youtubeApi.js';
import type { WebshareProxy } from './proxy.js';
import { invalidateMediaProbe, probeMedia } from './mediaProbe.js';
import { probeHls } from './hlsProxy.js';
import { boundedFetch, requestDeadline, requestSignal, withIndependentRequestDeadline, withRequestDeadline } from './requestDeadline.js';

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

export interface ResolveOptions {
  /** Bypass stream caches after a rejected route. Extraction always uses Webshare. */
  forceProxy?: boolean;
  excludeProxyUrl?: string | null;
}

// INFO_CACHE: caches getBasicInfo results for 1 hour.
const INFO_CACHE = new BoundedCache<any>(2048, 3600);
type Json = Record<string, any>;

export interface InnertubeStreamingData {
  formats?: Json[];
  adaptiveFormats?: Json[];
  adaptive_formats?: Json[];
  hls_manifest_url?: string;
  hlsManifestUrl?: string;
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

export function resetInnertube(): void {
  for (const task of PROXIED_INNERTUBE_BOOTSTRAPS.values()) task.controller.abort(new Error('Innertube reset'));
  PROXIED_INNERTUBE_BOOTSTRAPS.clear();
  PROXIED_INNERTUBE_POOL.clear();
  directBootstrap = null;
}

// Innertube instances whose HTTP traffic is bound to one Webshare exit — one
// per proxy URL, so the googlevideo URLs they return stay playable through it.
const PROXIED_INNERTUBE_POOL = new BoundedCache<Innertube>(50, 3600);
interface SharedTask<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
}
const PROXIED_INNERTUBE_BOOTSTRAPS = new Map<string, SharedTask<Innertube>>();
const INNERTUBE_PROXY_URLS = new WeakMap<Innertube, string>();

/** A caller owns its subscription; the last departing caller cancels shared work. */
function subscribe<T>(task: SharedTask<T>, detached: () => void): Promise<T> {
  const signal = requestSignal();
  signal?.throwIfAborted();
  task.waiters++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (value: T | undefined, error?: unknown) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', cancelled);
      if (--task.waiters === 0 && !task.settled) {
        detached();
        task.controller.abort(new Error('No extraction callers remain'));
      }
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const cancelled = () => finish(undefined, signal?.reason ?? new Error('Extraction caller cancelled'));
    signal?.addEventListener('abort', cancelled, { once: true });
    task.promise.then(value => finish(value), error => finish(undefined, error));
  });
}

const PLAYER_CONCURRENCY = 8;
const PLAYER_CONCURRENCY_PER_EXIT = 1;
const MAX_PENDING_PLAYERS = 128;
const PLAYER_QUEUE = new Set<{ proxyUrl: string; start: () => void }>();
const ACTIVE_PLAYERS_PER_EXIT = new Map<string, number>();
let activePlayers = 0;

class PlayerAdmissionError extends Error {}

function drainPlayerQueue(): void {
  for (const entry of PLAYER_QUEUE) {
    if (activePlayers >= PLAYER_CONCURRENCY) break;
    if ((ACTIVE_PLAYERS_PER_EXIT.get(entry.proxyUrl) ?? 0) < PLAYER_CONCURRENCY_PER_EXIT) entry.start();
  }
}

/** Queue wait shares the extraction deadline, but never counts as an exit failure. */
function acquirePlayer(proxyUrl: string): Promise<() => void> {
  const signal = requestSignal();
  const expires = requestDeadline();
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      PLAYER_QUEUE.delete(entry);
      signal?.removeEventListener('abort', cancelled);
      reject(new PlayerAdmissionError('Player admission cancelled'));
    };
    const entry = { proxyUrl, start: () => {
      PLAYER_QUEUE.delete(entry);
      signal?.removeEventListener('abort', cancelled);
      if (signal?.aborted || Date.now() >= expires) { cancelled(); return; }
      activePlayers++;
      ACTIVE_PLAYERS_PER_EXIT.set(proxyUrl, (ACTIVE_PLAYERS_PER_EXIT.get(proxyUrl) ?? 0) + 1);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activePlayers--;
        const remaining = (ACTIVE_PLAYERS_PER_EXIT.get(proxyUrl) ?? 1) - 1;
        if (remaining) ACTIVE_PLAYERS_PER_EXIT.set(proxyUrl, remaining);
        else ACTIVE_PLAYERS_PER_EXIT.delete(proxyUrl);
        drainPlayerQueue();
      });
    } };
    if (signal?.aborted) { cancelled(); return; }
    if (activePlayers < PLAYER_CONCURRENCY && (ACTIVE_PLAYERS_PER_EXIT.get(proxyUrl) ?? 0) < PLAYER_CONCURRENCY_PER_EXIT) entry.start();
    else if (PLAYER_QUEUE.size >= MAX_PENDING_PLAYERS) reject(new PlayerAdmissionError('Player admission queue is full'));
    else {
      PLAYER_QUEUE.add(entry);
      signal?.addEventListener('abort', cancelled, { once: true });
    }
  });
}

async function getPlayerInfo(yt: Innertube, vid: string, client: string, budget: number): Promise<any> {
  const release = await acquirePlayer(INNERTUBE_PROXY_URLS.get(yt) ?? 'unknown');
  try {
    requestSignal()?.throwIfAborted();
    return await withRequestDeadline(budget, 'proxied getBasicInfo', () => yt.getBasicInfo(vid, { client } as any));
  } finally {
    release();
  }
}

/** Webshare fetch; without an agent this is the plain direct fetch. */
function makeProxiedFetch(agent?: ProxyAgent): typeof fetch {
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
    return agent
      ? undiciFetch(url as any, { ...reqInit, dispatcher: agent } as any)
      : undiciFetch(url as any, reqInit as any);
  };
  return boundedFetch(proxied as unknown as typeof fetch);
}

async function getProxiedInnertube(proxyUrl: string): Promise<Innertube> {
  const cached = PROXIED_INNERTUBE_POOL.get(proxyUrl);
  if (cached) return cached;
  let task = PROXIED_INNERTUBE_BOOTSTRAPS.get(proxyUrl);
  if (!task) {
    const controller = new AbortController();
    const current: SharedTask<Innertube> = { controller, promise: Promise.resolve(undefined as unknown as Innertube), waiters: 0, settled: false };
    PROXIED_INNERTUBE_BOOTSTRAPS.set(proxyUrl, current);
    let started = false;
    current.promise = withIndependentRequestDeadline(PROXY_BOOTSTRAP_TIMEOUT_MS, 'shared Innertube bootstrap', controller.signal, async () => {
      const release = await acquirePlayer(proxyUrl);
      try {
        requestSignal()?.throwIfAborted();
        started = true;
        const instance = await withRequestDeadline(PROXY_BOOTSTRAP_TIMEOUT_MS, 'Innertube session creation', () =>
          Innertube.create({ fetch: makeProxiedFetch(new ProxyAgent(proxyUrl)) }));
        requestSignal()?.throwIfAborted();
        if (PROXIED_INNERTUBE_BOOTSTRAPS.get(proxyUrl) === current && current.waiters) {
          INNERTUBE_PROXY_URLS.set(instance, proxyUrl);
          PROXIED_INNERTUBE_POOL.set(proxyUrl, instance);
        }
        return instance;
      } finally {
        release();
      }
    }).catch(error => {
      if (!started) throw new PlayerAdmissionError('Innertube bootstrap admission cancelled');
      throw error;
    }).finally(() => {
      current.settled = true;
      if (PROXIED_INNERTUBE_BOOTSTRAPS.get(proxyUrl) === current) PROXIED_INNERTUBE_BOOTSTRAPS.delete(proxyUrl);
    });
    task = current;
  }
  const current = task;
  return subscribe(current, () => {
    if (PROXIED_INNERTUBE_BOOTSTRAPS.get(proxyUrl) === current) PROXIED_INNERTUBE_BOOTSTRAPS.delete(proxyUrl);
  });
}

const DIRECT_INNERTUBE_KEY = 'direct:';
let directBootstrap: Promise<Innertube> | null = null;

/** Opt-in last resort when the proxy tier is empty: a plain (non-proxied) session. */
function directFallbackEnabled(): boolean {
  try {
    return Boolean(config().EXTRACTION_DIRECT_FALLBACK);
  } catch {
    return ['1', 'true', 'yes'].includes((process.env.EXTRACTION_DIRECT_FALLBACK || '').trim().toLowerCase());
  }
}

/**
 * Direct (proxy-less) Innertube session for the EXTRACTION_DIRECT_FALLBACK
 * path. Datacenter IPs can be bot-checked by YouTube, so this is opt-in and
 * only reached when the Webshare pool has no usable exit at all.
 */
async function getDirectInnertube(): Promise<Innertube> {
  const cached = PROXIED_INNERTUBE_POOL.get(DIRECT_INNERTUBE_KEY);
  if (cached) return cached;
  directBootstrap ??= withRequestDeadline(PROXY_BOOTSTRAP_TIMEOUT_MS, 'direct Innertube bootstrap', () =>
    Innertube.create({ fetch: makeProxiedFetch() }),
  ).then((instance) => {
    PROXIED_INNERTUBE_POOL.set(DIRECT_INNERTUBE_KEY, instance);
    return instance;
  }, (error) => {
    directBootstrap = null;
    throw error;
  });
  return directBootstrap;
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
            await withRequestDeadline(PROXY_BOOTSTRAP_TIMEOUT_MS, 'prewarm', () => getProxiedInnertube(p.url));
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
  if (!websharePool.enabled) throw new Error('Webshare is required for YouTube extraction; configure WEBSHARE_API_KEY');
  return withRequestDeadline(TIER_BUDGET_MS, 'Webshare Innertube bootstrap', async () => {
    const candidates = websharePool.getWarmCandidates(PROXY_CANDIDATES, isProxiedInnertubeWarm);
    if (!candidates.length) {
      const proxy = await websharePool.getProxy();
      if (proxy) candidates.push(proxy);
    }
    for (const proxy of candidates) {
      try {
        return await getProxiedInnertube(proxy.url);
      } catch (error) {
        requestSignal()?.throwIfAborted();
        if (playerExceptionFailure(error) === 'proxy') websharePool.markBad(proxy.id, proxy.url);
        log.warning(`[YTJS] Webshare session initialization failed: ${String(error)}`);
      }
    }
    if (!websharePool.size && directFallbackEnabled()) {
      log.warning('[YTJS] Webshare pool empty — trying direct extraction fallback');
      try {
        return await getDirectInnertube();
      } catch (error) {
        log.warning(`[YTJS] Direct extraction fallback failed: ${String(error)}`);
      }
    }
    throw new Error('No usable Webshare proxy is available for YouTube extraction');
  });
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
  const formats = (sd.formats ?? []).filter((f) => f.url && isMuxedFormat(f));
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

function isMuxedFormat(format: Json): boolean {
  if (format.has_video === false || format.has_audio === false) return false;
  if ((format.mimeType ?? format.mime_type ?? '').startsWith('audio/')) return false;
  let itag = format.itag;
  try { itag ??= Number(new URL(format.url).searchParams.get('itag')); } catch { /* deciphered URL may follow later */ }
  return ![139, 140, 141, 249, 250, 251, 256, 258, 325, 328, 599, 600].includes(Number(itag));
}

export interface ResolveMeta {
  urls: [string | null, string | null];
  /** Common playback route, or the Webshare route when formats have different bindings. */
  proxyUrl: string | null;
  /** Per-format playback routes (muxed, audio), present only when they differ. */
  proxyUrls?: [string | null, string | null];
  /** HLS manifests need a playlist/segment relay instead of a continuous file relay. */
  streamTypes?: ['hls' | null, 'hls' | null];
}

function formatProxy(meta: ResolveMeta, index: 0 | 1): string | null {
  return meta.proxyUrls ? meta.proxyUrls[index] : meta.proxyUrl;
}

function invalidateMetaProbes(meta: ResolveMeta | null | undefined): void {
  if (!meta) return;
  for (const index of [0, 1] as const) {
    const url = meta.urls[index];
    if (url) invalidateMediaProbe(url, formatProxy(meta, index));
  }
}

const RESOLVED_STREAM_CACHE = new BoundedCache<ResolveMeta>(2048, 1800);
type StreamKind = 'audio' | 'muxed';
interface StreamResolveTask extends SharedTask<ResolveMeta> {
  vid: string;
  invalidated: boolean;
  kinds: Map<StreamKind, number>;
  completedKinds: Set<StreamKind>;
}
const ACTIVE_STREAM_RESOLVES = new Map<string, StreamResolveTask>();

/** Forget revoked URLs and prevent an older player request from restoring them. */
export function invalidateResolvedStream(urlOrId: string): void {
  const vid = extractId(urlOrId);
  if (!vid) return;
  const cached = RESOLVED_STREAM_CACHE.get(vid);
  invalidateMetaProbes(cached);
  RESOLVED_STREAM_CACHE.delete(vid);
  INFO_CACHE.delete(vid);
  for (const [key, task] of ACTIVE_STREAM_RESOLVES) {
    if (task.vid !== vid) continue;
    task.invalidated = true;
    ACTIVE_STREAM_RESOLVES.delete(key);
    task.controller.abort(new Error('Stream invalidated'));
  }
}

async function fetchInfo(vid: string): Promise<any | null> {
  const cached = INFO_CACHE.get(vid);
  if (cached !== undefined) return cached;

  const yt = await getInnertube();
  // Working client ladder for metadata
  for (const client of ['TV_SIMPLY', 'MWEB', 'ANDROID', 'WEB', 'IOS'] as const) {
    try {
      const info = await getPlayerInfo(yt, vid, client, 6_000);
      requestSignal()?.throwIfAborted();
      if (info.basic_info?.title || info.playability_status?.status === 'OK') {
        if (liveManifest(info) === undefined) INFO_CACHE.set(vid, info);
        return info;
      }
      log.info(`[YTJS] ${vid} ${client} playability status: ${info.playability_status?.status} (${info.playability_status?.reason || 'no reason'})`);
    } catch (e) {
      log.warning(`[YTJS] ${vid} ${client} failed: ${String(e)}`);
    }
  }
  return null;
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
  if (error instanceof PlayerAdmissionError) return 'unknown';
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
  geo?: GeoRestriction;
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
    if (f && isMuxedFormat(f)) {
      const deciphered = (await f.decipher(yt.session.player)) || f.url || null;
      if (deciphered && isMuxedFormat({ ...f, url: deciphered })) muxedUrl = deciphered;
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
  // YouTube live/post-live URLs are finite fragments, even when startup bytes pass.
  if (isLiveFragment(muxedUrl)) muxedUrl = null;
  if (isLiveFragment(audioUrl)) audioUrl = null;
  return [muxedUrl, audioUrl];
}

function isLiveFragment(url: string | null): boolean {
  if (!url) return false;
  try {
    const params = new URL(url).searchParams;
    return params.get('live') === '1' || params.get('source') === 'yt_live_broadcast';
  } catch { return false; }
}

function liveManifest(info: any): string | null | undefined {
  const sd = info.streaming_data as InnertubeStreamingData | undefined;
  const hls = sd?.hls_manifest_url ?? sd?.hlsManifestUrl;
  // is_live_content alone also labels completed broadcasts that have normal files.
  return info.basic_info?.is_live || info.basic_info?.is_post_live_dvr ? hls ?? null : undefined;
}

// App clients (ANDROID/TV_SIMPLY/IOS) return stream URLs that don't require Web PO tokens.
const PROXY_CLIENT_LADDER = ['ANDROID', 'TV_SIMPLY', 'IOS', 'MWEB', 'WEB'] as const;

interface VerifiedStream { url: string; proxyUrl: string | null; streamType?: 'hls' }

function verifiedMeta(streams: [VerifiedStream | null, VerifiedStream | null]): ResolveMeta {
  const [muxed, audio] = streams;
  const routes: [string | null, string | null] = [muxed?.proxyUrl ?? null, audio?.proxyUrl ?? null];
  const streamTypes: ['hls' | null, 'hls' | null] = [muxed?.streamType ?? null, audio?.streamType ?? null];
  return {
    urls: [muxed?.url ?? null, audio?.url ?? null], proxyUrl: routes[0] ?? routes[1],
    ...(routes[0] !== routes[1] ? { proxyUrls: routes } : {}),
    ...(streamTypes.some(Boolean) ? { streamTypes } : {}),
  };
}

async function verifiedLiveUrls(
  url: string,
  proxyUrl: string | null,
  probes: Map<string, Promise<VerifiedStream | null>>,
  deadline: number,
): Promise<ResolveMeta> {
  const streams = await Promise.all((['video', 'audio'] as const).map(mode => {
    const key = `hls:${mode}:${url}`;
    let pending = probes.get(key);
    if (!pending) {
      pending = (async (): Promise<VerifiedStream | null> => {
        const options = { deadline, signal: requestSignal(), mode };
        if (await probeHls(url, { ...options, proxyUrl: null })) return { url, proxyUrl: null, streamType: 'hls' };
        if (proxyUrl && await probeHls(url, { ...options, proxyUrl })) return { url, proxyUrl, streamType: 'hls' };
        return null;
      })();
      probes.set(key, pending);
    }
    return pending;
  }));
  return verifiedMeta(streams as [VerifiedStream | null, VerifiedStream | null]);
}

/** Prefer server-direct media even when Webshare was needed for extraction. */
async function verifiedStreamUrls(
  urls: [string | null, string | null],
  proxyUrl: string | null,
  probes: Map<string, Promise<VerifiedStream | null>>,
  deadline = requestDeadline(),
): Promise<ResolveMeta> {
  const checked = await Promise.all(urls.map(async url => {
    if (!url) return null;
    let pending = probes.get(url);
    if (!pending) {
      pending = (async (): Promise<VerifiedStream | null> => {
        if (await probeMedia(url, { proxyUrl: null, deadline })) return { url, proxyUrl: null };
        // Failure stays local to this client ladder. Do not repeat the same
        // direct/proxy checks if another client returns the identical URL.
        if (proxyUrl && await probeMedia(url, { proxyUrl, deadline })) return { url, proxyUrl };
        return null;
      })();
      probes.set(url, pending);
    }
    return pending;
  }));
  // Audio may use a combined source; a video request must contain video.
  const muxed = checked[0];
  const audio = checked[1] ?? checked[0];
  return verifiedMeta([muxed, audio]);
}

function mergeStreamMeta(first: ResolveMeta | null | undefined, next: ResolveMeta): ResolveMeta {
  const sources = ([0, 1] as const).map(index => first?.urls[index] ? first : next);
  const urls = sources.map((source, index) => source!.urls[index]) as ResolveMeta['urls'];
  const routes = sources.map((source, index) => formatProxy(source!, index as 0 | 1)) as [string | null, string | null];
  const streamTypes = sources.map((source, index) => source!.streamTypes?.[index] ?? null) as ['hls' | null, 'hls' | null];
  return {
    urls, proxyUrl: routes[0] ?? routes[1],
    ...(routes[0] !== routes[1] ? { proxyUrls: routes } : {}),
    ...(streamTypes.some(Boolean) ? { streamTypes } : {}),
  };
}

/**
 * Resolve through a proxied Innertube instance (stage A of the geo-bypass
 * tier). The instance is bootstrapped by the caller (on its own clock); here
 * each client in the ladder gets its own probe budget bounded by `deadline`,
 * so one slow or non-OK client can't starve the ones after it. Each format's
 * media is checked directly first, then through this exit if necessary.
 */
async function attemptResolveWithProxiedInnertube(
  vid: string,
  proxyUrl: string | null,
  yt: Innertube,
  deadline: number,
  isCurrent: () => boolean,
  isUsable: (meta: ResolveMeta) => boolean,
  onComplete: () => void,
): Promise<ProxiedResolveAttempt> {
  let contentFailure = false;
  let proxyFailure = false;
  let geo: GeoRestriction | undefined;
  let best: ResolveMeta | null = null;
  const probes = new Map<string, Promise<VerifiedStream | null>>();
  for (const client of PROXY_CLIENT_LADDER) {
    if (Date.now() >= deadline) break;
    try {
      const budget = Math.min(PROXY_PROBE_TIMEOUT_MS, Math.max(1_000, deadline - Date.now()));
      const info = await getPlayerInfo(yt, vid, client, budget);
      requestSignal()?.throwIfAborted();
      if (info.playability_status?.status !== 'OK') {
        const failure = playabilityFailure(info.playability_status?.status, info.playability_status?.reason);
        contentFailure ||= failure === 'content';
        proxyFailure ||= failure === 'proxy';
        if (!geo && isGeoBlockedError(String(info.playability_status?.reason ?? ''))) {
          geo = { allowed: extractGeoCountries(info), blocked: [] };
        }
        continue;
      }
      contentFailure = true; // A playable player response proves this exit is reachable.
      const manifest = liveManifest(info);
      let meta = manifest !== undefined
        ? manifest ? await verifiedLiveUrls(manifest, proxyUrl, probes, deadline) : { urls: [null, null] as ResolveMeta['urls'], proxyUrl: null }
        : await verifiedStreamUrls(await extractStreamUrls(yt, info), proxyUrl, probes, deadline);
      // VOD can advertise HLS as well. Keep usable finite formats first;
      // use HLS only for a requested slot that the finite choices cannot supply.
      const alternateManifest = info.streaming_data?.hls_manifest_url ?? info.streaming_data?.hlsManifestUrl;
      if (manifest === undefined && !isUsable(meta) && alternateManifest) {
        meta = mergeStreamMeta(meta, await verifiedLiveUrls(alternateManifest, proxyUrl, probes, deadline));
      }
      requestSignal()?.throwIfAborted();
      if (meta.urls[0] || meta.urls[1]) {
        if (isCurrent() && manifest === undefined) INFO_CACHE.set(vid, info);
        best = mergeStreamMeta(best, meta);
        if (isUsable(best)) {
          onComplete();
          return { meta: best, failure: 'content' };
        }
      }
    } catch (error) {
      if (requestSignal()?.aborted) return { meta: null, failure: 'unknown' };
      const failure = playerExceptionFailure(error);
      contentFailure ||= failure === 'content';
      proxyFailure ||= failure === 'proxy';
      const reason = (error as { info?: { reason?: string } } | null)?.info?.reason ?? String(error);
      if (!geo && isGeoBlockedError(reason)) geo = { allowed: [], blocked: [] };
    }
  }
  onComplete();
  return { meta: best, failure: contentFailure ? 'content' : proxyFailure ? 'proxy' : 'unknown', geo };
}

/**
 * Webshare geo-bypass:
 *   youtubei.js through a scoped proxy dispatcher (fast, ~seconds).
 * When the failure was classified as a geo-restriction, the proxy is targeted
 * at a country where the video is playable (whitelist) or at least outside
 * the blocked set (blacklist); everything else keeps plain round-robin.
 * Webshare's country labels often disagree with Google's geo-IP view of
 * datacenter IPs, so up to PROXY_CANDIDATES exits are tried under a time budget before giving up.
 * Formats needing Webshare remain pinned to the extracting exit. Only pairs
 * verified as server-direct can enter RESOLVED_STREAM_CACHE.
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
function raceUsable(tasks: Promise<ResolveMeta | null>[], isUsable: (meta: ResolveMeta) => boolean): Promise<ResolveMeta | null> {
  if (!tasks.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let remaining = tasks.length;
    let settled = false;
    let best: ResolveMeta | null = null;
    const onDone = (v: ResolveMeta | null) => {
      if (settled) return;
      if (v) best = mergeStreamMeta(best, v);
      if (best && isUsable(best)) {
        settled = true;
        resolve(best);
      } else if (--remaining === 0) {
        resolve(best);
      }
    };
    for (const t of tasks) void t.then(onDone, () => onDone(null));
  });
}

async function resolveViaProxyTier(
  vid: string,
  excludeProxyUrl?: string | null,
  isCurrent: () => boolean = () => !requestSignal()?.aborted,
  isUsable: (meta: ResolveMeta) => boolean = meta => !!(meta.urls[0] || meta.urls[1]),
  onComplete: () => void = () => {},
): Promise<ResolveMeta | null> {
  if (!websharePool.enabled) {
    log.error('[YTJS] Webshare is required for YouTube extraction; configure WEBSHARE_API_KEY');
    return null;
  }

  const deadline = Math.min(Date.now() + TIER_BUDGET_MS, requestDeadline());
  const tried = new Set<string>();
  let geo: GeoRestriction | undefined;
  let geoLookup: Promise<void> | undefined;
  let best: ResolveMeta | null = null;
  // Startup and an exhausted pool can need an on-demand list refresh. When
  // that finds no usable exit, EXTRACTION_DIRECT_FALLBACK may still resolve
  // non-geo videos without a proxy.
  if (!websharePool.getAllCandidates().length && !await websharePool.getProxy()) {
    if (!directFallbackEnabled()) {
      log.error('[YTJS] No Webshare proxy is available for YouTube extraction');
      return null;
    }
    log.warning('[YTJS] Webshare pool empty — trying direct extraction fallback');
    const yt = await getDirectInnertube().catch((e) => {
      log.warning(`[YTJS] Direct extraction fallback failed: ${String(e)}`);
      return null;
    });
    if (!yt) return null;
    const result = await attemptResolveWithProxiedInnertube(vid, null, yt, deadline, isCurrent, meta => isUsable(mergeStreamMeta(best, meta)), onComplete);
    return result.meta;
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
      const yt = await getProxiedInnertube(proxy.url);
      const result = await attemptResolveWithProxiedInnertube(vid, proxy.url, yt, deadline, isCurrent, meta => isUsable(mergeStreamMeta(best, meta)), onComplete);
      requestSignal()?.throwIfAborted();
      if (result.meta) {
        websharePool.markOk(proxy.id, proxy.url);
        log.info(`[YTJS] ✅ ${vid} resolved via Webshare proxy (youtubei.js)`);
        if (isUsable(mergeStreamMeta(best, result.meta))) return result.meta;
      } else if (result.failure === 'proxy') {
        PROXIED_INNERTUBE_POOL.delete(proxy.url);
        websharePool.markBad(proxy.id, proxy.url);
      } else if (result.failure === 'content') {
        websharePool.markReachable(proxy.id, proxy.url);
      }
      // Discover region restrictions from proxied player responses. The first
      // observation steers later batches; parallel exits share the API lookup.
      if (result.geo && !geoLookup) {
        geo = result.geo;
        const observed = result.geo;
        geoLookup = (async () => {
          const official = await fetchRegionRestriction(vid).catch(() => null);
          requestSignal()?.throwIfAborted();
          geo = {
            allowed: [...new Set([...observed.allowed, ...(official?.allowed ?? [])])],
            blocked: official?.blocked ?? [],
          };
          log.info(`[YTJS] ${vid} Webshare geo target [${geo.allowed.join(',') || 'any'}], avoid [${geo.blocked.join(',') || 'none'}]`);
        })();
      }
      if (geoLookup) await geoLookup;
      return result.meta;
    } catch (e) {
      if (requestSignal()?.aborted) return null;
      log.warning(`[YTJS] proxied innertube attempt failed: ${String(e)}`);
      if (playerExceptionFailure(e) === 'proxy') {
        PROXIED_INNERTUBE_POOL.delete(proxy.url);
        websharePool.markBad(proxy.id, proxy.url);
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

    let untried = candidates.filter((p) => !tried.has(p.id) && p.url !== excludeProxyUrl);
    if (!untried.length) {
      const all = websharePool.getAllCandidates().filter((p) => !tried.has(p.id) && p.url !== excludeProxyUrl);
      if (!all.length) break;
      untried = all.slice(0, PROXY_CANDIDATES);
    }
    for (const p of untried) tried.add(p.id);

    const warm = untried.filter((c) => isProxiedInnertubeWarm(c.url));
    const cold = untried.filter((c) => !isProxiedInnertubeWarm(c.url));
    for (const group of [warm, cold]) {
      if (!group.length || Date.now() >= deadline) continue;
      const meta = await raceUsable(group.map((p) => attempt(p)), meta => isUsable(mergeStreamMeta(best, meta)));
      if (meta) best = mergeStreamMeta(best, meta);
      if (best && isUsable(best)) return best;
    }
  }

  return best;
}

export async function resolveBothWithMeta(
  urlOrId: string,
  kind: 'audio' | 'muxed' = 'audio',
  options: ResolveOptions = {},
): Promise<ResolveMeta> {
  return withRequestDeadline(42_000, 'stream resolution', () => resolveBothWithinDeadline(urlOrId, kind, options));
}

async function resolveBothWithinDeadline(
  urlOrId: string,
  kind: 'audio' | 'muxed',
  options: ResolveOptions,
): Promise<ResolveMeta> {
  const vid = extractId(urlOrId);
  if (!vid) return { urls: [null, null], proxyUrl: null };

  const cached = options.forceProxy || options.excludeProxyUrl ? undefined : RESOLVED_STREAM_CACHE.get(vid);
  if (cached?.urls[kind === 'audio' ? 1 : 0]) return cached;

  const key = JSON.stringify([vid, !!options.forceProxy, options.excludeProxyUrl ?? null]);
  let task = ACTIVE_STREAM_RESOLVES.get(key);
  if (!task) {
    const controller = new AbortController();
    const current: StreamResolveTask = {
      vid, controller, invalidated: false, kinds: new Map(), completedKinds: new Set([kind]), waiters: 0, settled: false,
      promise: Promise.resolve({ urls: [null, null], proxyUrl: null }),
    };
    ACTIVE_STREAM_RESOLVES.set(key, current);
    current.promise = withIndependentRequestDeadline(42_000, 'shared stream resolution', controller.signal, async () => {
      const isCurrent = () => ACTIVE_STREAM_RESOLVES.get(key) === current && !current.invalidated && !requestSignal()?.aborted && current.waiters > 0;
      const isUsable = (meta: ResolveMeta) => [...current.kinds.keys()].every(requested => !!meta.urls[requested === 'audio' ? 1 : 0]);
      const resolved = await resolveViaProxyTier(vid, options.excludeProxyUrl, isCurrent, meta => isUsable(mergeStreamMeta(cached, meta)), () => {
        for (const requested of current.kinds.keys()) current.completedKinds.add(requested);
      });
      const result = mergeStreamMeta(cached, resolved ?? { urls: [null, null], proxyUrl: null });
      requestSignal()?.throwIfAborted();
      // Only verified direct sources enter this memo; the extracting session is Webshare.
      if (isCurrent() && !result.proxyUrl && !result.streamTypes?.some(Boolean) && (result.urls[0] || result.urls[1])) RESOLVED_STREAM_CACHE.set(vid, result);
      return result;
    }).finally(() => {
      current.settled = true;
      if (ACTIVE_STREAM_RESOLVES.get(key) === current) ACTIVE_STREAM_RESOLVES.delete(key);
    });
    task = current;
  }
  const current = task;
  current.kinds.set(kind, (current.kinds.get(kind) ?? 0) + 1);
  try {
    const result = await subscribe(current, () => {
      if (ACTIVE_STREAM_RESOLVES.get(key) === current) ACTIVE_STREAM_RESOLVES.delete(key);
    });
    // A subscriber can arrive after a different mode's final player selection.
    if (!result.urls[kind === 'audio' ? 1 : 0] && !current.completedKinds.has(kind) && result.urls.some(Boolean)) {
      return resolveBothWithinDeadline(urlOrId, kind, options);
    }
    return result;
  } catch (error) {
    requestSignal()?.throwIfAborted();
    if (current.invalidated) return resolveBothWithinDeadline(urlOrId, kind, options);
    throw error;
  } finally {
    const remaining = (current.kinds.get(kind) ?? 1) - 1;
    if (remaining) current.kinds.set(kind, remaining);
    else current.kinds.delete(kind);
  }
}

export async function resolveBoth(
  urlOrId: string,
): Promise<[string | null, string | null]> {
  return (await resolveBothWithMeta(urlOrId)).urls;
}

/** Like `resolve`, but also reports the verified playback route for this format. */
export async function resolveWithMeta(
  urlOrId: string,
  kind: 'audio' | 'muxed',
  options: ResolveOptions = {},
): Promise<{ url: string | null; proxyUrl: string | null; streamType?: 'hls' }> {
  const vid = extractId(urlOrId);
  if (!vid) return { url: null, proxyUrl: null };
  const meta = await resolveBothWithMeta(urlOrId, kind, options);
  const index = kind === 'audio' ? 1 : 0;
  return { url: meta.urls[index], proxyUrl: formatProxy(meta, index),
    ...(meta.streamTypes?.[index] ? { streamType: meta.streamTypes[index]! } : {}),
  };
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

const RELATED_CACHE = new BoundedCache<RelatedItem[]>(2048, 300);
const RELATED_REQUESTS = new BoundedCache<Promise<RelatedItem[]>>(2048);

export async function related(urlOrId: string, limit = 5): Promise<RelatedItem[]> {
  const vid = extractId(urlOrId);
  if (!vid) return [];

  const select = (items: RelatedItem[]) => items.slice(0, limit).map(item => ({ ...item }));
  const cached = RELATED_CACHE.get(vid);
  if (cached) return select(cached);
  let pending = RELATED_REQUESTS.get(vid);
  if (!pending) {
    pending = fetchRelated(vid).then(items => {
      // Keep the whole list so a small request cannot truncate later callers.
      if (items.length) RELATED_CACHE.set(vid, items);
      return items;
    });
    RELATED_REQUESTS.set(vid, pending);
  }
  try {
    return select(await pending);
  } finally {
    if (RELATED_REQUESTS.get(vid) === pending) RELATED_REQUESTS.delete(vid);
  }
}

async function fetchRelated(vid: string): Promise<RelatedItem[]> {
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
    }
    return items;
  } catch (e) {
    log.warning(`[YTJS] next endpoint failed for ${vid}`, { err: String(e) });
    return [];
  }
}
