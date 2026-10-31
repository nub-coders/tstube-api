/**
 * Playlist parser — port of utils/playlist_parser.py.
 *
 * Supports normal playlists (PL...), auto-generated (OL..., UU...) and YouTube
 * Mix (RD...) playlists by scraping the public playlist/watch page.
 */
import { getLogger } from './logger.js';
import { HttpError } from './httpError.js';
import { boundedFetch, requestSignal, withRequestDeadline } from './requestDeadline.js';

const log = getLogger('ytube_api.playlist');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export interface PlaylistSong {
  videoId: string;
  title: string;
  channel: string;
  duration: string | number;
  url: string;
  thumbnail: string;
}

/** Mirrors Python's ValueError, which main.py maps to a 400 (other errors 500). */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

export function extractPlaylistId(value: string): string {
  const v = value.trim();
  if (v.startsWith('PL') || v.startsWith('OL') || v.startsWith('UU') || v.startsWith('RD')) {
    return v;
  }
  let pid: string | null = null;
  try {
    pid = new URL(v).searchParams.get('list');
  } catch {
    pid = null;
  }
  if (!pid) throw new ValueError('Invalid playlist link or ID');
  return pid;
}

export function extractVideoId(value: string): string | null {
  try {
    return new URL(value).searchParams.get('v');
  } catch {
    return null;
  }
}

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await boundedFetch(globalThis.fetch, 20_000)(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function extractYtInitialData(html: string): any {
  const m = /ytInitialData\s*=\s*({.*?});\s*<\/script>/s.exec(html);
  if (!m) throw new ValueError('Unable to extract ytInitialData');
  try {
    return JSON.parse(m[1]!);
  } catch {
    // Python's json.JSONDecodeError is a ValueError subclass.
    throw new ValueError('Unable to parse ytInitialData');
  }
}

function getText(obj: any): string {
  if (!obj) return '';
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map((r: any) => r.text ?? '').join('');
  return '';
}

function makeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
}

function song(r: any): PlaylistSong | null {
  const vid = r?.videoId;
  if (!vid) return null;
  return {
    videoId: vid,
    title: getText(r.title),
    channel: getText(r.shortBylineText),
    duration: r.lengthSeconds ?? 'N/A',
    url: `https://music.youtube.com/watch?v=${vid}`,
    thumbnail: makeThumbnail(vid),
  };
}

function normalPlaylistItems(data: any): any[] {
  const result: any[] = [];
  const tabs: any[] = data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  for (const tab of tabs) {
    const content = tab?.tabRenderer?.content;
    if (!content) continue;
    const sections: any[] = content?.sectionListRenderer?.contents ?? [];
    for (const section of sections) {
      const items: any[] = section?.itemSectionRenderer?.contents ?? [];
      for (const item of items) {
        const videos: any[] = item?.playlistVideoListRenderer?.contents ?? [];
        result.push(...videos);
      }
    }
  }
  return result;
}

function continuationItems(data: any): { items: any[]; next?: string } {
  const items: any[] = [];
  for (const action of [...(data?.onResponseReceivedActions ?? []), ...(data?.onResponseReceivedEndpoints ?? [])]) {
    items.push(...(action?.appendContinuationItemsAction?.continuationItems ?? action?.reloadContinuationItemsCommand?.continuationItems ?? []));
  }
  const page = data?.continuationContents?.playlistVideoListContinuation;
  if (page) items.push(...(page.contents ?? []));
  return { items, next: page?.continuations?.[0]?.nextContinuationData?.continuation };
}

function continuationContext(html: string): Record<string, any> {
  const cfg: Record<string, any> = {};
  for (const match of html.matchAll(/ytcfg\.set\((\{.*?\})\);/gs)) {
    try { Object.assign(cfg, JSON.parse(match[1])); } catch { /* unrelated config block */ }
  }
  const context = cfg.INNERTUBE_CONTEXT;
  if (context?.client?.clientVersion) return context;
  if (typeof cfg.INNERTUBE_CLIENT_VERSION === 'string') {
    return { client: { clientName: 'WEB', clientVersion: cfg.INNERTUBE_CLIENT_VERSION } };
  }
  throw new HttpError(502, { error: 'YouTube playlist continuation context is unavailable' });
}

async function completePlaylist(html: string, data: any): Promise<PlaylistSong[]> {
  const songs: PlaylistSong[] = [];
  const entries = new Set<string>();
  const tokens = new Set<string>();
  let page: { items: any[]; next?: string } = { items: normalPlaylistItems(data) };
  let context: Record<string, any> | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    requestSignal()?.throwIfAborted();
    let next = page.next;
    for (const item of page.items) {
      const renderer = item?.playlistVideoRenderer;
      if (renderer && renderer.isPlayable !== false) {
        const parsed = song(renderer);
        // Preserve intentional duplicate videos at distinct playlist positions.
        const identity = `${getText(renderer.index)}:${parsed?.videoId}`;
        if (parsed && !entries.has(identity)) {
          entries.add(identity);
          songs.push(parsed);
          if (songs.length > 5000) throw new HttpError(413, { error: 'Playlist exceeds the 5000-song limit' });
        }
      }
      next = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ?? next;
    }
    if (!next) return songs;
    if (tokens.has(next)) throw new HttpError(502, { error: 'YouTube repeated a playlist continuation' });
    tokens.add(next);
    if (pageNumber === 99) break;
    context ??= continuationContext(html);
    const response = await boundedFetch(globalThis.fetch, 20_000)('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json', 'x-youtube-client-name': '1', 'x-youtube-client-version': context.client.clientVersion },
      body: JSON.stringify({ context, continuation: next }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(502, { error: 'YouTube playlist continuation request failed' });
    }
    page = continuationItems(await response.json());
    if (!page.items.length && !page.next) throw new HttpError(502, { error: 'YouTube returned an incomplete playlist page' });
  }
  throw new HttpError(413, { error: 'Playlist exceeds the 100-page limit' });
}

function parseMixPlaylist(data: any): PlaylistSong[] {
  const songs: PlaylistSong[] = [];
  const panels: any[] =
    data?.contents?.twoColumnWatchNextResults?.playlist?.playlist?.contents ?? [];
  for (const item of panels) {
    const s = song(item?.playlistPanelVideoRenderer);
    if (s) songs.push(s);
  }
  return songs;
}

export async function extractPlaylist(inputValue: string): Promise<PlaylistSong[]> {
  return withRequestDeadline(30_000, 'playlist extraction', () => extractWithinDeadline(inputValue));
}

async function extractWithinDeadline(inputValue: string): Promise<PlaylistSong[]> {
  const playlistId = extractPlaylistId(inputValue);

  if (playlistId.startsWith('RD')) {
    const videoId = extractVideoId(inputValue) || playlistId.replace(/^RD/, '');
    const url = `https://www.youtube.com/watch?${new URLSearchParams({ v: videoId, list: playlistId })}`;
    const html = await fetchPage(url);
    return parseMixPlaylist(extractYtInitialData(html));
  }

  const url = `https://www.youtube.com/playlist?${new URLSearchParams({ list: playlistId })}`;
  const html = await fetchPage(url);
  return completePlaylist(html, extractYtInitialData(html));
}

export { log as _log };
