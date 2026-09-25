import { describe, it, expect, vi } from 'vitest';
import {
  Emoji,
  PINNED_EMOJI_DOC_IDS,
  extractButtonEmoji,
  loadRegistry,
  pickDocumentId,
  render,
  renderCustomEmojis,
  stripCustomEmojis,
} from '../telegram/customEmojis.js';
import { TelegramApi } from '../telegram/api.js';
import { sendSmartRichMessage, editSmartRichMessage, btn } from '../telegram/rich.js';

describe('Custom Emojis Module', () => {
  it('loads registry and preserves 64-bit document IDs as strings without float truncation', () => {
    const reg = loadRegistry();
    expect(reg.size).toBeGreaterThan(100);

    // Verify key IDs are strings and match exact known 64-bit Telegram document IDs
    const pingId = pickDocumentId('⚡');
    expect(pingId).toBe('5843553939672274145');
    expect(typeof pingId).toBe('string');
    // Ensure no precision loss (ending in 000 typically indicates float truncation)
    expect(pingId?.endsWith('145')).toBe(true);

    const keyId = pickDocumentId('🔑');
    expect(keyId).toBe('6005570495603282482');
    expect(keyId?.endsWith('482')).toBe(true);
  });

  it('normalizes variation selectors (\ufe0f / \ufe0e)', () => {
    const idPlain = pickDocumentId('⚡');
    const idVariant = pickDocumentId('⚡️');
    expect(idPlain).toBe(idVariant);

    const timerPlain = pickDocumentId('⏱');
    const timerVariant = pickDocumentId('⏱️');
    expect(timerPlain).toBe(timerVariant);
  });

  it('renders individual custom emoji tags', () => {
    const tag = render('👑');
    expect(tag).toBe('<tg-emoji emoji-id="5807868868886009920">👑</tg-emoji>');

    const fallbackTag = render('👑', 'ADMIN');
    expect(fallbackTag).toBe('<tg-emoji emoji-id="5807868868886009920">ADMIN</tg-emoji>');
  });

  it('returns glyph directly when emoji has no custom sticker', () => {
    const unknown = render('⚧');
    expect(unknown).toBe('⚧');
  });

  it('renderCustomEmojis transforms emojis in headers and paragraphs', () => {
    const input = '<h1>🏓 Pong!</h1><p>⚡ Latency: 12 ms</p><blockquote>🔒 Security notice</blockquote>';
    const output = renderCustomEmojis(input);

    expect(output).toContain('<tg-emoji emoji-id="5843553939672274145">🏓</tg-emoji> Pong!</h1>');
    expect(output).toContain('<tg-emoji emoji-id="5843553939672274145">⚡</tg-emoji> Latency: 12 ms</p>');
    expect(output).toContain('<tg-emoji emoji-id="5785324637088910941">🔒</tg-emoji> Security notice</blockquote>');
  });

  it('renderCustomEmojis protects code blocks, pre tags, and markdown code', () => {
    const input = '<p>Use <code>⚡ tok_123 🔒</code> in your requests</p><pre>⚡ code block 🔒</pre>';
    const output = renderCustomEmojis(input);

    // Emojis inside <code> and <pre> must NOT be transformed into tg-emoji tags
    expect(output).toContain('<code>⚡ tok_123 🔒</code>');
    expect(output).toContain('<pre>⚡ code block 🔒</pre>');
  });

  it('renderCustomEmojis preserves existing tg-emoji tags without double wrapping', () => {
    const existing = '<tg-emoji emoji-id="5807868868886009920">👑</tg-emoji> Admin';
    const output = renderCustomEmojis(existing);
    expect(output).toBe(existing);
    expect(output).not.toContain('<tg-emoji emoji-id="5807868868886009920"><tg-emoji');
  });

  it('renderCustomEmojis preserves HTML tag attributes', () => {
    const input = '<a href="https://example.com?q=⚡&user=👑">Link 🚀</a>';
    const output = renderCustomEmojis(input);

    expect(output).toContain('href="https://example.com?q=⚡&user=👑"');
    expect(output).toContain('Link <tg-emoji emoji-id="5857290546459973028">🚀</tg-emoji>');
  });

  it('stripCustomEmojis unwraps custom emoji tags to visible characters', () => {
    const html = '<h1><tg-emoji emoji-id="5807868868886009920">👑</tg-emoji> Title</h1>';
    const stripped = stripCustomEmojis(html);
    expect(stripped).toBe('<h1>👑 Title</h1>');
  });

  it('extractButtonEmoji extracts leading emoji and document ID', () => {
    const res = extractButtonEmoji('🔧 API Implementation');
    expect(res.text).toBe('API Implementation');
    expect(res.icon_custom_emoji_id).toBe('5988023995125993550');

    const resNoEmoji = extractButtonEmoji('Regular Button');
    expect(resNoEmoji.text).toBe('Regular Button');
    expect(resNoEmoji.icon_custom_emoji_id).toBeUndefined();
  });

  it('btn helper supports explicit icon_custom_emoji_id', () => {
    const b = btn('Tools', { icon_custom_emoji_id: Emoji.TOOLS });
    expect(b.text).toBe('Tools');
    expect(b.icon_custom_emoji_id).toBe('5988023995125993550');
  });

  it('btn helper supports emojiId shorthand', () => {
    const b = btn('Tools', { emojiId: '5988023995125993550' });
    expect(b.text).toBe('Tools');
    expect(b.icon_custom_emoji_id).toBe('5988023995125993550');
  });

  it('btn helper prefers icon_custom_emoji_id over emojiId', () => {
    const b = btn('Tools', { emojiId: '1111111111111111111', icon_custom_emoji_id: '2222222222222222222' });
    expect(b.icon_custom_emoji_id).toBe('2222222222222222222');
  });

  it('btn helper prefers icon_custom_emoji_id over extracted emoji', () => {
    const b = btn('🔧 Tools', { icon_custom_emoji_id: '1111111111111111111' });
    expect(b.icon_custom_emoji_id).toBe('1111111111111111111');
  });

  it('btn helper with emojiId only works for non-emoji text', () => {
    const b = btn('Tools', { emojiId: '5988023995125993550' });
    expect(b.text).toBe('Tools');
    expect(b.icon_custom_emoji_id).toBe('5988023995125993550');
  });

  it('sendSmartRichMessage automatically applies custom emojis to rich messages', async () => {
    let capturedPayload: Record<string, unknown> | null = null;
    const api = new TelegramApi('MOCK');
    vi.spyOn(api, 'sendRichMessage').mockImplementation(async (params) => {
      capturedPayload = params as unknown as Record<string, unknown>;
      return { message_id: 1, chat: { id: 123, type: 'private' } };
    });

    await sendSmartRichMessage(api, 123, '<h1>🏓 Pong!</h1><p>⚡ Latency: 5ms</p>');

    expect(capturedPayload).not.toBeNull();
    const richMessage = (capturedPayload as { rich_message: { html: string } }).rich_message;
    expect(richMessage.html).toContain('<tg-emoji emoji-id="5843553939672274145">🏓</tg-emoji>');
    expect(richMessage.html).toContain('<tg-emoji emoji-id="5843553939672274145">⚡</tg-emoji>');
  });
});
