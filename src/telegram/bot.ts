/**
 * Bot entrypoint — grammY-powered Bot API 10.3 engine with custom emojis support.
 *
 * Handler registration mirrors the Python decorators: commands in
 * plugins/commands.py + status.py (any chat), and the private-only admin
 * commands from admin.py / broadcast.py.
 */
import { Bot } from 'grammy';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramApi, type CallbackQuery, type TgMessage } from './api.js';
import { BOT_COMMANDS, cmdHelp, cmdMenu, cmdPing, cmdPlatforms, cmdRevoke, cmdStart, cmdStatus, cmdToken } from './commands.js';
import {
  cmdAdminHelp,
  cmdBroadcast,
  cmdErrors,
  cmdGrant,
  cmdListUsers,
  cmdProxyStats,
  cmdRevokeAdmin,
  cmdStats,
  cmdUser,
} from './admin.js';
import { handleCallback } from './callbacks.js';
import { buildStats } from './adminContent.js';
import type { Config } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('ytube_api.bot');

const USER_RE = /^\/user(@\w+)?\s+\d+/i;
const GRANT_RE = /^\/grant(@\w+)?\s+\d+\s+\d+/i;
const REVOKE_ID_RE = /^\/revoke(@\w+)?\s+\d+/i;

const PRIVATE_ONLY = new Set([
  'stats',
  'proxystats',
  'webshare',
  'user',
  'grant',
  'listusers',
  'adminhelp',
  'errors',
  'broadcast',
]);

export async function dispatchMessage(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!msg.from || msg.from.is_bot) return;
  const text = msg.text ?? msg.caption ?? '';
  if (!text.startsWith('/')) return;

  const isPrivate = msg.chat.type === 'private';
  const command = text.split(/\s+/)[0]!.slice(1).split('@')[0]!.toLowerCase();

  // Admin /revoke <id> is private-only; general /revoke is public for self-revocation
  if (command === 'revoke' && REVOKE_ID_RE.test(text)) {
    if (!isPrivate) return;
    return cmdRevokeAdmin(api, msg);
  }

  // Private-only admin commands keyed on real args (regex filters in Python).
  if (isPrivate) {
    if (USER_RE.test(text)) return cmdUser(api, msg);
    if (GRANT_RE.test(text)) return cmdGrant(api, msg);
  }

  if (PRIVATE_ONLY.has(command) && !isPrivate) return;

  switch (command) {
    case 'start':
      return cmdStart(api, msg);
    case 'menu':
      return cmdMenu(api, msg);
    case 'ping':
      return cmdPing(api, msg);
    case 'status':
      return cmdStatus(api, msg);
    case 'token':
      return cmdToken(api, msg);
    case 'stats':
      return cmdStats(api, msg);
    case 'proxystats':
    case 'webshare':
      return cmdProxyStats(api, msg);
    case 'user':
      return cmdUser(api, msg);
    case 'grant':
      return cmdGrant(api, msg);
    case 'listusers':
      return cmdListUsers(api, msg);
    case 'adminhelp':
      return cmdAdminHelp(api, msg);
    case 'errors':
      return cmdErrors(api, msg);
    case 'broadcast':
      return cmdBroadcast(api, msg);
    case 'platforms':
      return cmdPlatforms(api, msg);
    case 'help':
      return cmdHelp(api, msg);
    case 'revoke':
      return cmdRevoke(api, msg);
    default:
      return;
  }
}

/**
 * Start the bot's long-poll loop using grammY with Bot API 10.3.
 * Returns a function that gracefully stops polling.
 */
export async function startBot(cfg: Config): Promise<() => Promise<void>> {
  if (!cfg.BOT_TOKEN) throw new Error('BOT_TOKEN is required to start the bot');

  const bot = new Bot(cfg.BOT_TOKEN);
  const api = new TelegramApi(cfg.BOT_TOKEN, bot.api);

  await bot.api.deleteWebhook({ drop_pending_updates: false });
  await bot.api.setMyCommands(BOT_COMMANDS);
  const me = await bot.api.getMe();
  bot.botInfo = me;
  log.info(`[BOT] Started @${me.username ?? me.first_name} (${me.id}) via grammY (Bot API 10.3)`);

  // Pre-warm stats cache in background so admin button responds instantly
  void buildStats(api).catch(() => {});

  bot.on(['message:text', 'message:caption'], async (ctx) => {
    try {
      await dispatchMessage(api, ctx.message as unknown as TgMessage);
    } catch (e) {
      log.error('[BOT] message handler failed', { err: String(e) });
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    try {
      await handleCallback(api, ctx.callbackQuery as unknown as CallbackQuery);
    } catch (e) {
      log.error('[BOT] callback handler failed', { err: String(e) });
    }
  });

  bot.catch((err) => {
    log.error('[BOT] grammY error caught', { err: String(err.error) });
  });

  const stopping = new AbortController();
  // grammY's middleware error handler does not handle polling failures.
  // Supervise this promise for its entire lifetime, including restarts.
  const polling = (async () => {
    while (!stopping.signal.aborted) {
      try {
        await bot.start({ allowed_updates: ['message', 'callback_query'] });
        return;
      } catch (error) {
        if (stopping.signal.aborted) return;
        const code = (error as { error_code?: number })?.error_code;
        if (code !== 409) {
          log.error('[BOT] Polling stopped; HTTP API remains available', { err: String(error) });
          return; // Invalid credentials and other terminal failures need operator action.
        }
        log.warning('[BOT] Polling conflict; retrying in 30 seconds');
        await delay(30_000, undefined, { signal: stopping.signal }).catch((error: unknown) => {
          if (!stopping.signal.aborted) throw error;
        });
      }
    }
  })().catch((error: unknown) => {
    log.error('[BOT] Polling supervisor failed', { err: String(error) });
  });

  return async () => {
    stopping.abort();
    try {
      if (bot.isRunning()) await bot.stop();
    } catch (error) {
      log.warning('[BOT] Failed to confirm polling shutdown', { err: String(error) });
    }
    await polling;
  };
}
