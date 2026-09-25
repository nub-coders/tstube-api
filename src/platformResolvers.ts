/**
 * platformResolvers.ts — Multi-platform link resolution & extraction pipeline.
 *
 * Supports Apple Music, Amazon Music (Odesli API), JioSaavn, SoundCloud, Spotify, and plain-text search fallback.
 */

// ── Custom Exceptions ─────────────────────────────────────────────────────────

export class ResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolverError';
  }
}

export class PlatformHttpError extends ResolverError {
  readonly statusCode: number;
  override readonly message: string;

  constructor(statusCode: number, message: string) {
    super(`HTTP ${statusCode}: ${message}`);
    this.name = 'PlatformHttpError';
    this.statusCode = statusCode;
    this.message = message;
  }
}

export class EmptyPlaylistError extends ResolverError {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyPlaylistError';
  }
}

export class MalformedUrlError extends ResolverError {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedUrlError';
  }
}

export class NetworkTimeoutError extends ResolverError {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkTimeoutError';
  }
}

// ── Regex Patterns ────────────────────────────────────────────────────────────

export const APPLE_MUSIC_RE = /^https?:\/\/music\.apple\.com\/([a-z]{2}\/)?(album|playlist|song|artist)\/([^/]+)(\/([^/\?]+))?/i;
export const AMAZON_MUSIC_RE = /^https?:\/\/music\.amazon\.[a-z\.]+\/.*/i;
export const SOUNDCLOUD_RE = /^https?:\/\/(www\.)?soundcloud\.com\/[^/]+\/.+/i;
export const JIOSAAVN_RE = /^https?:\/\/(www\.)?(jiosaavn|saavn)\.com\/.+/i;
export const SPOTIFY_RE = /^https?:\/\/(open\.)?spotify\.com\/(track|album|playlist|artist)\/[^/\?]+/i;

// ── Provider Detection & URL Validation ───────────────────────────────────────

export function isAppleMusic(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  return APPLE_MUSIC_RE.test(url.trim());
}

export function isAmazonMusic(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  return AMAZON_MUSIC_RE.test(url.trim());
}

export function isSoundCloud(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  return SOUNDCLOUD_RE.test(url.trim());
}

export function isJioSaavn(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  return JIOSAAVN_RE.test(url.trim());
}

export function isSpotify(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  return SPOTIFY_RE.test(url.trim());
}

export function isPlainTextQuery(query: string | null | undefined): boolean {
  if (!query || typeof query !== 'string') return false;
  const trimmed = query.trim();
  if (!trimmed) return false;
  return !trimmed.startsWith('http://') && !trimmed.startsWith('https://');
}

export function detectProvider(queryOrUrl: string | null | undefined): string {
  if (!queryOrUrl || typeof queryOrUrl !== 'string') {
    throw new MalformedUrlError('Input query or URL must be a non-empty string.');
  }

  const url = queryOrUrl.trim();
  if (!url) {
    throw new MalformedUrlError('Empty input provided.');
  }

  if (isAppleMusic(url)) {
    return 'apple_music';
  } else if (isAmazonMusic(url)) {
    return 'amazon_music';
  } else if (isSoundCloud(url)) {
    return 'soundcloud';
  } else if (isJioSaavn(url)) {
    return 'jiosaavn';
  } else if (isSpotify(url)) {
    return 'spotify';
  } else if (isPlainTextQuery(url)) {
    return 'text_search';
  } else if (url.startsWith('http://') || url.startsWith('https://')) {
    return 'generic_url';
  } else {
    return 'text_search';
  }
}

// ── HTML Unescape Helper ──────────────────────────────────────────────────────

export function htmlUnescape(text: string): string {
  if (!text) return '';
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ── Apple Music Scraper & Parser ──────────────────────────────────────────────

export function stripAppleMusicBranding(title: string): string {
  if (!title) return '';
  let cleaned = title.trim();
  // Remove " on Apple Music" suffix
  cleaned = cleaned.replace(/\s+on Apple Music$/i, '');
  // Replace " - Song by ..." or " - Album by ..." with " by ..."
  cleaned = cleaned.replace(/\s+-\s+(Song|Album|Playlist|Single|EP)\s+by\s+/i, ' by ');
  // Strip residual trailing dashes or spaces
  return cleaned.replace(/^[\s-]+|[\s-]+$/g, '');
}

export function parseAppleMusicHtml(htmlContent: string): {
  title: string;
  description: string;
  tracks: string[];
} {
  if (!htmlContent || !htmlContent.trim()) {
    throw new ResolverError('Empty Apple Music HTML content.');
  }

  let ogTitle = '';
  let ogDescription = '';
  const tracks: string[] = [];

  // Match meta tags with matching quote delimiters
  const metaRegex = /<meta\s+[^>]*?(?:property|name)=(["'])(og:title|og:description)\1[^>]*?content=(["'])(.*?)\3/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(htmlContent)) !== null) {
    const prop = match[2].toLowerCase();
    const content = match[4];
    if (prop === 'og:title' && !ogTitle) {
      ogTitle = content;
    } else if (prop === 'og:description' && !ogDescription) {
      ogDescription = content;
    }
  }

  // Reverse meta attribute order fallback: content before property/name
  if (!ogTitle || !ogDescription) {
    const metaAltRegex = /<meta\s+[^>]*?content=(["'])(.*?)\1[^>]*?(?:property|name)=(["'])(og:title|og:description)\3/gi;
    while ((match = metaAltRegex.exec(htmlContent)) !== null) {
      const content = match[2];
      const prop = match[4].toLowerCase();
      if (prop === 'og:title' && !ogTitle) {
        ogTitle = content;
      } else if (prop === 'og:description' && !ogDescription) {
        ogDescription = content;
      }
    }
  }

  const title = stripAppleMusicBranding(htmlUnescape(ogTitle));
  const description = htmlUnescape(ogDescription);

  // Extract song names from elements with class containing songs-list-row__song-name or song-name
  const rowMatches = htmlContent.matchAll(/class=["'][^"']*(?:songs-list-row__song-name|song-name)[^"']*["'][^>]*>(.*?)</gis);
  for (const m of rowMatches) {
    const cleanM = m[1].replace(/<[^>]+>/g, '').trim();
    if (cleanM) {
      tracks.push(htmlUnescape(cleanM));
    }
  }

  return {
    title,
    description,
    tracks,
  };
}

export async function resolveAppleMusic(
  url: string,
  options?: { session?: any; fetchFn?: typeof fetch },
): Promise<{
  provider: string;
  title: string;
  description: string;
  tracks: string[];
  query: string;
}> {
  if (!isAppleMusic(url)) {
    throw new MalformedUrlError('Invalid Apple Music URL format.');
  }

  const fetchImpl = options?.fetchFn || globalThis.fetch;
  let response: Response;

  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new NetworkTimeoutError('Apple Music request timed out.');
    }
    throw new ResolverError(`Network error fetching Apple Music: ${err?.message || err}`);
  }

  if (response.status === 404 || response.status === 429) {
    throw new PlatformHttpError(response.status, `Apple Music returned status ${response.status}`);
  }
  if (response.status !== 200) {
    throw new PlatformHttpError(response.status, `Apple Music request failed with status ${response.status}`);
  }

  const htmlText = await response.text();
  const parsed = parseAppleMusicHtml(htmlText);

  const isPlaylistOrAlbum = url.includes('/playlist/') || url.includes('/album/');
  if (isPlaylistOrAlbum && (!parsed.tracks || parsed.tracks.length === 0)) {
    if (!parsed.title) {
      throw new EmptyPlaylistError('Apple Music page contains no tracks or title.');
    }
  }

  return {
    provider: 'apple_music',
    title: parsed.title,
    description: parsed.description,
    tracks: parsed.tracks,
    query: parsed.title,
  };
}

// ── Amazon Music & Spotify (Odesli / Songlink API) ───────────────────────────

export function parseOdesliResponse(data: any): {
  entity_id: string | null;
  title: string;
  artist: string;
  youtube_url: string | null;
  search_query: string;
} {
  if (!data || typeof data !== 'object') {
    throw new ResolverError('Invalid Odesli API JSON response.');
  }

  const entityId = data.entityUniqueId || null;
  const entities = data.entitiesByUniqueId || {};
  const entity = entityId ? entities[entityId] || {} : {};

  const title = entity.title || '';
  const artistName = entity.artistName || '';

  const linksByPlatform = data.linksByPlatform || {};
  const youtubeInfo = linksByPlatform.youtube || {};
  const youtubeUrl = typeof youtubeInfo === 'object' && youtubeInfo !== null ? youtubeInfo.url || null : null;

  const searchQuery = title || artistName ? `${title} ${artistName}`.trim() : '';

  return {
    entity_id: entityId,
    title,
    artist: artistName,
    youtube_url: youtubeUrl,
    search_query: searchQuery,
  };
}

export async function resolveAmazonMusic(
  url: string,
  options?: { session?: any; fetchFn?: typeof fetch },
): Promise<{
  provider: string;
  title: string;
  artist: string;
  youtube_url: string | null;
  search_query: string;
  query: string;
}> {
  if (!isAmazonMusic(url)) {
    throw new MalformedUrlError('Invalid Amazon Music URL format.');
  }

  const encodedUrl = encodeURIComponent(url);
  const odesliApiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodedUrl}`;
  const fetchImpl = options?.fetchFn || globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(odesliApiUrl, {
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new NetworkTimeoutError('Amazon Music (Odesli) request timed out.');
    }
    throw new ResolverError(`Network error resolving Amazon Music: ${err?.message || err}`);
  }

  if (response.status === 404 || response.status === 429) {
    throw new PlatformHttpError(response.status, `Odesli API returned status ${response.status}`);
  }
  if (response.status !== 200) {
    throw new PlatformHttpError(response.status, `Odesli API request failed with status ${response.status}`);
  }

  const jsonData = await response.json();
  const parsed = parseOdesliResponse(jsonData);

  return {
    provider: 'amazon_music',
    title: parsed.title,
    artist: parsed.artist,
    youtube_url: parsed.youtube_url,
    search_query: parsed.search_query,
    query: parsed.youtube_url || parsed.search_query,
  };
}

export async function resolveSpotify(
  url: string,
  options?: { session?: any; fetchFn?: typeof fetch },
): Promise<{
  provider: string;
  title: string;
  artist: string;
  youtube_url: string | null;
  search_query: string;
  query: string;
}> {
  if (!isSpotify(url)) {
    throw new MalformedUrlError('Invalid Spotify URL format.');
  }

  const encodedUrl = encodeURIComponent(url);
  const odesliApiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodedUrl}`;
  const fetchImpl = options?.fetchFn || globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(odesliApiUrl, {
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new NetworkTimeoutError('Spotify (Odesli) request timed out.');
    }
    throw new ResolverError(`Network error resolving Spotify: ${err?.message || err}`);
  }

  if (response.status === 404 || response.status === 429) {
    throw new PlatformHttpError(response.status, `Odesli API returned status ${response.status}`);
  }
  if (response.status !== 200) {
    throw new PlatformHttpError(response.status, `Odesli API request failed with status ${response.status}`);
  }

  const jsonData = await response.json();
  const parsed = parseOdesliResponse(jsonData);

  return {
    provider: 'spotify',
    title: parsed.title,
    artist: parsed.artist,
    youtube_url: parsed.youtube_url,
    search_query: parsed.search_query,
    query: parsed.youtube_url || parsed.search_query,
  };
}

// ── JioSaavn Scraper & Parser ─────────────────────────────────────────────────

export function selectHighestBitrateUrl(mediaData: any): string | null {
  if (!mediaData) return null;

  if (typeof mediaData === 'string') {
    return mediaData;
  }

  const bitrateMap: Record<number, string> = {};

  if (Array.isArray(mediaData)) {
    for (const item of mediaData) {
      if (typeof item === 'object' && item !== null) {
        const quality = String(item.quality || '').toLowerCase();
        const link = item.link || item.url;
        if (link) {
          const match = quality.match(/(\d+)/);
          const kbps = match ? parseInt(match[1], 10) : 0;
          bitrateMap[kbps] = link;
        }
      }
    }
  } else if (typeof mediaData === 'object' && mediaData !== null) {
    for (const [key, value] of Object.entries(mediaData)) {
      if (typeof value === 'string' && value) {
        const match = String(key).match(/(\d+)/);
        const kbps = match ? parseInt(match[1], 10) : 0;
        bitrateMap[kbps] = value;
      }
    }
  }

  const keys = Object.keys(bitrateMap).map((k) => parseInt(k, 10));
  if (keys.length > 0) {
    const highestBitrate = Math.max(...keys);
    return bitrateMap[highestBitrate];
  }

  return null;
}

export function parseJioSaavnJson(data: any): {
  title: string;
  artist: string;
  duration: number | null;
  stream_url: string | null;
  search_query: string;
} {
  if (!data || typeof data !== 'object') {
    throw new ResolverError('Invalid JioSaavn JSON response.');
  }

  let title = data.song || data.title || data.name || '';
  title = htmlUnescape(String(title)).trim();

  let artist = data.singers || data.primary_artists || data.artist || '';
  artist = htmlUnescape(String(artist)).trim();

  let duration: number | null = null;
  if (data.duration !== undefined && data.duration !== null) {
    const parsedDur = parseInt(String(data.duration), 10);
    duration = isNaN(parsedDur) ? null : parsedDur;
  }

  const mediaData = data.download_url || data.media_url || data.media_preview_url;
  const streamUrl = selectHighestBitrateUrl(mediaData);

  const searchQuery = title || artist ? `${title} ${artist}`.trim() : '';

  return {
    title,
    artist,
    duration,
    stream_url: streamUrl,
    search_query: searchQuery,
  };
}

export async function resolveJioSaavn(
  url: string,
  options?: { session?: any; fetchFn?: typeof fetch },
): Promise<{
  provider: string;
  title: string;
  artist: string;
  duration: number | null;
  stream_url: string | null;
  search_query: string;
  query: string;
}> {
  if (!isJioSaavn(url)) {
    throw new MalformedUrlError('Invalid JioSaavn URL format.');
  }

  const apiUrl = `https://www.jiosaavn.com/api.php?__call=webapi.get&token=${encodeURIComponent(url)}&type=song&_format=json&_marker=0`;
  const fetchImpl = options?.fetchFn || globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new NetworkTimeoutError('JioSaavn request timed out.');
    }
    throw new ResolverError(`Network error resolving JioSaavn: ${err?.message || err}`);
  }

  if (response.status === 404 || response.status === 429) {
    throw new PlatformHttpError(response.status, `JioSaavn API returned status ${response.status}`);
  }
  if (response.status !== 200) {
    throw new PlatformHttpError(response.status, `JioSaavn API request failed with status ${response.status}`);
  }

  const jsonData = await response.json();
  const parsed = parseJioSaavnJson(jsonData);

  return {
    provider: 'jiosaavn',
    title: parsed.title,
    artist: parsed.artist,
    duration: parsed.duration,
    stream_url: parsed.stream_url,
    search_query: parsed.search_query,
    query: parsed.stream_url || parsed.search_query,
  };
}

// ── SoundCloud Resolver ───────────────────────────────────────────────────────

export function resolveSoundCloud(url: string): {
  provider: string;
  url: string;
  bypass_search: boolean;
  stream_url: string;
} {
  if (!isSoundCloud(url)) {
    throw new MalformedUrlError('Invalid SoundCloud URL format.');
  }

  return {
    provider: 'soundcloud',
    url,
    bypass_search: true,
    stream_url: url,
  };
}

// ── Master Dispatcher Function ────────────────────────────────────────────────

export async function resolveToPlayableStream(
  queryOrUrl: string,
  options?: {
    session?: any;
    fetchFn?: typeof fetch;
    ytDlpExtractor?: (url: string) => Promise<any>;
  },
): Promise<any> {
  if (!queryOrUrl || typeof queryOrUrl !== 'string' || !queryOrUrl.trim()) {
    throw new MalformedUrlError('Input query or URL cannot be empty.');
  }

  const cleanInput = queryOrUrl.trim();
  const provider = detectProvider(cleanInput);

  if (provider === 'apple_music') {
    const res = await resolveAppleMusic(cleanInput, options);
    let query: string;
    if (res.tracks && res.tracks.length > 0) {
      const firstTrack = res.tracks[0];
      query = `${firstTrack} ${res.title}`.trim();
    } else {
      query = res.title;
    }
    return {
      provider: 'apple_music',
      title: res.title,
      artist: null,
      stream_url: null,
      search_query: query,
      tracks: res.tracks || [],
      bypass_search: false,
    };
  } else if (provider === 'amazon_music') {
    const res = await resolveAmazonMusic(cleanInput, options);
    if (res.youtube_url) {
      const streamUrl = res.youtube_url;
      if (options?.ytDlpExtractor && typeof options.ytDlpExtractor === 'function') {
        return await options.ytDlpExtractor(streamUrl);
      }
      return {
        provider: 'amazon_music',
        title: res.title,
        artist: res.artist,
        stream_url: streamUrl,
        search_query: res.search_query,
        bypass_search: true,
      };
    } else {
      return {
        provider: 'amazon_music',
        title: res.title,
        artist: res.artist,
        stream_url: null,
        search_query: res.search_query,
        bypass_search: false,
      };
    }
  } else if (provider === 'spotify') {
    const res = await resolveSpotify(cleanInput, options);
    if (res.youtube_url) {
      const streamUrl = res.youtube_url;
      if (options?.ytDlpExtractor && typeof options.ytDlpExtractor === 'function') {
        return await options.ytDlpExtractor(streamUrl);
      }
      return {
        provider: 'spotify',
        title: res.title,
        artist: res.artist,
        stream_url: streamUrl,
        search_query: res.search_query,
        bypass_search: true,
      };
    } else {
      return {
        provider: 'spotify',
        title: res.title,
        artist: res.artist,
        stream_url: null,
        search_query: res.search_query,
        bypass_search: false,
      };
    }
  } else if (provider === 'jiosaavn') {
    const res = await resolveJioSaavn(cleanInput, options);
    if (res.stream_url) {
      return {
        provider: 'jiosaavn',
        title: res.title,
        artist: res.artist,
        duration: res.duration,
        stream_url: res.stream_url,
        search_query: res.search_query,
        bypass_search: true,
      };
    }
    return {
      provider: 'jiosaavn',
      title: res.title,
      artist: res.artist,
      duration: res.duration,
      stream_url: null,
      search_query: res.search_query,
      bypass_search: false,
    };
  } else if (provider === 'soundcloud') {
    const res = resolveSoundCloud(cleanInput);
    if (options?.ytDlpExtractor && typeof options.ytDlpExtractor === 'function') {
      return await options.ytDlpExtractor(cleanInput);
    }
    return {
      provider: 'soundcloud',
      title: null,
      artist: null,
      stream_url: cleanInput,
      search_query: null,
      bypass_search: true,
    };
  } else if (provider === 'text_search') {
    if (options?.ytDlpExtractor && typeof options.ytDlpExtractor === 'function') {
      return await options.ytDlpExtractor(cleanInput);
    }
    return {
      provider: 'text_search',
      title: cleanInput,
      artist: null,
      stream_url: null,
      search_query: cleanInput,
      bypass_search: false,
    };
  } else {
    // Generic URL fallback
    if (options?.ytDlpExtractor && typeof options.ytDlpExtractor === 'function') {
      return await options.ytDlpExtractor(cleanInput);
    }
    return {
      provider: 'generic_url',
      title: cleanInput,
      artist: null,
      stream_url: cleanInput,
      search_query: null,
      bypass_search: true,
    };
  }
}

export const getAudioStream = resolveToPlayableStream;
