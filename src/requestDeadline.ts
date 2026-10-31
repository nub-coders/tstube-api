import { AsyncLocalStorage } from 'node:async_hooks';

interface Deadline { signal: AbortSignal; expires: number }
const deadlines = new AsyncLocalStorage<Deadline>();

export function requestSignal(): AbortSignal | undefined {
  return deadlines.getStore()?.signal;
}

export function requestDeadline(): number {
  return deadlines.getStore()?.expires ?? Infinity;
}

/** Shared work belongs to its subscribers, not the async scope of the first caller. */
export function withIndependentRequestDeadline<T>(
  ms: number,
  label: string,
  ownerSignal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return deadlines.run({ signal: ownerSignal, expires: Date.now() + ms }, () =>
    withRequestDeadline(ms, label, operation));
}

/** Bound the operation and cancel network work started within its async scope. */
export async function withRequestDeadline<T>(ms: number, label: string, operation: () => Promise<T>): Promise<T> {
  const parent = deadlines.getStore();
  parent?.signal.throwIfAborted();
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent.signal, controller.signal]) : controller.signal;
  const expires = Math.min(Date.now() + ms, parent?.expires ?? Infinity);
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out`)), Math.max(0, expires - Date.now()));
  try {
    return await deadlines.run({ signal, expires }, () => new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
        .then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    }));
  } finally {
    clearTimeout(timer);
    // Also cancel losing attempts in a race once the winning result is returned.
    controller.abort(new Error(`${label} finished`));
  }
}

/** Preserve Request/init cancellation and cover response-body reads as well as headers. */
export function boundedFetch(fetchFn: typeof fetch, timeoutMs = 8_000): typeof fetch {
  return (input, init) => {
    const inherited = typeof input === 'object' && input !== null && 'signal' in input ? input.signal : undefined;
    const signals = [requestSignal(), inherited, init?.signal, AbortSignal.timeout(timeoutMs)]
      .filter((signal): signal is AbortSignal => signal != null);
    return fetchFn(input, { ...init, signal: AbortSignal.any(signals) });
  };
}
