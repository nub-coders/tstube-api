/** Public SoundCloud track/set extraction using the metadata served to its web player. */
interface Transcoding {
  url?: string;
  snipped?: boolean;
  format?: { protocol?: string };
}

interface Track {
  id?: number;
  title?: string;
  streamable?: boolean;
  policy?: string;
  user?: { username?: string };
  track_authorization?: string;
  media?: { transcodings?: Transcoding[] };
}

export interface SoundCloudMedia {
  provider: 'soundcloud';
  title: string;
  artist: string;
  stream_url: string;
  bypass_search: true;
}

const PAGE_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);
const API_HOSTS = new Set(['api-v2.soundcloud.com']);

function checkedUrl(value: string, allowed: (hostname: string) => boolean): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed(url.hostname)) {
    throw new Error('Unsupported SoundCloud resource URL');
  }
  return url;
}

async function fetchResource(
  url: URL,
  allowed: (hostname: string) => boolean,
  fetchFn: typeof fetch,
): Promise<Response> {
  // Check each redirect before dialing it, and share a deadline across the chain.
  const signal = AbortSignal.timeout(10_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchFn(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('SoundCloud redirect has no destination');
      url = checkedUrl(new URL(location, url).href, allowed);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SoundCloud returned HTTP ${response.status}`);
    }
    return response;
  }
  throw new Error('Too many SoundCloud redirects');
}

export async function resolveSoundCloudMedia(value: string, fetchFn: typeof fetch = globalThis.fetch): Promise<SoundCloudMedia> {
  const input = new URL(value);
  if (input.protocol === 'http:') input.protocol = 'https:';
  const url = checkedUrl(input.href, host => PAGE_HOSTS.has(host));
  if (url.pathname.split('/').filter(Boolean).length < 2) throw new Error('A SoundCloud track or set URL is required');

  const response = await fetchResource(url, host => PAGE_HOSTS.has(host), fetchFn);
  const html = await response.text();
  const match = /window\.__sc_hydration\s*=\s*(\[.*?\]);/s.exec(html);
  if (!match) throw new Error('SoundCloud track metadata is unavailable');
  const hydration: unknown = JSON.parse(match[1]);
  if (!Array.isArray(hydration)) throw new Error('Invalid SoundCloud track metadata');

  const clientId = hydration.find(entry => entry?.hydratable === 'apiClient')?.data?.id;
  if (typeof clientId !== 'string' || !clientId) throw new Error('SoundCloud web player client is unavailable');
  let track: Track | undefined = hydration.find(entry => entry?.hydratable === 'sound')?.data;
  if (!track) {
    const tracks = hydration.find(entry => entry?.hydratable === 'playlist')?.data?.tracks;
    if (Array.isArray(tracks)) track = tracks.find(item => Number.isSafeInteger(item?.id) && item.id > 0);
  }
  if (!track) throw new Error('No SoundCloud track found');
  if (!track.media && Number.isSafeInteger(track.id) && track.id! > 0) {
    const details = new URL(`https://api-v2.soundcloud.com/tracks/${track.id}`);
    details.searchParams.set('client_id', clientId);
    track = await (await fetchResource(details, host => API_HOSTS.has(host), fetchFn)).json() as Track;
  }
  if (!track || !track.streamable || (track.policy && !['ALLOW', 'MONETIZE'].includes(track.policy))) {
    throw new Error('SoundCloud track is not publicly streamable');
  }

  const transcodings = Array.isArray(track.media?.transcodings) ? track.media.transcodings : [];
  const full = transcodings.filter(item => !item.snipped);
  const selected = full.find(item => item.format?.protocol === 'progressive')
    ?? full.find(item => item.format?.protocol === 'hls');
  if (!selected?.url) throw new Error('No full SoundCloud audio stream is available');
  const endpoint = checkedUrl(selected.url, host => API_HOSTS.has(host));
  endpoint.searchParams.set('client_id', clientId);
  if (track.track_authorization) endpoint.searchParams.set('track_authorization', track.track_authorization);
  const media = await (await fetchResource(endpoint, host => API_HOSTS.has(host), fetchFn)).json() as { url?: string };
  if (typeof media.url !== 'string') throw new Error('SoundCloud did not return an audio stream');
  const stream = checkedUrl(media.url, host => host.endsWith('.sndcdn.com') || host.endsWith('.soundcloud.cloud'));

  return {
    provider: 'soundcloud',
    title: typeof track.title === 'string' ? track.title : '',
    artist: typeof track.user?.username === 'string' ? track.user.username : '',
    stream_url: stream.href,
    bypass_search: true,
  };
}
