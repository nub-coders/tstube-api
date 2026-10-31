import { afterEach, expect, it, vi } from 'vitest';
import type { Ctx } from '../httpServer.js';
const state = vi.hoisted(() => ({ metadata: vi.fn(async (id: string) => ({ title: 'Song', video_id: id })), related: vi.fn(async () => []) }));
vi.mock('../youtubeApi.js', () => ({ getVideoById: state.metadata, fetchResults: vi.fn() }));
vi.mock('../streamJobs.js', () => ({ ensureStreamJob: async () => 'id.secret', resolveMode: vi.fn(), awaitStreamJob: vi.fn(), refreshStreamUrl: vi.fn() }));
vi.mock('../innertube.js', async original => ({ ...await original<typeof import('../innertube.js')>(), related: state.related }));
import { videoInfo } from '../apiRoutes.js';

afterEach(() => vi.clearAllMocks());

it.each([
  'https://www.youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk',
  ...['shorts', 'live', 'embed', 'v'].map(path => `https://www.youtube.com/${path}/abcdefghijk`),
])('uses the same video identity for metadata and streaming: %s', async q => {
  const ctx = { authUserId: 123, routePath: '/info', query: new URLSearchParams({ q }), req: { headers: { host: 'api.example.com' } } } as unknown as Ctx;
  const result = await videoInfo(ctx);
  expect(result.status).toBe(200);
  expect(result.json).toMatchObject({ title: 'Song', video_id: 'abcdefghijk' });
  expect(state.metadata).toHaveBeenCalledWith('abcdefghijk');
  expect(state.related).toHaveBeenCalledWith('abcdefghijk', 5);
});

it('continues rejecting unsupported URL hosts before metadata lookup', async () => {
  const ctx = { authUserId: 123, routePath: '/info', query: new URLSearchParams({ q: 'https://evil.example/shorts/abcdefghijk' }) } as Ctx;
  await expect(videoInfo(ctx)).rejects.toMatchObject({ status: 400 });
  expect(state.metadata).not.toHaveBeenCalled();
});
