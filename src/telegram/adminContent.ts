/**
 * Admin rich-UI content + telemetry — port of plugins/admin.py.
 *
 * `buildStats` reproduces the Redis scan/aggregate dashboard; the remaining
 * builders are the smaller admin cards.
 */
import type { TelegramApi } from './api.js';
import { escapeHtml } from './rich.js';
import { redis, scanKeys } from '../redis.js';
import { isAdmin, config } from '../config.js';
import { getRecentErrors, type ErrorLogEntry } from '../tools.js';
import { comma, pyRoundStr } from '../pyTime.js';
import { getReadableUptime, apiUrl } from './content.js';
import { cookiePool } from '../cookiePool.js';

export const ADMIN_BOT_START_TIME = Date.now();

const usernameCache = new Map<string, string>();

async function resolveUsername(api: TelegramApi, uid: string): Promise<string> {
  const cached = usernameCache.get(uid);
  if (cached) return cached;
  try {
    const chatPromise = api.getChat(Number(uid));
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('getChat timeout')), 800),
    );
    const chat = await Promise.race([chatPromise, timeoutPromise]);
    const name = `${chat.first_name ?? ''} ${chat.last_name ?? ''}`.trim() || `User ${uid}`;
    usernameCache.set(uid, name);
    return name;
  } catch {
    const fallback = `User ${uid}`;
    usernameCache.set(uid, fallback);
    return fallback;
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Parse `/info` reply into a map, coercing numeric fields like redis-py does. */
async function redisInfo(): Promise<Record<string, string | number>> {
  const raw = (await redis().info()) as string;
  const out: Record<string, string | number> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx);
    const val = trimmed.slice(idx + 1);
    out[key] = /^-?\d+$/.test(val) ? Number.parseInt(val, 10) : val;
  }
  return out;
}

async function intGet(key: string): Promise<number> {
  const v = await redis().get(key);
  return v ? Number.parseInt(v, 10) : 0;
}

async function mgetInts(keys: string[]): Promise<number[]> {
  if (keys.length === 0) return [];
  const chunkSize = 500;
  const result: number[] = [];
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const vals = await redis().mget(chunk);
    for (const v of vals) {
      result.push(v ? Number.parseInt(v, 10) : 0);
    }
  }
  return result;
}

interface StatsCache {
  html: string;
  ts: number;
}
let statsCache: StatsCache | null = null;
const STATS_CACHE_TTL_MS = 20_000;

export async function buildStats(
  api: TelegramApi,
  onProgress?: (text: string) => Promise<void>,
  forceRefresh = false,
): Promise<string> {
  const nowMs = Date.now();
  if (!forceRefresh && !onProgress && statsCache && nowMs - statsCache.ts < STATS_CACHE_TTL_MS) {
    return statsCache.html;
  }

  const now = new Date();

  const progress = async (t: string): Promise<void> => {
    if (onProgress) await onProgress(t);
  };

  await progress('Connecting to Redis cache database...');

  // Scan user tokens and active sessions concurrently
  const [userKeys, requestKeys] = await Promise.all([
    scanKeys('user_token:*'),
    scanKeys('user_requests:*'),
  ]);
  const totalUsers = userKeys.length;
  const activeUsers = requestKeys.length;

  await progress(`Registered users loaded (${comma(totalUsers)} found). Scanning active sessions...`);

  // Batch-fetch all request counters in a single round-trip
  const counts = await mgetInts(requestKeys);
  let totalRequestsToday = 0;
  const userRequestData: Array<[string, number]> = [];
  const requestCounts: number[] = [];
  for (let i = 0; i < requestKeys.length; i++) {
    const count = counts[i]!;
    totalRequestsToday += count;
    const uid = requestKeys[i]!.split(':')[1]!;
    userRequestData.push([uid, count]);
    requestCounts.push(count);
  }
  userRequestData.sort((a, b) => b[1] - a[1]);

  let adminRequests = 0;
  let regularRequests = 0;
  let adminActive = 0;
  let regularActive = 0;
  for (const [uid, count] of userRequestData) {
    if (isAdmin(Number(uid))) {
      adminRequests += count;
      adminActive += 1;
    } else {
      regularRequests += count;
      regularActive += 1;
    }
  }
  const totalAdminCount = userKeys.filter((k) => isAdmin(Number(k.split(':')[1]))).length;
  const regularTotal = totalUsers - totalAdminCount;

  const avgRequests = pyRoundStr(totalRequestsToday / Math.max(activeUsers, 1), 2);
  const medianRequests = Math.trunc(median(requestCounts));
  const peakRequests = requestCounts.length ? Math.max(...requestCounts) : 0;

  const heavyUsers = requestCounts.filter((c) => c >= 500).length;
  const moderateUsers = requestCounts.filter((c) => c >= 100 && c < 500).length;
  const lightUsers = requestCounts.filter((c) => c >= 10 && c < 100).length;
  const idleUsers = requestCounts.filter((c) => c < 10).length;
  const inactiveUsers = totalUsers - activeUsers;

  // Zero network round-trips: compute new users with 0 requests today in-memory
  const activeUidSet = new Set(userRequestData.map(([uid]) => uid));
  let newToday = 0;
  for (const key of userKeys) {
    const uid = key.split(':')[1]!;
    if (!activeUidSet.has(uid)) newToday += 1;
  }

  const botUptime = getReadableUptime((Date.now() - ADMIN_BOT_START_TIME) / 1000);

  // Parallelize failure keys, database size, redis info, and global failed count
  const [
    statusKeys,
    pathKeys,
    failUserKeys,
    totalKeys,
    redis_info,
    globalFailed,
  ] = await Promise.all([
    scanKeys('failed_by_status:*'),
    scanKeys('failed_by_path:*'),
    scanKeys('user_failed:*'),
    redis().dbsize().catch(() => userKeys.length + requestKeys.length),
    redisInfo().catch(() => ({} as Record<string, string | number>)),
    intGet('global_failed_total'),
  ]);

  // Batch-fetch failure values concurrently
  const [statusVals, pathVals, failUserVals] = await Promise.all([
    mgetInts(statusKeys),
    mgetInts(pathKeys),
    mgetInts(failUserKeys),
  ]);

  const statusBreakdown: Array<[string, number]> = statusKeys.map((sk, idx) => [
    sk.split(':')[1]!,
    statusVals[idx]!,
  ]);
  statusBreakdown.sort((a, b) => b[1] - a[1]);

  const pathBreakdown: Array<[string, number]> = pathKeys.map((pk, idx) => [
    pk.split(':').slice(1).join(':'),
    pathVals[idx]!,
  ]);
  pathBreakdown.sort((a, b) => b[1] - a[1]);
  const topFailPaths = pathBreakdown.slice(0, 5);

  const userFailData: Array<[string, number]> = failUserKeys.map((fk, idx) => [
    fk.split(':')[1]!,
    failUserVals[idx]!,
  ]);
  userFailData.sort((a, b) => b[1] - a[1]);
  const topFailUsers = userFailData.slice(0, 5);

  const redisMemory = String(redis_info.used_memory_human ?? 'N/A');
  const redisPeakMemory = String(redis_info.used_memory_peak_human ?? 'N/A');
  const redisUptime = Number(redis_info.uptime_in_seconds ?? 0);
  const redisUptimeStr = getReadableUptime(redisUptime);
  const connectedClients = redis_info.connected_clients ?? 'N/A';
  const opsPerSec = redis_info.instantaneous_ops_per_sec ?? 'N/A';
  const totalCommands = redis_info.total_commands_processed ?? 'N/A';

  const hits = Number(redis_info.keyspace_hits ?? 0);
  const misses = Number(redis_info.keyspace_misses ?? 0);
  const totalLookups = hits + misses;
  const hitRate = pyRoundStr((hits / Math.max(totalLookups, 1)) * 100, 1);

  const userUtilization = pyRoundStr((activeUsers / Math.max(totalUsers, 1)) * 100, 1);

  const theoreticalMax =
    activeUsers > 0 ? regularActive * config().DAILY_LIMIT + adminActive * config().ADMIN_LIMIT : 1;
  const capacityUsage = pyRoundStr((totalRequestsToday / theoreticalMax) * 100, 1);

  let loadIndicator: string;
  if (totalRequestsToday < config().DAILY_LIMIT) loadIndicator = '🟢 Low';
  else if (totalRequestsToday < config().DAILY_LIMIT * 50) loadIndicator = '🟡 Moderate';
  else if (totalRequestsToday < config().DAILY_LIMIT * 100) loadIndicator = '🟠 High';
  else loadIndicator = '🔴 Critical';

  const totalAll = totalRequestsToday + globalFailed;
  const successRate = pyRoundStr(((totalAll - globalFailed) / Math.max(totalAll, 1)) * 100, 1);

  const statusTableRows =
    statusBreakdown
      .slice(0, 6)
      .map(([code, cnt]) => `<tr><td><code>${escapeHtml(code)}</code></td><td><b>${comma(cnt)}</b></td></tr>`)
      .join('') || "<tr><td colspan='2'>None today ✨</td></tr>";
  const pathTableRows =
    topFailPaths
      .map(([p, cnt]) => `<tr><td><code>${escapeHtml(p)}</code></td><td><b>${comma(cnt)}</b></td></tr>`)
      .join('') || "<tr><td colspan='2'>None today ✨</td></tr>";

  // Resolve top fail and top active usernames concurrently
  const topUsers = userRequestData.slice(0, 10);

  const [resolvedFailUsers, resolvedTopUsers] = await Promise.all([
    Promise.all(
      topFailUsers.map(async ([uid, cnt], idx) => {
        if (onProgress) await onProgress(`Resolving failed user identity ${idx + 1}/${topFailUsers.length}...`);
        const name = await resolveUsername(api, uid);
        return [uid, cnt, name] as const;
      }),
    ),
    Promise.all(
      topUsers.map(async ([uid, count], idx) => {
        if (onProgress) await onProgress(`Resolving identity for active user ${idx + 1}/${topUsers.length}...`);
        const name = await resolveUsername(api, uid);
        return [uid, count, name] as const;
      }),
    ),
  ]);

  const failUserRows = resolvedFailUsers.map(
    ([uid, cnt, name]) =>
      `<tr><td><b>${escapeHtml(name)}</b> (<code>${uid}</code>)</td><td><b>${comma(cnt)}</b></td></tr>`,
  );
  const failUserTableRows = failUserRows.join('') || "<tr><td colspan='2'>None today ✨</td></tr>";

  const topUsersRows = resolvedTopUsers.map(([uid, count, name], idx) => {
    const adminBadge = isAdmin(Number(uid)) ? '👑 Admin' : '👤 User';
    const limit = isAdmin(Number(uid)) ? config().ADMIN_LIMIT : config().DAILY_LIMIT;
    const pct = pyRoundStr((count / limit) * 100, 1);
    return `<tr><td>${idx + 1}</td><td>${adminBadge} <b>${escapeHtml(name)}</b><br/><code>${uid}</code></td><td><b>${comma(count)}</b> / ${comma(limit)}</td><td><b>${pct}%</b></td></tr>`;
  });
  const topUsersTable =
    topUsersRows.join('') || "<tr><td colspan='4'>No active users today</td></tr>";

  const cmdCountStr =
    typeof totalCommands === 'number' ? comma(totalCommands) : String(totalCommands);

  const ts = now.toISOString().slice(0, 19).replace('T', ' ');

  const fullHtml = `<h1>Bot Statistics Dashboard</h1>
<blockquote>Generated: <b>${ts} UTC</b> | Bot Uptime: <code>${botUptime}</code></blockquote>

<h2>User Metrics</h2>
<table border="1">
  <tr><th>Metric</th><th>Count</th></tr>
  <tr><td><b>Total Registered</b></td><td>${comma(totalUsers)}</td></tr>
  <tr><td><b>Active Today</b></td><td>${comma(activeUsers)} (${userUtilization}%)</td></tr>
  <tr><td><b>Inactive Today</b></td><td>${comma(inactiveUsers)}</td></tr>
  <tr><td><b>New (0 Requests)</b></td><td>${comma(newToday)}</td></tr>
  <tr><td><b>Admin Users</b></td><td>${totalAdminCount} (${adminActive} active)</td></tr>
  <tr><td><b>Regular Users</b></td><td>${comma(regularTotal)} (${regularActive} active)</td></tr>
</table>

<h2>Request Analytics</h2>
<table border="1">
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td><b>Total Today</b></td><td><b>${comma(totalRequestsToday)}</b></td></tr>
  <tr><td><b>Admin Requests</b></td><td>${comma(adminRequests)}</td></tr>
  <tr><td><b>Regular Requests</b></td><td>${comma(regularRequests)}</td></tr>
  <tr><td><b>Avg / Active User</b></td><td>${avgRequests}</td></tr>
  <tr><td><b>Median / User</b></td><td>${medianRequests}</td></tr>
  <tr><td><b>Peak Single User</b></td><td>${comma(peakRequests)}</td></tr>
  <tr><td><b>Capacity Used</b></td><td>${capacityUsage}%</td></tr>
</table>

<h2>Activity Tiers</h2>
<table border="1">
  <tr><th>Tier</th><th>Range</th><th>Users</th></tr>
  <tr><td>🔴 <b>Heavy</b></td><td>500+ req</td><td>${heavyUsers}</td></tr>
  <tr><td>🟠 <b>Moderate</b></td><td>100–499 req</td><td>${moderateUsers}</td></tr>
  <tr><td>🟢 <b>Light</b></td><td>10–99 req</td><td>${lightUsers}</td></tr>
  <tr><td>⚪ <b>Idle</b></td><td>&lt;10 req</td><td>${idleUsers}</td></tr>
</table>

<h2>Top 10 Users Today</h2>
<table border="1">
  <tr><th>#</th><th>User</th><th>Requests</th><th>Quota</th></tr>
  ${topUsersTable}
</table>

<h2>Redis Infrastructure</h2>
<table border="1">
  <tr><th>Property</th><th>Status</th></tr>
  <tr><td><b>Used Memory</b></td><td>${redisMemory} (Peak: ${redisPeakMemory})</td></tr>
  <tr><td><b>Redis Uptime</b></td><td>${redisUptimeStr}</td></tr>
  <tr><td><b>Clients</b></td><td>${connectedClients}</td></tr>
  <tr><td><b>Ops / Sec</b></td><td>${opsPerSec}</td></tr>
  <tr><td><b>Commands</b></td><td>${cmdCountStr}</td></tr>
  <tr><td><b>Hit Rate</b></td><td>${hitRate}% (${comma(hits)} hits / ${comma(misses)} misses)</td></tr>
  <tr><td><b>Total Keys</b></td><td>${comma(totalKeys)}</td></tr>
</table>

<h2>System Health &amp; Rate Limits</h2>
<table border="1">
  <tr><th>Configuration</th><th>Value</th></tr>
  <tr><td><b>Regular Limit</b></td><td>${comma(config().DAILY_LIMIT)} req/day</td></tr>
  <tr><td><b>Admin Limit</b></td><td>${comma(config().ADMIN_LIMIT)} req/day</td></tr>
  <tr><td><b>Search API</b></td><td>Unlimited</td></tr>
  <tr><td><b>System Load</b></td><td>${loadIndicator}</td></tr>
  <tr><td><b>Active Ratio</b></td><td>${userUtilization}%</td></tr>
  <tr><td><b>Cache Status</b></td><td><b>Operational</b></td></tr>
</table>

<h2>Failure Analytics</h2>
<table border="1">
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td><b>Total Failed</b></td><td><b>${comma(globalFailed)}</b></td></tr>
  <tr><td><b>Success Rate</b></td><td><b>${successRate}%</b></td></tr>
</table>

<details>
  <summary><b>Error Details &amp; Failing Endpoints</b></summary>
  <h3>By Status Code</h3>
  <table border="1">
    <tr><th>Status</th><th>Count</th></tr>
    ${statusTableRows}
  </table>
  <h3>Top Failing Paths</h3>
  <table border="1">
    <tr><th>Path</th><th>Failures</th></tr>
    ${pathTableRows}
  </table>
  <h3>Top Failing Users</h3>
  <table border="1">
    <tr><th>User</th><th>Failures</th></tr>
    ${failUserTableRows}
  </table>
</details>`;

  statsCache = { html: fullHtml, ts: Date.now() };
  return fullHtml;
}

// ── Smaller admin cards ─────────────────────────────────────────

export function userInfoCard(
  targetUserId: string,
  token: string,
  requestCount: number,
  failedCount: number,
): string {
  const total = requestCount + failedCount;
  const successRate = pyRoundStr((requestCount / Math.max(total, 1)) * 100, 1);
  const limit = isAdmin(Number(targetUserId)) ? config().ADMIN_LIMIT : config().DAILY_LIMIT;
  const remaining = Math.max(0, limit - requestCount);
  const isAdm = isAdmin(Number(targetUserId))
    ? `Yes (${comma(config().ADMIN_LIMIT)} req/day)`
    : `No (${comma(config().DAILY_LIMIT)} req/day)`;

  return `<h1>User Information</h1>
<blockquote>Account profile and activity metrics for user <code>${targetUserId}</code>.</blockquote>

<table border="1">
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td><b>User ID</b></td><td><code>${targetUserId}</code></td></tr>
  <tr><td><b>Token</b></td><td><code>${token}</code></td></tr>
  <tr><td><b>Admin Status</b></td><td>${isAdm}</td></tr>
</table>

<h2>Usage Summary</h2>
<table border="1">
  <tr><th>Metric</th><th>Count</th></tr>
  <tr><td><b>Successful Requests</b></td><td><b>${comma(requestCount)}</b> / ${comma(limit)}</td></tr>
  <tr><td><b>Failed Requests</b></td><td><b>${comma(failedCount)}</b></td></tr>
  <tr><td><b>Total Requests</b></td><td><b>${comma(total)}</b></td></tr>
  <tr><td><b>Success Rate</b></td><td><b>${successRate}%</b></td></tr>
  <tr><td><b>Remaining Quota</b></td><td><b>${comma(remaining)}</b></td></tr>
</table>`;
}

export function grantCard(
  targetUserId: number,
  amount: number,
  currentCount: number,
  newCount: number,
): string {
  return `<h1>Request Quota Granted</h1>
<blockquote>Successfully credited extra API requests to user <code>${targetUserId}</code>.</blockquote>

<table border="1">
  <tr><th>Parameter</th><th>Detail</th></tr>
  <tr><td><b>User ID</b></td><td><code>${targetUserId}</code></td></tr>
  <tr><td><b>Granted Bonus</b></td><td><b>+${comma(amount)}</b> requests</td></tr>
  <tr><td><b>Previous Used Count</b></td><td>${comma(currentCount)}</td></tr>
  <tr><td><b>Adjusted Used Count</b></td><td><b>${comma(newCount)}</b></td></tr>
</table>`;
}

export function revokeAdminCard(targetUserId: number): string {
  return `<h1>Token Revoked</h1>
<blockquote>✅ API token for user <code>${targetUserId}</code> has been revoked and deleted from the database.</blockquote>`;
}

export function listUsersCard(rows: string): string {
  const tableRows = rows || "<tr><td colspan='2'>No users found</td></tr>";
  return `<h1>Recent Registered Users</h1>
<blockquote>Displaying up to 20 registered users and their daily request counts.</blockquote>

<table border="1">
  <tr><th>User ID</th><th>Requests Today</th></tr>
  ${tableRows}
</table>`;
}

export function adminHelpCard(): string {
  return `<h1>Admin Control Panel</h1>
<blockquote>Administrative commands for maintenance, telemetry, and quota control.</blockquote>

<h2>Command Reference</h2>
<table border="1">
  <tr><th>Command</th><th>Purpose</th></tr>
  <tr><td><code>/stats</code></td><td>View interactive bot and server statistics</td></tr>
  <tr><td><code>/errors [n]</code></td><td>View recent API error logs (default 15)</td></tr>
  <tr><td><code>/user &lt;id&gt;</code></td><td>Query user quota, token, and error counts</td></tr>
  <tr><td><code>/grant &lt;id&gt; &lt;qty&gt;</code></td><td>Credit extra requests to a user</td></tr>
  <tr><td><code>/revoke &lt;id&gt;</code></td><td>Forcefully revoke a user's API token</td></tr>
  <tr><td><code>/listusers</code></td><td>List recent registered users</td></tr>
  <tr><td><code>/broadcast</code></td><td>Broadcast a replied message to all users</td></tr>
  <tr><td><code>/cookies</code></td><td>🍪 View cookie pool status and management panel</td></tr>
  <tr><td><code>/cookie_terminate &lt;label&gt;</code></td><td>🗑 Terminate a cookie by label/ID</td></tr>
  <tr><td><code>/cookie_probe</code></td><td>🔍 Force background health probe on all cookies</td></tr>
  <tr><td><code>/cookie_upload</code></td><td>📤 Show the full cookie upload command with your key</td></tr>
  <tr><td><code>/cookie_purge</code></td><td>🗑 Hard-delete all expired and inactive cookies</td></tr>
</table>

<details>
  <summary><b>Command Examples</b></summary>
  <pre><code>/user 123456789
/grant 123456789 500
/revoke 123456789
/errors 30
/cookies
/cookie_terminate myaccount_label
/cookie_probe
/cookie_upload</code></pre>
</details>`;
}

// ── Cookie Management Cards ─────────────────────────────────────

/** Build a rich cookie pool status dashboard. */
export async function buildCookieStatus(): Promise<string> {
  const cookies = await cookiePool.getStatus();
  const total = cookies.length;
  const active = cookies.filter((c) => c.is_active).length;
  const inactive = total - active;

  const healthIcon = (c: (typeof cookies)[0]): string => {
    if (!c.is_active) return '🔴';
    if ((c.error_count ?? 0) >= 2) return '🟠';
    if ((c.error_count ?? 0) >= 1) return '🟡';
    return '🟢';
  };

  const rows = cookies
    .map((c) => {
      const icon = healthIcon(c);
      const lastUsed = c.last_used_at
        ? new Date(c.last_used_at).toISOString().slice(0, 16).replace('T', ' ')
        : 'Never';
      const lastErr = c.last_error ? escapeHtml(c.last_error.slice(0, 50)) : '—';
      const successes = typeof c.success_count === 'number' ? comma(c.success_count) : '—';
      return `<tr>
  <td>${icon} <b>${escapeHtml(c.label)}</b></td>
  <td><code>${c.is_active ? 'Active' : 'Inactive'}</code></td>
  <td>${c.error_count ?? 0} errs / ${successes} ok</td>
  <td>${lastUsed}</td>
  <td>${lastErr}</td>
</tr>`;
    })
    .join('');

  const tableRows = rows || "<tr><td colspan='5'>No cookies in pool</td></tr>";

  const poolBackend = cookiePool.size >= 0 ? 'MongoDB' : 'In-memory';
  void poolBackend;

  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');

  return `<h1>🍪 Cookie Pool Status</h1>
<blockquote>Generated: <b>${ts} UTC</b></blockquote>

<h2>Pool Summary</h2>
<table border="1">
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td><b>Total Cookies</b></td><td>${comma(total)}</td></tr>
  <tr><td><b>Active (in rotation)</b></td><td><b>${comma(active)}</b></td></tr>
  <tr><td><b>Inactive / Terminated</b></td><td>${comma(inactive)}</td></tr>
  <tr><td><b>Current Pool Size</b></td><td><b>${comma(cookiePool.size)}</b></td></tr>
</table>

<h2>Cookie Details</h2>
<table border="1">
  <tr><th>Label</th><th>Status</th><th>Stats</th><th>Last Used</th><th>Last Error</th></tr>
  ${tableRows}
</table>

<details>
  <summary><b>Management Commands</b></summary>
  <pre><code>/cookie_terminate &lt;label&gt;  — Deactivate a cookie
/cookie_probe               — Force health probe now
/cookie_upload              — Show upload command</code></pre>
</details>`;
}

/** Build the full cookie upload command card with the admin token embedded. */
export function cookieUploadCommandCard(adminToken: string): string {
  const cfg = config();
  const serverUrl = cfg.BASE_URL || apiUrl();
  const key = cfg.ADMIN_API_KEY || adminToken;

  const basicCmd = `bash <(curl -s ${serverUrl}/upload.sh) -k ${key}`;
  const fullCmd = `bash <(curl -s ${serverUrl}/upload.sh) -k ${key} -b chrome,firefox,brave -v`;
  const loopCmd = `bash <(curl -s ${serverUrl}/upload.sh) -k ${key} --loop --interval 3600`;

  return `<h1>📤 Cookie Upload Command</h1>
<blockquote>Use the commands below on your machine to extract and sync YouTube cookies to the API pool.</blockquote>

<h2>Basic Upload</h2>
<blockquote>Detects all browsers automatically:</blockquote>
<pre><code>${escapeHtml(basicCmd)}</code></pre>

<h2>Full Upload (All Browsers)</h2>
<blockquote>Extract from Chrome, Firefox, and Brave with verbose output:</blockquote>
<pre><code>${escapeHtml(fullCmd)}</code></pre>

<h2>Loop Mode (Auto-Sync)</h2>
<blockquote>Continuously sync every hour:</blockquote>
<pre><code>${escapeHtml(loopCmd)}</code></pre>

<details>
  <summary><b>Options Reference</b></summary>
  <table border="1">
    <tr><th>Flag</th><th>Description</th></tr>
    <tr><td><code>-k &lt;KEY&gt;</code></td><td>Admin API key (required)</td></tr>
    <tr><td><code>-b &lt;LIST&gt;</code></td><td>Browsers: chrome,firefox,brave,edge,chromium</td></tr>
    <tr><td><code>-p &lt;LIST&gt;</code></td><td>Profiles to use (default: all)</td></tr>
    <tr><td><code>--loop</code></td><td>Run continuously</td></tr>
    <tr><td><code>--interval &lt;SEC&gt;</code></td><td>Loop interval in seconds (default: 3600)</td></tr>
    <tr><td><code>-d, --dry-run</code></td><td>Extract locally without uploading</td></tr>
    <tr><td><code>-v, --verbose</code></td><td>Verbose yt-dlp output</td></tr>
  </table>
</details>`;
}

export const ACCESS_DENIED = "<blockquote>❌ <b>Access Denied:</b> Admin privileges required.</blockquote>";
export const ACCESS_DENIED_STATS =
  "<blockquote>❌ <b>Access Denied:</b> You don't have admin privileges.</blockquote>";

/** Build the chunked `/errors` message list. */
export function errorLogCards(entries: ErrorLogEntry[]): string[] {
  const header = `<h1>Recent API Error Log (${entries.length})</h1><blockquote>Displaying latest error entries recorded by the API.</blockquote>`;
  const cards: string[] = [];
  entries.forEach((entry, i) => {
    const ts = escapeHtml(entry.ts ?? '?');
    const uid = escapeHtml(entry.user ?? '?');
    const status = escapeHtml(entry.status ?? '?');
    const path = escapeHtml(entry.path ?? '?');
    let error = escapeHtml(entry.error ?? 'No message');
    if (error.length > 150) error = error.slice(0, 147) + '...';
    cards.push(`<table border="1">
  <tr><th>#</th><th>Timestamp</th><th>User</th><th>Status</th><th>Path</th></tr>
  <tr><td>${i + 1}</td><td>${ts}</td><td><code>${uid}</code></td><td><code>${status}</code></td><td><code>${path}</code></td></tr>
</table>
<blockquote>💬 ${error}</blockquote>`);
  });

  const messages: string[] = [];
  let current = header;
  for (const card of cards) {
    if (current.length + card.length > 3600) {
      messages.push(current);
      current = '';
    }
    current += '\n' + card;
  }
  if (current) messages.push(current);
  return messages;
}

export { getRecentErrors, redis, scanKeys };
