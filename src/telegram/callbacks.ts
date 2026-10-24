/**
 * Callback-query handlers — port of the `@Client.on_callback_query()` switch in
 * plugins/commands.py (including the admin_refresh_stats branch).
 */
import type { CallbackQuery, TelegramApi } from './api.js';
import { btn, keyboard, ButtonStyle, sendSmartRichMessage, editSmartRichMessage } from './rich.js';
import {
  apiDocs,
  apiInfoGet,
  backMenu,
  help,
  implQuickRef,
  platformsCard,
  revoked,
  revokeConfirm,
  usageCallback,
  viewTokenGroup,
  type Card,
} from './callbackContent.js';
import { buildStats, ACCESS_DENIED, webshareStatsCard } from './adminContent.js';
import { generateToken, getUserRequestCount, getUserToken, revokeUserToken, setUserToken } from '../tools.js';
import { isAdmin, config } from '../config.js';
import { getLogger } from '../logger.js';
import { websharePool } from '../proxy.js';

const log = getLogger('ytube_api.bot');

function isGroup(cb: CallbackQuery): boolean {
  return !!cb.message && cb.message.chat.type !== 'private';
}

async function answer(
  api: TelegramApi,
  cb: CallbackQuery,
  text?: string,
  showAlert = false,
): Promise<void> {
  try {
    await api.answerCallbackQuery({ callback_query_id: cb.id, text, show_alert: showAlert });
  } catch (e) {
    log.debug('[CALLBACK] answer failed', { err: String(e) });
  }
}

/** Group menus can contain user-specific credentials: always deliver cards privately. */
async function editCard(api: TelegramApi, cb: CallbackQuery, card: Card): Promise<void> {
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  if (cb.message?.chat.type === 'private' && chatId === cb.from.id && messageId !== undefined) {
    const ok = await editSmartRichMessage(api, chatId, messageId, card.html, card.keyboard);
    if (ok) return;
  }
  const delivered = await sendSmartRichMessage(api, cb.from.id, card.html, { replyMarkup: card.keyboard });
  if (!delivered) {
    await answer(api, cb, 'Open a private chat with the bot to view this information.', true);
  }
}

export async function handleCallback(api: TelegramApi, cb: CallbackQuery): Promise<void> {
  const userId = cb.from.id;
  const data = cb.data ?? '';
  const isGrp = isGroup(cb);

  switch (data) {
    case 'view_token': {
      const token = await getUserToken(userId);
      if (!token) {
        await answer(api, cb, '❌ No token found. Use /start to get one.', true);
        break;
      }
      if (isGrp) {
        const chatId = cb.message?.chat.id ?? userId;
        try {
          await api.sendRichMessage({
            chat_id: chatId,
            rich_message: { html: viewTokenGroup(token) },
            ephemeral_message_parameters: { receiver_user_id: userId },
          });
          await answer(api, cb, '🔑 Token sent ephemerally!', false);
        } catch {
          await answer(api, cb, `🔑 Your API Token: ${token}`, true);
        }
      } else {
        await answer(api, cb, `🔑 Your API Token: ${token}`, true);
      }
      break;
    }

    case 'get_token': {
      let token = await getUserToken(userId);
      if (!token) {
        token = generateToken();
        await setUserToken(userId, token);
      }
      if (isGrp) {
        const chatId = cb.message?.chat.id ?? userId;
        try {
          await api.sendRichMessage({
            chat_id: chatId,
            rich_message: { html: viewTokenGroup(token) },
            ephemeral_message_parameters: { receiver_user_id: userId },
          });
          await answer(api, cb, '🔑 Token generated ephemerally!', false);
        } catch {
          await answer(api, cb, `🔑 Your API Token: ${token}`, true);
        }
      } else {
        await answer(api, cb, `🔑 Your API Token: ${token}`, true);
      }
      break;
    }

    case 'usage_status': {
      const token = await getUserToken(userId);
      if (!token) {
        await answer(api, cb, '❌ No token found. Use /start to get one.', true);
        return;
      }
      const requestCount = await getUserRequestCount(userId);
      const admin = isAdmin(userId);
      const limit = admin ? config().ADMIN_LIMIT : config().DAILY_LIMIT;
      const proxyHealth = await websharePool.getPublicHealth();
      await answer(api, cb);
      await editCard(api, cb, usageCallback(token, requestCount, limit, admin, isGrp, proxyHealth));
      break;
    }

    case 'revoke_token':
      await answer(api, cb);
      await editCard(api, cb, revokeConfirm());
      break;

    case 'confirm_revoke': {
      const newToken = generateToken();
      // Replacement removes the previous mapping atomically.
      await setUserToken(userId, newToken);
      await answer(api, cb, '✅ Token revoked successfully!');
      await editCard(api, cb, revoked(newToken));
      break;
    }

    case 'help': {
      const userToken = (await getUserToken(userId)) ?? 'YOUR_TOKEN';
      await answer(api, cb);
      await editCard(api, cb, help(userToken));
      break;
    }

    // Documentation, quick reference, and endpoint reference cards
    case 'api_docs':
    case 'impl_quick_ref':
    case 'api_implementation':
    case 'impl_get_all':
    case 'impl_python_all':
    case 'impl_python_part2':
    case 'impl_python_examples':
    case 'impl_python_advanced':
    case 'impl_python_errors':
    case 'api_info':
    case 'api_info_get':
    case 'api_info_python':
    case 'api_ratelimit':
    case 'api_ratelimit_get':
    case 'api_ratelimit_python':
    case 'api_search':
    case 'api_search_get':
    case 'api_search_python':
    case 'api_health':
    case 'api_health_get':
    case 'api_health_python': {
      const token = (await getUserToken(userId)) ?? 'YOUR_TOKEN';
      await answer(api, cb);
      await editCard(api, cb, tokenCard(data, token));
      break;
    }

    case 'supported_platforms':
      await answer(api, cb);
      await editCard(api, cb, platformsCard());
      break;

    case 'back_menu': {
      await answer(api, cb);
      const isGrp = isGroup(cb);
      const token = (await getUserToken(userId)) ?? 'YOUR_TOKEN';
      const rawUsername = cb.from?.username || cb.from?.first_name || 'User';
      await editCard(api, cb, backMenu(rawUsername, token, isGrp, userId));
      break;
    }

    case 'admin_refresh_stats': {
      if (!isAdmin(userId)) {
        try {
          await api.sendRichMessage({
            chat_id: cb.message?.chat.id ?? userId,
            rich_message: { html: ACCESS_DENIED },
            ephemeral_message_parameters: { receiver_user_id: userId },
          });
        } catch {
          /* ignore */
        }
        await answer(api, cb, '❌ Admin only.', true);
        return;
      }
      await answer(api, cb, '🔄 Refreshing statistics...');
      try {
        const statsHtml = await buildStats(api, undefined, true);
        const kbd = keyboard([
          [btn('🔄 Refresh Stats', { callback_data: 'admin_refresh_stats', style: ButtonStyle.PRIMARY })],
          [btn('🌐 Proxy Stats', { callback_data: 'admin_refresh_proxystats' })],
          [btn('📱 Back to Menu', { callback_data: 'back_menu' })],
        ]);
        await editCard(api, cb, {
          html: `<h1>⚙️ Administration Panel</h1>
${statsHtml}
<p>Select an action below:</p>`,
          keyboard: kbd,
        });
      } catch (e) {
        await editCard(api, cb, {
          html: `<blockquote>❌ <b>Refresh failed:</b> ${String(e)}</blockquote>`,
        });
      }
      break;
    }

    case 'admin_refresh_proxystats': {
      if (!isAdmin(userId)) {
        await answer(api, cb, '❌ Admin only.', true);
        return;
      }
      await answer(api, cb, '🔄 Refreshing proxy stats...');
      try {
        const stats = await websharePool.getBandwidthStats(true);
        const cardHtml = webshareStatsCard(stats, websharePool.size, websharePool.summary());
        const kbd = keyboard([
          [btn('🔄 Refresh Proxy Stats', { callback_data: 'admin_refresh_proxystats', style: ButtonStyle.PRIMARY })],
          [btn('⚙️ Admin Panel', { callback_data: 'admin_panel' })],
          [btn('📱 Back to Menu', { callback_data: 'back_menu' })],
        ]);
        await editCard(api, cb, {
          html: cardHtml,
          keyboard: kbd,
        });
      } catch (e) {
        await editCard(api, cb, {
          html: `<blockquote>❌ <b>Refresh failed:</b> ${String(e)}</blockquote>`,
        });
      }
      break;
    }

    case 'admin_panel': {
      if (!isAdmin(userId)) {
        await answer(api, cb, '❌ Admin only.', true);
        return;
      }
      await answer(api, cb);
      const statsHtml = await buildStats(api);
      const card = {
        html: `<h1>⚙️ Administration Panel</h1>
${statsHtml}
<p>Select an action below:</p>`,
        keyboard: keyboard([
          [btn('🔄 Refresh Stats', { callback_data: 'admin_refresh_stats', style: ButtonStyle.PRIMARY })],
          [btn('🌐 Proxy Stats', { callback_data: 'admin_refresh_proxystats' })],
          [btn('📱 Back to Menu', { callback_data: 'back_menu' })],
        ]),
      };
      await editCard(api, cb, card);
      break;
    }

    default:
      // Python has no handler for unknown callback data.
      break;
  }
}

function tokenCard(data: string, token: string): Card {
  switch (data) {
    case 'api_info_get':
      return apiInfoGet(token);
    case 'impl_quick_ref':
    case 'api_implementation':
    case 'impl_get_all':
    case 'impl_python_all':
    case 'impl_python_examples':
    case 'api_info_python':
    case 'api_ratelimit_get':
    case 'api_ratelimit_python':
      return implQuickRef(token);
    case 'api_docs':
    default:
      return apiDocs(token);
  }
}
