/**
 * Resolver capability tests — "<coreId>.<secret>" bearer URLs.
 *
 * The coreId is derivable from any video URL, so the random secret stored in
 * the job is the only thing keeping the unauthenticated /stream/resolver
 * endpoint from serving streams for every known video.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  extractedUrl: 'https://rr3---sn-test.googlevideo.com/videoplayback?expire=4102444800&ip=203.0.113.9',
}));

vi.mock('../redis.js', () => ({
  redis: () => ({
    get: async (key: string) => state.store.get(key) ?? null,
    set: async (key: string, value: string, ...rest: unknown[]) => {
      const opts = rest.map(String);
      if (opts.includes('NX') && state.store.has(key)) return null;
      if (opts.includes('XX') && !state.store.has(key)) return null;
      state.store.set(key, value);
      return 'OK';
    },
    del: async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (state.store.delete(key)) removed += 1;
      return removed;
    },
  }),
}));

vi.mock('../cacheManager.js', () => ({
  PROXY_STREAM_TTL_S: 3600,
  invalidate: async () => {},
  getStream: async () => ({ url: state.extractedUrl, proxyUrl: null }),
  getVideoStream: async () => ({ url: state.extractedUrl, proxyUrl: null }),
}));

import {
  awaitStreamJob,
  encodeStreamId,
  ensureStreamJob,
  parseStreamCapability,
  refreshStreamUrl,
  resetJobState,
} from '../streamJobs.js';

/** The extraction is fire-and-forget; wait until the job carries a URL. */
async function waitForExtraction(streamId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const raw = state.store.get(`stream_job:${streamId}`);
    const job = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (job?.extracted_url) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('extraction did not complete');
}

function secretOf(capability: string): string {
  const secret = capability.split('.')[1];
  if (!secret) throw new Error(`capability without secret: ${capability}`);
  return secret;
}

beforeEach(() => {
  state.store.clear();
  resetJobState();
});

describe('parseStreamCapability', () => {
  it('splits core id and secret at the first dot', () => {
    expect(parseStreamCapability('abc.def')).toEqual({ streamId: 'abc', secret: 'def' });
    expect(parseStreamCapability('abc.def.ghi')).toEqual({ streamId: 'abc', secret: 'def.ghi' });
  });

  it('rejects bare ids and empty halves', () => {
    expect(parseStreamCapability('nosecrethere')).toBeNull();
    expect(parseStreamCapability('.secret')).toBeNull();
    expect(parseStreamCapability('core.')).toBeNull();
    expect(parseStreamCapability('')).toBeNull();
  });
});

describe('resolver capability flow', () => {
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';

  it('issues an unguessable capability whose job carries the same secret', async () => {
    const capability = await ensureStreamJob(url, 'audio');
    const coreId = encodeStreamId(url, 'audio');
    const secret = secretOf(capability);

    expect(capability).toBe(`${coreId}.${secret}`);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const stored = await waitForExtraction(coreId);
    expect(stored.secret).toBe(secret);
    expect(stored.extracted_url).toBe(state.extractedUrl);
  });

  it('resolves a valid capability through awaitStreamJob', async () => {
    const capability = await ensureStreamJob(url, 'video');
    const resolved = await awaitStreamJob(capability);
    expect(resolved).not.toBeNull();
    expect(resolved!.streamId).toBe(encodeStreamId(url, 'video'));
    expect(resolved!.job.extracted_url).toBe(state.extractedUrl);
    expect(resolved!.job.secret).toBe(secretOf(capability));
  });

  it('hands the same capability to repeat requests for the same url+mode', async () => {
    const first = await ensureStreamJob(url, 'audio');
    await waitForExtraction(encodeStreamId(url, 'audio'));
    const second = await ensureStreamJob(url, 'audio');
    expect(second).toBe(first);
  });

  it('waits for a pending job, then resolves', async () => {
    const capability = await ensureStreamJob(url, 'audio');
    // No waitForExtraction: the resolver wait must ride out the extraction.
    const resolved = await awaitStreamJob(capability);
    expect(resolved?.job.extracted_url).toBe(state.extractedUrl);
  });

  it('rejects wrong secrets, bare pre-capability ids, and unknown ids identically', async () => {
    const capability = await ensureStreamJob(url, 'audio');
    await waitForExtraction(encodeStreamId(url, 'audio'));
    const coreId = encodeStreamId(url, 'audio');

    expect(await awaitStreamJob(capability)).not.toBeNull();
    expect(await awaitStreamJob(coreId)).toBeNull(); // deterministic id alone no longer works
    expect(await awaitStreamJob(`${coreId}.wrongsecret`)).toBeNull();
    expect(await awaitStreamJob(`${'A'.repeat(43)}.bad`)).toBeNull();
    expect(await awaitStreamJob('garbage')).toBeNull();
  });

  it('keeps the capability valid across a 403 refresh', async () => {
    const capability = await ensureStreamJob(url, 'audio');
    const resolved = (await awaitStreamJob(capability))!;
    const originalSecret = resolved.job.secret;

    const refreshedUrl = state.extractedUrl + '&refreshed=1';
    state.extractedUrl = refreshedUrl;
    const refreshed = await refreshStreamUrl(resolved.streamId, resolved.job);

    expect(refreshed?.extracted_url).toBe(refreshedUrl);
    expect(refreshed?.secret).toBe(originalSecret);
    expect((await awaitStreamJob(capability))?.job.extracted_url).toBe(refreshedUrl);
  });

  it('backfills a secret on pre-capability jobs and retires bare-id URLs', async () => {
    const coreId = encodeStreamId(url, 'audio');
    const legacy = { url, mode: 'audio', extracted_url: state.extractedUrl, extracted_time: 1 };
    state.store.set(`stream_job:${coreId}`, JSON.stringify(legacy));

    const capability = await ensureStreamJob(url, 'audio');
    expect(capability.startsWith(`${coreId}.`)).toBe(true);

    const stored = JSON.parse(state.store.get(`stream_job:${coreId}`)!) as Record<string, unknown>;
    expect(stored.secret).toBe(secretOf(capability));

    expect((await awaitStreamJob(capability))?.job.extracted_url).toBe(state.extractedUrl);
    expect(await awaitStreamJob(coreId)).toBeNull();
  });
});
