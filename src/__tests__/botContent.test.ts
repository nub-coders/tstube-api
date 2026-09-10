import { describe, it, expect, beforeAll } from 'vitest';
import { loadConfig } from '../config.js';

// Config is loaded once; templates read BASE_URL from it.
beforeAll(() => {
  process.env.BASE_URL = 'https://apitest.nubcoders.com';
  process.env.API_HOST = 'apitest.nubcoders.com';
  loadConfig();
});

describe('rich content', () => {
  it('prepends the ephemeral notice for groups and omits it in private', async () => {
    const { menuContent } = await import('../telegram/content.js');
    const priv = menuContent(false);
    const grp = menuContent(true);
    expect(priv.html).not.toContain('Ephemeral Message');
    expect(grp.html).toContain('<blockquote>🔒 <b>Ephemeral Message:</b> Only visible to you in this group.</blockquote>');
    // fallback never carries the ephemeral line
    expect(grp.fallback).not.toContain('Ephemeral Message');
  });

  it('masks tokens in the group fallback and keeps them in the ephemeral html', async () => {
    const { startNew } = await import('../telegram/content.js');
    const token = 'ABCDefghij';
    const c = startNew('Bob', token, true);
    expect(c.html).toContain(`<code>${token}</code>`);
    expect(c.fallback).toContain('<code>ABCD******</code>');
    expect(c.fallback).toContain('Group Chat Privacy Notice');
  });

  it('escapes the username', async () => {
    const { startNew } = await import('../telegram/content.js');
    const c = startNew('a<b>&"c', 'tok1234567', false);
    expect(c.html).toContain('Welcome to YT-DLP API, a&lt;b&gt;&amp;&quot;c!');
  });

  it('renders the status progress bar and Indian-grouped counts', async () => {
    const { statusWithToken } = await import('../telegram/content.js');
    const c = statusWithToken('tok1234567', 500, 1000, false, false);
    expect(c.html).toContain('🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜');
    expect(c.html).toContain('<b>500</b> / 1,000');
    expect(c.html).toContain('👤 Standard (1,000 req/day)');
  });

  it('formats /ping latency with a Python float', async () => {
    const { pingContent } = await import('../telegram/content.js');
    expect(pingContent(12, '1m 2s')).toContain('<code>12.0 ms</code>');
    // 12.345 is really 12.3449... as a double, so Python rounds down to 12.34.
    expect(pingContent(12.345, '1m 2s')).toContain('<code>12.34 ms</code>');
  });

  it('builds the main menu keyboard in Python row order with styles', async () => {
    const { buildMainMenuKeyboard } = await import('../telegram/callbackContent.js');
    const kb = buildMainMenuKeyboard();
    expect(kb.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ['🔧 API Implementation', '📊 Usage Status'],
      ['🔄 Revoke Token', '❓ Help'],
      ['📖 API Docs'],
    ]);
    expect(kb.inline_keyboard[0]![0]!.style).toBe('primary');
    expect(kb.inline_keyboard[1]![0]!.style).toBe('danger');
    // Unstyled (ButtonStyle.DEFAULT) buttons omit `style` entirely.
    expect(kb.inline_keyboard[1]![1]!.style).toBeUndefined();
  });

  it('renders every callback card without throwing and keeps key headers', async () => {
    const cb = await import('../telegram/callbackContent.js');
    expect(cb.apiDocs().html).toContain('<h1>API Documentation</h1>');
    expect(cb.apiInfoGet('T').html).toContain('&amp;q=https://youtube.com/watch?v=dQw4w9WgXcQ');
    expect(cb.help('T').html).toContain('params={"token": "T", "q": "VIDEO_URL"}');
    expect(cb.backMenu().html).toContain('YT-DLP API Bot Menu');
    expect(cb.viewTokenGroup('T')).toContain('<code>T</code>');
  });

  it('strips rich html for the classic fallback', async () => {
    const { stripRichHtml } = await import('../telegram/rich.js');
    const plain = stripRichHtml('<h1>Hi</h1><p>a &amp; b</p><table><tr><td>x</td><td>y</td></tr></table>');
    expect(plain).toContain('Hi');
    expect(plain).toContain('a & b');
    expect(plain).not.toContain('<');
  });

  it('renders admin error-log cards in 3600-char chunks', async () => {
    const { errorLogCards } = await import('../telegram/adminContent.js');
    const entries = Array.from({ length: 40 }, (_, i) => ({
      ts: '2026-09-12 10:00:00',
      user: String(1000 + i),
      status: 500,
      path: '/info',
      error: 'x'.repeat(200),
    }));
    const chunks = errorLogCards(entries);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3600 + 300);
    expect(chunks[0]).toContain('Recent API Error Log (40)');
  });
});

describe('readable time helpers', () => {
  it('formats the same as get_readable_time / _get_readable_uptime', async () => {
    const { getReadableTime, getReadableUptime } = await import('../telegram/content.js');
    expect(getReadableTime(45)).toBe('45s');
    expect(getReadableTime(125)).toBe('2m 5s');
    expect(getReadableTime(3725)).toBe('1h 2m 5s');
    expect(getReadableTime(90061)).toBe('1d 1h 1m 1s');
    // admin variant drops zero components but always keeps seconds
    expect(getReadableUptime(3600)).toBe('1h 0s');
    expect(getReadableUptime(61)).toBe('1m 1s');
  });
});
