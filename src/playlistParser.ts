/**
 * Playlist parser — port of utils/playlist_parser.py.
 *
 * Supports normal playlists (PL...), auto-generated (OL..., UU...) and YouTube
 * Mix (RD...) playlists by scraping the public playlist/watch page.
 */
import { getLogger } from './logger.js';

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
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
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

function parseNormalPlaylist(data: any): PlaylistSong[] {
  const songs: PlaylistSong[] = [];
  const tabs: any[] = data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  for (const tab of tabs) {
    const content = tab?.tabRenderer?.content;
    if (!content) continue;
    const sections: any[] = content?.sectionListRenderer?.contents ?? [];
    for (const section of sections) {
      const items: any[] = section?.itemSectionRenderer?.contents ?? [];
      for (const item of items) {
        const videos: any[] = item?.playlistVideoListRenderer?.contents ?? [];
        for (const v of videos) {
          const s = song(v?.playlistVideoRenderer);
          if (s) songs.push(s);
        }
      }
    }
  }
  return songs;
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
  const playlistId = extractPlaylistId(inputValue);

  if (playlistId.startsWith('RD')) {
    const videoId = extractVideoId(inputValue) || playlistId.replace(/^RD/, '');
    const url = `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`;
    const html = await fetchPage(url);
    return parseMixPlaylist(extractYtInitialData(html));
  }

  const url = `https://www.youtube.com/playlist?list=${playlistId}`;
  const html = await fetchPage(url);
  return parseNormalPlaylist(extractYtInitialData(html));
}

export { log as _log };
