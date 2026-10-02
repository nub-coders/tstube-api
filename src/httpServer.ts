/**
 * Minimal HTTP server + middleware — replaces the FastAPI/Starlette stack from
 * main.py. Node's `http` module only; no framework.
 *
 * Middleware order matches FastAPI: metrics is outermost, rate limiting wraps the
 * router, so an unauthenticated request to a protected path gets the middleware's
 * 401 before any route validation (never a 422).
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { config, isAdmin } from './config.js';
import { getLogger } from './logger.js';
import * as metrics from './metrics.js';
import { redis } from './redis.js';
import {
  getUserByToken,
  incrementUserRequests,
  incrementFailedRequests,
} from './tools.js';
import { argsFor, validateQuery, paramsFor, type QueryValues, type ValidationDetail } from './routeArgs.js';
import { HttpError } from './httpError.js';
import { nextUtcMidnightEpoch } from './quota.js';

const log = getLogger('ytube_api.http');

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets');

const FREE_PATHS = new Set([
  '/',
  '/upload.sh',
  '/search',
  '/trending',
  '/suggest',
  '/health',
  '/rate-limit-status',
  '/docs',
  '/openapi.json',
  '/metrics',
  '/favicon.ico',
  '/favicon.svg',
]);

const FREE_PREFIXES = ['/stream/resolver/', '/stream/proxy/'];

// ── Response model ──────────────────────────────────────────────

export interface Result {
  status: number;
  headers: Record<string, string>;
  /** Buffered body (already serialized). */
  body?: Buffer;
  /** JSON value, serialized at write time (preserves key insertion order). */
  json?: unknown;
  /** Streaming body (media proxy). */
  stream?: Readable | null;
  contentType?: string;
}

export function json(status: number, body: unknown): Result {
  return { status, json: body, headers: {}, contentType: 'application/json' };
}

/** Pre-serialized JSON (avoids re-encoding static envelopes). */
export function rawJson(status: number, body: string): Result {
  return { status, body: Buffer.from(body), headers: {}, contentType: 'application/json' };
}

export function text(status: number, body: string, contentType: string): Result {
  return { status, body: Buffer.from(body), headers: {}, contentType };
}

export function redirect(status: number, location: string): Result {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

export function file(path: string, contentType: string): Result {
  return { status: 200, headers: {}, body: readFileSync(path), contentType };
}

export function streamResponse(
  status: number,
  headers: Record<string, string>,
  stream: Readable,
): Result {
  return { status, headers, stream };
}

export function assetPath(name: string): string {
  return join(ASSET_DIR, name);
}

// ── Router ──────────────────────────────────────────────────────

export interface Ctx {
  req: IncomingMessage;
  url: URL;
  pathname: string;
  params: Record<string, string>;
  /** Route template when matched, else the raw path (FastAPI's metrics fallback). */
  routePath: string;
  matched: boolean;
  query: URLSearchParams;
  token: string | null;
  /** Set by the rate-limit middleware; null when no valid token. */
  authUserId: number | null;
  /** Parsed query values (populated by `requireArgs`). */
  values: QueryValues;
  method: string;
  /** Aborted when the client disconnects, including while awaiting upstream headers. */
  signal?: AbortSignal;
}

export type Handler = (ctx: Ctx) => Promise<Result> | Result;

interface Route {
  method: string;
  template: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, template: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      keys.push(name);
      return '([^/]+)';
    });
    this.routes.push({
      method: method.toUpperCase(),
      template,
      regex: new RegExp(`^${pattern}$`),
      keys,
      handler,
    });
  }

  get(template: string, handler: Handler): void {
    this.add('GET', template, handler);
  }

  post(template: string, handler: Handler): void {
    this.add('POST', template, handler);
  }

  /** Match path; HEAD falls back to the GET route (Starlette auto-adds HEAD). */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const want = method === 'HEAD' ? 'GET' : method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== want) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1] ?? '');
        } catch {
          throw new HttpError(400, { error: 'Invalid path encoding' });
        }
      });
      return { route, params };
    }
    return null;
  }

  /** True if the path matches some route but not for this method. */
  methodAllowed(pathname: string): boolean {
    return this.routes.some((r) => r.regex.test(pathname));
  }
}

// ── Request helpers ─────────────────────────────────────────────

/** Prefer `Authorization: Bearer <token>`; fall back to the deprecated ?token=. */
export function tokenFromRequest(ctx: Ctx): string | null {
  const auth = ctx.req.headers['authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (authStr && authStr.toLowerCase().startsWith('bearer ')) {
    return authStr.slice(7).trim() || null;
  }
  return ctx.query.get('token');
}

/** FastAPI's `Depends(require_token)`: 401 when the middleware resolved no user. */
export function requireToken(ctx: Ctx): number {
  if (!ctx.authUserId) {
    throw new HttpError(401, {
      error: 'Token required',
      message:
        "Get your token from the Telegram bot via /start and send it as 'Authorization: Bearer <token>' (or the deprecated ?token= query param)",
    });
  }
  return ctx.authUserId;
}

/**
 * Check if the caller is an authenticated administrator.
 * Supports either ADMIN_API_KEY from Authorization: Bearer <key>
 * or an admin Telegram user token.
 */
export function isCallerAdmin(ctx: Ctx): boolean {
  try {
    const cfg = config();
    if (cfg.ADMIN_API_KEY && ctx.token && ctx.token === cfg.ADMIN_API_KEY) {
      return true;
    }
    if (ctx.authUserId !== null && ctx.authUserId !== undefined && isAdmin(ctx.authUserId)) {
      return true;
    }
  } catch {
    /* config not loaded in isolated tests */
  }
  return false;
}

/**
 * Require admin privileges. Throws 401 if unauthenticated, 403 if unauthorized.
 */
export function requireAdmin(ctx: Ctx): void {
  if (!ctx.token && ctx.authUserId === null) {
    throw new HttpError(401, {
      error: 'Token required',
      message: "Admin authorization required. Provide token via 'Authorization: Bearer <token>'",
    });
  }
  if (!isCallerAdmin(ctx)) {
    throw new HttpError(403, {
      error: 'Forbidden',
      message: 'Admin privileges required for this endpoint.',
    });
  }
}

/**
 * Read and parse JSON request body with a size limit guard (default 5MB)
 * to prevent denial of service (DoS) and buffer overflow vulnerabilities.
 */
export async function readJsonBody<T = unknown>(ctx: Ctx, maxBytes = 5 * 1024 * 1024): Promise<T> {
  const req = ctx.req;
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        cleanup();
        reject(
          new HttpError(413, {
            error: 'Payload Too Large',
            message: `Body exceeds limit of ${maxBytes} bytes`,
          }),
        );
      } else {
        chunks.push(chunk);
      }
    };

    const onEnd = () => {
      cleanup();
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) {
          resolve({} as T);
          return;
        }
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new HttpError(400, { error: 'Invalid JSON body' }));
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(new HttpError(400, { error: 'Request body read error', details: err.message }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Validate the route's query params (FastAPI raises RequestValidationError
 * before the handler runs). Returns the parsed values or throws a 422.
 */
export function requireArgs(ctx: Ctx): QueryValues {
  const { values, details } = validateQuery(ctx.query, paramsFor(ctx.routePath));
  if (details.length) throw new HttpError(422, validationBody(ctx.routePath, details));
  ctx.values = values;
  return values;
}

function validationBody(path: string, details: ValidationDetail[]): unknown {
  const { required_arguments, optional_arguments } = argsFor(path);
  return {
    error: 'Validation Error',
    message: 'The endpoint was used incorrectly. Please verify the arguments below.',
    details,
    endpoint: path,
    required_arguments,
    optional_arguments,
  };
}

export function isFreePath(pathname: string): boolean {
  if (FREE_PATHS.has(pathname)) return true;
  return FREE_PREFIXES.some((p) => pathname.startsWith(p));
}

// ── Result serialization ────────────────────────────────────────

function serializeBody(result: Result): Buffer {
  if (result.body !== undefined) return result.body;
  if (result.json !== undefined) return Buffer.from(JSON.stringify(result.json));
  return Buffer.alloc(0);
}

function writeResult(res: ServerResponse, result: Result, headOnly: boolean): void {
  const headers: Record<string, string> = { ...result.headers };
  if (result.contentType && headers['content-type'] === undefined) {
    headers['content-type'] = result.contentType;
  }
  if (result.stream) {
    const bodyStream = result.stream;
    const stop = () => bodyStream.destroy();
    res.once('close', stop);
    bodyStream.once('close', () => res.off('close', stop));
    if (res.destroyed) {
      bodyStream.destroy();
      return;
    }
    res.writeHead(result.status, headers);
    if (headOnly) {
      result.stream.destroy();
      res.end();
      return;
    }
    result.stream.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    });
    result.stream.pipe(res);
    return;
  }
  const body = serializeBody(result);
  if (headers['content-length'] === undefined) headers['content-length'] = String(body.length);
  res.writeHead(result.status, headers);
  if (headOnly) res.end();
  else res.end(body);
}

/** Extract the error message from a 4xx/5xx body for the failure log. */
function extractError(body: Buffer): string {
  try {
    const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    let msg: unknown = payload.error ?? payload.detail ?? payload.message ?? '';
    if (typeof msg === 'object' && msg !== null) {
      const m = msg as Record<string, unknown>;
      msg = m.error ?? m.message ?? JSON.stringify(msg);
    }
    return String(msg ?? '');
  } catch {
    return body.subarray(0, 300).toString('utf8');
  }
}

export type RouteSpec =
  | [template: string, handler: Handler]
  | [method: string, template: string, handler: Handler];

export interface ServerDeps {
  routes: RouteSpec[];
}

export function createAppServer(deps: ServerDeps): http.Server {
  const router = new Router();
  for (const entry of deps.routes) {
    if (entry.length === 2) {
      router.get(entry[0], entry[1]);
    } else {
      router.add(entry[0], entry[1], entry[2]);
    }
  }

  return http.createServer((req, res) => {
    void handle(req, res, router).catch((error) => {
      log.error('[HTTP] request failed outside response handler', { err: String(error) });
      try {
        if (!res.headersSent && !res.destroyed) {
          writeResult(res, json(500, { error: 'Internal Server Error' }), req.method === 'HEAD');
        } else {
          res.destroy();
        }
      } catch {
        res.destroy();
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, router: Router): Promise<void> {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', () => {
    req.off('aborted', abort);
    abort();
  });
  const url = new URL('http://localhost/');
  let metricPath = 'unmatched';
  const ctx: Ctx = {
    req,
    url,
    pathname: '/',
    params: {},
    routePath: '/',
    matched: false,
    query: url.searchParams,
    token: null,
    authUserId: null,
    values: {},
    method,
    signal: controller.signal,
  };

  let result: Result;
  try {
    try {
      ctx.url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      throw new HttpError(400, { error: 'Invalid request URL' });
    }
    ctx.pathname = ctx.url.pathname;
    ctx.query = ctx.url.searchParams;
    const matched = router.match(method, ctx.pathname);
    ctx.params = matched?.params ?? {};
    ctx.routePath = matched?.route.template ?? ctx.pathname;
    ctx.matched = matched !== null;
    ctx.token = tokenFromRequest(ctx);
    metricPath = matched?.route.template ?? 'unmatched';
    result = await runPipeline(ctx, router, matched);
  } catch (e) {
    if (e instanceof HttpError) {
      result = json(e.status, e.payload);
    } else {
      log.error(`[HTTP] unhandled error for ${method} ${ctx.pathname}`, { err: String(e) });
      result = json(500, { error: String(e) });
    }
  }

  const duration = (Date.now() - started) / 1000;
  // Only registered templates reach metric labels; never arbitrary request paths.
  metrics.record(method, metricPath, result.status, duration);

  if (res.destroyed) {
    result.stream?.destroy();
    return;
  }

  try {
    writeResult(res, result, method === 'HEAD');
  } catch (e) {
    result.stream?.destroy();
    log.error(`[HTTP] failed to write response for ${method} ${ctx.pathname}`, { err: String(e) });
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

async function runPipeline(
  ctx: Ctx,
  router: Router,
  matched: { route: Route; params: Record<string, string> } | null,
): Promise<Result> {
  if (isFreePath(ctx.pathname)) {
    return await dispatch(ctx, router, matched);
  }

  // ── RateLimitMiddleware ──
  if (ctx.token) {
    // Revocations and legacy orphan cleanup take effect on the next request.
    ctx.authUserId = await getUserByToken(ctx.token);
    if (!ctx.authUserId) {
      try {
        const cfg = config();
        if (cfg.ADMIN_API_KEY && ctx.token === cfg.ADMIN_API_KEY) {
          ctx.authUserId = cfg.ADMIN_IDS[0] ?? -1;
        }
      } catch {
        /* config not loaded in isolated tests */
      }
    }
  }

  if (!ctx.authUserId) {
    const { required_arguments, optional_arguments } = argsFor(ctx.routePath);
    return json(401, {
      error: 'Token required',
      message: 'Get your token from @ytdlp_nub_bot using /start',
      required_arguments,
      optional_arguments,
    });
  }

  let userLimit = 1000;
  try {
    const cfg = config();
    userLimit = isCallerAdmin(ctx) ? cfg.ADMIN_LIMIT : cfg.DAILY_LIMIT;
  } catch {
    /* fallback to default */
  }

  // Increment optimistically; only reject if we've now gone over.
  const newCount = ctx.authUserId > 0 ? await incrementUserRequests(ctx.authUserId) : 1;
  if (newCount > userLimit) {
    return json(429, {
      error: 'Daily limit exceeded',
      message: `Limit: ${userLimit} req/day. Search is always free.`,
      remaining_requests: 0,
      reset_time: 'Resets at midnight UTC',
    });
  }

  let result = await dispatch(ctx, router, matched);

  // Log failures. Buffered responses only; the proxy only returns JSON errors.
  if (result.status >= 400 && !result.stream) {
    const body = serializeBody(result);
    try {
      await incrementFailedRequests(ctx.authUserId, result.status, ctx.pathname, extractError(body));
    } catch (e) {
      log.error(`[RATELIMIT] failed to record failure: ${String(e)}`);
    }
  }

  const remaining = Math.max(0, userLimit - newCount);
  result.headers['X-RateLimit-Limit'] = String(userLimit);
  result.headers['X-RateLimit-Remaining'] = String(remaining);
  result.headers['X-RateLimit-Reset'] = String(nextUtcMidnightEpoch());
  return result;
}

async function dispatch(
  ctx: Ctx,
  router: Router,
  matched: { route: Route; params: Record<string, string> } | null,
): Promise<Result> {
  if (!matched) {
    if (router.methodAllowed(ctx.pathname)) {
      return json(405, { detail: 'Method Not Allowed' });
    }
    return json(404, { detail: 'Not Found' });
  }
  try {
    return await matched.route.handler(ctx);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, e.payload);
    throw e;
  }
}

// ── Misc shared endpoints ───────────────────────────────────────

export async function metricsHandler(): Promise<Result> {
  return text(200, metrics.render(), 'text/plain; version=0.0.4');
}

export async function rateLimitStatus(ctx: Ctx): Promise<Result> {
  requireArgs(ctx);
  const cfg = config();
  const token = ctx.query.get('token');
  const userId = await getUserByToken(token);
  if (!userId) {
    return json(200, {
      error: 'No token provided',
      message:
        'Please get your token from the Telegram bot using /start command and add it as ?token=YOUR_TOKEN',
      auth_method: 'none',
    });
  }
  const admin = isAdmin(userId);
  const limit = admin ? cfg.ADMIN_LIMIT : cfg.DAILY_LIMIT;
  const used = await requestCount(userId);
  return json(200, {
    user_id: userId,
    daily_limit: limit,
    requests_used: used,
    requests_remaining: Math.max(0, limit - used),
    reset_time: 'Resets at midnight UTC',
    is_admin: admin,
    auth_method: 'token',
  });
}

async function requestCount(userId: number): Promise<number> {
  const v = await redis().get(`user_requests:${userId}`);
  return v ? Number.parseInt(v, 10) : 0;
}
