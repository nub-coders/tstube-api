/**
 * Callback-query handlers — port of the `@Client.on_callback_query()` switch in
 * plugins/commands.py (including the admin_refresh_stats branch).
 */
import type { CallbackQuery, TelegramApi } from './api.js';
import { btn, keyboard, ButtonStyle, sendSmartRichMessage, editSmartRichMessage } from './rich.js';
import {
  apiDocs,
  apiHealth,
  apiHealthGet,
  apiHealthPython,
  apiImplementation,
  apiInfo,
  apiInfoGet,
  apiInfoPython,
  apiRateLimit,
  apiRateLimitGet,
  apiRateLimitPython,
  apiSearch,
  apiSearchGet,
  apiSearchPython,
  backMenu,
  help,
  implGetAll,
  implPythonAdvanced,
  implPythonAll,
  implPythonErrors,
  implPythonExamples,
  implPythonPart2,
  implQuickRef,
  revoked,
  revokeConfirm,
  usageCallback,
  viewTokenGroup,
  type Card,
} from './callbackContent.js';
import { buildStats, buildCookieStatus, cookieUploadCommandCard, ACCESS_DENIED } from './adminContent.js';
import { generateToken, getUserRequestCount, getUserToken, revokeUserToken, setUserToken } from '../tools.js';
import { isAdmin, config } from '../config.js';
import { getLogger } from '../logger.js';
import { cookiePool } from '../cookiePool.js';

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

    case 'api_implementation': {
      const token = await getUserToken(userId);
      if (!token) {
        await answer(api, cb, '❌ No token found. Use /start to generate one.', true);
        break;
      }
      await answer(api, cb);
      await editCard(api, cb, apiImplementation(token));
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
      const limit = admin ? 10000 : 1000;
      await answer(api, cb);
      await editCard(api, cb, usageCallback(token, requestCount, limit, admin, isGrp));
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

    // Token-bearing informational cards.
    case 'impl_get_all':
    case 'impl_python_all':
    case 'impl_python_part2':
    case 'impl_python_examples':
    case 'impl_python_advanced':
    case 'impl_python_errors':
    case 'impl_quick_ref':
    case 'api_info':
    case 'api_info_get':
    case 'api_info_python':
    case 'api_ratelimit':
    case 'api_ratelimit_get':
    case 'api_ratelimit_python': {
      const token = (await getUserToken(userId)) ?? 'YOUR_TOKEN';
      await answer(api, cb);
      await editCard(api, cb, tokenCard(data, token));
      break;
    }

    // Static informational cards.
    case 'api_search':
      await answer(api, cb);
      await editCard(api, cb, apiSearch());
      break;
    case 'api_search_get':
      await answer(api, cb);
      await editCard(api, cb, apiSearchGet());
      break;
    case 'api_search_python':
      await answer(api, cb);
      await editCard(api, cb, apiSearchPython());
      break;
    case 'api_health':
      await answer(api, cb);
      await editCard(api, cb, apiHealth());
      break;
    case 'api_health_get':
      await answer(api, cb);
      await editCard(api, cb, apiHealthGet());
      break;
    case 'api_health_python':
      await answer(api, cb);
      await editCard(api, cb, apiHealthPython());
      break;
    case 'api_docs':
      await answer(api, cb);
      await editCard(api, cb, apiDocs());
      break;
    case 'back_menu':
      await answer(api, cb);
      await editCard(api, cb, backMenu());
      break;

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
        const statsHtml = await buildStats(api);
        const kbd = keyboard([
          [btn('🔄 Refresh Stats', { callback_data: 'admin_refresh_stats', style: ButtonStyle.PRIMARY })],
        ]);
        await editCard(api, cb, { html: statsHtml, keyboard: kbd });
      } catch (e) {
        await editCard(api, cb, {
          html: `<blockquote>❌ <b>Refresh failed:</b> ${String(e)}</blockquote>`,
        });
      }
      break;
    }

    case 'admin_cookies_refresh': {
      if (!isAdmin(userId)) {
        await answer(api, cb, '❌ Admin only.', true);
        return;
      }
      await answer(api, cb, '🔄 Refreshing cookie status...');
      try {
        const statusHtml = await buildCookieStatus();
        const kbd = keyboard([
          [
            btn('🔄 Refresh', { callback_data: 'admin_cookies_refresh', style: ButtonStyle.PRIMARY }),
            btn('📤 Upload Command', { callback_data: 'admin_cookies_upload', style: ButtonStyle.SUCCESS }),
          ],
          [
            btn('🔍 Force Probe', { callback_data: 'admin_cookies_probe', style: ButtonStyle.PRIMARY }),
          ],
        ]);
        await editCard(api, cb, { html: statusHtml, keyboard: kbd });
      } catch (e) {
        await editCard(api, cb, {
          html: `<blockquote>❌ <b>Refresh failed:</b> ${String(e)}</blockquote>`,
        });
      }
      break;
    }

    case 'admin_cookies_upload': {
      if (!isAdmin(userId)) {
        await answer(api, cb, '❌ Admin only.', true);
        return;
      }
      await answer(api, cb);
      const uploadToken = (await getUserToken(userId)) ?? 'YOUR_ADMIN_TOKEN';
      const cfg = config();
      const effectiveKey = cfg.ADMIN_API_KEY || uploadToken;
      const cardHtml = cookieUploadCommandCard(effectiveKey);
      await editCard(api, cb, {
        html: cardHtml,
        keyboard: keyboard([
          [btn('🍪 Back to Cookie Status', { callback_data: 'admin_cookies_refresh', style: ButtonStyle.PRIMARY })],
        ]),
      });
      break;
    }

    case 'admin_cookies_probe': {
      if (!isAdmin(userId)) {
        await answer(api, cb, '❌ Admin only.', true);
        return;
      }
      await answer(api, cb, `🔍 Probing ${cookiePool.size} cookie(s)...`);
      // Run probe in background then post updated status
      const probeChatId = cb.message?.chat.id ?? userId;
      void cookiePool.probeActiveCookiesWithDelay(1000).then(async () => {
        try {
          const statusHtml = await buildCookieStatus();
          await sendSmartRichMessage(api, probeChatId, statusHtml, {
            replyMarkup: keyboard([
              [
                btn('🔄 Refresh', { callback_data: 'admin_cookies_refresh', style: ButtonStyle.PRIMARY }),
                btn('📤 Upload Command', { callback_data: 'admin_cookies_upload', style: ButtonStyle.SUCCESS }),
              ],
            ]),
          });
        } catch { /* ignore */ }
      });
      break;
    }

    default:
      // Python has no handler for unknown callback data.
      break;
  }
}

function tokenCard(data: string, token: string): Card {
  switch (data) {
    case 'impl_get_all':
      return implGetAll(token);
    case 'impl_python_all':
      return implPythonAll(token);
    case 'impl_python_part2':
      return implPythonPart2();
    case 'impl_python_examples':
      return implPythonExamples(token);
    case 'impl_python_advanced':
      return implPythonAdvanced();
    case 'impl_python_errors':
      return implPythonErrors();
    case 'impl_quick_ref':
      return implQuickRef(token);
    case 'api_info':
      return apiInfo();
    case 'api_info_get':
      return apiInfoGet(token);
    case 'api_info_python':
      return apiInfoPython(token);
    case 'api_ratelimit':
      return apiRateLimit();
    case 'api_ratelimit_get':
      return apiRateLimitGet(token);
    case 'api_ratelimit_python':
      return apiRateLimitPython(token);
    default:
      return backMenu();
  }
}
