import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextPacificMidnightEpoch, nextUtcMidnightEpoch } from '../quota.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('YouTube Pacific quota reset', () => {
  it.each([
    ['winter day', '2026-01-15T12:00:00Z', '2026-01-16T08:00:00Z'],
    ['winter UTC date ahead of Pacific', '2026-01-15T04:00:00Z', '2026-01-15T08:00:00Z'],
    ['summer day', '2026-07-15T12:00:00Z', '2026-07-16T07:00:00Z'],
    ['summer UTC date ahead of Pacific', '2026-07-15T04:00:00Z', '2026-07-15T07:00:00Z'],
    ['just before winter midnight', '2026-01-15T07:59:59.999Z', '2026-01-15T08:00:00Z'],
    ['exact winter midnight', '2026-01-15T08:00:00Z', '2026-01-16T08:00:00Z'],
    ['just before summer midnight', '2026-07-15T06:59:59.999Z', '2026-07-15T07:00:00Z'],
    ['exact summer midnight', '2026-07-15T07:00:00Z', '2026-07-16T07:00:00Z'],
    ['just before spring transition day', '2026-03-08T07:59:59.999Z', '2026-03-08T08:00:00Z'],
    ['after spring clock change', '2026-03-08T10:00:00Z', '2026-03-09T07:00:00Z'],
    ['first repeated fall hour', '2026-11-01T08:30:00Z', '2026-11-02T08:00:00Z'],
    ['second repeated fall hour', '2026-11-01T09:30:00Z', '2026-11-02T08:00:00Z'],
    ['month boundary', '2026-04-30T23:30:00Z', '2026-05-01T07:00:00Z'],
    ['year boundary', '2026-12-31T23:30:00Z', '2027-01-01T08:00:00Z'],
  ])('computes the next local midnight: %s', (_, now, reset) => {
    expect(nextPacificMidnightEpoch(Date.parse(now))).toBe(Date.parse(reset) / 1000);
  });

  it.each([
    { season: 'spring', start: '2026-03-08T08:00:00Z', reset: '2026-03-09T07:00:00Z', hours: 23 },
    { season: 'fall', start: '2026-11-01T07:00:00Z', reset: '2026-11-02T08:00:00Z', hours: 25 },
  ])('uses a $season transition quota day of the correct length', ({ start, reset, hours }) => {
    const startMs = Date.parse(start);
    const cutoff = nextPacificMidnightEpoch(startMs);
    expect(cutoff).toBe(Date.parse(reset) / 1000);
    expect(cutoff - startMs / 1000).toBe(hours * 3600);
  });

  it.each(['UTC', 'Asia/Kolkata', 'Pacific/Auckland'])('ignores process timezone %s', (tz) => {
    vi.stubEnv('TZ', tz);
    expect(nextPacificMidnightEpoch(Date.parse('2026-11-01T07:00:00Z')))
      .toBe(Date.parse('2026-11-02T08:00:00Z') / 1000);
  });
});

describe('application UTC quota reset', () => {
  it.each([
    ['2026-03-08T08:00:00Z', '2026-03-09T00:00:00Z'],
    ['2026-11-01T07:00:00Z', '2026-11-02T00:00:00Z'],
    ['2026-12-31T23:59:59.999Z', '2027-01-01T00:00:00Z'],
    ['2027-01-01T00:00:00Z', '2027-01-02T00:00:00Z'],
  ])('keeps the UTC reset for %s', (now, reset) => {
    expect(nextUtcMidnightEpoch(Date.parse(now))).toBe(Date.parse(reset) / 1000);
  });
});
