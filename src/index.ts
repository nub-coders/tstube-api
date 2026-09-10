/**
 * Entrypoint — mirrors main.py's `if __name__ == "__main__"` and lifespan.
 *
 * Starts the HTTP API always, and the Telegram bot when BOT_TOKEN + START_BOT
 * are enabled. Cookies bootstrap runs in the background so a slow browser probe
 * never delays startup or /health.
 */
import { loadConfig } from './config.js';
import { setupJsonLogging, getLogger } from './logger.js';
import { createRedis, closeRedis } from './redis.js';
import { createAppServer, metricsHandler, rateLimitStatus, type Handler } from './httpServer.js';
import * as routes from './apiRoutes.js';
import { bootstrap as bootstrapCookies, startRefresh, stopRefresh } from './cookies.js';

const log = getLogger('ytube_api.main');

const HTTP_PORT = 8000;
const HTTP_HOST = '0.0.0.0';

const routeTable: Array<[string, Handler]> = [
  ['/', routes.root],
  ['/search', routes.searchSongs],
  ['/trending', routes.trendingSongs],
  ['/suggest', routes.suggestSongs],
  ['/stream/redirect', routes.streamRedirect],
  ['/stream', routes.streamUrl],
  ['/stream/resolver/{stream_id}', routes.streamResolver],
  ['/stream/proxy/{stream_id}', routes.streamResolver],
  ['/info', routes.videoInfo],
  ['/playlist', routes.playlistSongs],
  ['/health', routes.health],
  ['/rate-limit-status', rateLimitStatus],
  ['/metrics', metricsHandler],
  ['/favicon.ico', routes.faviconIco],
  ['/favicon.svg', routes.faviconSvg],
];

async function main(): Promise<void> {
  const cfg = loadConfig();
  setupJsonLogging(cfg);
  createRedis(cfg);

  if (!cfg.TESTING) {
    // Best-effort: browser probe can take up to 60s per browser.
    void (async () => {
      try {
        await bootstrapCookies(cfg);
        startRefresh(cfg);
      } catch (e) {
        log.warning(`[STARTUP] Cookie bootstrap skipped: ${String(e)}`);
      }
    })();
  }

  const server = createAppServer({ routes: routeTable });
  server.listen(HTTP_PORT, HTTP_HOST, () => {
    log.info(`[STARTUP] HTTP API listening on http://${HTTP_HOST}:${HTTP_PORT}`);
  });

  let stopBot: (() => Promise<void>) | null = null;
  if (cfg.BOT_TOKEN && cfg.START_BOT) {
    try {
      const { startBot } = await import('./telegram/bot.js');
      stopBot = await startBot(cfg);
    } catch (e) {
      log.error(`[STARTUP] Bot failed: ${String(e)} — running HTTP API standalone`);
    }
  } else if (!cfg.START_BOT) {
    log.info('[STARTUP] Telegram bot disabled via configuration (START_BOT=false).');
  } else {
    log.warning('[STARTUP] BOT_TOKEN is not set. Telegram bot will not start.');
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`[SHUTDOWN] ${signal} — stopping`);
    stopRefresh();
    if (stopBot) {
      try {
        await stopBot();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error(`[FATAL] ${String(e)}`);
  process.exit(1);
});
