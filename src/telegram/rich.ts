/**
 * Rich UI helpers — the TS equivalent of tools.send_smart_rich_message plus the
 * InlineKeyboard/InputRichMessage builders used across the bot.
 *
 * Bot API 10.2/10.3 delivers `InputRichMessage(html=...)` as
 * `rich_message: { html }`. When the server doesn't support rich messages (or the
 * bot isn't a group admin for ephemeral delivery) we degrade gracefully:
 *   * BOT_NOT_ADMIN on an ephemeral send -> resend without `receiver_user_id`,
 *     exactly like the Python `fallback_rich_message`.
 *   * sendRichMessage unsupported        -> classic sendMessage with stripped text.
 */
import { TelegramApi, type InlineButton, type InlineKeyboardMarkup, type TgMessage } from './api.js';
import { getLogger } from '../logger.js';
import { renderCustomEmojis, stripCustomEmojis, extractButtonEmoji } from './customEmojis.js';

const log = getLogger('ytube_api.bot');

export const ButtonStyle = {
  PRIMARY: 'primary',
  SUCCESS: 'success',
  DANGER: 'danger',
} as const;

export type ButtonStyleValue = (typeof ButtonStyle)[keyof typeof ButtonStyle];

export interface ButtonSpec {
  text: string;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
  /** Shorthand for `copy_text: { text }` to copy text to clipboard on tap. */
  copyText?: string;
  style?: ButtonStyleValue;
  disabled?: boolean;
  icon_custom_emoji_id?: string;
  /** Shorthand for `icon_custom_emoji_id` — pass a raw Telegram custom emoji document ID. */
  emojiId?: string;
  /** Optional label rendered beneath the button (second line in Telegram's two-line button layout). */
  label?: string;
  /** Optional hint text shown in the button's bottom-right corner alongside the emoji. */
  hint?: string;
}

/** One inline-keyboard button. `style` is omitted when unspecified (DEFAULT). */
export function btn(text: string, opts: Omit<ButtonSpec, 'text'> = {}): InlineButton {
  const extracted = extractButtonEmoji(text);
  const iconId = opts.icon_custom_emoji_id ?? opts.emojiId ?? extracted.icon_custom_emoji_id;
  const buttonText = (iconId !== undefined && extracted.icon_custom_emoji_id !== undefined)
    ? extracted.text
    : text;

  const b: InlineButton = { text: buttonText };
  if (opts.callback_data !== undefined) b.callback_data = opts.callback_data;
  if (opts.url !== undefined) b.url = opts.url;
  if (opts.copy_text !== undefined) {
    b.copy_text = opts.copy_text;
  } else if (opts.copyText !== undefined) {
    b.copy_text = { text: opts.copyText };
  }
  if (opts.style !== undefined) b.style = opts.style;
  if (opts.disabled) b.disabled = true;
  if (iconId !== undefined) {
    b.icon_custom_emoji_id = iconId;
  }
  if (opts.label !== undefined) b.label = opts.label;
  if (opts.hint !== undefined) b.hint = opts.hint;
  return b;
}

export function keyboard(rows: InlineButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Best-effort rich HTML -> readable plain text for the classic fallback. */
export function stripRichHtml(html: string): string {
  let out = html;
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|h[1-6]|div|tr|li|blockquote|details|summary|tg-button-row)>/gi, '\n');
  out = out.replace(/<tg-button[^>]*\burl=["']([^"']+)["'][^>]*>(.*?)<\/tg-button>/gi, '[$2: $1] ');
  out = out.replace(/<tg-button[^>]*>(.*?)<\/tg-button>/gi, '[$1] ');
  out = out.replace(/<li[^>]*>/gi, '• ');
  out = out.replace(/<\/t[dh]>/gi, '  ');
  out = stripCustomEmojis(out);
  out = out.replace(/<[^>]+>/g, '');
  out = out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export interface SmartSendOptions {
  receiverUserId?: number | null;
  fallbackHtml?: string;
  replyMarkup?: InlineKeyboardMarkup;
}

/**
 * Port of tools.send_smart_rich_message. Delivers a rich HTML message, handling
 * Telegram's BOT_NOT_ADMIN error for ephemeral group messages by falling back to
 * standard (masked) delivery.
 */
export async function sendSmartRichMessage(
  api: TelegramApi,
  chatId: number | string,
  html: string,
  opts: SmartSendOptions = {},
): Promise<TgMessage | null> {
  const { receiverUserId, fallbackHtml, replyMarkup } = opts;
  const richHtml = renderCustomEmojis(html);

  if (receiverUserId !== undefined && receiverUserId !== null) {
    try {
      return await api.sendRichMessage({
        chat_id: chatId,
        rich_message: { html: richHtml },
        reply_markup: replyMarkup,
        ephemeral_message_parameters: { receiver_user_id: receiverUserId },
      });
    } catch (e) {
      const err = String(e).toLowerCase();
      if (['bot_not_admin', 'ephemeral', '400', 'bad request'].some((k) => err.includes(k))) {
        return await sendRichOrPlain(api, chatId, fallbackHtml ? renderCustomEmojis(fallbackHtml) : richHtml, replyMarkup);
      }
      log.error('[RICH] ephemeral send failed', { err: String(e) });
      return null;
    }
  }
  return await sendRichOrPlain(api, chatId, richHtml, replyMarkup);
}

/** Rich send, degrading to a classic message when rich messages are unsupported. */
async function sendRichOrPlain(
  api: TelegramApi,
  chatId: number | string,
  html: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<TgMessage | null> {
  const richHtml = renderCustomEmojis(html);
  if (api.richAvailable) {
    try {
      return await api.sendRichMessage({
        chat_id: chatId,
        rich_message: { html: richHtml },
        reply_markup: replyMarkup,
      });
    } catch (e) {
      log.warning('[RICH] send failed, using classic fallback', { err: String(e) });
    }
  }
  try {
    return await api.sendMessage({
      chat_id: chatId,
      text: stripRichHtml(richHtml),
      reply_markup: replyMarkup,
    });
  } catch (e) {
    log.error('[SEND] classic fallback failed', { err: String(e) });
    return null;
  }
}

/** Edit a message's rich content, with the same degradation path. */
export async function editSmartRichMessage(
  api: TelegramApi,
  chatId: number | string,
  messageId: number,
  html: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<boolean> {
  const richHtml = renderCustomEmojis(html);
  if (api.richAvailable) {
    try {
      await api.editRichMessage({
        chat_id: chatId,
        message_id: messageId,
        rich_message: { html: richHtml },
        reply_markup: replyMarkup,
      });
      return true;
    } catch (e) {
      log.warning('[RICH] edit failed, using classic fallback', { err: String(e) });
    }
  }
  try {
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: stripRichHtml(richHtml),
      reply_markup: replyMarkup,
    });
    return true;
  } catch (e) {
    log.error('[EDIT] classic fallback failed', { err: String(e) });
    return false;
  }
}

/** Best-effort rich draft (streaming placeholder); failures are non-fatal. */
export async function sendRichDraft(
  api: TelegramApi,
  chatId: number | string,
  draftId: number,
  html: string,
): Promise<void> {
  if (!api.richAvailable) return;
  try {
    await api.sendRichMessageDraft({
      chat_id: chatId,
      draft_id: draftId,
      rich_message: { html: renderCustomEmojis(html) },
    });
  } catch {
    /* drafts are cosmetic */
  }
}

export type { InlineKeyboardMarkup, TgMessage };
