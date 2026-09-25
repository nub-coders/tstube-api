/**
 * Callback rich-UI content — verbatim port of the `@Client.on_callback_query()`
 * bodies in plugins/commands.py.
 */
import { btn, keyboard, ButtonStyle, escapeHtml, type InlineKeyboardMarkup } from './rich.js';
import { apiUrl } from './content.js';
import { comma } from '../pyTime.js';

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

// ── api_implementation ──────────────────────────────────────────

export function apiImplementation(token: string): Card {
  return {
    html: `<h1>API Implementation Guide</h1>
<blockquote>Select an integration guide or reference below to get started.</blockquote>

<table border="1">
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td><b>Your Token</b></td><td><code>${token}</code></td></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}</code></td></tr>
</table>

<tg-button-row>
  <tg-button type="copy_text" text="${escapeHtml(token)}" style="success">🔑 Copy Token</tg-button>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
</tg-button-row>

<details>
  <summary><b>Authentication Tips</b></summary>
  <p>Tokens can be passed as query parameter (<code>?token=...</code>) or Bearer header (<code>Authorization: Bearer ...</code>).</p>
</details>`,
    keyboard: keyboard([
      [
        btn('🌐 GET Examples', { callback_data: 'impl_get_all', style: ButtonStyle.PRIMARY }),
        btn('🐍 Python Implement', { callback_data: 'impl_python_all', style: ButtonStyle.PRIMARY }),
      ],
      [
        btn('📋 Quick Reference', { callback_data: 'impl_quick_ref', style: ButtonStyle.PRIMARY }),
        btn('🔙 Back to Menu', { callback_data: 'back_menu' }),
      ],
    ]),
  };
}

// ── usage_status (callback) ─────────────────────────────────────

export function usageCallback(
  token: string,
  requestCount: number,
  limit: number,
  isAdminUser: boolean,
  isGrp: boolean,
): Card {
  const remaining = Math.max(0, limit - requestCount);
  const adminBadge = isAdminUser ? '👑 Admin (10,000 req/day)' : '👤 Standard (1,000 req/day)';
  const progress = Math.min(Math.trunc((requestCount / limit) * 10), 10);
  const bar = '🟩'.repeat(progress) + '⬜'.repeat(10 - progress);

  let html = `<h1>Usage Statistics</h1>
<blockquote>Real-time quota monitoring and rate limit status.</blockquote>

<table border="1">
  <tr><th>Metric</th><th>Status</th></tr>
  <tr><td><b>Token</b></td><td><code>${token}</code></td></tr>
  <tr><td><b>Tier</b></td><td>${adminBadge}</td></tr>
  <tr><td><b>Used Today</b></td><td><b>${comma(requestCount)}</b> / ${comma(limit)}</td></tr>
  <tr><td><b>Remaining</b></td><td><b>${comma(remaining)}</b></td></tr>
  <tr><td><b>Quota Reset</b></td><td>Midnight UTC</td></tr>
  <tr><td><b>Progress</b></td><td>${bar}</td></tr>
</table>

<details>
  <summary><b>Rate Limiting Rules</b></summary>
  <p>• Data endpoints (<code>/info</code>, <code>/stream</code>): ${comma(limit)} req/day<br/>
  • Search &amp; Discovery (<code>/search</code>, <code>/trending</code>): Unlimited</p>
</details>`;

  if (isGrp) {
    html += '<blockquote>🔒 <b>Ephemeral:</b> Only visible to you in this group.</blockquote>';
  }

  return {
    html,
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

// ── help ────────────────────────────────────────────────────────

export function help(userToken: string): Card {
  return {
    html: `<h1>Help &amp; Documentation</h1>
<blockquote>Quick reference guide for bot commands and core API endpoints.</blockquote>

<h2>Bot Commands</h2>
<table border="1">
  <tr><th>Command</th><th>Description</th></tr>
  <tr><td><code>/start</code></td><td>Provision or view your token</td></tr>
  <tr><td><code>/menu</code></td><td>Interactive navigation menu</td></tr>
  <tr><td><code>/status</code></td><td>Check daily quota consumption</td></tr>
  <tr><td><code>/token</code></td><td>View active API bearer token</td></tr>
  <tr><td><code>/revoke</code></td><td>Cycle and revoke credentials</td></tr>
  <tr><td><code>/ping</code></td><td>Inspect latency and uptime</td></tr>
</table>

<h2>API Endpoints</h2>
<table border="1">
  <tr><th>Endpoint</th><th>Auth Required</th><th>Description</th></tr>
  <tr><td><code>/info</code></td><td>Yes</td><td>Video metadata + direct stream URL</td></tr>
  <tr><td><code>/search</code></td><td>No (Free)</td><td>Fast YouTube video search</td></tr>
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
      [btn('📖 Full API Docs', { callback_data: 'api_docs', style: ButtonStyle.PRIMARY })],
      [btn('🔙 Back to Menu', { callback_data: 'back_menu' })],
    ]),
  };
}

// ── implementation pages ────────────────────────────────────────

export function implGetAll(token: string): Card {
  return {
    html: `<h1>GET Endpoint Examples</h1>
<blockquote>Ready-to-use HTTP GET requests with your credentials.</blockquote>

<h2>1. Video Info &amp; Stream URL</h2>
<pre><code>GET ${apiUrl('info')}?token=${token}&amp;q=https://youtube.com/watch?v=dQw4w9WgXcQ</code></pre>

<h2>2. Search Videos (Free)</h2>
<pre><code>GET ${apiUrl('search')}?q=python+tutorial&amp;max_results=5</code></pre>

<h2>3. Rate Limit Quota Check</h2>
<pre><code>GET ${apiUrl('rate-limit-status')}?token=${token}</code></pre>

<h2>4. Health Probe</h2>
<pre><code>GET ${apiUrl('health')}</code></pre>`,
    keyboard: keyboard([
      [btn('🔙 Back to Implementation', { callback_data: 'api_implementation' })],
    ]),
  };
}

export function implPythonAll(token: string): Card {
  return {
    html: `<h1>Python Implementation (Part 1)</h1>
<blockquote>Lightweight standalone helper functions using <code>requests</code>.</blockquote>

<pre><code class="language-python">import requests
from typing import List, Dict, Optional, Tuple

API_TOKEN = "${token}"
BASE_URL = "${apiUrl()}"

def get_video_info(url_or_query: str, max_results: int = 1):
    """Returns direct stream URL and metadata."""
    r = requests.get(
        f"{BASE_URL}/info",
        params={"token": API_TOKEN, "q": url_or_query, "max_results": max_results},
        timeout=30
    )
    return r.json()

def search_videos(query: str, max_results: int = 5):
    """Free search endpoint without stream URLs."""
    r = requests.get(
        f"{BASE_URL}/search",
        params={"q": query, "max_results": max_results},
        timeout=30
    )
    return r.json().get("results", [])</code></pre>`,
    keyboard: keyboard([
      [
        btn('📄 Part 2: Client Class', { callback_data: 'impl_python_part2', style: ButtonStyle.PRIMARY }),
        btn('💡 Usage Examples', { callback_data: 'impl_python_examples', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to Implementation', { callback_data: 'api_implementation' })],
    ]),
  };
}

export function implQuickRef(token: string): Card {
  return {
    html: `<h1>Quick Reference Guide</h1>
<blockquote>Essential configuration values and endpoint parameters.</blockquote>

<table border="1">
  <tr><th>Resource</th><th>Target</th></tr>
  <tr><td><b>Token</b></td><td><code>${token}</code></td></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}</code></td></tr>
</table>

<h2>Endpoints</h2>
<table border="1">
  <tr><th>Route</th><th>Output</th></tr>
  <tr><td><code>/info</code></td><td>Metadata + direct MP4/Audio stream URL</td></tr>
  <tr><td><code>/search</code></td><td>Video title, ID, duration, channel</td></tr>
  <tr><td><code>/rate-limit-status</code></td><td>Current quota consumption</td></tr>
  <tr><td><code>/health</code></td><td>Service status check</td></tr>
</table>

<details>
  <summary><b>Python Quick One-Liner</b></summary>
  <pre><code class="language-python">import requests
data = requests.get("${apiUrl('info')}?token=${token}&amp;q=VIDEO_URL").json()</code></pre>
</details>`,
    keyboard: keyboard([
      [btn('🔙 Back to Implementation', { callback_data: 'api_implementation' })],
    ]),
  };
}

// ── API docs ────────────────────────────────────────────────────

export function apiDocs(): Card {
  return {
    html: `<h1>API Documentation</h1>
<blockquote>Interactive endpoint reference, request parameters, and schemas. Tap any endpoint below to expand:</blockquote>

<table border="1">
  <tr><th>Feature</th><th>Specification</th></tr>
  <tr><td><b>Base URL</b></td><td><code>${apiUrl()}/</code></td></tr>
  <tr><td><b>Authentication</b></td><td><code>?token=YOUR_TOKEN</code> or <code>Authorization: Bearer</code></td></tr>
  <tr><td><b>Daily Quota</b></td><td>1,000 calls/day (Data), Unlimited (Search &amp; Trending)</td></tr>
  <tr><td><b>Burst Rate</b></td><td>10 req/s concurrency limit</td></tr>
</table>

<tg-button-row>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
  <tg-button type="url" url="${apiUrl('health')}" style="primary">🩺 System Health</tg-button>
</tg-button-row>

<details>
  <summary><b>🎥 GET /info — Video Metadata &amp; Streams</b></summary>
  <blockquote>Extract rich video metadata, available formats (1080p, 720p, 480p, 360p), audio tracks, and direct CDN URLs.</blockquote>
  <table border="1">
    <tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr>
    <tr><td><code>q</code></td><td>string</td><td>Yes</td><td>Video URL (YouTube, TikTok, Bilibili) or search query</td></tr>
    <tr><td><code>token</code></td><td>string</td><td>Yes*</td><td>Bearer token (*or Authorization header)</td></tr>
    <tr><td><code>max_results</code></td><td>int</td><td>No</td><td>Search fallback count (default: 1)</td></tr>
  </table>
  <p><b>cURL:</b></p>
  <pre><code class="language-bash">curl -s -H "Authorization: Bearer YOUR_TOKEN" "${apiUrl('info')}?q=https://youtu.be/dQw4w9WgXcQ"</code></pre>
</details>

<details>
  <summary><b>⚡ GET /stream — Live Seekable Media Stream Pipe</b></summary>
  <blockquote>Direct streaming proxy pipe supporting HTTP 206 Partial Content, Range headers, and chunked playback.</blockquote>
  <table border="1">
    <tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr>
    <tr><td><code>q</code></td><td>string</td><td>Yes</td><td>Video URL to stream</td></tr>
    <tr><td><code>token</code></td><td>string</td><td>Yes*</td><td>Bearer token (*or Authorization header)</td></tr>
    <tr><td><code>format</code></td><td>string</td><td>No</td><td>Specific format code or audio/video selector</td></tr>
  </table>
  <p><b>cURL:</b></p>
  <pre><code class="language-bash">curl -L -H "Authorization: Bearer YOUR_TOKEN" "${apiUrl('stream')}?q=https://youtu.be/dQw4w9WgXcQ" -o video.mp4</code></pre>
</details>

<details>
  <summary><b>🔍 GET /search — Multi-Platform Search (Free &amp; Unmetered)</b></summary>
  <blockquote>Fast query discovery with durations, thumbnails, views, and channel IDs. Unmetered (no quota consumed).</blockquote>
  <table border="1">
    <tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr>
    <tr><td><code>q</code></td><td>string</td><td>Yes</td><td>Search query keywords</td></tr>
    <tr><td><code>max_results</code></td><td>int</td><td>No</td><td>Results to return (1–20, default: 5)</td></tr>
  </table>
  <p><b>cURL:</b></p>
  <pre><code class="language-bash">curl -s "${apiUrl('search')}?q=lofi+hip+hop&amp;max_results=5"</code></pre>
</details>

<details>
  <summary><b>🔥 GET /trending — Regional Trending Feeds (Free)</b></summary>
  <blockquote>Explore viral videos across countries and categories. Completely free and unmetered.</blockquote>
  <table border="1">
    <tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr>
    <tr><td><code>region</code></td><td>string</td><td>No</td><td>ISO 3166-1 alpha-2 country code (default: US)</td></tr>
    <tr><td><code>category</code></td><td>string</td><td>No</td><td>Category: default, music, gaming, movies</td></tr>
  </table>
  <p><b>cURL:</b></p>
  <pre><code class="language-bash">curl -s "${apiUrl('trending')}?region=US"</code></pre>
</details>

<details>
  <summary><b>🎼 GET /formats — Stream Format Matrix</b></summary>
  <blockquote>List all available resolutions, video/audio codecs (h264, vp9, av01), and audio bitrates.</blockquote>
  <table border="1">
    <tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr>
    <tr><td><code>q</code></td><td>string</td><td>Yes</td><td>Video URL to analyze</td></tr>
    <tr><td><code>token</code></td><td>string</td><td>Yes*</td><td>Bearer token (*or Authorization header)</td></tr>
  </table>
  <p><b>cURL:</b></p>
  <pre><code class="language-bash">curl -s -H "Authorization: Bearer YOUR_TOKEN" "${apiUrl('formats')}?q=https://youtu.be/dQw4w9WgXcQ"</code></pre>
</details>

<details>
  <summary><b>📊 GET /rate-limit-status — Quota Telemetry</b></summary>
  <blockquote>Check consumed quota, remaining daily requests, burst capacity, and midnight UTC reset time.</blockquote>
  <table border="1">
    <tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr>
    <tr><td><code>token</code></td><td>string</td><td>Yes*</td><td>Bearer token (*or Authorization header)</td></tr>
  </table>
  <p><b>cURL:</b></p>
  <pre><code class="language-bash">curl -s "${apiUrl('rate-limit-status')}?token=YOUR_TOKEN"</code></pre>
</details>

<details>
  <summary><b>🩺 GET /health — Health Check Probe</b></summary>
  <blockquote>High-availability health check endpoint returning HTTP 200 {"status": "ok"}.</blockquote>
  <p><b>cURL:</b></p>
  <pre><code class="language-bash">curl -s "${apiUrl('health')}"</code></pre>
</details>`,
    keyboard: keyboard([
      [btn('🔙 Back to Menu', { callback_data: 'back_menu' })],
    ]),
  };
}

export function apiInfo(): Card {
  return {
    html: `<h1>Video Info Endpoint</h1>
<blockquote>Extract rich metadata and playable direct CDN stream URLs.</blockquote>

<table border="1">
  <tr><th>Property</th><th>Value</th></tr>
  <tr><td><b>Path</b></td><td><code>${apiUrl('info')}</code></td></tr>
  <tr><td><b>Method</b></td><td><code>GET</code></td></tr>
  <tr><td><b>Auth</b></td><td>Bearer Token Required</td></tr>
</table>

<h2>Parameters</h2>
<table border="1">
  <tr><th>Param</th><th>Type</th><th>Description</th></tr>
  <tr><td><code>token</code></td><td>string</td><td>Your personal API token</td></tr>
  <tr><td><code>q</code></td><td>string</td><td>YouTube video URL, ID, or query</td></tr>
  <tr><td><code>max_results</code></td><td>int</td><td>Results count when searching (default 1)</td></tr>
</table>`,
    keyboard: keyboard([
      [
        btn('🌐 GET Examples', { callback_data: 'api_info_get', style: ButtonStyle.PRIMARY }),
        btn('🐍 Python Code', { callback_data: 'api_info_python', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to API Docs', { callback_data: 'api_docs' })],
    ]),
  };
}

export function apiInfoGet(token: string): Card {
  return {
    html: `<h1>Video Info — GET Examples</h1>
<blockquote>cURL and browser query formats for <code>/info</code>.</blockquote>

<h2>1. Query by Video URL</h2>
<pre><code>GET ${apiUrl('info')}?token=${token}&amp;q=https://youtube.com/watch?v=dQw4w9WgXcQ</code></pre>

<h2>2. Query by Search Term</h2>
<pre><code>GET ${apiUrl('info')}?token=${token}&amp;q=python+tutorial&amp;max_results=1</code></pre>

<h2>3. cURL Command</h2>
<pre><code class="language-bash">curl "${apiUrl('info')}?token=${token}&amp;q=https://youtube.com/watch?v=dQw4w9WgXcQ"</code></pre>`,
    keyboard: keyboard([[btn('🔙 Back to Video Info', { callback_data: 'api_info' })]]),
  };
}

export function apiInfoPython(token: string): Card {
  return {
    html: `<h1>Video Info — Python Code</h1>
<blockquote>Robust client script with error and timeout handling.</blockquote>

<pre><code class="language-python">import requests

TOKEN = "${token}"
BASE = "${apiUrl()}"

def fetch_video(url_or_query: str):
    params = {"token": TOKEN, "q": url_or_query, "max_results": 1}
    try:
        r = requests.get(f"{BASE}/info", params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        print(f"Title: {data.get('title')}")
        print(f"Stream URL: {data.get('url')}")
        return data
    except Exception as e:
        print(f"Error fetching info: {e}")
        return None

# Run fetch
fetch_video("https://youtube.com/watch?v=dQw4w9WgXcQ")</code></pre>`,
    keyboard: keyboard([[btn('🔙 Back to Video Info', { callback_data: 'api_info' })]]),
  };
}

export function apiSearch(): Card {
  return {
    html: `<h1>Search Endpoint (Free)</h1>
<blockquote>Fast video searching with metadata (no quota consumed).</blockquote>

<table border="1">
  <tr><th>Property</th><th>Specification</th></tr>
  <tr><td><b>Path</b></td><td><code>${apiUrl('search')}</code></td></tr>
  <tr><td><b>Method</b></td><td><code>GET</code></td></tr>
  <tr><td><b>Auth</b></td><td>None (Free &amp; Public)</td></tr>
  <tr><td><b>Output</b></td><td>Metadata list (No stream URLs)</td></tr>
</table>

<h2>Parameters</h2>
<table border="1">
  <tr><th>Param</th><th>Type</th><th>Description</th></tr>
  <tr><td><code>q</code></td><td>string</td><td>Search keywords</td></tr>
  <tr><td><code>max_results</code></td><td>int</td><td>Number of results (1–20)</td></tr>
</table>`,
    keyboard: keyboard([
      [
        btn('🌐 GET Examples', { callback_data: 'api_search_get', style: ButtonStyle.PRIMARY }),
        btn('🐍 Python Code', { callback_data: 'api_search_python', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to API Docs', { callback_data: 'api_docs' })],
    ]),
  };
}

export function apiSearchGet(): Card {
  return {
    html: `<h1>Search — GET Examples</h1>
<blockquote>Public search request patterns.</blockquote>

<h2>1. Basic Single Result</h2>
<pre><code>GET ${apiUrl('search')}?q=python+tutorial&amp;max_results=1</code></pre>

<h2>2. Multi-Result Batch (10 items)</h2>
<pre><code>GET ${apiUrl('search')}?q=machine+learning&amp;max_results=10</code></pre>

<h2>3. cURL</h2>
<pre><code class="language-bash">curl "${apiUrl('search')}?q=javascript+tutorial&amp;max_results=3"</code></pre>`,
    keyboard: keyboard([[btn('🔙 Back to Search', { callback_data: 'api_search' })]]),
  };
}

export function apiSearchPython(): Card {
  return {
    html: `<h1>Search — Python Implementation</h1>
<blockquote>Search and parse YouTube video results.</blockquote>

<pre><code class="language-python">import requests
from typing import List, Dict

BASE = "${apiUrl()}"

def search_youtube(query: str, max_results: int = 5) -> List[Dict]:
    params = {"q": query, "max_results": min(max_results, 20)}
    r = requests.get(f"{BASE}/search", params=params, timeout=15)
    r.raise_for_status()
    return r.json().get("results", [])

results = search_youtube("python async programming", 3)
for v in results:
    print(f"• {v['title']} ({v.get('channel_name')})")
    print(f"  URL: https://youtube.com/watch?v={v.get('video_id')}")</code></pre>`,
    keyboard: keyboard([[btn('🔙 Back to Search', { callback_data: 'api_search' })]]),
  };
}

export function apiRateLimit(): Card {
  return {
    html: `<h1>Rate Limit Status Endpoint</h1>
<blockquote>Check your real-time quota balance and reset schedule via HTTP.</blockquote>

<table border="1">
  <tr><th>Property</th><th>Value</th></tr>
  <tr><td><b>Path</b></td><td><code>${apiUrl('rate-limit-status')}</code></td></tr>
  <tr><td><b>Method</b></td><td><code>GET</code></td></tr>
  <tr><td><b>Auth</b></td><td>Bearer Token Required</td></tr>
</table>`,
    keyboard: keyboard([
      [
        btn('🌐 GET Examples', { callback_data: 'api_ratelimit_get', style: ButtonStyle.PRIMARY }),
        btn('🐍 Python Code', { callback_data: 'api_ratelimit_python', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to API Docs', { callback_data: 'api_docs' })],
    ]),
  };
}

export function apiRateLimitGet(token: string): Card {
  return {
    html: `<h1>Rate Limit — GET Examples</h1>
<blockquote>Inspect quota responses with cURL.</blockquote>

<h2>Request</h2>
<pre><code>GET ${apiUrl('rate-limit-status')}?token=${token}</code></pre>

<h2>JSON Response Schema</h2>
<pre><code class="language-json">{
  "user_id": 123456789,
  "daily_limit": 1000,
  "requests_used": 42,
  "requests_remaining": 958,
  "reset_time": "Midnight UTC",
  "is_admin": false
}</code></pre>`,
    keyboard: keyboard([[btn('🔙 Back to Rate Limit', { callback_data: 'api_ratelimit' })]]),
  };
}

export function apiRateLimitPython(token: string): Card {
  return {
    html: `<h1>Rate Limit — Python Example</h1>
<blockquote>Check remaining quota before executing heavy batch jobs.</blockquote>

<pre><code class="language-python">import requests

TOKEN = "${token}"
BASE = "${apiUrl()}"

def check_quota():
    r = requests.get(f"{BASE}/rate-limit-status", params={"token": TOKEN}, timeout=10)
    data = r.json()
    print(f"Used: {data['requests_used']} / {data['daily_limit']}")
    print(f"Remaining: {data['requests_remaining']}")
    return data['requests_remaining'] > 0

if check_quota():
    print("✅ Ready to process video requests")</code></pre>`,
    keyboard: keyboard([[btn('🔙 Back to Rate Limit', { callback_data: 'api_ratelimit' })]]),
  };
}

export function apiHealth(): Card {
  return {
    html: `<h1>Health Check Endpoint</h1>
<blockquote>Automated health probe for monitoring and uptime checkers.</blockquote>

<table border="1">
  <tr><th>Property</th><th>Specification</th></tr>
  <tr><td><b>Path</b></td><td><code>${apiUrl('health')}</code></td></tr>
  <tr><td><b>Method</b></td><td><code>GET</code></td></tr>
  <tr><td><b>Auth</b></td><td>None</td></tr>
  <tr><td><b>Rate Limit</b></td><td>None</td></tr>
</table>`,
    keyboard: keyboard([
      [
        btn('🌐 GET Examples', { callback_data: 'api_health_get', style: ButtonStyle.PRIMARY }),
        btn('🐍 Python Code', { callback_data: 'api_health_python', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to API Docs', { callback_data: 'api_docs' })],
    ]),
  };
}

export function apiHealthGet(): Card {
  return {
    html: `<h1>Health Probe — GET Examples</h1>
<blockquote>Probe API health status and response latency.</blockquote>

<h2>1. Direct GET</h2>
<pre><code>GET ${apiUrl('health')}</code></pre>

<h2>2. cURL with Exit Code Check</h2>
<pre><code class="language-bash">curl -f -s "${apiUrl('health')}" &amp;&amp; echo "API is Online"</code></pre>

<h2>Response</h2>
<pre><code class="language-json">{
  "status": "ok"
}</code></pre>`,
    keyboard: keyboard([[btn('🔙 Back to Health Check', { callback_data: 'api_health' })]]),
  };
}

export function apiHealthPython(): Card {
  return {
    html: `<h1>Health Check — Python Example</h1>
<blockquote>Verify API connectivity with timeout bounds.</blockquote>

<pre><code class="language-python">import requests

def is_api_online():
    try:
        r = requests.get("${apiUrl('health')}", timeout=5)
        return r.status_code == 200 and r.json().get("status") == "ok"
    except requests.RequestException:
        return False

print("Online:" if is_api_online() else "Offline")</code></pre>`,
    keyboard: keyboard([[btn('🔙 Back to Health Check', { callback_data: 'api_health' })]]),
  };
}

export function implPythonPart2(): Card {
  return {
    html: `<h1>Python Implementation (Part 2)</h1>
<blockquote>Production-ready <code>NubYtApiClient</code> wrapper with connection pooling.</blockquote>

<pre><code class="language-python">import requests
from typing import Dict, List

class NubYtApiClient:
    def __init__(self, token: str, base_url: str = "${apiUrl()}"):
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()

    def get_info(self, url_or_query: str, max_results: int = 1) -> Dict:
        r = self.session.get(
            f"{self.base_url}/info",
            params={"token": self.token, "q": url_or_query, "max_results": max_results},
            timeout=30
        )
        r.raise_for_status()
        return r.json()

    def search(self, query: str, max_results: int = 5) -> List[Dict]:
        r = self.session.get(
            f"{self.base_url}/search",
            params={"q": query, "max_results": min(max_results, 20)},
            timeout=15
        )
        r.raise_for_status()
        return r.json().get("results", [])

    def quota(self) -> Dict:
        r = self.session.get(f"{self.base_url}/rate-limit-status", params={"token": self.token})
        return r.json()</code></pre>`,
    keyboard: keyboard([
      [
        btn('📄 Part 1', { callback_data: 'impl_python_all', style: ButtonStyle.PRIMARY }),
        btn('💡 Usage Examples', { callback_data: 'impl_python_examples', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to Implementation', { callback_data: 'api_implementation' })],
    ]),
  };
}

export function implPythonExamples(token: string): Card {
  return {
    html: `<h1>Python Usage Examples</h1>
<blockquote>Calling client methods for search, info, and quota checks.</blockquote>

<pre><code class="language-python">client = NubYtApiClient("${token}")

# 1. Search videos
videos = client.search("python fast api", max_results=3)
for v in videos:
    print(f"• {v['title']} ({v['channel_name']})")

# 2. Get direct streaming link
info = client.get_info("https://youtube.com/watch?v=dQw4w9WgXcQ")
print(f"Direct stream URL: {info.get('url')}")

# 3. Check remaining quota
status = client.quota()
print(f"Remaining requests today: {status.get('requests_remaining')}")</code></pre>`,
    keyboard: keyboard([
      [
        btn('🔄 Advanced Batching', { callback_data: 'impl_python_advanced', style: ButtonStyle.PRIMARY }),
        btn('🔧 Error Handling', { callback_data: 'impl_python_errors', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to Implementation', { callback_data: 'api_implementation' })],
    ]),
  };
}

export function implPythonAdvanced(): Card {
  return {
    html: `<h1>Advanced Batching &amp; Fallbacks</h1>
<blockquote>Batch extraction with polite delays and automatic retry fallbacks.</blockquote>

<pre><code class="language-python">import time

def process_batch(client: NubYtApiClient, urls: list[str]):
    results = []
    for i, url in enumerate(urls, 1):
        try:
            status = client.quota()
            if status.get("requests_remaining", 0) &lt; 1:
                print("Daily quota exhausted, stopping batch.")
                break
            info = client.get_info(url)
            results.append(info)
            time.sleep(0.3)  # Polite pacing
        except Exception as e:
            print(f"Failed {url}: {e}")
    return results</code></pre>`,
    keyboard: keyboard([
      [
        btn('💡 Basic Examples', { callback_data: 'impl_python_examples', style: ButtonStyle.PRIMARY }),
        btn('🔧 Error Handling', { callback_data: 'impl_python_errors', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to Implementation', { callback_data: 'api_implementation' })],
    ]),
  };
}

export function implPythonErrors(): Card {
  return {
    html: `<h1>Error Handling &amp; Best Practices</h1>
<blockquote>Handling rate limits, expired tokens, and network retries.</blockquote>

<pre><code class="language-python">import requests
import time

def safe_get_video(client: NubYtApiClient, url: str, retries: int = 3):
    for attempt in range(retries):
        try:
            return client.get_info(url)
        except requests.HTTPError as e:
            if e.response.status_code == 429:
                print("Rate limit reached. Try again after midnight UTC.")
                return None
            elif e.response.status_code == 401:
                print("Invalid or revoked token. Use /token to check.")
                return None
            time.sleep(1)
        except requests.RequestException:
            time.sleep(1)
    return None</code></pre>`,
    keyboard: keyboard([
      [
        btn('💡 Basic Examples', { callback_data: 'impl_python_examples', style: ButtonStyle.PRIMARY }),
        btn('🔄 Advanced Batching', { callback_data: 'impl_python_advanced', style: ButtonStyle.PRIMARY }),
      ],
      [btn('🔙 Back to Implementation', { callback_data: 'api_implementation' })],
    ]),
  };
}

export function backMenu(): Card {
  return {
    html: `<h1>⚡ NuB YT API • Control Center</h1>
<blockquote>Choose an option below to inspect usage metrics, test endpoints, or view documentation.</blockquote>

<table border="1">
  <tr><th>🚀 Service</th><th>📖 Capabilities</th></tr>
  <tr><td><b>🎥 Video Extraction</b></td><td>Direct mp4/webm streams, resolutions &amp; audio</td></tr>
  <tr><td><b>🔍 YouTube Search</b></td><td>Instant query search with duration &amp; thumbnails</td></tr>
  <tr><td><b>📊 Quota Dashboard</b></td><td>Real-time request metrics &amp; quota status</td></tr>
  <tr><td><b>🔑 Key Management</b></td><td>View or cycle your authorization token</td></tr>
</table>

<tg-button-row>
  <tg-button type="url" url="${apiUrl()}" style="primary">🌐 Open API Gateway</tg-button>
  <tg-button type="url" url="${apiUrl('health')}" style="primary">🩺 System Health</tg-button>
</tg-button-row>`,
    keyboard: buildMainMenuKeyboard(),
  };
}

export function buildMainMenuKeyboard(): InlineKeyboardMarkup {
  return keyboard([
    [
      btn('🚀 Quick Start', { callback_data: 'impl_quick_ref', style: ButtonStyle.PRIMARY }),
      btn('📊 Usage Status', { callback_data: 'usage_status', style: ButtonStyle.PRIMARY }),
    ],
    [
      btn('📖 API Docs', { callback_data: 'api_docs', style: ButtonStyle.PRIMARY }),
      btn('❓ Help & Guide', { callback_data: 'help' }),
    ],
  ]);
}
