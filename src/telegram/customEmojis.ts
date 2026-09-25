/**
 * Custom emoji registry and HTML rendering engine for Telegram Bot API.
 *
 * Backed by custom_emoji_ids.json (sourced from Telegram sticker packs:
 * TgAndroidIcons, iconemoji1, CenterOfEmoji980633, DMJUnigramAnimationEmoji,
 * L4EVector001_by_fStikBot, NewsEmoji, FilterIcons, VerifiEmoji_by_fStikBot).
 *
 * NOTE: Telegram document IDs are 64-bit integers and must strictly remain
 * string-encoded in JavaScript to avoid float precision truncation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Pinned Tested Custom Emoji Document IDs ──────────────────────────────────
export const PINNED_EMOJI_DOC_IDS: Record<string, string> = {
  // Latency, ping & time
  '⚡': '5843553939672274145',
  '⚡️': '5843553939672274145',
  '⏱': '5981043230160981261',
  '⏱️': '5981043230160981261',
  '⏰': '5985616167740379273',
  '⌛': '5787237370709413702',
  '⏳': '5787237370709413702',

  // Status & Verification
  '✅': '5774022692642492953',
  '✔️': '5825794181183836432',
  '❌': '5778527486270770928',
  '✖️': '5818804920773512716',
  '⚠️': '5881702736843511327',
  'ℹ️': '5879785854284599288',
  'ℹ': '5879785854284599288',
  '🚫': '5877413297170419326',
  '⛔': '5098561200409543522',

  // Security, Auth & Tokens
  '🔒': '5785324637088910941',
  '🔓': '6034962180875490251',
  '🔐': '5787313834012184077',
  '🔑': '6005570495603282482',
  '🛡️': '5784993237412351403',
  '🛡': '5784993237412351403',

  // Administration & Users
  '👑': '5807868868886009920',
  '👤': '5771887475421090729',
  '👥': '5915556996215476302',
  '🤖': '5819078828017849357',
  '💎': '5963312935148195483',
  '⭐': '5366238787955347845',
  '⭐️': '5366238787955347845',
  '✨': '5989815447459991163',
  '🌟': '5989815447459991163',

  // System, Network & Web
  '🌐': '5821388137443626414',
  '🔗': '5778586619380503542',
  '📢': '5771695636411847302',
  '💬': '5978636253178891455',
  '📱': '5978716328549158057',
  '💻': '5866334008123591985',
  '🚀': '5857290546459973028',
  '🔥': '6008118472066732010',
  '🏓': '5843553939672274145', // Ping rocket/bolt
  '🐍': '5819154994967874788', // Python -> developer code

  // Navigation, Actions & UI
  '🏠': '5967822972931542886',
  '🔙': '5877629862306385808',
  '◀️': '5877629862306385808',
  '◀': '5877629862306385808',
  '➡️': '5877468380125990242',
  '▶️': '5775981206319402773',
  '🔄': '5877410604225924969',
  '📊': '5877485980901971030',
  '📈': '5994378914636500516',
  '📉': '5994378914636500516',
  '🔧': '5988023995125993550',
  '🛠️': '5988023995125993550',
  '🛠': '5988023995125993550',
  '⚙️': '5787237370709413702',
  '⚙': '5787237370709413702',
  '❓': '5873121512445187000',
  '💡': '5843553939672274145',
  '📖': '5778184941154078090',
  '📄': '5956561916573782596',
  '📝': '6007904127428858838',
  '📋': '5877301185639091664',
  '🔍': '5879785854284599288',
  '🔎': '5879785854284599288',
  '🗑️': '5979070714890686650',
  '🗑': '5979070714890686650',
  '✏️': '5879841310902324730',
  '✏': '5879841310902324730',

  // Indicators & Colors
  '🟢': '5818812952362356039',
  '🔴': '5967333011652350314',
  '🟡': '5819199598203244104',
  '🟠': '5881702736843511327',
  '⚪': '5994324703559290598',
  '🟩': '5098579110423167799',
  '🟥': '5890710155141582641',
  '❤️': '5098366466592342927',
  '🩺': '5098366466592342927',
  '🎁': '5035311179841406042',
  '💳': '5967548335542767952',
  '💰': '5811989245761426317',
  '💵': '5967390100357648692',
};

export const Emoji = {
  PING: PINNED_EMOJI_DOC_IDS['⚡']!,
  UPTIME: PINNED_EMOJI_DOC_IDS['⏱']!,
  SUCCESS: PINNED_EMOJI_DOC_IDS['✅']!,
  ERROR: PINNED_EMOJI_DOC_IDS['❌']!,
  WARNING: PINNED_EMOJI_DOC_IDS['⚠️']!,
  INFO: PINNED_EMOJI_DOC_IDS['ℹ️']!,
  LOCK: PINNED_EMOJI_DOC_IDS['🔒']!,
  UNLOCK: PINNED_EMOJI_DOC_IDS['🔓']!,
  KEY: PINNED_EMOJI_DOC_IDS['🔑']!,
  TOKEN: PINNED_EMOJI_DOC_IDS['🔑']!,
  ADMIN: PINNED_EMOJI_DOC_IDS['👑']!,
  USER: PINNED_EMOJI_DOC_IDS['👤']!,
  USERS: PINNED_EMOJI_DOC_IDS['👥']!,
  STATS: PINNED_EMOJI_DOC_IDS['📊']!,
  ROCKET: PINNED_EMOJI_DOC_IDS['🚀']!,
  REFRESH: PINNED_EMOJI_DOC_IDS['🔄']!,
  TOOLS: PINNED_EMOJI_DOC_IDS['🔧']!,
  HELP: PINNED_EMOJI_DOC_IDS['❓']!,
  DOCS: PINNED_EMOJI_DOC_IDS['📖']!,
  MENU: PINNED_EMOJI_DOC_IDS['📋']!,
  GLOBE: PINNED_EMOJI_DOC_IDS['🌐']!,
  BROADCAST: PINNED_EMOJI_DOC_IDS['📢']!,
  TRASH: PINNED_EMOJI_DOC_IDS['🗑️']!,
  BACK: PINNED_EMOJI_DOC_IDS['🔙']!,
  NEXT: PINNED_EMOJI_DOC_IDS['➡️']!,
  HOME: PINNED_EMOJI_DOC_IDS['🏠']!,
  SPARKLE: PINNED_EMOJI_DOC_IDS['✨']!,
  STAR: PINNED_EMOJI_DOC_IDS['⭐']!,
} as const;

// ── Registry Loading with Safe BigInt/String Document IDs ─────────────────────

let registryCache: Map<string, string[]> | null = null;

function normalizeGlyph(glyph: string): string {
  return glyph.replace(/[\ufe0f\ufe0e]/g, '');
}

export function loadRegistry(): Map<string, string[]> {
  if (registryCache) return registryCache;

  const registry = new Map<string, string[]>();

  // Add pinned emojis first
  for (const [glyph, docId] of Object.entries(PINNED_EMOJI_DOC_IDS)) {
    if (!registry.has(glyph)) registry.set(glyph, []);
    registry.get(glyph)!.push(docId);
    const norm = normalizeGlyph(glyph);
    if (norm !== glyph) {
      if (!registry.has(norm)) registry.set(norm, []);
      registry.get(norm)!.push(docId);
    }
  }

  // Find custom_emoji_ids.json
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    join(currentDir, '..', 'assets', 'custom_emoji_ids.json'),
    join(currentDir, 'assets', 'custom_emoji_ids.json'),
    join(process.cwd(), 'src', 'assets', 'custom_emoji_ids.json'),
    join(process.cwd(), 'dist', 'assets', 'custom_emoji_ids.json'),
    '/root/tstube-api/src/assets/custom_emoji_ids.json',
    '/root/Userbot-deployer/data/custom_emoji_ids.json',
    '/root/OTPBOT/data/custom_emoji_ids.json',
  ];

  let filePath: string | null = null;
  for (const p of candidatePaths) {
    if (existsSync(p)) {
      filePath = p;
      break;
    }
  }

  if (filePath) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      // Ensure numeric document_id is converted to string literal to avoid double float rounding
      const safeJson = raw.replace(/"document_id":\s*(\d+)/g, '"document_id": "$1"');
      const packs = JSON.parse(safeJson) as Array<{
        short_name?: string;
        items?: Array<{ emoji?: string; document_id?: string | number }>;
      }>;

      for (const pack of packs) {
        for (const item of pack.items ?? []) {
          const glyph = item.emoji;
          const docId = item.document_id ? String(item.document_id) : undefined;
          if (!glyph || !docId) continue;

          if (!registry.has(glyph)) registry.set(glyph, []);
          registry.get(glyph)!.push(docId);

          const norm = normalizeGlyph(glyph);
          if (norm !== glyph) {
            if (!registry.has(norm)) registry.set(norm, []);
            registry.get(norm)!.push(docId);
          }
        }
      }
    } catch {
      /* Fallback to pinned constants if json read fails */
    }
  }

  registryCache = registry;
  return registry;
}

/**
 * Returns the Telegram custom emoji document ID for a given Unicode emoji.
 */
export function pickDocumentId(emoji: string, index = 0): string | undefined {
  if (PINNED_EMOJI_DOC_IDS[emoji]) {
    return PINNED_EMOJI_DOC_IDS[emoji];
  }
  const clean = normalizeGlyph(emoji);
  if (PINNED_EMOJI_DOC_IDS[clean]) {
    return PINNED_EMOJI_DOC_IDS[clean];
  }

  const reg = loadRegistry();
  const list = reg.get(emoji) ?? reg.get(clean);
  if (!list || list.length === 0) return undefined;
  return list[Math.abs(index) % list.length];
}

/**
 * Render a single custom emoji tag: <tg-emoji emoji-id="...">glyph</tg-emoji>
 */
export function render(emoji: string, fallback?: string, index = 0): string {
  const docId = pickDocumentId(emoji, index);
  const visible = fallback !== undefined ? fallback : emoji;
  if (!docId) return visible;
  return `<tg-emoji emoji-id="${docId}">${visible}</tg-emoji>`;
}

// ── Emoji Matching Regex ───────────────────────────────────────────────────────

export const EMOJI_REGEX_STR =
  '(?:' +
  '[\\u{1F1E6}-\\u{1F1FF}]{2}' + // Country flags
  '|[\\u{1F000}-\\u{1F9FF}][\\uFE0E\\uFE0F]?' + // Pictographs
  '|[\\u{1FA00}-\\u{1FAFF}][\\uFE0E\\uFE0F]?' + // Symbols Extended
  '|[\\u{2600}-\\u{27BF}][\\uFE0E\\uFE0F]?' + // Misc Symbols (⚠️, ❌, ✅, ⚡)
  '|[\\u{2500}-\\u{25FF}][\\uFE0E\\uFE0F]?' + // Geometric Shapes
  '|[\\u{2300}-\\u{23FF}][\\uFE0E\\uFE0F]?' + // Tech (⏱, ⏰, ⌛)
  '|[\\u{2B00}-\\u{2BFF}][\\uFE0E\\uFE0F]?' + // Arrows & Stars (⭐)
  '|\\d\\uFE0F?\\u20E3' + // Keycaps
  ')';

/**
 * Replace recognized Unicode emojis in HTML text with `<tg-emoji>` tags.
 *
 * Safely preserves:
 * 1. Existing `<tg-emoji>` or `<emoji>` tags
 * 2. `<code>...</code>` and `<pre>...</code>` tags
 * 3. Markdown code spans and blocks (`...`, ```...```)
 * 4. All HTML tag attributes (e.g. `<a href="...">`)
 */
export function renderCustomEmojis(html: string): string {
  if (!html || typeof html !== 'string') return html;

  // Normalize legacy <emoji id="..."> or <tg-emoji id="...">
  let text = html.replace(
    /<(?:tg-emoji|emoji)\b[^>]*?\b(?:emoji-)?id=["']?(\d+)["']?[^>]*>(.*?)<\/(?:tg-emoji|emoji)>/gis,
    '<tg-emoji emoji-id="$1">$2</tg-emoji>',
  );

  // Match tags, code blocks, and existing emoji tags to preserve them intact
  const protectPattern = /(<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>|<code\b[^>]*>[\s\S]*?<\/code>|<pre\b[^>]*>[\s\S]*?<\/pre>|```[\s\S]*?```|`[^`\n]+`|<[^>]+>)/gi;
  const parts = text.split(protectPattern);

  const emojiRe = new RegExp(`(${EMOJI_REGEX_STR})`, 'gu');

  // Even indices are plain text outside of protected blocks
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i];
    if (!part) continue;

    parts[i] = part.replace(emojiRe, (match) => {
      const docId = pickDocumentId(match);
      if (!docId) return match;
      return `<tg-emoji emoji-id="${docId}">${match}</tg-emoji>`;
    });
  }

  return parts.join('');
}

/**
 * Strip custom emoji HTML tags (<tg-emoji> or <emoji>), retaining visible emoji text.
 */
export function stripCustomEmojis(html: string): string {
  if (!html || typeof html !== 'string') return html;
  return html.replace(/<(?:tg-emoji|emoji)\b[^>]*>(.*?)<\/(?:tg-emoji|emoji)>/gi, '$1');
}

/**
 * Extract leading emoji from button text for button custom emoji icon (`icon_custom_emoji_id`).
 */
export function extractButtonEmoji(text: string): { text: string; icon_custom_emoji_id?: string } {
  if (!text || typeof text !== 'string') return { text };

  const trimmed = text.trim();
  const leadingEmojiMatch = trimmed.match(new RegExp(`^(${EMOJI_REGEX_STR})\\s*`, 'u'));

  if (leadingEmojiMatch && leadingEmojiMatch[1]) {
    const em = leadingEmojiMatch[1];
    const docId = pickDocumentId(em);
    if (docId) {
      return {
        text: trimmed.slice(leadingEmojiMatch[0].length),
        icon_custom_emoji_id: docId,
      };
    }
  }

  return { text };
}
