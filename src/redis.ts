/**
 * Redis client — shared by the HTTP API and the bot, like tools.py's async client.
 */
import { Redis } from 'ioredis';
import type { Config } from './config.js';

let client: Redis | null = null;

export function createRedis(cfg: Config): Redis {
  const options = {
    lazyConnect: false,
    // Finite so a dead Redis rejects commands (caught per-call) instead of
    // queueing them forever. We use no blocking commands, so ioredis does not
    // require `null` here; the Python client failed after a 10s socket timeout.
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    connectTimeout: 10_000,
    commandTimeout: 10_000,
    retryStrategy: (times: number) => Math.min(times * 200, 3_000),
  };
  client = cfg.REDIS_URL
    ? new Redis(cfg.REDIS_URL, options)
    : new Redis({
        ...options,
        host: cfg.REDIS_HOST,
        port: cfg.REDIS_PORT,
        username: cfg.REDIS_USERNAME || undefined,
        password: cfg.REDIS_PASSWORD || undefined,
      });

  // ioredis emits 'error' for transient connection issues; without a listener
  // Node treats it as an unhandled error and crashes the process.
  client.on('error', () => {
    /* surfaced through individual command failures */
  });
  client.on('connect', () => {
    /* noop */
  });
  return client;
}

export function redis(): Redis {
  if (!client) throw new Error('redis not initialised — call createRedis() first');
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
    client = null;
  }
}

/** Non-blocking replacement for KEYS — iterates with SCAN, like tools.scan_keys. */
export async function scanKeys(pattern = '*', count = 500): Promise<string[]> {
  const r = redis();
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}
