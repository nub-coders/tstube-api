/**
 * Bot entrypoint — grammY-powered Bot API 10.3 engine with custom emojis support.
 *
 * Handler registration mirrors the Python decorators: commands in
 * plugins/commands.py + status.py (any chat), and the private-only admin
 * commands from admin.py / broadcast.py.
 */
import { Bot } from 'grammy';
import { TelegramApi, type CallbackQuery, type TgMessage } from './api.js';
import { BOT_COMMANDS, cmdHelp, cmdMenu, cmdPing, cmdPlatforms, cmdRevoke, cmdStart, cmdStatus, cmdToken } from './commands.js';
import {
  cmdAdminHelp,
  cmdBroadcast,
  cmdCookieProbe,
  cmdCookiePurge,
  cmdCookies,
  cmdCookieTerminate,
  cmdCookieUpload,
  cmdErrors,
  cmdGrant,
  cmdListUsers,
  cmdRevokeAdmin,
  cmdStats,
  cmdUser,
} from './admin.js';
import { handleCallback } from './callbacks.js';
import { buildStats } from './adminContent.js';
import type { Config } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('ytube_api.bot');

const USER_RE = /^\/user\s+\d+/;
const GRANT_RE = /^\/grant\s+\d+\s+\d+/;
const REVOKE_ID_RE = /^\/revoke\s+\d+/;

const PRIVATE_ONLY = new Set(['stats', 'user', 'grant', 'revoke', 'listusers', 'adminhelp', 'errors', 'broadcast', 'cookies', 'cookie_terminate', 'cookie_probe', 'cookie_upload', 'cookie_purge']);

export async function dispatchMessage(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!msg.from || msg.from.is_bot) return;
  const text = msg.text ?? '';
  if (!text.startsWith('/')) return;

  const isPrivate = msg.chat.type === 'private';
  const command = text.split(/\s+/)[0]!.slice(1).split('@')[0]!.toLowerCase();

  // Private-only admin commands keyed on real args (regex filters in Python).
  if (isPrivate) {
    if (USER_RE.test(text)) return cmdUser(api, msg);
    if (GRANT_RE.test(text)) return cmdGrant(api, msg);
    if (REVOKE_ID_RE.test(text)) return cmdRevokeAdmin(api, msg);
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
    case 'cookies':
      return cmdCookies(api, msg);
    case 'cookie_terminate':
      return cmdCookieTerminate(api, msg);
    case 'cookie_probe':
      return cmdCookieProbe(api, msg);
    case 'cookie_upload':
      return cmdCookieUpload(api, msg);
    case 'cookie_purge':
      return cmdCookiePurge(api, msg);
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
  log.info(`[BOT] Started @${me.username ?? me.first_name} (${me.id}) via grammY (Bot API 10.3)`);

  // Pre-warm stats cache in background so admin button responds instantly
  void buildStats(api).catch(() => {});

  bot.on('message:text', async (ctx) => {
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

  void bot.start({
    allowed_updates: ['message', 'callback_query'],
  });

  return async () => {
    await bot.stop();
  };
}
