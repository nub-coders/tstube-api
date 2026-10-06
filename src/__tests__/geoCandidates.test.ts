/**
 * WebsharePool.getGeoCandidates tests: ordered, distinct, limit-bounded
 * candidate exits for the geo-bypass tier's multi-attempt loop (F3).
 */
import { describe, expect, it } from 'vitest';
import { WebsharePool, type WebshareProxy } from '../proxy.js';

let nextIp = 20;
const proxy = (id: string, cc: string): WebshareProxy => ({
  id,
  address: `45.61.0.${nextIp++}`,
  port: 8000,
  username: 'u',
  password: 'p',
  url: `http://u:p@45.61.0.${nextIp - 1}:8000`,
  countryCode: cc,
  city: '',
  lastVerification: 0,
});

function poolWith(spec: Array<[string, string]>): WebsharePool {
  const pool = new WebsharePool();
  pool._setCandidatesForTest(spec.map(([id, cc]) => proxy(id, cc)));
  return pool;
}

describe('getGeoCandidates', () => {
  it('whitelist: country priority first, then fills within later codes, distinct and bounded', () => {
    const pool = poolWith([
      ['in1', 'IN'],
      ['us1', 'US'],
      ['sg1', 'SG'],
      ['sg2', 'SG'],
      ['sg3', 'SG'],
      ['us2', 'US'],
    ]);
    const out = pool.getGeoCandidates({ allowed: ['IN', 'SG', 'US'] }, 3);
    expect(out.map((p) => p.id)).toEqual(['in1', 'sg1', 'sg2']);
    expect(new Set(out.map((p) => p.id)).size).toBe(3);
  });

  it('whitelist: earlier codes win even when a later code has more exits', () => {
    const pool = poolWith([
      ['sg1', 'SG'],
      ['sg2', 'SG'],
      ['sg3', 'SG'],
      ['in1', 'IN'],
    ]);
    const out = pool.getGeoCandidates({ allowed: ['SG', 'IN'] }, 3);
    expect(out.map((p) => p.id)).toEqual(['sg1', 'sg2', 'sg3']);
  });

  it('whitelist: rotates within a country across successive calls', () => {
    const pool = poolWith([
      ['in1', 'IN'],
      ['sg1', 'SG'],
      ['sg2', 'SG'],
      ['sg3', 'SG'],
    ]);
    const first = pool.getGeoCandidates({ allowed: ['IN', 'SG'] }, 3).map((p) => p.id);
    const second = pool.getGeoCandidates({ allowed: ['IN', 'SG'] }, 3).map((p) => p.id);
    expect(first[0]).toBe('in1');
    expect(second[0]).toBe('in1'); // single IN exit stays first
    expect(second[1]).not.toBe(first[1]); // SG rotation advanced
  });

  it('blacklist: returns exits outside the blocked set, bounded by limit', () => {
    const pool = poolWith([
      ['us1', 'US'],
      ['de1', 'DE'],
      ['fr1', 'FR'],
      ['it1', 'IT'],
      ['es1', 'ES'],
    ]);
    const out = pool.getGeoCandidates({ blocked: ['US', 'DE'] }, 3);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.countryCode).sort()).toEqual(['ES', 'FR', 'IT']);
  });

  it('returns empty (no throw) when nothing matches', () => {
    const pool = poolWith([['us1', 'US']]);
    expect(pool.getGeoCandidates({ allowed: ['IN', 'SG'] }, 3)).toEqual([]);
    expect(pool.getGeoCandidates({ blocked: ['US'] }, 3)).toEqual([]);
    expect(pool.getGeoCandidates({}, 3)).toEqual([]);
  });

  it('handles an empty pool', () => {
    const pool = new WebsharePool();
    expect(pool.getGeoCandidates({ allowed: ['IN'] }, 3)).toEqual([]);
    expect(pool.getGeoCandidates({ blocked: ['US'] }, 3)).toEqual([]);
  });
});
