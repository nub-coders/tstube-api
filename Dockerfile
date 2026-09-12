# ── build ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /src

# Manifests first, so editing source doesn't re-resolve the dependency tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# tsc -> dist/, then drop the dev-only toolchain (typescript, vitest).
RUN npm run build && npm prune --omit=dev

# ── runtime ─────────────────────────────────────────────────────────────────
# python:3.13-slim because yt-dlp comes from PyPI exactly as it did in the
# Python deployment: `yt-dlp[default]` drags in the extras (EJS challenge
# solver, curl_cffi) that the standalone PyInstaller release does not track
# identically. Node is layered on top for the service itself.
FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        gnupg \
        unzip \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# deno: the JS runtime yt-dlp uses to solve YouTube's EJS challenge.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && deno --version

# yt-dlp is deliberately unpinned: YouTube breaks extractors every 1-2 weeks,
# so every build takes the latest. Trade-off: a bad release can regress
# extraction with no lockfile to roll back to — rebuild to recover.
# ponytail: pin (==<version>) if rollback-safe deploys matter more than
# same-day YouTube fixes.
RUN pip install --no-cache-dir --upgrade 'yt-dlp[default]'

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY cookies.txt* ./

# Non-root: the process writes COOKIES_FILE and yt-dlp's cache into its home.
RUN useradd --create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app
USER app
ENV HOME=/home/app
ENV NODE_ENV=production

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# API and bot are one process: START_BOT decides which halves run. Configure by
# env (see .env.example). A missing BOT_TOKEN leaves the process serving the API
# standalone rather than exiting.
CMD ["node", "dist/index.js"]
