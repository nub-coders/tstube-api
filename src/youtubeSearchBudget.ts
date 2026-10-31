import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { redis } from './redis.js';
import { HttpError } from './httpError.js';
import { nextPacificMidnightEpoch } from './quota.js';
import { getLogger } from './logger.js';

const log = getLogger('ytube_api.youtube_budget');
// Reserve the search's 100 units and its possible one-unit details request.
const SEARCH_COST = 101;
const LEASE_MS = 15_000; // Google requests have a ten-second network deadline.
const ACTIVE_KEY = 'youtube_search:active';
const STARTS_KEY = 'youtube_search:starts';
const ADMIT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - 60000)
if tonumber(redis.call('GET', KEYS[1]) or '0') + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return -1 end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[3]) then return -2 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return -3 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIREAT', KEYS[1], ARGV[5])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[7]), ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[7])
redis.call('ZADD', KEYS[3], now, ARGV[6])
redis.call('EXPIRE', KEYS[3], 60)
return 1
`;

/** Shared admission control applies to every search attempt, including key retries. */
export async function withSearchSlot<T>(call: () => Promise<T>): Promise<T> {
  const cfg = config();
  const reset = nextPacificMidnightEpoch();
  const owner = randomUUID();
  let admitted: number;
  try {
    admitted = Number(await redis().eval(ADMIT, 3,
      `youtube_search:budget:${reset}`, ACTIVE_KEY, STARTS_KEY,
      SEARCH_COST, cfg.YOUTUBE_SEARCH_DAILY_BUDGET, cfg.YOUTUBE_SEARCH_REQUESTS_PER_MINUTE,
      cfg.YOUTUBE_SEARCH_MAX_CONCURRENCY, reset, owner, LEASE_MS));
  } catch (error) {
    log.warning('[YOUTUBE_API] Search admission unavailable', { err: String(error) });
    throw new HttpError(503, { error: 'YouTube search temporarily unavailable' });
  }
  if (admitted !== 1) {
    throw new HttpError(429, {
      error: admitted === -1 ? 'YouTube search daily allowance reached' : 'YouTube search is busy',
      retry_after: admitted === -1 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : admitted === -2 ? 60 : 1,
    });
  }
  try {
    return await call();
  } finally {
    try { await redis().zrem(ACTIVE_KEY, owner); }
    catch (error) { log.warning('[YOUTUBE_API] Search lease release failed', { err: String(error) }); }
  }
}
