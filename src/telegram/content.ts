/**
 * Rich-UI content — modern Bot API 10.3 templates for NuB YT API.
 *
 * Designed with rich formatting (h1, table, details, expandable blockquotes)
 * and custom emoji integrations. `{ephemeral}` is used in groups (token visible)
 * and `fallback` is sent when ephemeral delivery is rejected because the bot
 * isn't a group admin.
 */
import { config } from '../config.js';
import { maskToken } from '../tools.js';
import { escapeHtml } from './rich.js';
import { comma, pyRoundStr } from '../pyTime.js';
import { cookiePool } from '../cookiePool.js';

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
  '\n<details>\n  <summary><b>🔒 Group Chat Privacy Notice</b></summary>\n  <blockquote>Token is masked for group security. DM the bot /start or promote bot to admin for private ephemeral responses.</blockquote>\n</details>';

// ── /start ──────────────────────────────────────────────────────

function buildStartCard(
  username: string,
  token: string,
  isGrp: boolean,
  isNew: boolean,
): RichContent {
  const name = escapeHtml(username);
  const masked = maskToken(token);

  const table = (tokenDisplay: string, rawToken?: string): string => `<table border="1">
  <tr><th>⚡ System Property</th><th>📋 Configuration &amp; Status</th></tr>
  <tr><td><b>👤 Account</b></td><td>@${name}</td></tr>
  <tr><td><b>🔑 ${isNew ? 'Provisioned Token' : 'Active Token'}</b></td><td>${
    rawToken
      ? `<tg-button type="copy_text" text="${escapeHtml(rawToken)}" style="success">🔑 ${escapeHtml(tokenDisplay)}</tg-button>`
      : `<code>${tokenDisplay}</code>`
  }</td></tr>
  <tr><td><b>🌐 ${isNew ? 'Base Endpoint' : 'API Gateway'}</b></td><td><tg-button type="url" url="${apiUrl()}" style="primary">🌐 ${apiUrl().replace(/^https?:\/\//, '')}</tg-button></td></tr>
  <tr><td><b>🎬 Supported Platforms</b></td><td>YouTube · Spotify · Apple Music · SoundCloud · JioSaavn · Amazon Music</td></tr>
  <tr><td><b>📊 ${isNew ? 'Tier Limit' : 'Daily Allocation'}</b></td><td>${isNew ? `${comma(config().DAILY_LIMIT)} req/day (Free Tier) · Unlimited Search` : `${comma(config().DAILY_LIMIT)} req/day (Media) · Unlimited (Search)`}</td></tr>
  <tr><td><b>🛡 ${isNew ? 'Rate Guard' : 'Rate Limiter'}</b></td><td>10 req/s burst · Automatic reset at 00:00 UTC</td></tr>
</table>`;

  const richButtons = (rawToken: string): string => `<tg-button-row>
  <tg-button type="url" url="${apiUrl('info')}?token=${escapeHtml(rawToken)}&amp;q=${encodeURIComponent(config().COOKIES_BOOTSTRAP_URL)}" style="primary">▶️ Test Video Info</tg-button>
  <tg-button type="url" url="${apiUrl('search')}?token=${escapeHtml(rawToken)}&amp;q=lofi+hip+hop" style="primary">🔍 Test Search</tg-button>
</tg-button-row>`;

  const quickStart = (tokenDisplay: string): string =>
    isNew
      ? `<blockquote expandable>
<b>🚀 Quick Setup:</b><br/>
Pass your token via query parameter or Authorization Bearer header:<br/>
• <b>Video Info:</b> <code>curl -H "Authorization: Bearer ${tokenDisplay}" "${apiUrl('info')}?q=${config().COOKIES_BOOTSTRAP_URL}"</code><br/>
• <b>Search:</b> <code>curl -s "${apiUrl('search')}?token=${tokenDisplay}&amp;q=lofi+hip+hop"</code>
</blockquote>`
      : '';

  const header = isNew ? '⚡ Welcome to NuB YT API!' : '⚡ NuB YT API • Dashboard';
  const subtitle = isNew
    ? `Hello, <b>${name}</b>! Your personal API key has been provisioned and is ready for production use.`
    : `Welcome back, <b>${name}</b>! Your high-performance YouTube extraction integration is active and ready.`;

  const quick = quickStart(token);
  const ephemeral =
    `<h1>${header}</h1>
<blockquote>${subtitle}</blockquote>

${table(token, token)}

${richButtons(token)}` +
    (quick ? `\n\n${quick}` : '') +
    (isGrp
      ? '\n\n<blockquote>🔒 <b>Ephemeral Message:</b> This message and your API token are only visible to you in this group.</blockquote>'
      : '');

  const quickFb = quickStart(masked);
  const fallback =
    `<h1>${header}</h1>
<blockquote>${subtitle}</blockquote>

${table(masked)}

<tg-button-row>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
</tg-button-row>` +
    (quickFb ? `\n\n${quickFb}` : '') +
    GROUP_PRIVACY_FOOTER;

  return { html: ephemeral, fallback };
}

export function startExisting(username: string, token: string, isGrp: boolean): RichContent {
  return buildStartCard(username, token, isGrp, false);
}

export function startNew(username: string, token: string, isGrp: boolean): RichContent {
  return buildStartCard(username, token, isGrp, true);
}

// ── /menu ───────────────────────────────────────────────────────

export function menuContent(
  isGrp: boolean,
  username = 'User',
  token = 'YOUR_TOKEN',
): RichContent {
  return buildStartCard(username, token, isGrp, false);
}

export const MENU_BODY = buildStartCard('User', 'YOUR_TOKEN', false, false).html;

// ── /ping ───────────────────────────────────────────────────────

export function pingContent(elapsedMs: number, uptime: string): string {
  return `<h1>🏓 Pong! • System Diagnostics</h1>
<blockquote>NuB YT API core microservices and edge gateways are fully operational.</blockquote>

<table border="1">
  <tr><th>⚡ Subsystem / Metric</th><th>⏱ Telemetry &amp; Status</th></tr>
  <tr><td><b>⚡ Round-Trip Latency</b></td><td><code>${pyRoundStr(elapsedMs, 2)} ms</code></td></tr>
  <tr><td><b>⏱ Server Uptime</b></td><td><code>${uptime}</code></td></tr>
  <tr><td><b>🤖 Telegram Bot Core</b></td><td><b>grammY v1.40.2 (Bot API 10.3)</b></td></tr>
  <tr><td><b>🧠 Primary Resolver</b></td><td><b>youtubei.js v18 (Player API &lt;100ms)</b></td></tr>
  <tr><td><b>🛡 Platform Resolvers</b></td><td><b>Odesli (Spotify/Apple/SoundCloud/JioSaavn)</b></td></tr>
  <tr><td><b>🍪 Cookies Engine</b></td><td><b>🟢 MongoDB Pool (${cookiePool.size} active)</b></td></tr>
  <tr><td><b>🌐 DNS Infrastructure</b></td><td><b>Cloudflare (1.1.1.1 pinned, 0% drop)</b></td></tr>
  <tr><td><b>🚦 Redis State Cache</b></td><td><b>🟢 Connected &amp; Persistent</b></td></tr>
  <tr><td><b>🟢 Overall Health</b></td><td><b>100% Operational</b></td></tr>
</table>

<tg-button-row>
  <tg-button type="url" url="${apiUrl('health')}" style="primary">🩺 Live Health JSON</tg-button>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 API Gateway</tg-button>
</tg-button-row>`;
}

// ── /status (plugins/status.py) ─────────────────────────────────

export function statusNoToken(isGrp: boolean): RichContent {
  const base = `<h1>📊 Usage Status</h1>
<blockquote>❌ You don't have an active API token yet. Click below to generate one immediately.</blockquote>`;
  return {
    html:
      base +
      (isGrp ? '<blockquote>🔒 <b>Ephemeral:</b> Only visible to you in this group.</blockquote>' : ''),
    fallback:
      base +
      `
<details>
  <summary><b>🔒 Group Chat Privacy Notice</b></summary>
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
  const adminBadge = isAdminUser ? `👑 Admin (${comma(config().ADMIN_LIMIT)} req/day)` : `👤 Standard (${comma(config().DAILY_LIMIT)} req/day)`;

  const table = (tokenDisplay: string, rawToken?: string): string => `<table border="1">
  <tr><th>📈 Metric</th><th>📋 Current Value</th></tr>
  <tr><td><b>🔑 API Token</b></td><td>${
    rawToken
      ? `<tg-button type="copy_text" text="${escapeHtml(rawToken)}" style="success">🔑 ${escapeHtml(tokenDisplay)}</tg-button>`
      : `<code>${tokenDisplay}</code>`
  }</td></tr>
  <tr><td><b>👑 Service Tier</b></td><td>${adminBadge}</td></tr>
  <tr><td><b>📊 Used Today</b></td><td><b>${comma(requestCount)}</b> / ${comma(limit)}</td></tr>
  <tr><td><b>⚡ Remaining Quota</b></td><td><b>${comma(remaining)} requests</b></td></tr>
  <tr><td><b>⏱ Daily Reset</b></td><td>Midnight UTC (00:00)</td></tr>
  <tr><td><b>🔋 Quota Meter</b></td><td>${bar}</td></tr>
</table>`;

  let html = `<h1>📊 Quota &amp; Usage Dashboard</h1>
<blockquote>Real-time metrics, daily allocations, and rate limit tracking.</blockquote>

${table(token, token)}

<tg-button-row>
  <tg-button type="url" url="${apiUrl('rate-limit-status')}?token=${escapeHtml(token)}" style="primary">📊 Live Quota JSON</tg-button>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
</tg-button-row>

<details>
  <summary><b>ℹ️ Rate Limiting &amp; Allocation Rules</b></summary>
  <blockquote>
  • <b>Media Endpoints (<code>/info</code>, <code>/stream</code>):</b> Metered against your daily quota.<br/>
  • <b>Search &amp; Discovery (<code>/search</code>, <code>/trending</code>):</b> Free &amp; unmetered.<br/>
  • <b>Burst Capacity:</b> Up to 10 req/sec burst concurrency per token.<br/>
  • <b>Daily Reset:</b> Counter resets automatically at 00:00 UTC every night.
  </blockquote>
</details>`;

  if (isGrp) {
    html +=
      '<blockquote>🔒 <b>Ephemeral Message:</b> This usage status and your API token are only visible to you in this group.</blockquote>';
  }

  const fallback = `<h1>📊 Quota &amp; Usage Dashboard</h1>
<blockquote>Real-time metrics, daily allocations, and rate limit tracking.</blockquote>

${table(maskToken(token))}

<tg-button-row>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
</tg-button-row>

<details>
  <summary><b>🔒 Group Chat Privacy Notice</b></summary>
  <blockquote>Token is masked for group security. DM the bot /status or promote bot to admin for private ephemeral responses.</blockquote>
</details>`;

  return { html, fallback };
}

// ── /token (plugins/status.py) ──────────────────────────────────

export function tokenHas(token: string, isGrp: boolean): RichContent {
  const table = (tokenDisplay: string, rawToken?: string): string => `<table border="1">
  <tr><th>🔐 Active Bearer Authorization Key</th></tr>
  <tr><td>${
    rawToken
      ? `<tg-button type="copy_text" text="${escapeHtml(rawToken)}" style="success">🔑 ${escapeHtml(tokenDisplay)} (Tap to Copy)</tg-button>`
      : `<code>${tokenDisplay}</code>`
  }</td></tr>
</table>`;

  const buttons = `<tg-button-row>
  <tg-button type="url" url="${apiUrl('info')}?token=${escapeHtml(token)}&amp;q=https://youtube.com/watch?v=dQw4w9WgXcQ" style="primary">⚡ Test In Browser</tg-button>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
</tg-button-row>`;

  const security = `<blockquote expandable>
<b>🛡 Security Guidelines &amp; Best Practices:</b><br/>
• Store your token in environment variables (<code>.env</code>) or secrets managers.<br/>
• <b>Recommended Header:</b><br/>
  <code>Authorization: Bearer ${token}</code><br/>
• <b>Query Parameter:</b><br/>
  <code>${apiUrl('info')}?token=${token}&amp;q=URL</code><br/>
• If your token was compromised, click <b>Revoke Token</b> below to immediately generate a fresh key.
</blockquote>`;

  const html = isGrp
    ? `<h1>🔑 API Key Management</h1>
<blockquote>🔒 <b>Ephemeral Message:</b> This token is only visible to you in this group.</blockquote>

${table(token, token)}

${buttons}

${security}`
    : `<h1>🔑 API Key Management</h1>
<blockquote>Keep your bearer token confidential. Never expose it in client-side repositories.</blockquote>

${table(token, token)}

${buttons}

${security}`;

  const fallback = `<h1>🔑 API Key Management</h1>
<details>
  <summary><b>🔒 Token Masked</b></summary>
  <blockquote>Token is masked for group security. DM the bot /token to view your full token or promote bot to admin.</blockquote>
</details>

${table(maskToken(token))}

<tg-button-row>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
</tg-button-row>

${security}`;

  return { html, fallback };
}

export function tokenNone(isGrp: boolean): RichContent {
  const base = `<h1>🔑 API Key Management</h1>
<blockquote>❌ You don't have an active token yet. Click below to provision one immediately.</blockquote>`;
  return {
    html:
      base +
      (isGrp ? '<blockquote>🔒 <b>Ephemeral:</b> Only visible to you in this group.</blockquote>' : ''),
    fallback:
      base +
      `
<details>
  <summary><b>🔒 Group Chat Privacy Notice</b></summary>
  <blockquote>DM the bot /token or promote bot to admin to receive private ephemeral messages.</blockquote>
</details>`,
  };
}
