import { describe, it, expect, vi } from 'vitest';
import {
  isAppleMusic,
  isAmazonMusic,
  isSoundCloud,
  isJioSaavn,
  isSpotify,
  isPlainTextQuery,
  detectProvider,
  stripAppleMusicBranding,
  parseAppleMusicHtml,
  resolveAppleMusic,
  parseOdesliResponse,
  resolveAmazonMusic,
  resolveSpotify,
  selectHighestBitrateUrl,
  parseJioSaavnJson,
  resolveJioSaavn,
  resolveSoundCloud,
  resolveToPlayableStream,
  EmptyPlaylistError,
  MalformedUrlError,
  NetworkTimeoutError,
  PlatformHttpError,
  ResolverError,
} from '../platformResolvers.js';
import { isAllowedTarget, validateTarget } from '../urlValidation.js';
import { HttpError } from '../httpError.js';

// Sample HTML and JSON payloads for testing
const appleMusicHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta property="og:title" content="Blinding Lights - Song by The Weeknd on Apple Music" />
    <meta property="og:description" content="Listen to Blinding Lights by The Weeknd on Apple Music." />
</head>
<body>
    <div class="songs-list-row__song-name">Blinding Lights</div>
    <div class="songs-list-row__song-name">In Your Eyes</div>
</body>
</html>
`;

const appleMusicPlaylistHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta property="og:title" content="Today's Hits on Apple Music" />
    <meta property="og:description" content="The biggest songs in pop, hip-hop, R&B, and dance." />
</head>
<body>
    <div class="songs-list-row__song-name">Starboy</div>
    <div class="songs-list-row__song-name">Save Your Tears</div>
    <div class="songs-list-row__song-name">Die For You</div>
    <div class="songs-list-row__song-name">As It Was</div>
</body>
</html>
`;

const appleMusicAlbumHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta property="og:title" content="After Hours - Album by The Weeknd on Apple Music" />
    <meta property="og:description" content="Listen to After Hours by The Weeknd on Apple Music." />
</head>
<body>
    <div class="songs-list-row__song-name">Alone Again</div>
    <div class="songs-list-row__song-name">Too Late</div>
    <div class="songs-list-row__song-name">Hardest To Love</div>
    <div class="songs-list-row__song-name">Scared To Live</div>
    <div class="songs-list-row__song-name">Blinding Lights</div>
</body>
</html>
`;

const odesliJson = {
  entityUniqueId: 'AMAZON_SONG::B083335XYZ',
  userCountry: 'US',
  pageUrl: 'https://song.link/i/1499378610',
  entitiesByUniqueId: {
    'AMAZON_SONG::B083335XYZ': {
      id: 'B083335XYZ',
      type: 'song',
      title: 'Blinding Lights',
      artistName: 'The Weeknd',
      thumbnailUrl: 'https://m.media-amazon.com/images/I/71.jpg',
    },
  },
  linksByPlatform: {
    amazonMusic: {
      url: 'https://music.amazon.com/albums/B083321528?trackAsin=B083335XYZ',
    },
    youtube: {
      url: 'https://www.youtube.com/watch?q=blinding_lights_yt',
    },
  },
};

const jiosaavnJson = {
  id: 'X10ceh5ZAWs',
  song: 'Kesariya',
  singers: 'Arijit Singh, Pritam',
  duration: '268',
  download_url: [
    { quality: '12kbps', link: 'https://aac.saavncdn.com/kesariya_12kbps.mp4' },
    { quality: '160kbps', link: 'https://aac.saavncdn.com/kesariya_160kbps.mp4' },
    { quality: '320kbps', link: 'https://aac.saavncdn.com/kesariya_320kbps.mp4' },
  ],
};

describe('Provider Detection & URL Validation', () => {
  it('detects Apple Music URLs', () => {
    expect(isAppleMusic('https://music.apple.com/us/album/blinding-lights/1499378608?i=1499378610')).toBe(true);
    expect(isAppleMusic('https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aa18d3b43d70319')).toBe(true);
    expect(isAppleMusic('https://spotify.com/track/12345')).toBe(false);
    expect(isAppleMusic('invalid-url')).toBe(false);
    expect(isAppleMusic(null)).toBe(false);
  });

  it('detects Amazon Music URLs', () => {
    expect(isAmazonMusic('https://music.amazon.com/albums/B083321528')).toBe(true);
    expect(isAmazonMusic('https://music.amazon.in/tracks/B083335XYZ')).toBe(true);
    expect(isAmazonMusic('https://music.apple.com/us/album/test/123')).toBe(false);
    expect(isAmazonMusic(null)).toBe(false);
  });

  it('detects SoundCloud URLs', () => {
    expect(isSoundCloud('https://soundcloud.com/artist-name/track-title')).toBe(true);
    expect(isSoundCloud('https://www.soundcloud.com/artist/sets/my-playlist')).toBe(true);
    expect(isSoundCloud('https://soundcloud.com/')).toBe(false);
    expect(isSoundCloud(null)).toBe(false);
  });

  it('detects JioSaavn URLs', () => {
    expect(isJioSaavn('https://www.jiosaavn.com/song/kesariya/X10ceh5ZAWs')).toBe(true);
    expect(isJioSaavn('https://saavn.com/s/song/hindi/kesariya/X10ceh5ZAWs')).toBe(true);
    expect(isJioSaavn('https://youtube.com/watch?v=123')).toBe(false);
    expect(isJioSaavn(null)).toBe(false);
  });

  it('detects Spotify URLs', () => {
    expect(isSpotify('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBe(true);
    expect(isSpotify('https://open.spotify.com/album/1DFam4w928374')).toBe(true);
    expect(isSpotify('https://amazon.com')).toBe(false);
    expect(isSpotify(null)).toBe(false);
  });

  it('detects plain text queries', () => {
    expect(isPlainTextQuery('Blinding Lights The Weeknd')).toBe(true);
    expect(isPlainTextQuery('Kesariya Arijit Singh 🔥')).toBe(true);
    expect(isPlainTextQuery('https://music.apple.com/us/album/test/123')).toBe(false);
    expect(isPlainTextQuery('http://example.com')).toBe(false);
    expect(isPlainTextQuery(null)).toBe(false);
  });

  it('detects provider accurately', () => {
    expect(detectProvider('https://music.apple.com/us/album/test/123')).toBe('apple_music');
    expect(detectProvider('https://music.amazon.com/albums/B083321528')).toBe('amazon_music');
    expect(detectProvider('https://soundcloud.com/user/track')).toBe('soundcloud');
    expect(detectProvider('https://www.jiosaavn.com/song/test/123')).toBe('jiosaavn');
    expect(detectProvider('https://open.spotify.com/track/123')).toBe('spotify');
    expect(detectProvider('Starboy The Weeknd')).toBe('text_search');
    expect(detectProvider('https://example.com/audio.mp3')).toBe('generic_url');

    expect(() => detectProvider('')).toThrow(MalformedUrlError);
    expect(() => detectProvider(null as any)).toThrow(MalformedUrlError);
  });
});

describe('Apple Music Scraper & Parser', () => {
  it('strips Apple Music branding', () => {
    expect(stripAppleMusicBranding('Blinding Lights on Apple Music')).toBe('Blinding Lights');
    expect(stripAppleMusicBranding('Starboy - Song by The Weeknd on Apple Music')).toBe('Starboy by The Weeknd');
    expect(stripAppleMusicBranding('After Hours - Album by The Weeknd')).toBe('After Hours by The Weeknd');
    expect(stripAppleMusicBranding('')).toBe('');
  });

  it('parses Apple Music HTML correctly', () => {
    const parsed = parseAppleMusicHtml(appleMusicHtml);
    expect(parsed.title).toBe('Blinding Lights by The Weeknd');
    expect(parsed.description).toContain('Listen to Blinding Lights');
    expect(parsed.tracks).toContain('Blinding Lights');
    expect(parsed.tracks).toContain('In Your Eyes');
  });

  it('throws ResolverError on empty Apple Music HTML', () => {
    expect(() => parseAppleMusicHtml('')).toThrow(ResolverError);
  });

  it('resolves Apple Music link successfully with mock fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(appleMusicHtml),
    });

    const res = await resolveAppleMusic('https://music.apple.com/us/album/after-hours/1499378608', {
      fetchFn: mockFetch as any,
    });
    expect(res.provider).toBe('apple_music');
    expect(res.title).toBe('Blinding Lights by The Weeknd');
    expect(res.tracks).toContain('Blinding Lights');
  });

  it('throws PlatformHttpError on HTTP 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
    });

    await expect(
      resolveAppleMusic('https://music.apple.com/us/album/not-found/404', { fetchFn: mockFetch as any }),
    ).rejects.toThrow(PlatformHttpError);
  });

  it('throws NetworkTimeoutError on fetch timeout', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));

    await expect(
      resolveAppleMusic('https://music.apple.com/us/album/test/123', { fetchFn: mockFetch as any }),
    ).rejects.toThrow(NetworkTimeoutError);
  });
});

describe('Amazon Music & Spotify Odesli Parser', () => {
  it('parses Odesli response correctly', () => {
    const parsed = parseOdesliResponse(odesliJson);
    expect(parsed.entity_id).toBe('AMAZON_SONG::B083335XYZ');
    expect(parsed.title).toBe('Blinding Lights');
    expect(parsed.artist).toBe('The Weeknd');
    expect(parsed.youtube_url).toBe('https://www.youtube.com/watch?q=blinding_lights_yt');
    expect(parsed.search_query).toBe('Blinding Lights The Weeknd');
  });

  it('handles missing youtube link in Odesli response', () => {
    const data = {
      entityUniqueId: 'AMAZON_SONG::123',
      entitiesByUniqueId: {
        'AMAZON_SONG::123': { title: 'Song Without YT', artistName: 'Artist' },
      },
      linksByPlatform: {},
    };
    const parsed = parseOdesliResponse(data);
    expect(parsed.youtube_url).toBeNull();
    expect(parsed.search_query).toBe('Song Without YT Artist');
  });

  it('resolves Amazon Music link successfully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve(odesliJson),
    });

    const res = await resolveAmazonMusic('https://music.amazon.com/albums/B083321528', {
      fetchFn: mockFetch as any,
    });
    expect(res.provider).toBe('amazon_music');
    expect(res.title).toBe('Blinding Lights');
    expect(res.youtube_url).toBe('https://www.youtube.com/watch?q=blinding_lights_yt');
  });

  it('resolves Spotify link successfully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve(odesliJson),
    });

    const res = await resolveSpotify('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', {
      fetchFn: mockFetch as any,
    });
    expect(res.provider).toBe('spotify');
    expect(res.title).toBe('Blinding Lights');
    expect(res.youtube_url).toBe('https://www.youtube.com/watch?q=blinding_lights_yt');
  });
});

describe('JioSaavn Bitrate Selection & Parser', () => {
  it('selects highest bitrate URL', () => {
    const mediaList = [
      { quality: '12kbps', link: 'https://aac.saavncdn.com/12.mp4' },
      { quality: '160kbps', link: 'https://aac.saavncdn.com/160.mp4' },
      { quality: '320kbps', link: 'https://aac.saavncdn.com/320.mp4' },
      { quality: '96kbps', link: 'https://aac.saavncdn.com/96.mp4' },
    ];
    expect(selectHighestBitrateUrl(mediaList)).toBe('https://aac.saavncdn.com/320.mp4');

    const mediaDict = {
      '160kbps': 'https://aac.saavncdn.com/160.mp4',
      '320kbps': 'https://aac.saavncdn.com/320.mp4',
    };
    expect(selectHighestBitrateUrl(mediaDict)).toBe('https://aac.saavncdn.com/320.mp4');

    expect(selectHighestBitrateUrl('https://aac.saavncdn.com/direct.mp4')).toBe('https://aac.saavncdn.com/direct.mp4');
    expect(selectHighestBitrateUrl(null)).toBeNull();
  });

  it('parses JioSaavn JSON response', () => {
    const parsed = parseJioSaavnJson(jiosaavnJson);
    expect(parsed.title).toBe('Kesariya');
    expect(parsed.artist).toBe('Arijit Singh, Pritam');
    expect(parsed.duration).toBe(268);
    expect(parsed.stream_url).toBe('https://aac.saavncdn.com/kesariya_320kbps.mp4');
    expect(parsed.search_query).toBe('Kesariya Arijit Singh, Pritam');
  });

  it('resolves JioSaavn link successfully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve(jiosaavnJson),
    });

    const res = await resolveJioSaavn('https://www.jiosaavn.com/song/kesariya/X10ceh5ZAWs', {
      fetchFn: mockFetch as any,
    });
    expect(res.provider).toBe('jiosaavn');
    expect(res.title).toBe('Kesariya');
    expect(res.stream_url).toBe('https://aac.saavncdn.com/kesariya_320kbps.mp4');
  });
});

describe('SoundCloud Resolver', () => {
  it('rejects malformed links before fetching', async () => {
    await expect(resolveSoundCloud('invalid-url')).rejects.toThrow(MalformedUrlError);
  });
});

describe('Master Dispatcher & SSRF Guard', () => {
  it('dispatches plain text query', async () => {
    const res = await resolveToPlayableStream('Shape of You Ed Sheeran');
    expect(res.provider).toBe('text_search');
    expect(res.search_query).toBe('Shape of You Ed Sheeran');
    expect(res.bypass_search).toBe(false);
  });

  it('dispatches JioSaavn link', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve(jiosaavnJson),
    });

    const res = await resolveToPlayableStream('https://www.jiosaavn.com/song/kesariya/X10ceh5ZAWs', {
      fetchFn: mockFetch as any,
    });
    expect(res.provider).toBe('jiosaavn');
    expect(res.stream_url).toBe('https://aac.saavncdn.com/kesariya_320kbps.mp4');
    expect(res.bypass_search).toBe(true);
  });

  it('handles query with unicode emojis', async () => {
    const res = await resolveToPlayableStream('🔥 🎧 Srivalli - Pushpa 🎵 ✨');
    expect(res.provider).toBe('text_search');
    expect(res.search_query).toBe('🔥 🎧 Srivalli - Pushpa 🎵 ✨');
  });

  it('allows valid platform hosts in SSRF guard', () => {
    expect(isAllowedTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isAllowedTarget('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(isAllowedTarget('https://music.apple.com/us/album/test/123')).toBe(true);
    expect(isAllowedTarget('https://music.amazon.com/albums/B083321528')).toBe(true);
    expect(isAllowedTarget('https://music.amazon.in/tracks/B083335XYZ')).toBe(true);
    expect(isAllowedTarget('https://soundcloud.com/artist/track')).toBe(true);
    expect(isAllowedTarget('https://www.jiosaavn.com/song/test/123')).toBe(true);
    expect(isAllowedTarget('https://open.spotify.com/track/12345')).toBe(true);
    expect(isAllowedTarget('Arijit Singh hits')).toBe(true);
  });

  it('blocks untrusted hosts in SSRF guard', () => {
    expect(isAllowedTarget('https://evil.com/malicious.mp3')).toBe(false);
    expect(isAllowedTarget('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedTarget('ftp://files.example.com/test.mp3')).toBe(false);
  });

  it('validates target URLs', () => {
    expect(validateTarget('https://music.apple.com/us/album/test/123')).toBe('https://music.apple.com/us/album/test/123');

    expect(() => validateTarget('https://evil.com/hack')).toThrow(HttpError);
  });

  it('resolves Apple Music playlist URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(appleMusicPlaylistHtml),
    });

    const url = 'https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aa18d3b43d70319';
    const res = await resolveAppleMusic(url, { fetchFn: mockFetch as any });

    expect(res.provider).toBe('apple_music');
    expect(res.title).toBe("Today's Hits");
    expect(res.tracks.length).toBe(4);
    expect(res.tracks).toEqual(['Starboy', 'Save Your Tears', 'Die For You', 'As It Was']);
  });

  it('resolves Apple Music album URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(appleMusicAlbumHtml),
    });

    const url = 'https://music.apple.com/us/album/after-hours/1499378608';
    const res = await resolveAppleMusic(url, { fetchFn: mockFetch as any });

    expect(res.provider).toBe('apple_music');
    expect(res.title).toBe('After Hours by The Weeknd');
    expect(res.tracks.length).toBe(5);
    expect(res.tracks).toContain('Blinding Lights');
    expect(res.tracks).toContain('Hardest To Love');
  });

  it('recognizes SoundCloud set/playlist URLs', () => {
    const url = 'https://soundcloud.com/artist-name/sets/summer-vibes-2024';
    expect(isSoundCloud(url)).toBe(true);
    expect(detectProvider(url)).toBe('soundcloud');
  });

  it('resolves Amazon Music album URLs', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve(odesliJson),
    });

    const url = 'https://music.amazon.com/albums/B083321528';
    expect(isAmazonMusic(url)).toBe(true);
    expect(detectProvider(url)).toBe('amazon_music');

    const res = await resolveAmazonMusic(url, { fetchFn: mockFetch as any });
    expect(res.provider).toBe('amazon_music');
    expect(res.title).toBe('Blinding Lights');
    expect(res.youtube_url).toBe('https://www.youtube.com/watch?q=blinding_lights_yt');
  });

  it('master dispatcher routes playlist link resolution', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(appleMusicPlaylistHtml),
    });

    const url = 'https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aa18d3b43d70319';
    const res = await resolveToPlayableStream(url, { fetchFn: mockFetch as any });

    expect(res.provider).toBe('apple_music');
    expect(res.tracks.length).toBe(4);
    expect(res.tracks[0]).toBe('Starboy');
  });
});
