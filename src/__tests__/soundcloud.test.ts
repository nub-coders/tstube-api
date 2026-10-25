import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSoundCloud, resolveToPlayableStream } from '../platformResolvers.js';

const pageUrl = 'https://soundcloud.com/artist/track';
const endpoint = 'https://api-v2.soundcloud.com/media/soundcloud:tracks:123/test/stream/hls';
const mediaUrl = 'https://playback.media-streaming.soundcloud.cloud/test/playlist.m3u8';
const track = {
  id: 123, title: 'Track', streamable: true, policy: 'ALLOW',
  user: { username: 'Artist' }, track_authorization: 'public-track-auth',
  media: { transcodings: [{ url: endpoint, quality: 'sq', snipped: false, format: { protocol: 'hls' } }] },
};

function page(sound: unknown = track, kind = 'sound'): string {
  return `<script>window.__sc_hydration = ${JSON.stringify([
    { hydratable: 'apiClient', data: { id: 'public-client-id' } },
    { hydratable: kind, data: sound },
  ])};</script>`;
}

function transport(html = page()) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === pageUrl) return new Response(html);
    if (url.startsWith(endpoint + '?')) return Response.json({ url: mediaUrl });
    throw new Error('Unexpected request: ' + new URL(url).origin);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('SoundCloud media extraction', () => {
  it('accepts mobile track links and follows only SoundCloud page redirects', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://m.soundcloud.com/artist/track') {
        return new Response(null, { status: 302, headers: { location: pageUrl } });
      }
      return transport()(input);
    });
    const result = await resolveToPlayableStream('https://m.soundcloud.com/artist/track', { fetchFn });
    expect(result.stream_url).toBe(mediaUrl);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('resolves a public track to its real HLS audio instead of its page URL', async () => {
    const fetchFn = transport();
    const result = await resolveToPlayableStream(pageUrl, { fetchFn });
    expect(result).toMatchObject({ provider: 'soundcloud', title: 'Track', artist: 'Artist', stream_url: mediaUrl, bypass_search: true });
    const request = new URL(String(fetchFn.mock.calls[1][0]));
    expect(request.searchParams.get('client_id')).toBe('public-client-id');
    expect(request.searchParams.get('track_authorization')).toBe('public-track-auth');
  });

  it('prefers a full progressive stream over HLS and preview-only transcodings', async () => {
    const progressive = 'https://api-v2.soundcloud.com/media/test/stream/progressive';
    const html = page({ ...track, media: { transcodings: [
      { url: endpoint, snipped: true, format: { protocol: 'progressive' } },
      ...track.media.transcodings,
      { url: progressive, snipped: false, format: { protocol: 'progressive' } },
    ] } });
    const fetchFn = vi.fn(async (input: string | URL | Request) =>
      String(input) === pageUrl ? new Response(html) : Response.json({ url: 'https://cf-media.sndcdn.com/audio.mp3' }));
    const result = await resolveSoundCloud(pageUrl, { fetchFn });
    expect(result.stream_url).toBe('https://cf-media.sndcdn.com/audio.mp3');
    expect(String(fetchFn.mock.calls[1][0])).toContain(progressive + '?');
  });

  it('loads the first track in a set when hydration only contains a track ID', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'soundcloud.com') return new Response(page({ tracks: [{ id: 123 }] }, 'playlist'));
      if (url.pathname === '/tracks/123') return Response.json(track);
      return Response.json({ url: mediaUrl });
    });
    const result = await resolveSoundCloud('https://soundcloud.com/artist/sets/set', { fetchFn });
    expect(result.stream_url).toBe(mediaUrl);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ...track, streamable: false },
    { ...track, policy: 'BLOCK' },
    { ...track, media: { transcodings: [{ ...track.media.transcodings[0], snipped: true }] } },
  ])('rejects unavailable or preview-only tracks without fetching media', async sound => {
    const fetchFn = transport(page(sound));
    await expect(resolveSoundCloud(pageUrl, { fetchFn })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects an off-provider redirect before following it', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(resolveSoundCloud(pageUrl, { fetchFn })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects untrusted transcoding and returned media URLs', async () => {
    const unsafeEndpoint = transport(page({ ...track, media: { transcodings: [
      { ...track.media.transcodings[0], url: 'https://example.test/media' },
    ] } }));
    await expect(resolveSoundCloud(pageUrl, { fetchFn: unsafeEndpoint })).rejects.toThrow();
    expect(unsafeEndpoint).toHaveBeenCalledTimes(1);
    const unsafeMedia = vi.fn(async (input: string | URL | Request) => String(input) === pageUrl
      ? new Response(page()) : Response.json({ url: 'http://169.254.169.254/metadata' }));
    await expect(resolveSoundCloud(pageUrl, { fetchFn: unsafeMedia })).rejects.toThrow();
  });
});
