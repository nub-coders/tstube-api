/**
 * Optional official YouTube Data API path — port of utils/youtube_api.py.
 *
 * When no API keys are configured, GetVideoById() uses the Innertube fast path
 * and falls back to `yt-dlp -j`, so the endpoint works without any Google key.
 */
import { config } from './config.js';
import { nextUtcMidnightEpoch } from './quota.js';
import { metadata } from './innertube.js';
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

// ── Key health ──────────────────────────────────────────────────
// Quota is per project (one key per project) and Google resets it at midnight
// US Pacific; a quota-dead key is skipped until UTC midnight, matching the
// app-wide reset convention. Reviving early costs one failed probe, after
// which the key is re-marked — never more than one wasted call per key per day.

const QUOTA_DEAD_UNTIL = new Map<string, number>();
const REMOVED_KEYS = new Set<string>();

function keyTag(key: string): string {
  return key.slice(0, 8) + '…' + key.slice(-4);
}

function liveKeys(now = Date.now()): string[] {
  return getAvailableKeys().filter(
    (k) => !REMOVED_KEYS.has(k) && (QUOTA_DEAD_UNTIL.get(k) ?? 0) <= now,
  );
}

function pickLiveKey(exclude: Set<string>): string | null {
  const candidates = liveKeys().filter((k) => !exclude.has(k));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

/**
 * Classify a Data API error as a key-level failure: quota exhaustion cools the
 * key off for the rest of the day; an invalid key or a project without the API
 * enabled is removed outright. Everything else (network, 5xx, bad request
 * shape) is transient and must not touch key state.
 */
export function classifyKeyFailure(reason: string, message: string): 'quota-day' | 'removed' | null {
  if (/^(quotaExceeded|dailyLimitExceeded)$/.test(reason)) return 'quota-day';
  if (/^(keyInvalid|accessNotConfigured)$/.test(reason) || /api key not valid/i.test(message)) {
    return 'removed';
  }
  return null;
}

function markKeyFailure(key: string, reason: string, message: string): void {
  const kind = classifyKeyFailure(reason, message);
  if (kind === 'quota-day') {
    QUOTA_DEAD_UNTIL.set(key, nextUtcMidnightEpoch() * 1000);
    log.warning(`[YOUTUBE_API] key ${keyTag(key)} quota-dead until UTC midnight (${reason})`);
  } else if (kind === 'removed') {
    REMOVED_KEYS.add(key);
    log.error(`[YOUTUBE_API] key ${keyTag(key)} removed from rotation (${reason || message})`);
  }
}

interface ApiResponse {
  ok: boolean;
  status: number;
  body: any;
}

async function callGoogleApi(url: string, params: Record<string, string>): Promise<ApiResponse> {
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${url}?${qs}`, { signal: controller.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a Data API endpoint with a healthy key picked per call. Key-level
 * failures (quota, invalid key) mark the key and retry through the next live
 * one, so a burnt project costs at most one wasted call before traffic routes
 * around it. Transient failures return null without touching key state —
 * same silent-empty contract as before, minus the dead-key poison.
 */
async function getJson(url: string, params: Record<string, string>): Promise<any | null> {
  const tried = new Set<string>();
  for (;;) {
    const key = pickLiveKey(tried);
    if (!key) return null;
    tried.add(key);
    const res = await callGoogleApi(url, { ...params, key });
    if (res.ok) return res.body;
    if (res.status === 0) return null; // network / timeout — not a key problem
    const errors: any[] = res.body?.error?.errors ?? [];
    const reason = String(errors[0]?.reason ?? '');
    const message = String(res.body?.error?.message ?? '');
    if (classifyKeyFailure(reason, message)) {
      markKeyFailure(key, reason, message);
      continue;
    }
    return null;
  }
}

export async function fetchResults(query: string, limit = 1): Promise<ProcessedVideo[]> {
  if (!getAvailableKeys().length) return [];

  const search = await getJson(SEARCH_URL, {
    part: 'snippet',
    q: query,
    maxResults: String(limit),
    type: 'video',
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

export interface RegionRestriction {
  /** Playable ONLY in these countries (whitelist). */
  allowed?: string[];
  /** Playable everywhere EXCEPT these countries (blacklist). */
  blocked?: string[];
}

function cleanCodes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const codes = value
    .filter((c): c is string => typeof c === 'string' && /^[A-Za-z]{2}$/.test(c))
    .map((c) => c.toUpperCase());
  return codes.length ? codes : undefined;
}

/**
 * Official region restriction for a video (videos.list, contentDetails part —
 * 1 quota unit). The authoritative geo-block source when API keys exist:
 * `regionRestriction.allowed` whitelists playable countries, `blocked`
 * blacklists them. null when no keys are configured or the video is
 * unrestricted.
 */
export async function fetchRegionRestriction(videoId: string): Promise<RegionRestriction | null> {
  if (!getAvailableKeys().length) return null;
  const res = await getJson(DETAILS_URL, {
    part: 'contentDetails',
    id: videoId,
  });
  const rr = res?.items?.[0]?.contentDetails?.regionRestriction;
  if (!rr) return null;
  const allowed = cleanCodes(rr.allowed);
  const blocked = cleanCodes(rr.blocked);
  return allowed || blocked ? { allowed, blocked } : null;
}

export async function getVideoById(videoId: string): Promise<VideoInfo> {  if (!getAvailableKeys().length) {
    try {
      const info = await metadata(videoId);
      if (info) return info;
    } catch (e) {
      log.warning(`[YOUTUBE_API] Innertube metadata failed for ${videoId}`, { err: String(e) });
    }
    return {};
  }

  const res = await getJson(DETAILS_URL, {
    part: 'snippet,contentDetails,statistics',
    id: videoId,
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
