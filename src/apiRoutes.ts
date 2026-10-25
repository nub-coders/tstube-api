/**
 * HTTP endpoints — port of main.py's route handlers.
 *
 * Response envelopes are built as plain objects; JS preserves string-key
 * insertion order and `JSON.stringify` emits compact UTF-8 (no HTML escaping),
 * matching FastAPI's json.dumps(ensure_ascii=False, separators=(",", ":")).
 */
import { config } from './config.js';
import { getLogger } from './logger.js';
import {
  type Ctx,
  type Result,
  json,
  redirect,
  streamResponse,
  requireArgs,
  requireToken,
  file,
  assetPath,
} from './httpServer.js';
import { validateYoutubeTarget } from './urlValidation.js';
import { HttpError } from './httpError.js';
import { timeTaken } from './pyTime.js';
import {
  ensureStreamJob,
  resolveMode,
  awaitStreamJob,
  refreshStreamUrl,
} from './streamJobs.js';
import { proxyStream } from './streamProxy.js';
import {
  fetchResults as scrapeSearch,
  fetchTrending,
  fetchSuggestions,
} from './searchService.js';
import { fetchResults as apiSearch, getVideoById } from './youtubeApi.js';
import { related } from './innertube.js';
import { extractPlaylist, ValueError } from './playlistParser.js';

const log = getLogger('ytube_api.routes');

const VERSION = '2026.3.12';

// ── Helpers ─────────────────────────────────────────────────────

/**
 * The resolver URL handed to clients. FastAPI's url_for uses the request Host;
 * scheme is forced to https. Falls back to BASE_URL when no Host is present.
 */
function makeTempProxy(ctx: Ctx, streamToken: string): string {
  const host = ctx.req.headers.host;
  if (host) return `https://${host}/stream/resolver/${streamToken}`;
  return `${config().BASE_URL}/stream/resolver/${streamToken}`;
}

/** main._resolve_stream_url_for_info — note the `redirect` arg is unused in Python. */
async function resolveStreamUrlForInfo(ctx: Ctx, url: string): Promise<string> {
  const streamId = await ensureStreamJob(url, 'video');
  return makeTempProxy(ctx, streamId);
}

function extractVideoIdFromUrl(value: string): string | null {
  let p: URL;
  try {
    p = new URL(value);
  } catch {
    return null;
  }
  if (p.hostname.includes('youtu.be')) {
    const candidate = p.pathname.replace(/^\/+|\/+$/g, '');
    return candidate || null;
  }
  if (p.hostname.includes('youtube.com')) {
    return p.searchParams.get('v');
  }
  return null;
}

function errorBody(e: unknown, start: number): Record<string, unknown> {
  return { error: e instanceof Error ? e.message : String(e), time_taken: timeTaken(start) };
}

/**
 * Shared catch-all translation for handler failures. Client-facing errors —
 * HttpError from the guards, ValueError from the playlist parser — keep their
 * status and message. Anything else is an internal fault: respond with a
 * generic 500 and keep the detail in the server log, never the body.
 */
function failureResult(e: unknown, start: number): Result {
  if (e instanceof HttpError) return json(e.status, e.payload);
  if (e instanceof ValueError) return json(400, errorBody(e, start));
  const cause = (e as any)?.cause ? ` cause: ${String((e as any).cause)}` : '';
  const stack = e instanceof Error && e.stack ? `\n${e.stack}` : '';
  log.error(`[ROUTES] internal failure: ${String(e)}${cause}${stack}`);
  return json(500, { error: 'Internal Server Error', time_taken: timeTaken(start) });
}

// ── Root / health / favicons ────────────────────────────────────

export function root(): Result {
  return json(200, {
    name: 'ytube_api API',
    version: VERSION,
    supported_platforms: [
      'YouTube',
      'Apple Music',
      'Amazon Music',
      'SoundCloud',
      'JioSaavn',
      'Spotify',
    ],
    endpoints: {
      '/search': 'Search songs via scrape or YouTube Data API (FREE)',
      '/trending': 'Get trending music (FREE)',
      '/suggest': 'Get song suggestions for a query (FREE)',
      '/stream': 'Get stream URL (token required)',
      '/stream/redirect': 'Get instant redirect URL for pytgcall (token required)',
      '/info': 'Search + stream URL in one call (token required)',
      '/playlist': 'Get all songs from a YouTube playlist (token required)',
      '/health': 'Health check (FREE)',
      '/rate-limit-status': 'Check your rate limit usage',
    },
    free_endpoints: ['/search', '/trending', '/suggest', '/health'],
    auth: 'Get your token from the Telegram bot @ytdlp_nub_bot using /start',
    redirect_note:
      'Use /stream/redirect with pytgcall for instant response + background extraction',
  });
}

export function health(): Result {
  return json(200, { status: 'ok' });
}

export function faviconIco(): Result {
  return file(assetPath('favicon.ico'), 'image/x-icon');
}

export function faviconSvg(): Result {
  return file(assetPath('ytubeapi-icon.svg'), 'image/svg+xml');
}

// ── /search ─────────────────────────────────────────────────────

export async function searchSongs(ctx: Ctx): Promise<Result> {
  const { q, limit, method } = requireArgs(ctx) as { q: string; limit: number; method: string };
  const start = Date.now();
  try {
    if (method === 'api') {
      const results = await apiSearch(q, limit);
      return json(200, {
        query: q,
        method: 'youtube_data_api',
        results,
        total_results: results.length,
        time_taken: timeTaken(start),
      });
    }
    let data = await scrapeSearch(q, limit);
    if (!data.main_results.length) {
      try {
        let apiResults = await apiSearch(q, limit);
        if (!apiResults.length) {
          const relaxed = q.replace(/^[a-zA-Z0-9]+-\d+\s+/, '').trim();
          if (relaxed && relaxed !== q) {
            apiResults = await apiSearch(relaxed, limit);
          }
        }
        if (apiResults.length) {
          data = {
            main_results: apiResults.map((r) => ({
              title: r.title,
              video_id: r.video_id,
              url: r.url,
              time: r.duration ?? '0:00',
              duration: r.duration ?? '0:00',
              channel: r.channel_name,
              views: r.views ?? '0',
              thumbnail: r.thumbnail,
            })),
            suggested: [],
          };
        }
      } catch {
        /* fallback best effort */
      }
    }
    return json(200, {
      query: q,
      method: data.suggested.length ? 'scrape' : 'youtube_data_api',
      results: data.main_results,
      suggested: data.suggested,
      total_results: data.main_results.length,
      time_taken: timeTaken(start),
    });
  } catch (e) {
    return failureResult(e, start);
  }
}

// ── /trending ───────────────────────────────────────────────────

export async function trendingSongs(ctx: Ctx): Promise<Result> {
  const { limit } = requireArgs(ctx) as { limit: number };
  const start = Date.now();
  try {
    const results = await fetchTrending(limit);
    return json(200, {
      results,
      total_results: results.length,
      time_taken: timeTaken(start),
    });
  } catch (e) {
    return failureResult(e, start);
  }
}

// ── /suggest ────────────────────────────────────────────────────

export async function suggestSongs(ctx: Ctx): Promise<Result> {
  const { q, limit } = requireArgs(ctx) as { q: string; limit: number };
  const start = Date.now();
  try {
    const data = await fetchSuggestions(q, limit);
    return json(200, {
      query: q,
      results: data.results,
      suggested: data.suggested,
      total_results: data.results.length + data.suggested.length,
      time_taken: timeTaken(start),
    });
  } catch (e) {
    return failureResult(e, start);
  }
}

// ── /stream/redirect ────────────────────────────────────────────

export async function streamRedirect(ctx: Ctx): Promise<Result> {
  const { q, mode } = requireArgs(ctx) as { q: string; mode: string };
  requireToken(ctx);
  const resolvedMode = resolveMode(mode);
  const streamId = await ensureStreamJob(q, resolvedMode);
  return redirect(307, makeTempProxy(ctx, streamId));
}

// ── /stream ─────────────────────────────────────────────────────

export async function streamUrl(ctx: Ctx): Promise<Result> {
  const { q, redirect: wantRedirect, mode } = requireArgs(ctx) as {
    q: string;
    redirect: boolean;
    mode: string;
  };
  requireToken(ctx);
  validateYoutubeTarget(q); // SSRF guard (before the try, like Python)
  const start = Date.now();
  try {
    const streamId = await ensureStreamJob(q, resolveMode(mode));
    const streamUrlValue = makeTempProxy(ctx, streamId);
    const elapsed = timeTaken(start);

    if (wantRedirect) {
      return json(200, {
        url: q,
        redirect_url: streamUrlValue,
        stream_url: null,
        time_taken: elapsed,
      });
    }
    return json(200, { url: q, stream_url: streamUrlValue, time_taken: elapsed });
  } catch (e) {
    return failureResult(e, start);
  }
}

// ── /stream/resolver/{id} and /stream/proxy/{id} ────────────────

export async function streamResolver(ctx: Ctx): Promise<Result> {
  const started = Date.now();
  // Validate the "<id>.<secret>" capability before waiting: unknown ids and
  // wrong secrets 404 identically, so job existence is not observable.
  const resolved = await awaitStreamJob(ctx.params.stream_id!);

  if (resolved === null) {
    return json(404, {
      error: 'Stream not found',
      hint: 'Use /stream or /stream/redirect to get a valid URL',
    });
  }
  const { streamId, job } = resolved;

  if (!job.extracted_url) {
    return json(500, { error: 'Failed to extract stream URL', url: job.url });
  }

  let upstream = await proxyFor(ctx, job.extracted_url, started, job.proxy_url ?? null);
  if (upstream.status === 502 && upstream.error) {
    // A refused or stalled dial through a pinned exit (HTTP 407 replacement, or
    // connect/tunnel timeout) is recoverable: the pool already evicted the dead
    // exit, so re-extract through a fresh one and retry once, exactly like the
    // revoked-URL path.
    const retriable = Boolean((upstream.error as { retriable?: boolean }).retriable);
    if (retriable && job.proxy_url) {
      log.info(`[STREAM_PROXY] Dial failed for ${streamId} — refreshing via a new exit...`);
      const refreshed = await refreshStreamUrl(streamId, job);
      const newUrl = refreshed?.extracted_url;
      if (newUrl && newUrl !== job.extracted_url) {
        upstream = await proxyFor(ctx, newUrl, started, refreshed?.proxy_url ?? null);
      }
    }
    if (upstream.status === 502 && upstream.error) {
      return json(502, upstream.error);
    }
  }

  // Revoked-URL recovery, capped at a single retry: googlevideo answers 403/410
  // for a URL it has invalidated. 404 is the video being gone — re-extracting it
  // would just fail again more slowly.
  if (upstream.status === 403 || upstream.status === 410) {
    log.info(`[STREAM_PROXY] Got ${upstream.status} from upstream for ${streamId}, refreshing...`);
    const refreshed = await refreshStreamUrl(streamId, job);
    const newUrl = refreshed?.extracted_url;
    if (newUrl && newUrl !== job.extracted_url) {
      upstream = await proxyFor(ctx, newUrl, started, refreshed?.proxy_url ?? null);
      if (upstream.status === 502 && upstream.error) {
        return json(502, upstream.error);
      }
    } else {
      log.warning(`[STREAM_PROXY] Refresh for ${streamId} produced no new URL`);
    }
  }

  if (upstream.status >= 400) {
    return json(upstream.status, { error: `Upstream returned HTTP ${upstream.status}` });
  }

  return streamResponse(upstream.status, upstream.headers, upstream.body!);
}

async function proxyFor(
  ctx: Ctx,
  target: string,
  startedMs: number,
  proxyUrl: string | null = null,
): Promise<{ status: number; headers: Record<string, string>; body: import('node:stream').Readable | null; error?: unknown }> {
  const range = ctx.req.headers.range;
  const ua = ctx.req.headers['user-agent'];
  return proxyStream(target, {
    rangeHeader: Array.isArray(range) ? range[0] : (range ?? null),
    userAgent: Array.isArray(ua) ? ua[0] : (ua ?? null),
    startedMs,
    proxyUrl,
    signal: ctx.signal,
  });
}

// ── /info ───────────────────────────────────────────────────────

export async function videoInfo(ctx: Ctx): Promise<Result> {
  const { q, max_results, redirect: wantRedirect } = requireArgs(ctx) as {
    q: string;
    max_results: number;
    redirect: boolean;
  };
  requireToken(ctx);
  validateYoutubeTarget(q); // SSRF guard (bare search phrases pass — no host)
  const start = Date.now();

  try {
    const isUrl = /(youtube\.com|youtu\.be)/.test(q);

    if (isUrl) {
      const videoId = extractVideoIdFromUrl(q);
      const metadataTask = videoId ? getVideoById(videoId) : Promise.resolve(null);
      const relatedTask = videoId ? related(videoId, 5) : Promise.resolve([]);
      const streamUrlTask = resolveStreamUrlForInfo(ctx, q);

      const [streamUrlValue, metadataResult, suggestedRaw] = await Promise.all([
        streamUrlTask, metadataTask, relatedTask,
      ]);

      const info: Record<string, unknown> =
        metadataResult && typeof metadataResult === 'object'
          ? (metadataResult as Record<string, unknown>)
          : {};

      let suggested = suggestedRaw;
      if (!suggested.length && info.title) {
        try {
          const sData = await scrapeSearch(String(info.title), 5);
          const currVid = (info.video_id as string | undefined) ?? videoId;
          suggested = [...sData.main_results, ...sData.suggested]
            .filter((v) => v.video_id !== currVid)
            .slice(0, 5);
        } catch {
          /* keep suggested empty */
        }
      }

      return json(200, {
        query_type: 'url',
        title: info.title ?? null,
        duration: info.duration ?? null,
        youtube_link: q,
        channel_name: info.channel_name ?? info.channel ?? info.artist_name ?? null,
        views: info.views ?? null,
        video_id: info.video_id ?? null,
        stream_url: streamUrlValue,
        thumbnail: info.thumbnail ?? null,
        suggested,
        time_taken: timeTaken(start),
      });
    }

    const searchData = await scrapeSearch(q, max_results);

    if (max_results === 1 && searchData.main_results.length) {
      const result = searchData.main_results[0]!;
      const streamUrlValue = await resolveStreamUrlForInfo(ctx, result.url);
      return json(200, {
        query_type: 'search',
        query: q,
        title: result.title,
        duration: result.duration,
        youtube_link: result.url,
        channel_name: result.channel,
        views: result.views,
        video_id: result.video_id,
        stream_url: streamUrlValue,
        thumbnail: result.thumbnail,
        suggested: searchData.suggested.slice(0, 5),
        time_taken: timeTaken(start),
      });
    }

    return json(200, {
      query_type: 'search',
      query: q,
      results: searchData.main_results,
      suggested: searchData.suggested.slice(0, 5),
      total_results: searchData.main_results.length,
      time_taken: timeTaken(start),
    });
  } catch (e) {
    return failureResult(e, start);
  }
}

// ── /playlist ───────────────────────────────────────────────────

export async function playlistSongs(ctx: Ctx): Promise<Result> {
  const { url } = requireArgs(ctx) as { url: string };
  requireToken(ctx);
  const start = Date.now();
  try {
    const songs = await extractPlaylist(url);
    return json(200, {
      playlist_url: url,
      songs,
      total_songs: songs.length,
      time_taken: timeTaken(start),
    });
  } catch (e) {
    // failureResult keeps the ValueError → 400 mapping from the Python port.
    return failureResult(e, start);
  }
}


