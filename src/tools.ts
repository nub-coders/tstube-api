/**
 * Token + rate-limit plumbing — port of tools.py.
 *
 * Redis key catalogue (identical to Python):
 *   user_token:{uid}        -> token
 *   token_user:{token}      -> uid
 *   user_requests:{uid}     -> daily counter (TTL 86400)
 *   user_failed:{uid}       -> daily failure count (TTL 86400)
 *   global_failed_total     -> (TTL 86400)
 *   failed_by_status:{code} -> (TTL 86400)
 *   failed_by_path:{path}   -> (TTL 86400)
 *   failed_log              -> LPUSH list, trimmed to 100
 */
import { randomInt } from 'node:crypto';
import { config, isAdmin } from './config.js';
import { redis } from './redis.js';
import { getLogger } from './logger.js';

const log = getLogger('ytube_api.tools');

const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 10-char bearer token (crypto RNG, not Math.random). */
export function generateToken(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHANUM[randomInt(0, ALPHANUM.length)];
  return out;
}

export function maskToken(token: string | null | undefined): string {
  if (!token || token === 'YOUR_TOKEN') return token || 'YOUR_TOKEN';
  if (token.length <= 4) return '*'.repeat(token.length);
  return token.slice(0, 4) + '*'.repeat(token.length - 4);
}

export async function getUserToken(userId: number | string): Promise<string | null> {
  return redis().get(`user_token:${userId}`);
}

export async function setUserToken(userId: number | string, token: string): Promise<void> {
  await redis()
    .multi()
    .set(`user_token:${userId}`, token)
    .set(`token_user:${token}`, String(userId))
    .exec();
}

export async function revokeUserToken(userId: number | string): Promise<void> {
  const r = redis();
  const old = await r.get(`user_token:${userId}`);
  const pipe = r.multi();
  if (old) pipe.del(`token_user:${old}`);
  pipe.del(`user_token:${userId}`);
  await pipe.exec();
}

export async function getUserByToken(token: string | null | undefined): Promise<number | null> {
  if (!token) return null;
  try {
    const uid = await redis().get(`token_user:${token}`);
    return uid ? Number.parseInt(uid, 10) : null;
  } catch {
    return null;
  }
}

export async function getUserRequestCount(userId: number | string): Promise<number> {
  const v = await redis().get(`user_requests:${userId}`);
  return v ? Number.parseInt(v, 10) : 0;
}

export async function setUserRequestCount(userId: number | string, count: number): Promise<void> {
  await redis().setex(`user_requests:${userId}`, 86400, String(count));
}

/** INCR is atomic; TTL is set only on the first increment so it isn't reset mid-day. */
export async function incrementUserRequests(userId: number | string): Promise<number> {
  const r = redis();
  const key = `user_requests:${userId}`;
  const res = await r.multi().incr(key).ttl(key).exec();
  const newCount = Number(res?.[0]?.[1] ?? 0);
  const ttl = Number(res?.[1]?.[1] ?? -1);
  if (ttl < 0) await r.expire(key, 86400);
  return newCount;
}

export interface ErrorLogEntry {
  ts: string;
  user: string;
  status: number;
  path: string;
  error: string;
}

export async function incrementFailedRequests(
  userId: number | string,
  statusCode: number,
  path: string,
  errorMessage = '',
): Promise<number> {
  const r = redis();
  const userKey = `user_failed:${userId}`;
  const globalKey = 'global_failed_total';
  const statusKey = `failed_by_status:${statusCode}`;
  const pathKey = `failed_by_path:${path}`;

  const entry = JSON.stringify({
    ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
    user: String(userId),
    status: statusCode,
    path,
    error: (errorMessage || '').slice(0, 300),
  });

  const res = await r
    .multi()
    .incr(userKey)
    .ttl(userKey)
    .incr(globalKey)
    .ttl(globalKey)
    .incr(statusKey)
    .ttl(statusKey)
    .incr(pathKey)
    .ttl(pathKey)
    .lpush('failed_log', entry)
    .ltrim('failed_log', 0, 99)
    .exec();

  const pairs: Array<[string, number]> = [
    [userKey, Number(res?.[1]?.[1] ?? -1)],
    [globalKey, Number(res?.[3]?.[1] ?? -1)],
    [statusKey, Number(res?.[5]?.[1] ?? -1)],
    [pathKey, Number(res?.[7]?.[1] ?? -1)],
  ];
  await Promise.all(pairs.filter(([, ttl]) => ttl < 0).map(([key]) => r.expire(key, 86400)));

  return Number(res?.[0]?.[1] ?? 0);
}

export async function getFailedRequestCount(userId: number | string): Promise<number> {
  const v = await redis().get(`user_failed:${userId}`);
  return v ? Number.parseInt(v, 10) : 0;
}

export async function getRecentErrors(count = 20): Promise<ErrorLogEntry[]> {
  const raw = await redis().lrange('failed_log', 0, count - 1);
  const entries: ErrorLogEntry[] = [];
  for (const item of raw) {
    try {
      entries.push(JSON.parse(item) as ErrorLogEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

export { isAdmin };
export { log };
