/**
 * Rich-UI content — verbatim port of the HTML templates from
 * plugins/commands.py, plugins/status.py, plugins/admin.py and
 * plugins/broadcast.py.
 *
 * Wording, entities and whitespace match Python so the rendered messages are
 * identical. `{ephemeral}` is used in groups (token visible) and `fallback` is
 * sent when ephemeral delivery is rejected because the bot isn't a group admin.
 */
import { config } from '../config.js';
import { maskToken } from '../tools.js';
import { escapeHtml } from './rich.js';
import { comma, pyNumStr, pyRoundStr } from '../pyTime.js';

export interface RichContent {
  html: string;
  fallback?: string;
}

export const BOT_START_TIME = Date.now();

export function apiUrl(path = ''): string {
  const base = config().BASE_URL;
  return path ? `${base}/${path.replace(/^\/+/, '')}` : base;
}

export function getReadableTime(seconds: number): string {
  const total = Math.trunc(seconds);
  let m = Math.floor(total / 60);
  const s = total % 60;
  let h = Math.floor(m / 60);
  m %= 60;
  const d = Math.floor(h / 24);
  h %= 24;
  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Admin uptime: omit zero day/hour/minute parts, always show seconds. */
export function getReadableUptime(seconds: number): string {
  const total = Math.trunc(seconds);
  let m = Math.floor(total / 60);
  const s = total % 60;
  let h = Math.floor(m / 60);
  m %= 60;
  const d = Math.floor(h / 24);
  h %= 24;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

const GROUP_PRIVACY_FOOTER =
  '\n<details>\n  <summary>🔒 Group Chat Privacy Notice</summary>\n  <blockquote>Token is masked for group security. DM the bot /start or promote bot to admin for private ephemeral responses.</blockquote>\n</details>';

// ── /start ──────────────────────────────────────────────────────

export function startExisting(username: string, token: string, isGrp: boolean): RichContent {
  const name = escapeHtml(username);
  const masked = maskToken(token);
  const ephemeral =
    `<h1>Welcome back, ${name}!</h1>
<blockquote>Your YT-DLP API integration is active and ready for requests.</blockquote>

<table border="1">
  <tr><th>Setting</th><th>Value</th></tr>
  <tr><td><b>API Token</b></td><td><code>${token}</code></td></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}</code></td></tr>
  <tr><td><b>Daily Limit</b></td><td>1,000 requests</td></tr>
  <tr><td><b>Search API</b></td><td>Free &amp; Unlimited</td></tr>
</table>

<details>
  <summary>Quick Start Example</summary>
  <p>Add your token as a query parameter or Authorization header:</p>
  <code>${apiUrl('info')}?token=${token}&amp;q=VIDEO_URL</code>
</details>` +
    (isGrp
      ? '<blockquote>🔒 <b>Ephemeral Message:</b> This message and your API token are only visible to you in this group.</blockquote>'
      : '');

  const fallback =
    `<h1>Welcome back, ${name}!</h1>
<blockquote>Your YT-DLP API integration is active and ready for requests.</blockquote>

<table border="1">
  <tr><th>Setting</th><th>Value</th></tr>
  <tr><td><b>API Token</b></td><td><code>${masked}</code></td></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}</code></td></tr>
  <tr><td><b>Daily Limit</b></td><td>1,000 requests</td></tr>
  <tr><td><b>Search API</b></td><td>Free &amp; Unlimited</td></tr>
</table>

<details>
  <summary>Quick Start Example</summary>
  <p>Add your token as a query parameter or Authorization header:</p>
  <code>${apiUrl('info')}?token=${masked}&amp;q=VIDEO_URL</code>
</details>` + GROUP_PRIVACY_FOOTER;

  return { html: ephemeral, fallback };
}

export function startNew(username: string, token: string, isGrp: boolean): RichContent {
  const name = escapeHtml(username);
  const masked = maskToken(token);
  const ephemeral =
    `<h1>Welcome to YT-DLP API, ${name}!</h1>
<blockquote>Your personal API key has been provisioned below.</blockquote>

<table border="1">
  <tr><th>Configuration</th><th>Detail</th></tr>
  <tr><td><b>API Token</b></td><td><code>${token}</code></td></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}</code></td></tr>
  <tr><td><b>Daily Quota</b></td><td>1,000 requests/day</td></tr>
  <tr><td><b>Search Mode</b></td><td>Free &amp; Unlimited</td></tr>
</table>

<details>
  <summary>How to Use</summary>
  <p>Include your token in requests:</p>
  <code>${apiUrl('info')}?token=${token}&amp;q=VIDEO_URL</code>
</details>` +
    (isGrp
      ? '<blockquote>🔒 <b>Ephemeral Message:</b> This message and your API token are only visible to you in this group.</blockquote>'
      : '');

  const fallback =
    `<h1>Welcome to YT-DLP API, ${name}!</h1>
<blockquote>Your personal API key has been provisioned below.</blockquote>

<table border="1">
  <tr><th>Configuration</th><th>Detail</th></tr>
  <tr><td><b>API Token</b></td><td><code>${masked}</code></td></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}</code></td></tr>
  <tr><td><b>Daily Quota</b></td><td>1,000 requests/day</td></tr>
  <tr><td><b>Search Mode</b></td><td>Free &amp; Unlimited</td></tr>
</table>

<details>
  <summary>How to Use</summary>
  <p>Include your token in requests:</p>
  <code>${apiUrl('info')}?token=${masked}&amp;q=VIDEO_URL</code>
</details>` + GROUP_PRIVACY_FOOTER;

  return { html: ephemeral, fallback };
}

// ── /menu ───────────────────────────────────────────────────────

const MENU_BODY = `<h1>YT-DLP API Bot Menu</h1>
<blockquote>Choose an option below to manage your token, inspect usage metrics, or view endpoint documentation.</blockquote>

<table border="1">
  <tr><th>Feature</th><th>Description</th></tr>
  <tr><td><b>Implementation</b></td><td>Code examples (cURL, Python, GET)</td></tr>
  <tr><td><b>Usage Status</b></td><td>Live quota tracking &amp; reset timers</td></tr>
  <tr><td><b>Documentation</b></td><td>Endpoint parameters &amp; responses</td></tr>
</table>`;

export function menuContent(isGrp: boolean): RichContent {
  return {
    html:
      MENU_BODY +
      (isGrp ? '<blockquote>🔒 <b>Ephemeral Message:</b> Only visible to you in this group.</blockquote>' : ''),
    fallback: MENU_BODY,
  };
}

// ── /ping ───────────────────────────────────────────────────────

export function pingContent(elapsedMs: number, uptime: string): string {
  return `<h1>🏓 Pong!</h1>
<blockquote>Bot engine and API interfaces are healthy.</blockquote>

<table border="1">
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td><b>⚡ Latency</b></td><td><code>${pyRoundStr(elapsedMs, 2)} ms</code></td></tr>
  <tr><td><b>⏱ Uptime</b></td><td><code>${uptime}</code></td></tr>
  <tr><td><b>🌐 API Status</b></td><td><b>Online</b></td></tr>
</table>`;
}

// ── /status (plugins/status.py) ─────────────────────────────────

export function statusNoToken(isGrp: boolean): RichContent {
  const base = `<h1>Usage Status</h1>
<blockquote>❌ You don't have an active API token yet. Click below to generate one immediately.</blockquote>`;
  return {
    html:
      base +
      (isGrp ? '<blockquote>🔒 <b>Ephemeral:</b> Only visible to you in this group.</blockquote>' : ''),
    fallback:
      base +
      `
<details>
  <summary>🔒 Group Chat Privacy Notice</summary>
  <blockquote>DM the bot /status or promote bot to admin to receive private ephemeral messages.</blockquote>
</details>`,
  };
}

export function statusWithToken(
  token: string,
  requestCount: number,
  limit: number,
  isAdminUser: boolean,
  isGrp: boolean,
): RichContent {
  const remaining = Math.max(0, limit - requestCount);
  const progress = Math.min(Math.trunc((requestCount / limit) * 10), 10);
  const bar = '🟩'.repeat(progress) + '⬜'.repeat(10 - progress);
  const adminBadge = isAdminUser ? '👑 Admin (10,000 req/day)' : '👤 Standard (1,000 req/day)';

  const table = (tokenDisplay: string): string => `<table border="1">
  <tr><th>Property</th><th>Value</th></tr>
  <tr><td><b>Token</b></td><td><code>${tokenDisplay}</code></td></tr>
  <tr><td><b>Tier</b></td><td>${adminBadge}</td></tr>
  <tr><td><b>Used Today</b></td><td><b>${comma(requestCount)}</b> / ${comma(limit)}</td></tr>
  <tr><td><b>Remaining</b></td><td><b>${comma(remaining)}</b></td></tr>
  <tr><td><b>Reset Timer</b></td><td>Midnight UTC</td></tr>
  <tr><td><b>Progress</b></td><td>${bar}</td></tr>
</table>`;

  let html = `<h1>Usage Status</h1>
<blockquote>Real-time quota monitoring and rate limit tracking.</blockquote>

${table(token)}`;
  if (isGrp) {
    html +=
      '<blockquote>🔒 <b>Ephemeral Message:</b> This usage status and your API token are only visible to you in this group.</blockquote>';
  }

  const fallback = `<h1>Usage Status</h1>
<blockquote>Real-time quota monitoring and rate limit tracking.</blockquote>

${table(maskToken(token))}
<details>
  <summary>🔒 Group Chat Privacy Notice</summary>
  <blockquote>Token is masked for group security. DM the bot /status or promote bot to admin for private ephemeral responses.</blockquote>
</details>`;

  return { html, fallback };
}

// ── /token (plugins/status.py) ──────────────────────────────────

export function tokenHas(token: string, isGrp: boolean): RichContent {
  const html = isGrp
    ? `<h1>Your API Token</h1>
<blockquote>🔒 <b>Ephemeral Message:</b> This token is only visible to you in this group.</blockquote>

<table border="1">
  <tr><th>Active Bearer Token</th></tr>
  <tr><td><code>${token}</code></td></tr>
</table>`
    : `<h1>Your API Token</h1>
<blockquote>Keep this token secure and pass it in your API requests.</blockquote>

<table border="1">
  <tr><th>Active Bearer Token</th></tr>
  <tr><td><code>${token}</code></td></tr>
</table>`;

  const fallback = `<h1>Your API Token</h1>
<details>
  <summary>🔒 Token Masked</summary>
  <blockquote>Token is masked for group security. DM the bot /token to view your full token or promote bot to admin.</blockquote>
</details>

<table border="1">
  <tr><th>Active Bearer Token</th></tr>
  <tr><td><code>${maskToken(token)}</code></td></tr>
</table>`;

  return { html, fallback };
}

export function tokenNone(isGrp: boolean): RichContent {
  const base = `<h1>API Token</h1>
<blockquote>❌ You don't have an active token yet. Click below to provision one.</blockquote>`;
  return {
    html:
      base +
      (isGrp ? '<blockquote>🔒 <b>Ephemeral:</b> Only visible to you in this group.</blockquote>' : ''),
    fallback:
      base +
      `
<details>
  <summary>🔒 Group Chat Privacy Notice</summary>
  <blockquote>DM the bot /token or promote bot to admin to receive private ephemeral messages.</blockquote>
</details>`,
  };
}
