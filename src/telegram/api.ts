/**
 * Raw Telegram Bot API client (HTTPS JSON), replacing Pyrogram's MTProto client.
 *
 * The Python bot used Kurigram's rich UI (`InputRichMessage(html=...)`). Bot API
 * 10.2/10.3 exposes the same content over HTTP as `rich_message: { html }`, so the
 * rich templates port across nearly verbatim. Calls are feature-detected: if the
 * Bot API build predates rich messages we degrade to classic HTML + inline
 * keyboard instead of losing the interaction.
 */

import { Api } from 'grammy';

const API_BASE = 'https://api.telegram.org';

export class BotApiError extends Error {
  readonly errorCode: number;
  readonly description: string;
  constructor(errorCode: number, description: string) {
    super(`${errorCode}: ${description}`);
    this.name = 'BotApiError';
    this.errorCode = errorCode;
    this.description = description;
  }
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
  style?: 'primary' | 'success' | 'danger';
  disabled?: boolean;
  icon_custom_emoji_id?: string;
  /** Shorthand for `icon_custom_emoji_id` — pass a raw Telegram custom emoji document ID. */
  emojiId?: string;
  label?: string;
  hint?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineButton[][];
}

export interface Chat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  chat: Chat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string }>;
  video?: { file_id: string };
  document?: { file_id: string };
  reply_to_message?: TgMessage;
}

export interface CallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: CallbackQuery;
}

export interface RichMessage {
  html?: string;
  blocks?: unknown[];
}

type Json = Record<string, unknown>;

export class TelegramApi {
  private richUnsupported = false;
  readonly grammyApi: Api;

  constructor(private readonly token: string, apiInstance?: Api) {
    this.grammyApi = apiInstance ?? new Api(token);
  }

  get baseUrl(): string {
    return `${API_BASE}/bot${this.token}`;
  }

  get richAvailable(): boolean {
    return !this.richUnsupported;
  }

  /** Mark rich messages as unavailable after a "method not found" or missing text response. */
  private noteRichFailure(e: unknown): void {
    if (e instanceof BotApiError) {
      const d = e.description.toLowerCase();
      if (
        e.errorCode === 404 ||
        d.includes('method not found') ||
        d.includes('unknown method') ||
        d.includes('message text is empty') ||
        d.includes('text is empty') ||
        d.includes('text is required')
      ) {
        this.richUnsupported = true;
      }
    }
  }

  async call<T = unknown>(method: string, payload?: Json, timeoutMs = 35_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; result?: T; error_code?: number; description?: string }
        | null;
      if (!body?.ok) {
        throw new BotApiError(body?.error_code ?? res.status, body?.description ?? `HTTP ${res.status}`);
      }
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Rich messages ─────────────────────────────────────────────

  async sendRichMessage(params: {
    chat_id: number | string;
    rich_message: RichMessage;
    reply_markup?: InlineKeyboardMarkup;
    ephemeral_message_parameters?: {
      receiver_user_id: number;
      replace_callback_query_message?: boolean;
    };
    message_thread_id?: number;
  }): Promise<TgMessage> {
    try {
      return await this.call<TgMessage>('sendRichMessage', params as unknown as Json);
    } catch (e) {
      this.noteRichFailure(e);
      throw e;
    }
  }

  async sendRichMessageDraft(params: {
    chat_id: number | string;
    draft_id: number;
    rich_message: RichMessage;
    can_stop?: boolean;
    keep_on_stop?: boolean;
  }): Promise<unknown> {
    try {
      return await this.call('sendRichMessageDraft', params as unknown as Json);
    } catch (e) {
      this.noteRichFailure(e);
      throw e;
    }
  }

  async editRichMessage(params: {
    chat_id: number | string;
    message_id: number;
    rich_message: RichMessage;
    reply_markup?: InlineKeyboardMarkup;
  }): Promise<unknown> {
    try {
      return await this.call('editMessageText', params as unknown as Json);
    } catch (e) {
      this.noteRichFailure(e);
      throw e;
    }
  }

  // ── Classic messages (fallback + broadcast) ───────────────────

  sendMessage(params: {
    chat_id: number | string;
    text: string;
    parse_mode?: string;
    reply_markup?: InlineKeyboardMarkup;
  }): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', params as unknown as Json);
  }

  editMessageText(params: {
    chat_id: number | string;
    message_id: number;
    text: string;
    parse_mode?: string;
    reply_markup?: InlineKeyboardMarkup;
  }): Promise<unknown> {
    return this.call('editMessageText', params as unknown as Json);
  }

  sendPhoto(params: {
    chat_id: number | string;
    photo: string;
    caption?: string;
  }): Promise<TgMessage> {
    return this.call<TgMessage>('sendPhoto', params as unknown as Json);
  }

  sendVideo(params: {
    chat_id: number | string;
    video: string;
    caption?: string;
  }): Promise<TgMessage> {
    return this.call<TgMessage>('sendVideo', params as unknown as Json);
  }

  sendDocument(params: {
    chat_id: number | string;
    document: string;
    caption?: string;
  }): Promise<TgMessage> {
    return this.call<TgMessage>('sendDocument', params as unknown as Json);
  }

  forwardMessage(params: {
    chat_id: number | string;
    from_chat_id: number | string;
    message_id: number;
  }): Promise<TgMessage> {
    return this.call<TgMessage>('forwardMessage', params as unknown as Json);
  }

  copyMessage(params: {
    chat_id: number | string;
    from_chat_id: number | string;
    message_id: number;
    caption?: string;
  }): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>('copyMessage', params as unknown as Json);
  }

  answerCallbackQuery(params: {
    callback_query_id: string;
    text?: string;
    show_alert?: boolean;
  }): Promise<unknown> {
    return this.call('answerCallbackQuery', params as unknown as Json);
  }

  getChat(chatId: number | string): Promise<Chat> {
    return this.call<Chat>('getChat', { chat_id: chatId });
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe');
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<unknown> {
    return this.call('setMyCommands', { commands });
  }

  deleteWebhook(): Promise<unknown> {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  getUpdates(params: {
    offset?: number;
    limit?: number;
    timeout?: number;
    allowed_updates?: string[];
  }): Promise<Update[]> {
    // Allow the long-poll to outlive its timeout.
    return this.call<Update[]>(
      'getUpdates',
      params as unknown as Json,
      (params.timeout ?? 30) * 1000 + 10_000,
    );
  }

  /** Random positive 31-bit int, mirrors Pyrogram's client.rnd_id(). */
  rndId(): number {
    return Math.floor(Math.random() * 0x7fffffff);
  }
}
