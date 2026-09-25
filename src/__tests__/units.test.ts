import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { BoundedCache } from '../boundedCache.js';
import { parseDur, formatInd, formatViews, extractArtist, processVideo } from '../formatters.js';
import { isAllowedTarget, validateYoutubeTarget } from '../urlValidation.js';
import { HttpError } from '../httpError.js';
import { pyRoundStr, pyNumStr, comma, round2, pyFloatStr } from '../pyTime.js';
import { encodeStreamId, resolveMode } from '../streamJobs.js';
import * as metrics from '../metrics.js';
import { validateQuery, argsFor, paramsFor, type ValidationDetail } from '../routeArgs.js';
import { isFreePath } from '../httpServer.js';

describe('BoundedCache', () => {
  it('stores and retrieves values', () => {
    const c = new BoundedCache<number>(3);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.get('missing', -1)).toBe(-1);
  });

  it('evicts the least-recently-used beyond maxsize', () => {
    const c = new BoundedCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // touch a -> b is now LRU
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });

  it('setdefault only writes when absent', () => {
    const c = new BoundedCache<number>(4);
    expect(c.setdefault('x', 5)).toBe(5);
    expect(c.setdefault('x', 9)).toBe(5);
  });
});

describe('formatters', () => {
  it('parseDur matches helpers.parse_dur', () => {
    expect(parseDur('PT1H2M3S')).toBe('1:02:03');
    expect(parseDur('PT3M4S')).toBe('3:04');
    expect(parseDur('PT45S')).toBe('0:45');
    expect(parseDur('garbage')).toBe('N/A');
    expect(parseDur(null)).toBe('N/A');
  });

  it('formatInd uses Indian grouping', () => {
    expect(formatInd(123)).toBe('123');
    expect(formatInd(1500)).toBe('1.5K');
    expect(formatInd(250000)).toBe('2.5 Lakh');
    expect(formatInd(12_000_000)).toBe('1.2 Crore');
    expect(formatInd('nope')).toBe('0');
  });

  it('formatViews expands M/K suffixes (digits concatenated, like Python)', () => {
    expect(formatViews('12M views')).toBe('1.2 Crore');
    expect(formatViews('3K views')).toBe('3.0K');
    expect(formatViews('')).toBe('N/A');
  });

  it('extractArtist splits on the first dash', () => {
    expect(extractArtist('Artist - Song')).toBe('Artist');
    expect(extractArtist('NoDash')).toBe('Unknown Artist');
  });

  it('processVideo preserves Python key order', () => {
    const v = processVideo(
      {
        id: { videoId: 'abc' },
        snippet: { title: 'T - S', channelTitle: 'Chan', thumbnails: { high: { url: 'u' } } },
      },
      { contentDetails: { duration: 'PT1M5S' }, statistics: { viewCount: '1500' } },
    );
    expect(v).not.toBeNull();
    expect(Object.keys(v!)).toEqual([
      'title',
      'video_id',
      'url',
      'time',
      'duration',
      'artist_name',
      'channel_name',
      'views',
      'thumbnail',
    ]);
  });
});

describe('urlValidation', () => {
  it('allows YouTube hosts and bare ids, rejects others', () => {
    expect(isAllowedTarget('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(isAllowedTarget('https://youtu.be/x')).toBe(true);
    expect(isAllowedTarget('dQw4w9WgXcQ')).toBe(true);
    expect(isAllowedTarget('https://evil.com/watch?v=x')).toBe(false);
    // hostname strips userinfo, so this resolves to youtube.com (Python allows it too).
    expect(isAllowedTarget('https://evil.com@youtube.com/watch?v=x')).toBe(true);
    expect(isAllowedTarget('file:///etc/passwd')).toBe(false);
    expect(isAllowedTarget('')).toBe(false);
  });

  it('throws the FastAPI detail envelope on invalid targets', () => {
    try {
      validateYoutubeTarget('https://evil.com');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(400);
      expect((e as HttpError).payload).toEqual({
        detail: 'Invalid target: only allowed streaming target URLs or search queries permitted',
      });
    }
  });
});

describe('python number formatting', () => {
  it('rounds like Python and keeps .0', () => {
    expect(pyRoundStr(1, 2)).toBe('1.0');
    expect(pyRoundStr(1.25, 1)).toBe('1.2'); // half-to-even
    expect(pyRoundStr(0.1234, 2)).toBe('0.12');
    expect(pyNumStr(5)).toBe('5.0');
    expect(comma(1234567)).toBe('1,234,567');
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(pyFloatStr(2)).toBe('2.0');
  });
});

describe('stream ids', () => {
  it('encodeStreamId matches base64url(sha256("mode:url")) without padding', () => {
    const url = 'https://youtu.be/abc';
    const expected = createHash('sha256').update(`video:${url}`).digest().toString('base64url');
    const id = encodeStreamId(url, 'video');
    expect(id).toBe(expected);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.includes('=')).toBe(false);
    expect(encodeStreamId(url, 'audio')).not.toBe(id);
  });

  it('resolveMode mirrors _resolve_mode', () => {
    expect(resolveMode('video')).toBe('video');
    expect(resolveMode('STREAM')).toBe('video');
    expect(resolveMode('muxed')).toBe('video');
    expect(resolveMode('audio')).toBe('audio');
    expect(resolveMode('')).toBe('audio');
  });
});

describe('metrics render', () => {
  it('emits the exact exposition format', () => {
    metrics.resetMetrics();
    metrics.record('GET', '/health', 200, 0.5);
    metrics.record('GET', '/health', 200, 0.25);
    metrics.recordStreamTtfb(0.1);
    metrics.recordUpstreamConnect(1.5);
    metrics.recordStreamBytes(1024);
    metrics.streamStarted();
    metrics.recordStreamError('connect');
    const out = metrics.render();
    expect(out).toContain(
      '# HELP http_requests_total Total HTTP requests by method, path and status.\n# TYPE http_requests_total counter\n',
    );
    expect(out).toContain('http_requests_total{method="GET",path="/health",status="200"} 2');
    expect(out).toContain('http_request_duration_seconds_sum{method="GET",path="/health"} 0.75');
    expect(out).toContain('http_request_duration_seconds_count{method="GET",path="/health"} 2');
    expect(out).toContain('stream_upstream_connect_slow_total 1');
    expect(out).toContain('stream_bytes_total 1024');
    expect(out).toContain('stream_active 1');
    expect(out).toContain('stream_errors_total{code="connect"} 1');
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('query validation', () => {
  const search = paramsFor('/search');

  it('reports missing required params in signature order', () => {
    const { details } = validateQuery(new URLSearchParams(''), search);
    expect(details).toEqual<ValidationDetail[]>([
      { type: 'missing', loc: ['query', 'q'], msg: 'Field required', input: null },
    ]);
  });

  it('applies defaults for optional params', () => {
    const { values, details } = validateQuery(new URLSearchParams('q=hi'), search);
    expect(details).toEqual([]);
    expect(values).toEqual({ q: 'hi', limit: 5, method: 'scrape' });
  });

  it('matches pydantic int parsing and bounds', () => {
    expect(validateQuery(new URLSearchParams('q=x&limit=abc'), search).details[0]).toMatchObject({
      type: 'int_parsing',
      loc: ['query', 'limit'],
      input: 'abc',
    });
    expect(validateQuery(new URLSearchParams('q=x&limit=0'), search).details[0]).toMatchObject({
      type: 'greater_than_equal',
      input: '0',
      ctx: { ge: 1 },
    });
    expect(validateQuery(new URLSearchParams('q=x&limit=99'), search).details[0]).toMatchObject({
      type: 'less_than_equal',
      ctx: { le: 20 },
    });
    expect(validateQuery(new URLSearchParams('q=x&limit=2.0'), search).values.limit).toBe(2);
  });

  it('parses bools and takes the last repeated value', () => {
    const info = paramsFor('/info');
    const r = validateQuery(new URLSearchParams('q=x&redirect=false'), info);
    expect(r.values.redirect).toBe(false);
    expect(validateQuery(new URLSearchParams('q=a&q=b'), search).values.q).toBe('b');
    expect(validateQuery(new URLSearchParams('q=x&redirect=maybe'), info).details[0]).toMatchObject({
      type: 'bool_parsing',
    });
  });

  it('exposes the FastAPI argument tables in field order', () => {
    const { required_arguments, optional_arguments } = argsFor('/stream');
    expect(Object.keys(required_arguments)).toEqual(['q']);
    expect(Object.keys(optional_arguments)).toEqual(['redirect', 'mode', 'token']);
    expect(Object.keys(optional_arguments.redirect!)).toEqual(['type', 'in', 'description', 'default']);
  });

  it('marks /stream/redirect token as a required query param', () => {
    const { required_arguments } = argsFor('/stream/redirect');
    expect(Object.keys(required_arguments)).toEqual(['q', 'token']);
  });
});

describe('free paths', () => {
  it('matches the Python FREE_PATHS and prefixes', () => {
    for (const p of [
      '/',
      '/search',
      '/trending',
      '/suggest',
      '/health',
      '/rate-limit-status',
      '/metrics',
      '/favicon.ico',
    ]) {
      expect(isFreePath(p)).toBe(true);
    }
    expect(isFreePath('/stream/resolver/abc')).toBe(true);
    expect(isFreePath('/stream/proxy/abc')).toBe(true);
    expect(isFreePath('/stream')).toBe(false);
    expect(isFreePath('/info')).toBe(false);
  });
});
