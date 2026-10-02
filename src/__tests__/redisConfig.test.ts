import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRedis } from '../redis.js';
import { loadConfig } from '../config.js';

// Config must not load credentials from the developer's .env during tests.
vi.mock('node:fs', () => ({ existsSync: () => false, readFileSync: vi.fn() }));

beforeEach(() => {
  vi.spyOn(Redis.prototype, 'connect').mockResolvedValue(undefined);
  vi.stubEnv('REDIS_HOST', 'discrete.invalid');
  vi.stubEnv('REDIS_PORT', '15440');
  vi.stubEnv('REDIS_PASSWORD', 'discrete-dummy');
  vi.stubEnv('REDIS_USERNAME', 'discrete-user');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Redis connection URL', () => {
  it('preserves TLS, database, and URL credentials', () => {
    vi.stubEnv('REDIS_URL', 'rediss://audit:dummy@redis.example:6380/2');
    const client = createRedis(loadConfig());
    expect(client.options.tls).toBeDefined();
    expect(client.options.host).toBe('redis.example');
    expect(client.options.port).toBe(6380);
    expect(client.options.db).toBe(2);
    expect(client.options.username).toBe('audit');
    expect(client.options.password).toBe('dummy');
  });

  it('uses URL defaults instead of unrelated discrete settings', () => {
    vi.stubEnv('REDIS_URL', 'redis://redis.example/3');
    const cfg = loadConfig();
    const client = createRedis(cfg);
    expect(cfg.REDIS_PORT).toBe(6379);
    expect(client.options.port).toBe(6379);
    expect(client.options.db).toBe(3);
    expect(client.options.password).toBeFalsy();
    expect(client.options.username).toBeFalsy();
  });

  it('rejects malformed configured URLs instead of silently using another database', () => {
    vi.stubEnv('REDIS_URL', 'https://redis.example/2');
    expect(() => loadConfig()).toThrow('REDIS_URL');
  });

  it('retains discrete configuration when no URL is provided', () => {
    vi.stubEnv('REDIS_URL', '');
    const client = createRedis(loadConfig());
    expect(client.options.host).toBe('discrete.invalid');
    expect(client.options.port).toBe(15440);
    expect(client.options.password).toBe('discrete-dummy');
  });
});
