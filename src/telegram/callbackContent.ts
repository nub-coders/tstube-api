/**
 * Callback rich-UI content — consolidated and unified templates.
 *
 * Replaces fragmented multi-level sub-pages with comprehensive,
 * interactive Bot API 10.3 expandable documents (<details>, <table>, <blockquote expandable>).
 */
import { btn, keyboard, ButtonStyle, escapeHtml, type InlineKeyboardMarkup } from './rich.js';
import { apiUrl, statusWithToken, startExisting } from './content.js';
import { config, isAdmin } from '../config.js';
import { comma } from '../pyTime.js';
import type { WebsharePublicHealth } from '../proxy.js';

export interface Card {
  html: string;
  keyboard?: InlineKeyboardMarkup;
}

// ── Token cards ─────────────────────────────────────────────────

export function viewTokenGroup(token: string): string {
  return `<h1>Your API Token</h1>
<blockquote>🔒 <b>Ephemeral:</b> Only visible to you in this group.</blockquote>
<table border="1">
  <tr><th>Bearer Token</th></tr>
  <tr><td><code>${token}</code></td></tr>
</table>

<tg-button-row>
  <tg-button type="copy_text" text="${escapeHtml(token)}" style="success">🔑 Copy API Key</tg-button>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
</tg-button-row>`;
}

// ── usage_status (callback) — unified with statusWithToken ───────

export function usageCallback(
  token: string,
  requestCount: number,
  limit: number,
  isAdminUser: boolean,
  isGrp: boolean,
  proxyHealth?: WebsharePublicHealth,
): Card {
  const content = statusWithToken(token, requestCount, limit, isAdminUser, isGrp, proxyHealth);
  return {
    html: content.html,
    keyboard: keyboard([
      [btn('🔄 Refresh', { callback_data: 'usage_status', style: ButtonStyle.PRIMARY })],
      [btn('🔙 Back to Menu', { callback_data: 'back_menu' })],
    ]),
  };
}

// ── revoke ──────────────────────────────────────────────────────

export function revokeConfirm(): Card {
  return {
    html: `<h1>Revoke API Token</h1>
<blockquote>⚠️ <b>Are you sure?</b> This action will permanently invalidate your current token and generate a new one immediately.</blockquote>
<p>You will need to update the token in all active scripts and servers.</p>`,
    keyboard: keyboard([
      [
        btn('✅ Yes, Revoke', { callback_data: 'confirm_revoke', style: ButtonStyle.DANGER }),
        btn('❌ Cancel', { callback_data: 'back_menu' }),
      ],
    ]),
  };
}

export function revoked(token: string): Card {
  return {
    html: `<h1>Token Revoked Successfully</h1>
<blockquote>Your old token has been destroyed and a fresh token is active.</blockquote>

<table border="1">
  <tr><th>Configuration</th><th>Value</th></tr>
  <tr><td><b>New Token</b></td><td><code>${token}</code></td></tr>
  <tr><td><b>Status</b></td><td><b>Active &amp; Ready</b></td></tr>
</table>

<blockquote>⚠️ <b>Important:</b> Update your API calls with the new token immediately.</blockquote>`,
    keyboard: keyboard([
      [btn('🔙 Back to Menu', { callback_data: 'back_menu' })],
    ]),
  };
}

// ── Main Menu ───────────────────────────────────────────────────

export function buildMainMenuKeyboard(userId?: number): InlineKeyboardMarkup {
  const isAdminUser = userId !== undefined && isAdmin(userId);
  return keyboard([
    [
      btn('📊 Usage Status', { callback_data: 'usage_status', style: ButtonStyle.PRIMARY }),
    ],
    [
      btn('📖 API Docs', { callback_data: 'api_docs', style: ButtonStyle.PRIMARY }),
      btn('❓ Help & Guide', { callback_data: 'help' }),
    ],
    ...(isAdminUser ? [[btn('⚙️ Administration', { callback_data: 'admin_panel', style: ButtonStyle.DANGER })]] : []),
  ]);
}

export function backMenu(
  username = 'User',
  token = 'YOUR_TOKEN',
  isGrp = false,
  userId?: number,
): Card {
  const content = startExisting(username, token, isGrp);
  return {
    html: content.html,
    keyboard: buildMainMenuKeyboard(userId),
  };
}

// ── Quick Start Guide ───────────────────────────────────────────

export function implQuickRef(token: string): Card {
  return {
    html: `<h1>🚀 Quick Start Guide</h1>
<blockquote>Everything you need to start integrating NuB YT API immediately:</blockquote>

<table border="1">
  <tr><th>Configuration</th><th>Value</th></tr>
  <tr><td><b>API Token</b></td><td><code>${token}</code></td></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}</code></td></tr>
  <tr><td><b>Daily Quota</b></td><td>${comma(config().DAILY_LIMIT)} req/day (Media) · Unlimited (Search)</td></tr>
</table>

<tg-button-row>
  <tg-button type="copy_text" text="${escapeHtml(token)}" style="success">🔑 Copy Token</tg-button>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
</tg-button-row>

<h2>1. Direct cURL Examples</h2>
<pre><code class="language-bash"># Extract Video Metadata &amp; Stream URL:
curl -s -H "Authorization: Bearer ${token}" "${apiUrl('info')}?q=https://youtube.com/watch?v=dQw4w9WgXcQ"

# Search Videos (Free &amp; Unmetered):
curl -s "${apiUrl('search')}?q=lofi+hip+hop&amp;max_results=5"

# Check Remaining Quota:
curl -s "${apiUrl('rate-limit-status')}?token=${token}"</code></pre>

<h2>2. Python Quickstart</h2>
<pre><code class="language-python">import requests
res = requests.get("${apiUrl('info')}", params={"token": "${token}", "q": "https://youtube.com/watch?v=dQw4w9WgXcQ"}).json()
print("Direct Stream:", res.get("url"))</code></pre>`,
    keyboard: keyboard([
      [
        btn('🎬 Supported Platforms', { callback_data: 'supported_platforms', style: ButtonStyle.PRIMARY }),
        btn('📖 Full API Docs', { callback_data: 'api_docs', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to Menu', { callback_data: 'back_menu' })],
    ]),
  };
}

// ── Help & Guide ────────────────────────────────────────────────

export function help(userToken: string): Card {
  return {
    html: `<h1>❓ Help &amp; Documentation</h1>
<blockquote>Quick reference guide for bot commands and core API endpoints.</blockquote>

<h2>Bot Commands</h2>
<table border="1">
  <tr><th>Command</th><th>Description</th></tr>
  <tr><td><code>/start</code></td><td>Provision or view your API token &amp; dashboard</td></tr>
  <tr><td><code>/menu</code></td><td>Interactive navigation control center</td></tr>
  <tr><td><code>/status</code></td><td>Check daily quota and consumption meter</td></tr>
  <tr><td><code>/token</code></td><td>View or copy your active bearer token</td></tr>
  <tr><td><code>/revoke</code></td><td>Cycle and revoke credentials</td></tr>
  <tr><td><code>/ping</code></td><td>Inspect API latency and server uptime</td></tr>
</table>

<h2>API Endpoints</h2>
<table border="1">
  <tr><th>Endpoint</th><th>Auth Required</th><th>Description</th></tr>
  <tr><td><code>/info</code></td><td>Yes</td><td>Video metadata + direct stream URL</td></tr>
  <tr><td><code>/stream</code></td><td>Yes</td><td>HTTP 206 seekable media pipe</td></tr>
  <tr><td><code>/search</code></td><td>No (Free)</td><td>Fast YouTube video search</td></tr>
  <tr><td><code>/trending</code></td><td>No (Free)</td><td>Regional viral trending feeds</td></tr>
  <tr><td><code>/rate-limit-status</code></td><td>Yes</td><td>Check remaining quota via API</td></tr>
  <tr><td><code>/health</code></td><td>No</td><td>Service health probe</td></tr>
</table>

<details>
  <summary><b>Python Quick Example</b></summary>
  <pre><code class="language-python">import requests
res = requests.get(
    "${apiUrl('info')}",
    params={"token": "${userToken}", "q": "VIDEO_URL"}
)
print(res.json())</code></pre>
</details>`,
    keyboard: keyboard([
      [
        btn('🎬 Supported Platforms', { callback_data: 'supported_platforms', style: ButtonStyle.PRIMARY }),
        btn('📖 Full API Docs', { callback_data: 'api_docs', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to Menu', { callback_data: 'back_menu' })],
    ]),
  };
}

// ── Supported Platforms Card ────────────────────────────────────

export function platformsCard(): Card {
  return {
    html: `<h1>🎬 Supported Platforms &amp; Media Services</h1>
<blockquote>NuB YT API resolves and extracts playable media streams across major video and audio networks:</blockquote>

<table border="1">
  <tr><th>Category</th><th>Platforms</th><th>Capabilities</th></tr>
  <tr><td><b>🎥 Video &amp; Shorts</b></td><td>YouTube, YouTube Shorts, Music</td><td>4K, 1080p, 720p, 480p, 360p (MP4/WebM)</td></tr>
  <tr><td><b>🎵 Streaming Services</b></td><td>Spotify, Apple Music, Amazon Music</td><td>Metadata + automated high-fidelity audio matching</td></tr>
  <tr><td><b>🎼 Direct Audio</b></td><td>SoundCloud, JioSaavn</td><td>Available source audio quality; SoundCloud may require an HLS-capable player</td></tr>
</table>

<h2>📋 Supported Link Examples</h2>
<blockquote expandable>
• <b>YouTube Video:</b> <code>https://youtube.com/watch?v=...</code><br/>
• <b>YouTube Shorts:</b> <code>https://youtube.com/shorts/...</code><br/>
• <b>Spotify:</b> <code>https://open.spotify.com/track/...</code><br/>
• <b>Apple Music:</b> <code>https://music.apple.com/.../song/...</code><br/>
• <b>Amazon Music:</b> <code>https://music.amazon.com/albums/...</code><br/>
• <b>SoundCloud:</b> <code>https://soundcloud.com/.../...</code><br/>
• <b>JioSaavn:</b> <code>https://jiosaavn.com/song/...</code>
</blockquote>

<details>
  <summary><b>⚡ Quick Extraction cURL</b></summary>
  <p>Pass any supported URL directly to <code>/info</code> or <code>/stream</code>:</p>
  <pre><code class="language-bash">curl -s "${apiUrl('info')}?token=YOUR_TOKEN&amp;q=https://open.spotify.com/track/..."</code></pre>
</details>`,
    keyboard: keyboard([
      [
        btn('📖 API Docs', { callback_data: 'api_docs', style: ButtonStyle.PRIMARY }),
        btn('🚀 Quick Start', { callback_data: 'impl_quick_ref', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to Menu', { callback_data: 'back_menu' })],
    ]),
  };
}

// ── Master API Documentation (Interactive Reference) ────────────

export function apiDocs(userToken = 'YOUR_TOKEN'): Card {
  return {
    html: `<h1>API Documentation</h1>
<blockquote>Interactive endpoint reference and cURL examples. Tap any section to expand:</blockquote>

<table border="1">
  <tr><th>Feature</th><th>Specification</th></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}/</code></td></tr>
  <tr><td><b>Auth</b></td><td><code>?token=${escapeHtml(userToken)}</code> or <code>Authorization: Bearer</code></td></tr>
  <tr><td><b>Quota</b></td><td>${comma(config().DAILY_LIMIT)} req/day (Media) · Unlimited (Search &amp; Trending)</td></tr>
  <tr><td><b>Rate Guard</b></td><td>10 req/s burst limit · Resets 00:00 UTC</td></tr>
</table>

<tg-button-row>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
  <tg-button type="url" url="${apiUrl('health')}" style="primary">🩺 System Health</tg-button>
</tg-button-row>

<details>
  <summary><b>🎥 GET /info — Video Metadata &amp; Streams</b></summary>
  <blockquote>Extract metadata, formats (1080p, 720p, audio), and direct stream URL.</blockquote>
  <p><b>Params:</b> <code>q</code> (URL or query), <code>token</code>, <code>max_results</code></p>
  <pre><code class="language-bash">curl -s -H "Authorization: Bearer ${userToken}" "${apiUrl('info')}?q=https://youtu.be/dQw4w9WgXcQ"</code></pre>
</details>

<details>
  <summary><b>⚡ GET /stream — Live Seekable Stream</b></summary>
  <blockquote>Streaming proxy supporting HTTP 206 Partial Content and Range headers.</blockquote>
  <p><b>Params:</b> <code>q</code> (URL), <code>token</code>, <code>format</code></p>
  <pre><code class="language-bash">curl -L -H "Authorization: Bearer ${userToken}" "${apiUrl('stream')}?q=https://youtu.be/dQw4w9WgXcQ" -o video.mp4</code></pre>
</details>

<details>
  <summary><b>🔍 GET /search — Multi-Platform Search (Free)</b></summary>
  <blockquote>Fast query search with video durations, thumbnails, views, and channel IDs.</blockquote>
  <p><b>Params:</b> <code>q</code> (query), <code>max_results</code> (1–20, default 5)</p>
  <pre><code class="language-bash">curl -s "${apiUrl('search')}?q=lofi+hip+hop&amp;max_results=5"</code></pre>
</details>

<details>
  <summary><b>🔥 GET /trending — Regional Feeds (Free)</b></summary>
  <blockquote>Explore viral videos across countries and categories. Unmetered.</blockquote>
  <p><b>Params:</b> <code>region</code> (ISO code, default US), <code>category</code></p>
  <pre><code class="language-bash">curl -s "${apiUrl('trending')}?region=US"</code></pre>
</details>

<details>
  <summary><b>📊 GET /rate-limit-status — Quota Telemetry</b></summary>
  <blockquote>Inspect consumed quota, remaining daily requests, and midnight UTC reset time.</blockquote>
  <pre><code class="language-bash">curl -s "${apiUrl('rate-limit-status')}?token=${userToken}"</code></pre>
</details>

<details>
  <summary><b>🩺 GET /health — Health Check Probe</b></summary>
  <blockquote>Service uptime and connectivity probe returning HTTP 200 <code>{"status":"ok"}</code>.</blockquote>
  <pre><code class="language-bash">curl -s "${apiUrl('health')}"</code></pre>
</details>

<details>
  <summary><b>🐍 Python Quickstart</b></summary>
  <pre><code class="language-python">import requests
res = requests.get(
    "${apiUrl('info')}",
    headers={"Authorization": f"Bearer {userToken}"},
    params={"q": "https://youtu.be/dQw4w9WgXcQ"}
).json()
print("Stream URL:", res.get("url"))</code></pre>
</details>`,
    keyboard: keyboard([
      [
        btn('🎬 Supported Platforms', { callback_data: 'supported_platforms', style: ButtonStyle.PRIMARY }),
        btn('🔙 Back to Menu', { callback_data: 'back_menu' }),
      ],
    ]),
  };
}

// ── Legacy Compatibility Helpers (Preserve test contracts) ──────

export function apiImplementation(token: string): Card {
  return implQuickRef(token);
}

export function implGetAll(token: string): Card {
  return implQuickRef(token);
}

export function implPythonAll(token: string): Card {
  return implQuickRef(token);
}

export function implPythonPart2(): Card {
  return apiDocs();
}

export function implPythonExamples(token: string): Card {
  return implQuickRef(token);
}

export function implPythonAdvanced(): Card {
  return apiDocs();
}

export function implPythonErrors(): Card {
  return apiDocs();
}

export function apiInfo(): Card {
  return apiDocs();
}

export function apiInfoGet(token: string): Card {
  return {
    html: `<h1>Video Info — GET Examples</h1>
<blockquote>cURL and browser query formats for <code>/info</code>.</blockquote>
<pre><code>GET ${apiUrl('info')}?token=${token}&amp;q=https://youtube.com/watch?v=dQw4w9WgXcQ</code></pre>`,
    keyboard: keyboard([
      [btn('📖 Full API Docs', { callback_data: 'api_docs', style: ButtonStyle.PRIMARY })],
      [btn('🔙 Back to Menu', { callback_data: 'back_menu' })],
    ]),
  };
}

export function apiInfoPython(token: string): Card {
  return implQuickRef(token);
}

export function apiSearch(): Card {
  return apiDocs();
}

export function apiSearchGet(): Card {
  return apiDocs();
}

export function apiSearchPython(): Card {
  return apiDocs();
}

export function apiRateLimit(): Card {
  return apiDocs();
}

export function apiRateLimitGet(token: string): Card {
  return implQuickRef(token);
}

export function apiRateLimitPython(token: string): Card {
  return implQuickRef(token);
}

export function apiHealth(): Card {
  return apiDocs();
}

export function apiHealthGet(): Card {
  return apiDocs();
}

export function apiHealthPython(): Card {
  return apiDocs();
}
