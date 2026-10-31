import { Api, GrammyError } from 'grammy';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';

vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number, _value: unknown, opts: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
  const aborted = () => { clearTimeout(timer); reject(opts.signal.reason); };
  const timer = setTimeout(() => { opts.signal.removeEventListener('abort', aborted); resolve(); }, ms);
  opts.signal.addEventListener('abort', aborted, { once: true });
}) }));

vi.mock('../telegram/adminContent.js', () => ({ buildStats: async () => '' }));
import { startBot } from '../telegram/bot.js';

let stop: (() => Promise<void>) | undefined;
const cfg = { BOT_TOKEN: '123:local-test-placeholder' } as Config;
function pollingError(code: number) {
  return new GrammyError('Polling failed', { error_code: code, description: 'Test failure' }, 'getUpdates', {});
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Api.prototype, 'deleteWebhook').mockResolvedValue(true);
  vi.spyOn(Api.prototype, 'setMyCommands').mockResolvedValue(true);
  vi.spyOn(Api.prototype, 'getMe').mockResolvedValue({ id: 123, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as any);
});
afterEach(async () => { await stop?.(); stop = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

it('contains a terminal polling rejection after startup and stops safely', async () => {
  const updates = vi.spyOn(Api.prototype, 'getUpdates').mockRejectedValue(pollingError(401));
  stop = await startBot(cfg);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(updates).toHaveBeenCalledTimes(1);
  await expect(stop()).resolves.toBeUndefined();
});

it('retries conflicts after backoff and cancels the next backoff on shutdown', async () => {
  const updates = vi.spyOn(Api.prototype, 'getUpdates').mockRejectedValue(pollingError(409));
  stop = await startBot(cfg);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(updates).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(updates).toHaveBeenCalledTimes(2);
  await stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(updates).toHaveBeenCalledTimes(2);
});
