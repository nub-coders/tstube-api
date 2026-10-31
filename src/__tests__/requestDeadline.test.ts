import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { boundedFetch, requestSignal, withRequestDeadline, withIndependentRequestDeadline } from '../requestDeadline.js';

afterEach(() => vi.useRealTimers());

it('cancels a real upstream response body when the operation deadline expires', async () => {
  let closed = false;
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write('first bytes');
    res.once('close', () => { closed = true; });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await expect(withRequestDeadline(100, 'test download', async () => {
      const response = await boundedFetch(globalThis.fetch)(url);
      return response.text();
    })).rejects.toThrow('test download timed out');
    await vi.waitFor(() => expect(closed).toBe(true));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('cancels losing work when an operation finishes and keeps concurrent scopes separate', async () => {
  let first!: AbortSignal;
  let second!: AbortSignal;
  let release!: () => void;
  const pending = withRequestDeadline(10_000, 'second', () => {
    second = requestSignal()!;
    return new Promise<void>(resolve => { release = resolve; });
  });
  await withRequestDeadline(10_000, 'first', async () => { first = requestSignal()!; });
  expect(first.aborted).toBe(true);
  expect(second.aborted).toBe(false);
  release(); await pending;
  expect(second.aborted).toBe(true);
});

it('preserves the caller’s Request signal when adding a fetch deadline', async () => {
  const controller = new AbortController();
  let received!: AbortSignal;
  const wrapped = boundedFetch((async (_input, init) => { received = init!.signal!; return new Response('ok'); }) as typeof fetch);
  await wrapped(new Request('https://example.com', { signal: controller.signal }));
  controller.abort();
  expect(received.aborted).toBe(true);
});

it('keeps shared work alive after its initiating scope ends, until its owner cancels', async () => {
  const owner = new AbortController();
  let shared!: Promise<void>;
  let signal!: AbortSignal;
  await withRequestDeadline(10_000, 'caller', async () => {
    shared = withIndependentRequestDeadline(10_000, 'shared', owner.signal, async () => {
      signal = requestSignal()!;
      return new Promise<void>(() => {});
    });
    // Attach immediately: owner cancellation is expected to reject the shared task.
    void shared.catch(() => {});
    await Promise.resolve();
  });
  expect(signal.aborted).toBe(false);
  owner.abort(new Error('no subscribers'));
  await expect(shared).rejects.toThrow('no subscribers');
  expect(signal.aborted).toBe(true);
});
