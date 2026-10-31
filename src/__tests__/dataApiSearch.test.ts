import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ search: vi.fn(), store: new Map<string, string>() }));
vi.mock('../youtubeApi.js', () => ({ fetchResults: state.search, getAvailableKeys: () => ['fake-key'] }));
vi.mock('../redis.js', () => ({ redis: () => ({
  get: async (key: string) => state.store.get(key) ?? null,
  setex: async (key: string, _ttl: number, value: string) => { state.store.set(key, value); },
}) }));
const songs = Array.from({ length: 3 }, (_, n) => ({ title: `Song ${n}`, video_id: `video${n}`, url: `https://youtube.com/watch?v=video${n}` }));
beforeEach(() => {
  vi.resetModules(); state.store.clear();
  state.search.mockReset().mockImplementation(async (_q, limit) => songs.slice(0, limit));
});
afterEach(() => vi.restoreAllMocks());

it('coalesces concurrent identical public searches and reuses cached results', async () => {
  const api = await import('../dataApiSearch.js');
  await Promise.all(Array.from({ length: 10 }, () => api.fetchResults(' Song ', 2)));
  expect(await api.fetchResults('song', 2)).toEqual(songs.slice(0, 2));
  expect(state.search).toHaveBeenCalledTimes(1);
});

it('shares successful results across independently loaded workers', async () => {
  const first = await import('../dataApiSearch.js');
  await first.fetchResults('song', 2);
  vi.resetModules();
  const second = await import('../dataApiSearch.js');
  expect(await second.fetchResults('song', 2)).toEqual(songs.slice(0, 2));
  expect(state.search).toHaveBeenCalledTimes(1);
});

it('does not cache one caller’s smaller result limit for a larger request', async () => {
  const api = await import('../dataApiSearch.js');
  expect(await api.fetchResults('song', 1)).toHaveLength(1);
  expect(await api.fetchResults('song', 3)).toHaveLength(3);
});

it('releases coalesced failures and does not negative-cache transient errors', async () => {
  const api = await import('../dataApiSearch.js');
  state.search.mockRejectedValueOnce(new Error('upstream unavailable'));
  await expect(api.fetchResults('song', 1)).rejects.toThrow('unavailable');
  expect(await api.fetchResults('song', 1)).toHaveLength(1);
});
