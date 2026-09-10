/**
 * Optional official YouTube Data API path — port of utils/youtube_api.py.
 *
 * When no API keys are configured, GetVideoById() uses the Innertube fast path
 * and falls back to `yt-dlp -j`, so the endpoint works without any Google key.
 */
import { config } from './config.js';
import { metadata } from './innertube.js';
import { fetchJson } from './ytdlp.js';
import { formatInd, formatSeconds, parseDur, processVideo, extractArtist } from './formatters.js';
import type { ProcessedVideo } from './formatters.js';
import { getLogger } from './logger.js';

const log = getLogger('ytube_api.youtube_api');

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const DETAILS_URL = 'https://www.googleapis.com/youtube/v3/videos';

export interface VideoInfo {
  title?: string;
  url?: string;
  artist_name?: string;
  channel_name?: string;
  views?: string;
  duration?: string;
  thumbnail?: string;
  video_id?: string;
}

export function getAvailableKeys(): string[] {
  return config()
    .YOUTUBE_API_KEYS.split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

export function getRandomKey(): string {
  const keys = getAvailableKeys();
  if (!keys.length) throw new Error('YouTube API key not configured');
  return keys[Math.floor(Math.random() * keys.length)]!;
}

async function getJson(url: string, params: Record<string, string>): Promise<any | null> {
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${url}?${qs}`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchResults(query: string, limit = 1): Promise<ProcessedVideo[]> {
  if (!getAvailableKeys().length) return [];

  const search = await getJson(SEARCH_URL, {
    part: 'snippet',
    q: query,
    maxResults: String(limit),
    type: 'video',
    key: getRandomKey(),
  });
  if (!search) return [];

  const items: any[] = search.items ?? [];
  const videoIds = items
    .map((i) => i?.id?.videoId)
    .filter((id): id is string => Boolean(id));
  if (!videoIds.length) return [];

  const details = await getJson(DETAILS_URL, {
    part: 'contentDetails,statistics',
    id: videoIds.join(','),
    key: getRandomKey(),
  });
  if (!details) return [];

  const detailMap = new Map<string, any>();
  for (const v of details.items ?? []) detailMap.set(v.id, v);

  const results: ProcessedVideo[] = [];
  for (const item of items) {
    const videoId = item?.id?.videoId;
    if (!videoId) continue;
    const d = detailMap.get(videoId);
    if (!d) continue;
    const info = processVideo(item, d);
    if (info) results.push(info);
  }
  return results;
}

export async function getVideoById(videoId: string): Promise<VideoInfo> {
  if (!getAvailableKeys().length) {
    // Innertube first (~0.15s, no key needed).
    try {
      const info = await metadata(videoId);
      if (info) return info;
    } catch {
      /* fall back */
    }
    // Fallback: yt-dlp -j.
    try {
      const info = await fetchJson(videoId, 40);
      if (!info) return {};
      const title: string = info.title ?? '';
      const uploader: string = info.uploader ?? '';
      const durationSec: number = info.duration ?? 0;
      const views: number = info.view_count ?? 0;
      const thumbnail: string = info.thumbnail ?? '';
      return {
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        artist_name: extractArtist(title) || uploader,
        channel_name: uploader,
        views: formatInd(views),
        duration: formatSeconds(durationSec),
        thumbnail,
        video_id: videoId,
      };
    } catch (e) {
      log.warning(`[YOUTUBE_API] yt-dlp metadata failed for ${videoId}`, { err: String(e) });
      return {};
    }
  }

  const res = await getJson(DETAILS_URL, {
    part: 'snippet,contentDetails,statistics',
    id: videoId,
    key: getRandomKey(),
  });
  if (!res) return {};
  const items: any[] = res.items ?? [];
  if (!items.length) return {};

  const item = items[0];
  const snippet = item.snippet ?? {};
  const title: string = snippet.title ?? '';
  const channel: string = snippet.channelTitle ?? '';
  const thumbnail: string = snippet.thumbnails?.high?.url ?? '';
  const duration: string = item.contentDetails?.duration ?? 'N/A';
  const views: string = item.statistics?.viewCount ?? '0';
  return {
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    artist_name: extractArtist(title) || channel,
    channel_name: channel,
    views: formatInd(views),
    duration: parseDur(duration),
    thumbnail,
    video_id: videoId,
  };
}
