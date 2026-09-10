/**
 * Fast YouTube resolver powered by youtubei.js (ytjs).
 * Primary stream resolver; yt-dlp is the fallback.
 */
import { Innertube } from 'youtubei.js';
import { readFileSync, existsSync } from 'node:fs';
import { extractArtist, formatInd } from './formatters.js';
import { getLogger } from './logger.js';
import { config } from './config.js';

const log = getLogger('ytube_api.innertube');

const ID_RE = /(?:v=|\/shorts\/|youtu\.be\/|\/embed\/|\/v\/|\/live\/)([A-Za-z0-9_-]{11})/;
const BARE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

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

function parseCookieFile(path: string): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const cookies: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) {
        cookies.push(`${parts[5]}=${parts[6]!.trim()}`);
      }
    }
    return cookies.length ? cookies.join('; ') : null;
  } catch (e) {
    log.warning(`[YTJS] Failed reading cookies from ${path}`, { err: String(e) });
    return null;
  }
}

let ytPromise: Promise<Innertube> | null = null;

export async function getInnertube(): Promise<Innertube> {
  if (!ytPromise) {
    ytPromise = (async () => {
      let cookieStr: string | null = null;
      try {
        let cPath: string | undefined;
        try {
          cPath = config().COOKIES_FILE;
        } catch {
          cPath = process.env.COOKIES_FILE || 'cookies.txt';
        }
        if (cPath) cookieStr = parseCookieFile(cPath);
      } catch {
        /* ignore if config() not yet loaded */
      }

      const instance = await Innertube.create({
        retrieve_player: false,
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

async function fetchInfo(vid: string): Promise<any | null> {
  const yt = await getInnertube();
  // Client ladder: ANDROID_VR first (fastest, plain URLs), then ANDROID
  for (const client of ['ANDROID_VR', 'ANDROID'] as const) {
    try {
      const info = await yt.getBasicInfo(vid, { client });
      if (info.playability_status?.status === 'OK') {
        return info;
      }
      log.info(`[YTJS] ${vid} ${client} playability status: ${info.playability_status?.status} (${info.playability_status?.reason || 'no reason'})`);
    } catch (e) {
      log.warning(`[YTJS] ${vid} ${client} failed: ${String(e)}`);
    }
  }
  return null;
}

export async function resolveBoth(
  urlOrId: string,
): Promise<[string | null, string | null]> {
  const vid = extractId(urlOrId);
  if (!vid) return [null, null];

  const info = await fetchInfo(vid);
  if (!info) return [null, null];

  let muxedUrl: string | null = null;
  let audioUrl: string | null = null;

  try {
    const f = info.chooseFormat({ type: 'video+audio', quality: 'best', format: 'any' });
    if (f?.url) muxedUrl = f.url;
  } catch {
    /* ignore */
  }

  try {
    const f = info.chooseFormat({ type: 'audio', quality: 'best' });
    if (f?.url) audioUrl = f.url;
  } catch {
    /* ignore */
  }

  const sd: InnertubeStreamingData = info.streaming_data ?? {};
  if (!muxedUrl) muxedUrl = pickMuxed(sd);
  if (!audioUrl) audioUrl = pickAudio(sd);

  return [muxedUrl, audioUrl];
}

export async function resolve(urlOrId: string, kind: 'audio' | 'muxed'): Promise<string | null> {
  const [muxed, audio] = await resolveBoth(urlOrId);
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
