/**
 * Centralised configuration — 1:1 port of config.py.
 *
 * A local `.env` file is loaded at startup with setdefault semantics (real env
 * wins), exactly like the Python `load_dotenv`. Defaults match ytube_api so the
 * service behaves identically out of the box.
 */
import { readFileSync, existsSync } from 'node:fs';

function loadDotenv(path = '.env'): void {
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!key) continue;
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function getenv(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : def;
}

function getint(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function getfloat(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  return Number.isNaN(n) ? def : n;
}

function boolish(v: string): boolean {
  return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
}

export interface Config {
  // ── Telegram Bot ─────────────────────────────────────────────
  API_ID: number;
  API_HASH: string;
  BOT_TOKEN: string | null;
  GROUP: string;
  CHANNEL: string;
  START_BOT: boolean;
  ADMIN_IDS: number[];
  ADMIN_ID_SET: Set<number>;

  // ── Redis ────────────────────────────────────────────────────
  REDIS_URL: string | null;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_USERNAME: string;
  REDIS_PASSWORD: string | null;
  UPSTASH_REDIS_REST_URL: string | null;
  UPSTASH_REDIS_REST_TOKEN: string | null;

  // ── API Rate Limits ──────────────────────────────────────────
  DAILY_LIMIT: number;
  ADMIN_LIMIT: number;
  ADMIN_API_KEY: string | null;



  // ── Webshare geo-bypass proxy pool ───────────────────────────
  WEBSHARE_API_KEY: string | null;
  WEBSHARE_PROXY_COUNTRIES: string;
  WEBSHARE_REFRESH_SEC: number;

  // ── Deployment ───────────────────────────────────────────────
  API_HOST: string;
  BASE_URL: string;

  // ── Optional YouTube Data API ────────────────────────────────
  YOUTUBE_API_KEYS: string;

  // ── Tuning ───────────────────────────────────────────────────
  WEB_CONCURRENCY: number;

  TESTING: boolean;
}

let cached: Config | null = null;

/** Parse env into a frozen config object. Call once at startup. */
export function loadConfig(): Config {
  loadDotenv();

  const apiIDRaw = process.env.API_ID ?? '2040';
  const apiID = Number.parseInt(apiIDRaw, 10);
  if (Number.isNaN(apiID)) {
    throw new Error(`API_ID is not an integer: ${apiIDRaw}`);
  }

  const adminIDs: number[] = [];
  const adminSet = new Set<number>();
  // Trim per token: docker --env-file / k8s pass values verbatim, so a quoted
  // ADMIN_IDS="111 222" would otherwise silently drop the first and last admin.
  for (const tok of (process.env.ADMIN_IDS ?? '').split(/\s+/)) {
    const t = tok.trim().replace(/^['"]|['"]$/g, '');
    if (!/^\d+$/.test(t)) continue;
    const n = Number.parseInt(t, 10);
    adminIDs.push(n);
    adminSet.add(n);
  }

  const startBot =
    boolish(process.env.START_BOT ?? 'true') && boolish(process.env.ENABLE_BOT ?? 'true');

  const botToken = process.env.BOT_TOKEN || null;
  // Matches bot.py: a missing token is a warning at startup, not a config error —
  // main.py simply runs the API standalone in that case.

  const apiHost = getenv('API_HOST', 'apitest.nubcoders.com');

  let redisHost = getenv('REDIS_HOST', 'localhost');
  let redisPort = getint('REDIS_PORT', 15440);
  let redisUsername = getenv('REDIS_USERNAME', 'default');
  let redisPassword = process.env.REDIS_PASSWORD || null;
  let redisUrl = process.env.REDIS_URL || null;

  if (redisUrl) {
    try {
      const fixedUrl = redisUrl.replace(/^edis:\/\//, 'redis://');
      const parsed = new URL(fixedUrl.includes('://') ? fixedUrl : `redis://${fixedUrl}`);
      if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname ||
          (parsed.pathname && parsed.pathname !== '/' && !/^\/\d+$/.test(parsed.pathname))) {
        throw new Error('invalid Redis URL');
      }
      // A URL is a complete connection definition; discrete values only apply
      // when no URL is configured. Pass it intact to ioredis for TLS and DB.
      redisUrl = parsed.toString();
      redisHost = parsed.hostname;
      redisPort = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
      redisUsername = decodeURIComponent(parsed.username);
      redisPassword = parsed.password ? decodeURIComponent(parsed.password) : null;
    } catch {
      // Do not include the URL: it may contain a password.
      throw new Error('REDIS_URL must be a valid redis:// or rediss:// connection URL');
    }
  }

  cached = Object.freeze({
    API_ID: apiID,
    API_HASH: getenv('API_HASH', 'b18441a1ff607e10a989891a5462e627'),
    BOT_TOKEN: botToken,
    GROUP: getenv('TG_GROUP', 'nub_coder_s'),
    CHANNEL: getenv('TG_CHANNEL', 'nub_coders'),
    START_BOT: startBot,
    ADMIN_IDS: adminIDs,
    ADMIN_ID_SET: adminSet,

    REDIS_URL: redisUrl,
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    REDIS_USERNAME: redisUsername,
    REDIS_PASSWORD: redisPassword,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || null,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || null,

    DAILY_LIMIT: getint('DAILY_LIMIT', 100000),
    ADMIN_LIMIT: getint('ADMIN_LIMIT', 100000),
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || null,



    WEBSHARE_API_KEY: process.env.WEBSHARE_API_KEY || null,
    WEBSHARE_PROXY_COUNTRIES: (process.env.WEBSHARE_PROXY_COUNTRIES ?? '').toUpperCase(),
    WEBSHARE_REFRESH_SEC: getint('WEBSHARE_REFRESH_SEC', 600),

    API_HOST: apiHost,
    BASE_URL: getenv('BASE_URL', `https://${apiHost}`).replace(/\/+$/, ''),

    YOUTUBE_API_KEYS: process.env.YOUTUBE_API_KEYS ?? '',

    WEB_CONCURRENCY: getint('WEB_CONCURRENCY', 1),

    TESTING: boolish(process.env.TESTING ?? ''),
  });

  return cached;
}

/** Access the loaded config; throws if `loadConfig()` has not run. */
export function config(): Config {
  if (!cached) throw new Error('config not loaded — call loadConfig() first');
  return cached;
}

export function isAdmin(userId: number): boolean {
  return config().ADMIN_ID_SET.has(Number(userId));
}
