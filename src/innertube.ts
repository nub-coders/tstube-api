/**
 * Fast YouTube resolver powered by youtubei.js (ytjs).
 * Primary stream resolver; yt-dlp is the fallback.
 */
import { Innertube, Platform, Parser, Helpers } from 'youtubei.js';
import { readFileSync, existsSync } from 'node:fs';
import { extractArtist, formatInd } from './formatters.js';
import { getLogger } from './logger.js';
import { config } from './config.js';
import { onCookiesUpdated } from './cookies.js';
import { BoundedCache } from './boundedCache.js';
import { cookiePool } from './cookiePool.js';

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

/**
 * Parse cookies from any format:
 * - Netscape tab-separated text (cookies.txt format)
 * - Semicolon-separated HTTP cookie header ('SID=xxx; HSID=yyy')
 * - Line-separated 'key=value' pairs
 * - Base64 encoded version of any of the above
 *
 * Returns null if the result does not contain authenticated YouTube session
 * cookies (SAPISID, __Secure-1PSID, __Secure-3PSID, LOGIN_INFO, or SID).
 * Only authenticated cookies are accepted.
 */
export function parseCookies(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;
  let text = input.trim();
  if (!text) return null;

  // Handle base64 encoded input
  if (!text.includes('\t') && !text.includes('\n') && /^[A-Za-z0-9+/=]+$/.test(text) && text.length > 50) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.includes('=') || decoded.includes('\t')) {
        text = decoded.trim();
      }
    } catch {
      /* not base64 */
    }
  }

  let result: string | null = null;

  // Netscape tab-separated format
  if (text.includes('\t')) {
    const cookies: string[] = [];
    const seen = new Set<string>();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) {
        const domain = parts[0]!.trim().toLowerCase();
        if (domain !== '.youtube.com' && domain !== 'youtube.com' && !domain.endsWith('.youtube.com')) {
          continue;
        }
        const name = parts[5]!.trim();
        const value = parts[6]!.trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          cookies.push(`${name}=${value}`);
        }
      }
    }
    result = cookies.length ? cookies.join('; ') : null;
  } else if (text.includes('=')) {
    // Semicolon or newline-separated key=value pairs
    const items = text
      .split(/[;\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s && s.includes('=') && !s.startsWith('#'));
    result = items.length ? items.join('; ') : null;
  }

  if (!result) return null;

  // Only accept authenticated cookies — must contain at least one YouTube session token
  if (!isAuthenticatedCookieString(result)) {
    log.warning('[YTJS] Rejecting unauthenticated cookie string (no session tokens found)');
    return null;
  }

  return result;
}

/**
 * Returns true if the given semicolon-separated cookie string contains at least
 * one recognised YouTube authentication token that indicates a logged-in session.
 *
 * Recognised tokens: SAPISID, __Secure-1PSID, __Secure-3PSID, LOGIN_INFO, SID
 */
export function isAuthenticatedCookieString(cookieStr: string): boolean {
  // Match cookie name at start of string or after "; "
  return /(?:^|;\s*)(?:SAPISID|__Secure-1PSID|__Secure-3PSID|LOGIN_INFO|SID)=/i.test(cookieStr);
}

/**
 * Strip non-YouTube domains from Netscape cookie format.
 * Guarantees that accounts.google.com and external domains are discarded.
 */
export function sanitizeNetscapeCookies(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = ['# Netscape HTTP Cookie File'];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) {
      const domain = parts[0]!.trim().toLowerCase();
      if (domain === '.youtube.com' || domain === 'youtube.com' || domain.endsWith('.youtube.com')) {
        out.push(line);
      }
    }
  }
  return out.join('\n');
}

/**
 * Check if critical YouTube session cookies in a Netscape jar have expired by timestamp.
 */
export function isCookieExpired(text: string): { expired: boolean; reason?: string; expiresAt?: Date } {
  if (!text || !text.includes('\t')) return { expired: false };

  const nowSec = Math.floor(Date.now() / 1000);
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) {
      const name = parts[5]!.trim();
      const exp = Number(parts[4]);
      // Check YouTube session and authentication cookies
      if (/^(SAPISID|LOGIN_INFO|__Secure-[13]PSID|SID)$/i.test(name)) {
        if (!Number.isNaN(exp) && exp > 0 && exp < nowSec) {
          const expiresAt = new Date(exp * 1000);
          return {
            expired: true,
            reason: `Cookie "${name}" expired on ${expiresAt.toISOString()}`,
            expiresAt,
          };
        }
      }
    }
  }

  return { expired: false };
}

export function parseCookieFile(path: string): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return parseCookies(readFileSync(path, 'utf8'));
  } catch (e) {
    log.warning(`[YTJS] Failed reading cookies from ${path}`, { err: String(e) });
    return null;
  }
}

let ytPromise: Promise<Innertube> | null = null;

onCookiesUpdated(() => {
  log.info('[YTJS] Resetting Innertube instance due to updated cookies');
  ytPromise = null;
});

export function resetInnertube(): void {
  ytPromise = null;
}

const INNERTUBE_POOL = new BoundedCache<Innertube>(100, 3600);

export async function getInnertube(customCookies?: string | null): Promise<Innertube> {
  if (customCookies) {
    const cookieStr = parseCookies(customCookies);
    if (!cookieStr) {
      return getInnertube();
    }
    const cached = INNERTUBE_POOL.get(cookieStr);
    if (cached) return cached;

    const instance = await Innertube.create({ cookie: cookieStr });
    INNERTUBE_POOL.set(cookieStr, instance);
    return instance;
  }

  if (!ytPromise) {
    ytPromise = (async () => {
      let cookieStr: string | null = null;
      try {
        let text: string | null | undefined;
        let cPath: string | undefined;
        try {
          const cfg = config();
          text = cfg.COOKIES_TEXT;
          cPath = cfg.COOKIES_FILE;
        } catch {
          text = process.env.COOKIES_TEXT || process.env.YOUTUBE_COOKIES || process.env.COOKIES;
          cPath = process.env.COOKIES_FILE || 'cookies.txt';
        }

        if (text) {
          cookieStr = parseCookies(text);
          if (cookieStr) log.info('[YTJS] Loaded cookies from COOKIES_TEXT environment variable');
        }
        if (!cookieStr && cPath) {
          cookieStr = parseCookieFile(cPath);
          if (cookieStr) log.info(`[YTJS] Loaded cookies from ${cPath}`);
        }
      } catch {
        /* ignore if config() not yet loaded */
      }

      const instance = await Innertube.create({
        ...(cookieStr ? { cookie: cookieStr } : {}),
      });
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

const RESOLVED_STREAM_CACHE = new BoundedCache<[string | null, string | null]>(2048, 1800);

async function fetchInfo(vid: string, cookies?: string | null): Promise<any | null> {
  const cacheKey = cookies ? `${vid}:${cookies.slice(0, 32)}` : vid;
  const cached = INFO_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const yt = await getInnertube(cookies);
  // Working client ladder for metadata
  for (const client of ['TV_SIMPLY', 'MWEB', 'ANDROID', 'WEB', 'IOS'] as const) {
    try {
      const info = await yt.getBasicInfo(vid, { client });
      if (info.basic_info?.title || info.playability_status?.status === 'OK') {
        INFO_CACHE.set(cacheKey, info);
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
}

async function attemptResolveWithCookie(
  vid: string,
  cookies?: string | null,
): Promise<ResolveAttempt> {
  let yt: Innertube;
  try {
    yt = await getInnertube(cookies);
  } catch (e) {
    log.warning(`[YTJS] Failed initializing Innertube for cookie: ${String(e)}`);
    return { urls: [null, null], lastError: `Innertube init failed: ${String(e)}` };
  }

  const clients = ['TV_SIMPLY', 'MWEB', 'IOS', 'WEB', 'ANDROID'] as const;
  let lastError = 'No stream formats returned';

  for (const client of clients) {
    try {
      const info = await yt.getBasicInfo(vid, { client });
      if (info.playability_status?.status !== 'OK') {
        const st = info.playability_status?.status || 'STATUS_NOT_OK';
        const reason = info.playability_status?.reason || '';
        lastError = `${st}: ${reason}`.trim();
        continue;
      }

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

      if (muxedUrl || audioUrl) {
        INFO_CACHE.set(vid, info);
        return { urls: [muxedUrl, audioUrl] };
      }
    } catch (e) {
      lastError = `${client} error: ${String(e)}`;
      log.warning(`[YTJS] ${vid} ${client} resolution failed: ${String(e)}`);
    }
  }

  return { urls: [null, null], lastError };
}

export async function resolveBoth(
  urlOrId: string,
  cookies?: string | null,
): Promise<[string | null, string | null]> {
  const vid = extractId(urlOrId);
  if (!vid) return [null, null];

  if (!cookies) {
    const cached = RESOLVED_STREAM_CACHE.get(vid);
    if (cached) return cached;
  }

  // If specific cookies were explicitly passed, use them directly
  if (cookies) {
    const attempt = await attemptResolveWithCookie(vid, cookies);
    return attempt.urls;
  }

  // If the dynamic MongoDB cookie pool has active accounts, rotate with failover
  if (cookiePool.size > 0) {
    const active = cookiePool.getAllActive();
    const primary = cookiePool.nextCookie();
    const candidates = primary
      ? [primary, ...active.filter((c) => c.id !== primary.id)]
      : active;

    for (const item of candidates) {
      const attempt = await attemptResolveWithCookie(vid, item.cookieString);
      if (attempt.urls[0] || attempt.urls[1]) {
        void cookiePool.reportSuccess(item.id);
        RESOLVED_STREAM_CACHE.set(vid, attempt.urls);
        return attempt.urls;
      } else {
        void cookiePool.reportFailure(item.id, attempt.lastError || 'No stream formats returned');
      }
    }
  }

  // Fallback to default instance (COOKIES_TEXT / COOKIES_FILE / anonymous)
  const defaultAttempt = await attemptResolveWithCookie(vid, null);
  if (defaultAttempt.urls[0] || defaultAttempt.urls[1]) {
    RESOLVED_STREAM_CACHE.set(vid, defaultAttempt.urls);
  }
  return defaultAttempt.urls;
}

export async function resolve(
  urlOrId: string,
  kind: 'audio' | 'muxed',
  cookies?: string | null,
): Promise<string | null> {
  const [muxed, audio] = await resolveBoth(urlOrId, cookies);
  return kind === 'audio' ? audio : muxed;
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
