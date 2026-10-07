/**
 * Command handlers — /start, /menu, /ping (plugins/commands.py) and
 * /status, /token (plugins/status.py).
 */
import type { TelegramApi, TgMessage, InlineButton, InlineKeyboardMarkup } from './api.js';
import { btn, keyboard, ButtonStyle, sendSmartRichMessage, sendRichDraft } from './rich.js';
import {
  BOT_START_TIME,
  apiUrl,
  getReadableTime,
  menuContent,
  pingContent,
  startExisting,
  startNew,
  statusNoToken,
  statusWithToken,
  tokenHas,
  tokenNone,
} from './content.js';
import { help, platformsCard, revokeConfirm } from './callbackContent.js';
import { config, isAdmin } from '../config.js';
import { generateToken, getUserToken, setUserToken, getUserRequestCount } from '../tools.js';

export function isGroupChat(chat: { type: string } | undefined): boolean {
  return !!chat && chat.type !== 'private';
}

export function startKeyboard(userId?: number): InlineKeyboardMarkup {
  const isAdminUser = userId !== undefined && isAdmin(userId);
  return keyboard([
    [
      btn('📊 Usage Status', { callback_data: 'usage_status', style: ButtonStyle.PRIMARY }),
    ],
    [
      btn('📖 API Docs', { callback_data: 'api_docs', style: ButtonStyle.PRIMARY }),
      btn('❓ Help & Guide', { callback_data: 'help' }),
    ],
    ...(isAdminUser ? [[btn('⚙️ Administration', { callback_data: 'admin_panel', style: ButtonStyle.DANGER })]] : []),
  ]);
}

export async function cmdStart(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!msg.from) return;
  const userId = msg.from.id;
  const rawUsername = msg.from.username || msg.from.first_name || 'User';
  const isGrp = isGroupChat(msg.chat);
  const receiverUid = isGrp ? userId : null;

  const existingToken = await getUserToken(userId);

  if (existingToken) {
    const content = startExisting(rawUsername, existingToken, isGrp);
    await sendSmartRichMessage(api, msg.chat.id, content.html, {
      receiverUserId: receiverUid,
      fallbackHtml: content.fallback,
      replyMarkup: startKeyboard(userId),
    });
    return;
  }

  const newToken = generateToken();
  await setUserToken(userId, newToken);
  const content = startNew(rawUsername, newToken, isGrp);
  await sendSmartRichMessage(api, msg.chat.id, content.html, {
    receiverUserId: receiverUid,
    fallbackHtml: content.fallback,
    replyMarkup: startKeyboard(userId),
  });
}

export async function cmdMenu(api: TelegramApi, msg: TgMessage): Promise<void> {
  return cmdStart(api, msg);
}

export async function cmdPing(api: TelegramApi, msg: TgMessage): Promise<void> {
  const start = Date.now();
  const chatId = msg.chat.id;
  const draftId = api.rndId();
  const isGrp = isGroupChat(msg.chat);
  const receiverUid = msg.from && isGrp ? msg.from.id : null;

  await sendRichDraft(api, chatId, draftId, '<b>🏓 Measuring round-trip latency...</b>');

  const elapsed = Date.now() - start;
  const uptime = getReadableTime((Date.now() - BOT_START_TIME) / 1000);
  const html = pingContent(elapsed, uptime);

  await sendSmartRichMessage(api, chatId, html, {
    receiverUserId: receiverUid,
  });
}

export async function cmdStatus(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!msg.from) return;
  const userId = msg.from.id;
  const token = await getUserToken(userId);
  const isGrp = isGroupChat(msg.chat);
  const receiverUid = isGrp ? userId : null;

  if (!token) {
    const content = statusNoToken(isGrp);
    await sendSmartRichMessage(api, msg.chat.id, content.html, {
      receiverUserId: receiverUid,
      fallbackHtml: content.fallback,
      replyMarkup: keyboard([
        [btn('🚀 Get Token', { callback_data: 'get_token', style: ButtonStyle.SUCCESS })],
      ]),
    });
    return;
  }

  const requestCount = await getUserRequestCount(userId);
  const admin = isAdmin(userId);
  const limit = admin ? config().ADMIN_LIMIT : config().DAILY_LIMIT;
  const content = statusWithToken(token, requestCount, limit, admin, isGrp);

  await sendSmartRichMessage(api, msg.chat.id, content.html, {
    receiverUserId: receiverUid,
    fallbackHtml: content.fallback,
    replyMarkup: keyboard([
      [
        btn('🔄 Refresh', { callback_data: 'usage_status', style: ButtonStyle.PRIMARY }),
        btn('📱 Main Menu', { callback_data: 'back_menu' }),
      ],
    ]),
  });
}

export async function cmdToken(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!msg.from) return;
  const userId = msg.from.id;
  const token = await getUserToken(userId);
  const isGrp = isGroupChat(msg.chat);
  const receiverUid = isGrp ? userId : null;

  if (token) {
    const content = tokenHas(token, isGrp);
    await sendSmartRichMessage(api, msg.chat.id, content.html, {
      receiverUserId: receiverUid,
      fallbackHtml: content.fallback,
      replyMarkup: keyboard([
        [
          btn('📊 Check Usage', { callback_data: 'usage_status', style: ButtonStyle.PRIMARY }),
          btn('🔄 Revoke Token', { callback_data: 'revoke_token', style: ButtonStyle.DANGER }),
        ],
        [btn('📱 Main Menu', { callback_data: 'back_menu' })],
      ]),
    });
    return;
  }

  const content = tokenNone(isGrp);
  await sendSmartRichMessage(api, msg.chat.id, content.html, {
    receiverUserId: receiverUid,
    fallbackHtml: content.fallback,
    replyMarkup: keyboard([
      [btn('🚀 Get Token', { callback_data: 'get_token', style: ButtonStyle.SUCCESS })],
    ]),
  });
}

export async function cmdHelp(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!msg.from) return;
  const userId = msg.from.id;
  const token = (await getUserToken(userId)) ?? 'YOUR_TOKEN';
  const isGrp = isGroupChat(msg.chat);
  const card = help(token);
  await sendSmartRichMessage(api, msg.chat.id, card.html, {
    receiverUserId: isGrp ? userId : null,
    replyMarkup: card.keyboard ?? startKeyboard(),
  });
}

export async function cmdRevoke(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!msg.from) return;
  const isGrp = isGroupChat(msg.chat);
  const receiverUid = isGrp ? msg.from.id : null;
  const card = revokeConfirm();
  await sendSmartRichMessage(api, msg.chat.id, card.html, {
    receiverUserId: receiverUid,
    replyMarkup: card.keyboard,
  });
}

export async function cmdPlatforms(api: TelegramApi, msg: TgMessage): Promise<void> {
  const card = platformsCard();
  const isGrp = isGroupChat(msg.chat);
  const receiverUid = isGrp && msg.from ? msg.from.id : null;
  await sendSmartRichMessage(api, msg.chat.id, card.html, {
    receiverUserId: receiverUid,
    replyMarkup: card.keyboard,
  });
}

// Re-exported for command-menu setup.
export const BOT_COMMANDS = [
  { command: 'start', description: '🚀 Get your API token and welcome message' },
  { command: 'menu', description: '📋 Show main menu with options' },
  { command: 'platforms', description: '🎬 View all supported platforms & formats' },
  { command: 'ping', description: '🏓 Check bot latency' },
  { command: 'status', description: '📊 Check your usage statistics' },
  { command: 'token', description: '🔑 View your current API token' },
  { command: 'revoke', description: '🔄 Revoke your current token' },
  { command: 'help', description: '❓ Get help and API documentation' },
];
