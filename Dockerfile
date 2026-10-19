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
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/tstube-entrypoint

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
ENTRYPOINT ["tstube-entrypoint"]
CMD ["node", "dist/index.js"]
