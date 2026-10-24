import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadConfig } from '../config.js';

// Setup config
beforeAll(() => {
  process.env.BASE_URL = 'https://apitest.nubcoders.com';
  process.env.API_HOST = 'apitest.nubcoders.com';
  loadConfig();
});

describe('Telegram message size limits (must be < 4096 characters)', () => {
  it('apiDocs rendered length is strictly under 4096 characters', async () => {
    const { apiDocs } = await import('../telegram/callbackContent.js');
    const { renderCustomEmojis } = await import('../telegram/customEmojis.js');
    const card = apiDocs('tok_1234567890abcdef');
    const rendered = renderCustomEmojis(card.html);
    expect(rendered.length).toBeLessThan(4096);
  });

  it('buildStats rendered length is strictly under 4096 characters under heavy load', async () => {
    const mockUsers = Array.from({ length: 50 }, (_, i) => `user_token:${1000 + i}`);
    const mockRequests = Array.from({ length: 30 }, (_, i) => `user_requests:${1000 + i}`);
    const mockFailPaths = ['failed_by_path:/info', 'failed_by_path:/stream', 'failed_by_path:/search'];
    const mockFailUsers = ['user_failed:1001', 'user_failed:1002', 'user_failed:1003'];

    vi.doMock('../redis.js', () => ({
      redis: () => ({
        info: async () => 'used_memory_human:12.5M\nused_memory_peak_human:18.2M\ninstantaneous_ops_per_sec:145\nkeyspace_hits:1200\nkeyspace_misses:45\n',
        dbsize: async () => 200,
        get: async () => '5',
        mget: async (keys: string[]) => keys.map((_, i) => String(100 - i)),
      }),
      scanKeys: async (pattern: string) => {
        if (pattern.startsWith('user_token:')) return mockUsers;
        if (pattern.startsWith('user_requests:')) return mockRequests;
        if (pattern.startsWith('failed_by_path:')) return mockFailPaths;
        if (pattern.startsWith('user_failed:')) return mockFailUsers;
        return [];
      },
    }));

    const { buildStats } = await import('../telegram/adminContent.js');
    const { renderCustomEmojis } = await import('../telegram/customEmojis.js');

    const fakeApi = {
      getChat: async (id: number) => ({ first_name: 'Test', last_name: `User ${id}` }),
    } as any;

    const statsHtml = await buildStats(fakeApi, undefined, true);
    const rendered = renderCustomEmojis(statsHtml);

    expect(rendered.length).toBeLessThan(4096);
    expect(statsHtml).toContain('Bot Statistics Dashboard');
    expect(statsHtml).toContain('Traffic &amp; Users');
    expect(statsHtml).toContain('Top 5 Users Today');
  });

  it('all other admin and callback cards are well within 4096 characters', async () => {
    const { userInfoCard, grantCard, revokeAdminCard, listUsersCard, adminHelpCard } = await import('../telegram/adminContent.js');
    const { platformsCard, implQuickRef, help } = await import('../telegram/callbackContent.js');
    const { renderCustomEmojis } = await import('../telegram/customEmojis.js');

    const cards = [
      userInfoCard('123456789', 'token_abcdef', 500, 2),
      grantCard(123456789, 500, 200, 700),
      revokeAdminCard(123456789),
      listUsersCard('<tr><td>123</td><td>50</td></tr>'),
      adminHelpCard(),
      platformsCard().html,
      implQuickRef('test_token').html,
      help('test_token').html,
    ];

    for (const html of cards) {
      const rendered = renderCustomEmojis(html);
      expect(rendered.length).toBeLessThan(4096);
    }
  });
});
