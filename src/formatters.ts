/**
 * Display formatters — port of utils/helpers.py + utils/formatters.py.
 *
 * Number formatting is deliberately Indian-style (Crore/Lakh/K) because the
 * original API surfaces it that way.
 */
import { getLogger } from './logger.js';

const log = getLogger('ytube_api.formatters');

const DUR_RE = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;

export function parseDur(duration: string | null | undefined): string {
  const m = DUR_RE.exec(duration ?? '');
  if (!m) return 'N/A';
  const h = Number.parseInt(m[1] ?? '0', 10);
  const min = Number.parseInt(m[2] ?? '0', 10);
  const s = Number.parseInt(m[3] ?? '0', 10);
  if (h) return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${min}:${String(s).padStart(2, '0')}`;
}

export const formatDur = parseDur;

export function formatInd(n: unknown): string {
  const num = typeof n === 'number' ? n : Number.parseFloat(String(n));
  if (Number.isNaN(num)) return '0';
  if (num >= 1e7) return `${(num / 1e7).toFixed(1)} Crore`;
  if (num >= 1e5) return `${(num / 1e5).toFixed(1)} Lakh`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return String(Math.trunc(num));
}

export const format = formatInd;

/** Python-style "M"/"K" suffix expansion then Indian grouping. */
export function formatViews(viewsStr: string | null | undefined): string {
  if (!viewsStr) return 'N/A';
  const cleaned = viewsStr.replace(/\D/g, '');
  if (!cleaned) return 'N/A';
  let value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) return 'N/A';
  if (viewsStr.includes('M')) value *= 1e6;
  else if (viewsStr.includes('K')) value *= 1e3;
  return formatInd(value);
}

export function extractArtist(title: string): string {
  const idx = title.indexOf('-');
  if (idx >= 0) {
    const name = title.slice(0, idx).trim();
    if (name) return name;
  }
  return 'Unknown Artist';
}

export interface DataApiSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    thumbnails?: { high?: { url?: string } };
  };
}

export interface DataApiDetails {
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
}

export interface ProcessedVideo {
  title: string;
  video_id: string;
  url: string;
  time: string;
  duration: string;
  artist_name: string;
  channel_name: string;
  views: string;
  thumbnail: string;
}

export function processVideo(
  item: DataApiSearchItem,
  details: DataApiDetails,
): ProcessedVideo | null {
  try {
    const videoId = item.id?.videoId;
    if (!videoId) return null;
    const snippet = item.snippet ?? {};
    const title = snippet.title ?? '';
    const channel = snippet.channelTitle ?? '';
    const thumbnail = snippet.thumbnails?.high?.url ?? '';
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const duration = details.contentDetails?.duration ?? 'N/A';
    const views = details.statistics?.viewCount ?? '0';
    const artist = extractArtist(title) || channel;
    return {
      title,
      video_id: videoId,
      url,
      time: formatDur(duration),
      duration: formatDur(duration),
      artist_name: artist,
      channel_name: channel,
      views: format(views),
      thumbnail,
    };
  } catch (e) {
    log.debug('process_video failed', { err: String(e) });
    return null;
  }
}

/** Seconds -> h:mm:ss / m:ss (used by the yt-dlp metadata fallback). */
export function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
