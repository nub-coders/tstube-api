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

async function resolveUsername(api: TelegramApi, uid: string): Promise<string> {
  try {
    const chat = await api.getChat(Number(uid));
    const name = `${chat.first_name ?? ''} ${chat.last_name ?? ''}`.trim();
    return name || `User ${uid}`;
  } catch {
    return `User ${uid}`;
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

export async function buildStats(
  api: TelegramApi,
  onProgress?: (text: string) => Promise<void>,
): Promise<string> {
  const now = new Date();

  const progress = async (t: string): Promise<void> => {
    if (onProgress) await onProgress(t);
  };

  await progress('Connecting to Redis cache database...');

  const userKeys = await scanKeys('user_token:*');
  const totalUsers = userKeys.length;

  await progress(`Registered users loaded (${comma(totalUsers)} found). Scanning active sessions...`);

  const requestKeys = await scanKeys('user_requests:*');
  const activeUsers = requestKeys.length;

  let totalRequestsToday = 0;
  const userRequestData: Array<[string, number]> = [];
  const requestCounts: number[] = [];
  for (const key of requestKeys) {
    try {
      const count = await intGet(key);
      totalRequestsToday += count;
      const uid = key.split(':')[1]!;
      userRequestData.push([uid, count]);
      requestCounts.push(count);
    } catch {
      continue;
    }
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
  const minRequests = requestCounts.length ? Math.min(...requestCounts) : 0;
  void minRequests;

  const heavyUsers = requestCounts.filter((c) => c >= 500).length;
  const moderateUsers = requestCounts.filter((c) => c >= 100 && c < 500).length;
  const lightUsers = requestCounts.filter((c) => c >= 10 && c < 100).length;
  const idleUsers = requestCounts.filter((c) => c < 10).length;
  const inactiveUsers = totalUsers - activeUsers;

  let newToday = 0;
  for (const key of userKeys) {
    const uid = key.split(':')[1]!;
    const reqCount = await redis().get(`user_requests:${uid}`);
    if (reqCount === null) newToday += 1;
  }

  const botUptime = getReadableUptime((Date.now() - ADMIN_BOT_START_TIME) / 1000);

  const redis_info = await redisInfo();
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

  const totalKeys = (await scanKeys('*')).length;
  const userUtilization = pyRoundStr((activeUsers / Math.max(totalUsers, 1)) * 100, 1);

  const theoreticalMax =
    activeUsers > 0 ? regularActive * 1000 + adminActive * 10000 : 1;
  const capacityUsage = pyRoundStr((totalRequestsToday / theoreticalMax) * 100, 1);

  let loadIndicator: string;
  if (totalRequestsToday < 10000) loadIndicator = '🟢 Low';
  else if (totalRequestsToday < 50000) loadIndicator = '🟡 Moderate';
  else if (totalRequestsToday < 100000) loadIndicator = '🟠 High';
  else loadIndicator = '🔴 Critical';

  const globalFailed = await intGet('global_failed_total');

  const statusKeys = await scanKeys('failed_by_status:*');
  const statusBreakdown: Array<[string, number]> = [];
  for (const sk of statusKeys) {
    const code = sk.split(':')[1]!;
    statusBreakdown.push([code, await intGet(sk)]);
  }
  statusBreakdown.sort((a, b) => b[1] - a[1]);

  const pathKeys = await scanKeys('failed_by_path:*');
  const pathBreakdown: Array<[string, number]> = [];
  for (const pk of pathKeys) {
    const p = pk.split(':').slice(1).join(':');
    pathBreakdown.push([p, await intGet(pk)]);
  }
  pathBreakdown.sort((a, b) => b[1] - a[1]);
  const topFailPaths = pathBreakdown.slice(0, 5);

  const failUserKeys = await scanKeys('user_failed:*');
  const userFailData: Array<[string, number]> = [];
  for (const fk of failUserKeys) {
    userFailData.push([fk.split(':')[1]!, await intGet(fk)]);
  }
  userFailData.sort((a, b) => b[1] - a[1]);
  const topFailUsers = userFailData.slice(0, 5);

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

  const failUserRows: string[] = [];
  for (let idx = 0; idx < topFailUsers.length; idx++) {
    const [uid, cnt] = topFailUsers[idx]!;
    if (onProgress) await onProgress(`Resolving failed user identity ${idx + 1}/${topFailUsers.length}...`);
    const name = await resolveUsername(api, uid);
    failUserRows.push(
      `<tr><td><b>${escapeHtml(name)}</b> (<code>${uid}</code>)</td><td><b>${comma(cnt)}</b></td></tr>`,
    );
  }
  const failUserTableRows = failUserRows.join('') || "<tr><td colspan='2'>None today ✨</td></tr>";

  const topUsers = userRequestData.slice(0, 10);
  const topUsersRows: string[] = [];
  for (let i = 0; i < topUsers.length; i++) {
    const [uid, count] = topUsers[i]!;
    const adminBadge = isAdmin(Number(uid)) ? '👑 Admin' : '👤 User';
    if (onProgress) await onProgress(`Resolving identity for active user ${i + 1}/${topUsers.length}...`);
    const name = await resolveUsername(api, uid);
    const limit = isAdmin(Number(uid)) ? 10000 : 1000;
    const pct = pyRoundStr((count / limit) * 100, 1);
    topUsersRows.push(
      `<tr><td>${i + 1}</td><td>${adminBadge} <b>${escapeHtml(name)}</b><br/><code>${uid}</code></td><td><b>${comma(count)}</b> / ${comma(limit)}</td><td><b>${pct}%</b></td></tr>`,
    );
  }
  const topUsersTable =
    topUsersRows.join('') || "<tr><td colspan='4'>No active users today</td></tr>";

  const cmdCountStr =
    typeof totalCommands === 'number' ? comma(totalCommands) : String(totalCommands);

  const ts = now.toISOString().slice(0, 19).replace('T', ' ');

  return `<h1>Bot Statistics Dashboard</h1>
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
  <tr><td><b>Regular Limit</b></td><td>1,000 req/day</td></tr>
  <tr><td><b>Admin Limit</b></td><td>10,000 req/day</td></tr>
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
  const limit = isAdmin(Number(targetUserId)) ? 10000 : 1000;
  const remaining = Math.max(0, limit - requestCount);
  const isAdm = isAdmin(Number(targetUserId))
    ? 'Yes (10,000 req/day)'
    : 'No (1,000 req/day)';

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
