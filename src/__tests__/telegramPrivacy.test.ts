import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallbackQuery, TelegramApi, TgMessage } from '../telegram/api.js';
import { handleCallback } from '../telegram/callbacks.js';
import { dispatchMessage } from '../telegram/bot.js';
import { cmdUser, cmdBroadcast } from '../telegram/admin.js';

const mocks = vi.hoisted(() => ({
  getUserToken: vi.fn(async () => 'auditDummyToken'),
  revokeUserToken: vi.fn(), setUserToken: vi.fn(), del: vi.fn(),
}));
vi.mock('../config.js', () => ({
  config: () => ({ BASE_URL: 'https://example.test', DAILY_LIMIT: 1000, ADMIN_LIMIT: 10000 }),
  isAdmin: () => true,
}));
vi.mock('../tools.js', () => ({
  ...mocks, generateToken: () => 'auditRotatedToken',
  getUserRequestCount: async () => 1, getFailedRequestCount: async () => 0,
  getRecentErrors: async () => [], setUserRequestCount: vi.fn(),
  grantUserRequests: vi.fn(async () => [1, 0]), maskToken: () => 'masked',
}));
vi.mock('../redis.js', () => ({ redis: () => ({ del: mocks.del }), scanKeys: async () => ['user_token:123'] }));

const cb: CallbackQuery = {
  id: 'dummy', from: { id: 123, first_name: 'Test' },
  message: { message_id: 10, chat: { id: -1001, type: 'supergroup' } },
};
function api(rich: boolean) {
  return {
    richAvailable: rich,
    rndId: () => 1,
    answerCallbackQuery: vi.fn(async () => true),
    sendRichMessage: vi.fn(async () => ({ message_id: 1 })),
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    editRichMessage: vi.fn(async () => true),
    editMessageText: vi.fn(async () => true),
    sendRichMessageDraft: vi.fn(async () => true),
    forwardMessage: vi.fn(async () => { throw new Error('Forbidden: bot was blocked by user'); }),
  };
}
beforeEach(() => vi.clearAllMocks());

describe('Telegram privacy', () => {
  it('redacts group help when ephemeral delivery is unavailable', async () => {
    const client = api(true);
    client.sendRichMessage.mockRejectedValueOnce(new Error('400 BOT_NOT_ADMIN'));
    await dispatchMessage(client as unknown as TelegramApi, { ...cb.message!, from: cb.from, text: '/help' });
    const payloads = client.sendRichMessage.mock.calls as unknown as Array<[any]>;
    expect(payloads[0][0].ephemeral_message_parameters).toEqual({ receiver_user_id: 123 });
    expect(payloads[1][0].chat_id).toBe(-1001);
    expect(payloads[1][0].ephemeral_message_parameters).toBeUndefined();
    expect(JSON.stringify(payloads[1][0])).not.toContain('auditDummyToken');
    expect(JSON.stringify(payloads[1][0])).toContain('YOUR_TOKEN');
  });

  it.each([true, false])('keeps callback cards private when rich=%s', async rich => {
    const client = api(rich);
    for (const data of ['help', 'impl_quick_ref', 'api_implementation', 'confirm_revoke', 'api_info_get', 'impl_python_all']) {
      await handleCallback(client as unknown as TelegramApi, { ...cb, data });
    }
    expect(client.editRichMessage).not.toHaveBeenCalled();
    expect(client.editMessageText).not.toHaveBeenCalled();
    const calls = [...client.sendMessage.mock.calls, ...client.sendRichMessage.mock.calls] as unknown as Array<[Record<string, unknown>]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [payload] of calls) expect(payload.chat_id).toBe(123);
  });

  it('never falls back to posting tokens in a group if direct messages fail', async () => {
    const client = api(false);
    client.sendMessage.mockRejectedValue(new Error('Forbidden'));
    await handleCallback(client as unknown as TelegramApi, { ...cb, data: 'help' });
    expect(client.editMessageText).not.toHaveBeenCalled();
    for (const [payload] of client.sendMessage.mock.calls as unknown as Array<[any]>) expect(payload.chat_id).toBe(123);
  });

  it.each(['/user 123', '/grant 123 10', '/revoke 123'])('blocks private admin command %s in groups', async text => {
    const client = api(false);
    await dispatchMessage(client as unknown as TelegramApi, { ...cb.message!, from: cb.from, text });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(mocks.getUserToken).not.toHaveBeenCalled();
  });

  it('protects credential handlers even when called without the dispatcher', async () => {
    const client = api(false);
    await cmdUser(client as unknown as TelegramApi, { ...cb.message!, from: cb.from, text: '/user 123' });
    expect(mocks.getUserToken).not.toHaveBeenCalled();
  });

  it('revokes both token mappings before removing an unreachable user', async () => {
    const client = api(false);
    const msg: TgMessage = { message_id: 11, chat: { id: 999, type: 'private' }, from: { id: 999, first_name: 'Admin' }, text: '/broadcast', reply_to_message: { message_id: 2, chat: { id: 999, type: 'private' }, text: 'test' } };
    await cmdBroadcast(client as unknown as TelegramApi, msg);
    expect(mocks.revokeUserToken).toHaveBeenCalledWith(123);
    expect(mocks.del).not.toHaveBeenCalledWith('user_token:123');
  });
});
