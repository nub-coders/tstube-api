# tstube-api

A TypeScript rewrite of the `ytube_api` FastAPI service + Telegram bot. The HTTP
responses, status codes, JSON key order, error envelopes, rate limiting and the
bot's rich-message UI are ports of the Python original, not reinterpretations.

## Stack

- **Runtime:** Node.js ≥ 22 (ESM). No web framework — a small router on `node:http`.
- **Redis:** `ioredis`, for bearer tokens, daily counters and stream-job state.
- **Extraction:** the Innertube `player` endpoint first (one HTTP call), with
  `yt-dlp -g` / `yt-dlp -j` as the fallback.
- **Bot:** raw Telegram Bot API over HTTPS (`sendRichMessage` / `editMessageText`
  with `rich_message: { html }`), long-polled with `getUpdates`. No MTProto client.

## Layout

```
src/
  index.ts            entrypoint: config, redis, HTTP server, optional bot
  httpServer.ts       router, middleware (rate limit + metrics), result plumbing
  apiRoutes.ts        every HTTP endpoint
  routeArgs.ts        query validation + FastAPI argument tables
  streamJobs.ts       redis-backed stream jobs, local memo/events/refresh locks
  streamProxy.ts      byte-proxy for googlevideo URLs (node:http, never fetch)
  innertube.ts        Innertube client + related-video parsing
  searchService.ts    YouTube search scrape (in-process + Upstash cache)
  ytdlp.ts            yt-dlp subprocess runner (global semaphore)
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

## Behavior notes

- **Auth runs before routing.** An unauthenticated request to any protected path
  (or an unknown path) returns the middleware's `401`, never a `404`/`422`.
- **`/stream` returns a resolver URL**, not the raw CDN URL: googlevideo signs the
  extracting host's IP into the link, so `…/stream/resolver/{id}` proxies the
  bytes. `{id}` is `base64url(sha256("{mode}:{url}"))`.
- **Revoked URLs are retried once.** A `403`/`410` from the CDN triggers a single
  cache invalidation + re-extraction; `404` is deliberately not retried.
- **Bot UI degrades.** If rich messages are unsupported (or the bot isn't a group
  admin, so ephemeral delivery is rejected), the same card is sent as classic
  HTML + inline keyboard rather than being lost.

