# tstube-api

A TypeScript rewrite of the `ytube_api` FastAPI service + Telegram bot. The HTTP
responses, status codes, JSON key order, error envelopes, rate limiting and the
bot's rich-message UI are ports of the Python original, not reinterpretations.

## Stack

- **Runtime:** Node.js ≥ 22.19 (ESM). No web framework — a small router on `node:http`.
- **Redis:** `ioredis`, for bearer tokens, daily counters and stream-job state.
- **Extraction:** the Innertube `player` endpoint via `youtubei.js`, exclusively through Webshare, with client and proxy fallback ladders.
- **SoundCloud:** public track and set links resolve through web-player metadata to progressive audio or HLS. HLS streams require an HLS-capable player, such as FFmpeg. Blocked and preview-only tracks are rejected.
- **Bot:** raw Telegram Bot API over HTTPS (`sendRichMessage` / `editMessageText`
  with `rich_message: { html }`), long-polled with `getUpdates`. No MTProto client.

## Layout

```
src/
  index.ts            entrypoint: config, redis, HTTP server, optional bot
  httpServer.ts       router, middleware (rate limit + metrics), result plumbing
  apiRoutes.ts        every HTTP endpoint
  routeArgs.ts        query validation + FastAPI argument tables
  streamJobs.ts       Redis stream jobs, extraction leases, local memo/events
  streamProxy.ts      media byte relay and bounded playback resumption (node:http)
  hlsProxy.ts         validated HLS playlist/segment capability relay
  proxy.ts         country-aware proxy inventory and extraction health
  innertube.ts        Innertube client + related-video parsing
  searchService.ts    YouTube search scrape (in-process + Upstash cache)
  cacheManager.ts     stream-URL cache (Redis + container-local file)
  metrics.ts          Prometheus text exposition
  telegram/           Bot API client, rich UI helpers, commands/callbacks/admin
```

## Running

```sh
npm install
npm run build      # tsc -> dist/ (+ copies favicon assets)
npm start          # node dist/index.js
npm run dev        # rebuild-on-watch
npm run typecheck
npm test           # vitest
```

Configuration is environment-only (see `.env.example`). A `.env` file is loaded
with `setdefault` semantics, so real environment variables win. A missing
`BOT_TOKEN` leaves the process serving the HTTP API standalone.

`REDIS_URL`, when set, defines the whole Redis connection and overrides the
discrete Redis settings. Use `rediss://` for TLS and a path such as `/2` for the
database. A URL without a port uses 6379; discrete settings retain their own
configured port. Invalid connection URLs fail at startup without logging credentials.

## Behavior notes

- Quotas and their reset headers use the next midnight UTC. Granting quota does
  not extend the current day's window.
- YouTube Data API key cooldowns follow Google's midnight reset in US Pacific,
  including daylight-saving changes.
- Stream extraction uses a separate 120-second Redis lease. Concurrent workers
  share one attempt, and an expired worker cannot overwrite its successor.
  Background jobs have a 100-second deadline; individual YouTube resolutions
  have 42 seconds. Resolver requests wait up to 105 seconds, including any
  recovery wait. A job still pending returns `202` with `Retry-After: 2`;
  terminal extraction failure returns `502`. Disconnected callers stop waiting
  while background extraction retains its own job deadline.
- Public search remains free. Uncached YouTube Data API searches share Redis
  admission limits across replicas: 5,000 quota units per Pacific day, 10 attempts
  per rolling minute, and four concurrent search requests by default. Each
  attempt reserves 101 units for search and its possible details request.
  Successful results are cached for five minutes. Set
  `YOUTUBE_SEARCH_DAILY_BUDGET`, `YOUTUBE_SEARCH_REQUESTS_PER_MINUTE`, and
  `YOUTUBE_SEARCH_MAX_CONCURRENCY` to tune these limits. An explicit Data API
  search returns 429 when admission is denied and 503 when Redis admission is
  unavailable; cached results remain usable. Scraped search remains available.
- Finite playlists follow continuation pages, with limits of 5,000 songs,
  100 pages, and 30 seconds. Failure to finish produces an error instead of a
  successful partial list. YouTube Mix playlists return the current generated
  panel, since a Mix has no fixed end.

- **Auth runs before routing.** An unauthenticated request to any protected path
  (or an unknown path) returns the middleware's `401`, never a `404`/`422`.
- **`/stream` returns a bearer resolver URL**, not the raw CDN URL. The resolver
  relays bytes through the verified playback route. Its capability contains
  `base64url(sha256("{mode}:{url}"))` plus a random secret; the deterministic
  identifier alone cannot authorize playback.
- **Rejected sources receive one verified refresh per resolver request.** A
  CDN `403`, `404`, or `410`, or a recoverable dial failure through a pinned
  proxy, triggers cache invalidation and re-extraction through Webshare,
  excluding the previous proxy exit. The replacement must pass playback checks,
  and the original capability secret is preserved.
- **Interrupted finite media can resume without re-extraction.** For eligible
  signed media responses, the relay makes at most two reconnections after
  transient resets or truncated transfers. It keeps the same URL and proxy exit,
  requests exactly the remaining byte interval, and verifies the representation
  and range before forwarding more bytes.
- **Fresh YouTube extraction requires Webshare.** Innertube bootstrap and player
  requests, including metadata fallback sessions, always use a Webshare exit.
  There is no direct extraction fallback when `WEBSHARE_API_KEY` is missing or
  every exit fails. Existing validated cached streams remain usable. Region
  restrictions reported by proxied player requests steer later attempts to
  suitable countries.
  Concurrent callers share bootstrap for an exit and extraction for the same
  video. Player requests are limited to eight active calls per process and one
  per exit. Repeated proxy failures start a five-minute cooldown that survives
  proxy-list refreshes; recent extraction successes receive priority. Content
  unavailability does not count as a proxy failure.
- **Video requests require video.** An unavailable muxed/video source does not
  silently fall back to audio. Live HLS selection validates the requested mode,
  including video and its required audio rendition groups.
- **Webshare extraction does not force Webshare media transfer.** For every
  fresh candidate, each format is probed directly from the API server first.
  If that succeeds, the cached playback route omits Webshare. Otherwise, the
  media is checked through the extracting Webshare exit and retains that binding
  only if it works. Audio and video keep independent routes when necessary.
  The API continues relaying media through the existing resolver flow; this
  avoids Webshare bandwidth for accessible sources, not the API server's own
  media bandwidth.
- **Caches and jobs carry a playback validation version.** Legacy Redis/file
  cache entries are re-extracted instead of bypassing current checks. Existing
  stream jobs migrate lazily through a shared extraction owner while retaining
  the capability secret, so previously issued resolver URLs remain valid.
- **Fresh stream URLs receive a lightweight media check before publication.**
  This covers both YouTube formats, normal/recovery proxy candidates, and direct
  SoundCloud/JioSaavn URLs. The check uses the playback proxy binding and requests
  `bytes=0-16383`, inspecting at most 16 KiB before closing the response. YouTube
  CDN URLs must first pass an ordinary GET with a bounded 16 KiB read: some
  signed URLs serve a tiny range but reject normal playback with HTTP 403/404.
  Both checks use the same URL and direct/Webshare route. This retains at most
  32 KiB for a successful YouTube check; socket buffers can receive additional
  bytes, including when the origin ignores Range.
  Each source check has one five-second budget shared by both requests and queue
  time, with four active checks and at most 64 pending distinct routes per process.
  Duplicate checks coalesce;
  successes are cached for five minutes (or signed expiry, if sooner), keyed by
  URL and full proxy identity, with at most 2,048 entries. Rejected routes clear
  their probe result. Existing stream-cache hits avoid another network check.
  Bad status/ranges, empty or truncated samples, HTML/JSON errors, and unrecognized
  media headers are rejected. Recognized prefixes include MP4/M4A, WebM, MP3/AAC,
  Ogg, FLAC, WAV, and MPEG-TS. This checks source accessibility and basic format
  plausibility without FFmpeg, decoding, or codec compatibility checks.
- **Live HLS uses a playlist and resource relay.** Selection validates root and
  child playlists plus real media segments for the requested audio/video mode.
  The relay rewrites playlists to opaque local capabilities for child playlists,
  segments, keys, and initialization resources, preserving the selected proxy
  route. Child authority cannot outlive its parent: direct root capabilities
  last up to four hours and proxy-pinned roots up to one hour; segment/resource
  tokens last at most five minutes. Child playlists reload under that bounded
  authority. The separate HLS source cache lasts 60 seconds; that freshness limit
  does not shorten an issued capability's stable manifest-reload session.
  Playback requires an HLS-capable player, such as FFmpeg. CDN blocks and live
  source changes can still prevent playback; these checks do not guarantee
  uninterrupted delivery.
- Proxy agents retired from the connection cache drain existing streams before
  closing. New proxy credentials receive a separate agent.
- Telegram polling conflicts retry after 30 seconds. Terminal polling failures
  are logged and stop polling while leaving the HTTP API running; shutdown also
  cancels pending polling retries.
- **Bot UI degrades.** If rich or ephemeral delivery is unavailable, group cards
  use an explicitly safe public fallback. Otherwise, delivery falls back to a
  direct message. Credential-bearing content is never implicitly made public.
