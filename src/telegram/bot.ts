/**
 * Bot entrypoint — port of bot.py's setup_bot_commands + Pyrogram plugin
 * dispatch, running on the raw Bot API long-polling loop.
 *
 * Handler registration mirrors the Python decorators: commands in
 * plugins/commands.py + status.py (any chat), and the private-only admin
 * commands from admin.py / broadcast.py.
 */
import { TelegramApi, type TgMessage } from './api.js';
import { BOT_COMMANDS, cmdMenu, cmdPing, cmdStart, cmdStatus, cmdToken } from './commands.js';
import {
  cmdAdminHelp,
  cmdBroadcast,
  cmdErrors,
  cmdGrant,
  cmdListUsers,
  cmdRevokeAdmin,
  cmdStats,
  cmdUser,
} from './admin.js';
import { handleCallback } from './callbacks.js';
import type { Config } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('ytube_api.bot');

const USER_RE = /^\/user\s+\d+/;
const GRANT_RE = /^\/grant\s+\d+\s+\d+/;
const REVOKE_ID_RE = /^\/revoke\s+\d+/;

const PRIVATE_ONLY = new Set(['stats', 'listusers', 'adminhelp', 'errors', 'broadcast']);

async function dispatchMessage(api: TelegramApi, msg: TgMessage): Promise<void> {
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
    default:
      // /help and /revoke (bare) advertise in the command menu but have no
      // handlers in Python — intentionally left as no-ops for parity.
      return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the bot's long-poll loop. Returns a function that stops it after the
 * in-flight update finishes.
 */
export async function startBot(cfg: Config): Promise<() => Promise<void>> {
  if (!cfg.BOT_TOKEN) throw new Error('BOT_TOKEN is required to start the bot');

  const api = new TelegramApi(cfg.BOT_TOKEN);
  await api.deleteWebhook();
  await api.setMyCommands(BOT_COMMANDS);
  const me = await api.getMe();
  log.info(`[BOT] Started @${me.username ?? me.first_name} (${me.id})`);

  let running = true;
  let offset: number | undefined;

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        const updates = await api.getUpdates({
          offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const update of updates) {
          if (!running) break;
          offset = update.update_id + 1;
          try {
            if (update.message) await dispatchMessage(api, update.message);
            else if (update.callback_query) await handleCallback(api, update.callback_query);
          } catch (e) {
            log.error('[BOT] handler failed', { err: String(e) });
          }
        }
      } catch (e) {
        if (!running) break;
        log.error('[BOT] getUpdates failed, retrying', { err: String(e) });
        await sleep(2000);
      }
    }
  };

  void loop();

  return async () => {
    running = false;
  };
}
