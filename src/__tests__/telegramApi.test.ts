import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramApi } from '../telegram/api.js';
import { sendSmartRichMessage, editSmartRichMessage, keyboard, btn } from '../telegram/rich.js';

interface Call {
  method: string;
  body: Record<string, unknown>;
}

let calls: Call[];

function mockFetch(responder: (method: string, body: Record<string, unknown>) => unknown): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method, body });
    const result = responder(method, body);
    const payload =
      result instanceof Error
        ? { ok: false, error_code: 400, description: result.message }
        : { ok: true, result: result ?? { message_id: 1 } };
    return {
      status: 200,
      json: async () => payload,
    } as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TelegramApi rich payloads', () => {
  it('sends ephemeral rich messages as rich_message + ephemeral_message_parameters', async () => {
    mockFetch(() => ({ message_id: 7 }));
    const api = new TelegramApi('TOKEN');
    await api.sendRichMessage({
      chat_id: -100,
      rich_message: { html: '<h1>Hi</h1>' },
      ephemeral_message_parameters: { receiver_user_id: 42 },
      reply_markup: keyboard([[btn('Ok', { callback_data: 'x' })]]),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendRichMessage');
    expect(calls[0]!.body).toEqual({
      chat_id: -100,
      rich_message: { html: '<h1>Hi</h1>' },
      ephemeral_message_parameters: { receiver_user_id: 42 },
      reply_markup: { inline_keyboard: [[{ text: 'Ok', callback_data: 'x' }]] },
    });
  });

  it('edits via editMessageText carrying rich_message', async () => {
    mockFetch(() => true);
    const api = new TelegramApi('TOKEN');
    await api.editRichMessage({
      chat_id: 5,
      message_id: 9,
      rich_message: { html: '<b>x</b>' },
    });
    expect(calls[0]!.method).toBe('editMessageText');
    expect(calls[0]!.body).toMatchObject({
      chat_id: 5,
      message_id: 9,
      rich_message: { html: '<b>x</b>' },
    });
  });

  it('targets the bot token URL', async () => {
    let seen = '';
    globalThis.fetch = (async (url: string) => {
      seen = String(url);
      return { status: 200, json: async () => ({ ok: true, result: {} }) } as unknown as Response;
    }) as typeof fetch;
    await new TelegramApi('123:ABC').getMe();
    expect(seen).toBe('https://api.telegram.org/bot123:ABC/getMe');
  });
});

describe('sendSmartRichMessage fallbacks', () => {
  it('falls back to non-ephemeral delivery on BOT_NOT_ADMIN', async () => {
    mockFetch((method) => {
      if (method === 'sendRichMessage' && calls.length === 1) {
        return new Error('Bad Request: BOT_NOT_ADMIN');
      }
      return { message_id: 2 };
    });
    const api = new TelegramApi('T');
    await sendSmartRichMessage(api, -100, '<h1>priv</h1>', {
      receiverUserId: 42,
      fallbackHtml: '<h1>masked</h1>',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.ephemeral_message_parameters).toEqual({ receiver_user_id: 42 });
    // Retry drops the ephemeral parameters and uses the masked fallback.
    expect(calls[1]!.body.ephemeral_message_parameters).toBeUndefined();
    expect(calls[1]!.body.rich_message).toEqual({ html: '<h1>masked</h1>' });
  });

  it('degrades to classic sendMessage when rich messages are unsupported', async () => {
    mockFetch((method) => {
      if (method === 'sendRichMessage') return new Error('Not Found: method not found');
      return { message_id: 3 };
    });
    const api = new TelegramApi('T');
    await sendSmartRichMessage(api, 5, '<h1>Title</h1><p>Body</p>');
    expect(api.richAvailable).toBe(false);
    expect(calls[1]!.method).toBe('sendMessage');
    expect(calls[1]!.body.text).toBe('Title\nBody');
  });

  it('editSmartRichMessage falls back to classic edit', async () => {
    mockFetch((method) => {
      // Both the rich edit and the classic fallback use method `editMessageText`;
      // fail only the first (rich) attempt to exercise the degradation path.
      if (method === 'editMessageText' && calls.length === 1) {
        return new Error('Not Found: method not found');
      }
      return true;
    });
    const api = new TelegramApi('T');
    const ok = await editSmartRichMessage(api, 5, 9, '<h1>H</h1>');
    expect(ok).toBe(true);
    expect(calls[1]!.method).toBe('editMessageText');
    expect(calls[1]!.body.text).toBe('H');
  });
});
