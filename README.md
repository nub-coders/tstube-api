# TsTube API

High-performance, lightweight YouTube and SoundCloud extraction engine, media streaming relay, and Telegram bot written in TypeScript for Node.js.

TsTube API delivers fast, resilient media resolution and playback relaying without heavy external web frameworks, utilizing native Node.js HTTP servers, Innertube (`youtubei.js`), rotating proxy pools, and Redis distributed coordination.

---

## Features

- **Zero-Framework Architecture:** Powered directly by `node:http` with strict route validation, minimal dependencies, and high throughput.
- **Resilient Extraction Pipeline:** Multi-client Innertube resolution backed by automated Webshare proxy rotation, geo-targeted bypass, and cooldown tracking.
- **Smart Stream Relay & Resumption:** Returns opaque, capability-secured stream URLs that relay media, handle CDN renegotiation, and resume interrupted transfers automatically.
- **Validated HLS Delivery:** Rewrites master/variant playlists and child segments into scoped proxy tokens for seamless playback on modern players.
- **SoundCloud Integration:** Direct resolution of public tracks and sets into progressive or HLS audio streams.
- **Distributed State Management:** Redis-backed rate limiting, quota tracking, in-flight extraction leases, and cross-replica coordination.
- **Dual-Mode Telegram Bot:** Interactive bot built with `grammY` supporting inline search, rich HTML message cards, user quotas, and administrative controls.
- **Observability:** Built-in Prometheus metrics exposition (`/metrics`) and structured JSON logging.

---

## Architecture Overview

```
                      ┌─────────────────────────────────────────┐
                      │              Edge / Traefik             │
                      └────────────────────┬────────────────────┘
                                           │
                        ┌──────────────────┴──────────────────┐
                        │                                     │
                        ▼                                     ▼
             ┌─────────────────────┐               ┌─────────────────────┐
             │   tstube-api (xN)   │               │   tstube-bot (x1)   │
             │   HTTP API Server   │               │ Telegram Long-Poll  │
             └──────────┬──────────┘               └──────────┬──────────┘
                        │                                     │
                        ├──────────────────┬──────────────────┤
                        ▼                  ▼                  ▼
             ┌─────────────────────┐ ┌───────────┐ ┌─────────────────────┐
             │   Webshare Proxies  │ │   Redis   │ │    YouTube CDN      │
             │ (Rotating Outbound) │ │  (State)  │ │   (Direct/Relay)    │
             └─────────────────────┘ └───────────┘ └─────────────────────┘
```

---

## Deployment with Docker

The repository includes a multi-stage `Dockerfile` and a production-ready `docker-compose.yml` configured for zero-downtime horizontal scaling.

### 1. Configure Environment

Copy the example environment file and customize your settings:

```bash
cp .env.example .env
```

Ensure you configure your Redis host and credentials, Webshare API key (for YouTube extraction), and Telegram Bot token if running the bot.

### 2. Launch Services with Docker Compose

The `docker-compose.yml` file splits the application into two dedicated service roles sharing the same base image:

- `tstube-api`: Stateless HTTP API service (safe to scale horizontally).
- `tstube-bot`: Dedicated Telegram bot poller (strictly 1 replica to avoid polling conflicts).

```bash
# Build images and start containers in the background
docker compose up -d --build

# Inspect running containers
docker compose ps

# View unified real-time logs
docker compose logs -f
```

### 3. Scaling the API Service

Because extraction job leases and rate-limiting counters live in Redis, you can scale the API service to handle heavy traffic:

```bash
docker compose up -d --scale tstube-api=4
```

### 4. Running Directly with Docker

You can also build and run an isolated container manually:

```bash
# Build the Docker image
docker build -t tstube-api:latest .

# Run the container
docker run -d \
  --name tstube-api \
  --env-file .env \
  -p 8000:8000 \
  tstube-api:latest
```

---

## Local Development

### Prerequisites

- **Node.js:** `>= 22.19.0`
- **Redis:** `>= 6.2` (local instance or remote connection URL)

### Setup & Commands

```bash
# Install dependencies
npm install

# Build TypeScript to dist/ and copy static assets
npm run build

# Start the application in production mode
npm start

# Run with file watcher during development
npm run dev

# Execute TypeScript typechecking without emitting files
npm run typecheck

# Run unit and integration tests with Vitest
npm test

# Run Vitest in interactive watch mode
npm run test:watch
```

---

## Configuration Reference

All settings are configured via environment variables (loaded from `.env` on startup):

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | Port for the HTTP API server |
| `API_HOST` | `api.example.com` | Primary hostname used for link generation and routing |
| `BASE_URL` | `https://api.example.com` | Base public URL prepended to streaming endpoints |
| `REDIS_URL` | _None_ | Complete Redis connection string (e.g. `redis://:pass@host:6379/0`) |
| `REDIS_HOST` | `localhost` | Redis host when `REDIS_URL` is omitted |
| `REDIS_PORT` | `15440` | Redis port when `REDIS_URL` is omitted |
| `REDIS_PASSWORD` | _None_ | Redis authentication password |
| `START_BOT` | `true` | Set to `true` to start the Telegram bot process |
| `BOT_TOKEN` | _None_ | Telegram Bot token obtained from `@BotFather` |
| `ADMIN_IDS` | `""` | Space-separated list of numeric Telegram User IDs for admins |
| `TG_GROUP` | `""` | Support group username |
| `TG_CHANNEL` | `""` | Announcement channel username |
| `WEBSHARE_API_KEY` | _None_ | Webshare API key for rotating extraction proxies |
| `WEBSHARE_PROXY_COUNTRIES` | `""` | Comma-separated ISO country codes to filter proxy exits |
| `WEBSHARE_REFRESH_SEC` | `600` | Frequency in seconds to refresh proxy IP lists |
| `EXTRACTION_DIRECT_FALLBACK`| `false` | Fall back to direct connection if proxy pool is empty |
| `YOUTUBE_API_KEYS` | `""` | Comma-separated official YouTube Data API v3 keys |
| `YOUTUBE_SEARCH_DAILY_BUDGET`| `5000` | Maximum daily Data API quota units allocated to search |
| `DAILY_LIMIT` | `1000` | Daily request quota allocated to standard user tokens |
| `ADMIN_LIMIT` | `100000` | Daily request quota allocated to administrator tokens |

---

## API Endpoints

### Public Endpoints

- `GET /health` — Health check and operational diagnostics.
- `GET /search?q={query}&page={page}` — Free scraped YouTube search or quota-guarded Data API search.
- `GET /trending?limit={n}` — Current popular / trending videos.
- `GET /suggest?q={query}` — Search keyword suggestions and auto-completions.
- `GET /metrics` — Prometheus metrics format endpoint.
- `GET /rate-limit-status` — Inspect caller quota, daily usage, and reset windows.

### Protected Endpoints (Bearer Token Required)

Authentication is provided via the `Authorization: Bearer <TOKEN>` header or `?token=<TOKEN>` query argument.

- `GET /info?url={url}` — Fetch video details, formats, and related content. In-flight requests are automatically deduplicated and cached.
- `GET /stream?url={url}&mode={audio|video}` — Resolves target media and issues an opaque, secured capability URL (`/stream/resolver/{token}`).
- `GET /playlist?url={url}` — Paginates and resolves all items within a playlist.

### Streaming Relay

- `GET /stream/resolver/{stream_id}` — Capability-authorized media relay. Relays verified bytes directly or via pinned proxy exit, supporting HTTP Range requests and connection recovery.

---

## Telegram Bot Interface

When `START_BOT=true` and `BOT_TOKEN` is set, the built-in bot provides user and management interfaces:

### User Commands
- `/start` — Welcome overview, account information, and usage limits.
- `/menu` — Interactive card with quick actions and search options.
- `/token` — View or refresh personal API access token.
- `/ping` — Response latency and health check.

### Admin Commands
- `/admin` — Open administrative control panel.
- `/stats` — Real-time telemetry, active connections, and proxy health stats.
- `/grant <user_id> [count]` — Grant additional request quota to a user.
- `/revoke <user_id>` — Revoke active token and reset access.
- `/ban <user_id>` / `/unban <user_id>` — Manage access blocklists.

---

## License

This project is open-source software licensed under the [MIT License](LICENSE).
