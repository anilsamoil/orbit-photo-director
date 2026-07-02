/** Shared shot-count store — the map popup reads what the Profile pane
 *  publishes, so "have I shot it yet" needs no log fetch on tap (review R12). */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  publishShotCounts,
  getShotCount,
  aggregateShootCounts,
  claimMapShotFetch,
  _resetShotCountsForTest,
} from '../src/shot-counts';

beforeEach(() => _resetShotCountsForTest());

describe('shot-counts store', () => {
  it('returns 0 for unknown targets (quiet, not "never shot")', () => {
    expect(getShotCount('personal:jack:abc')).toBe(0);
  });

  it('returns the published count', () => {
    publishShotCounts(new Map([['personal:jack:abc', 3], ['pettit:tokyo', 1]]));
    expect(getShotCount('personal:jack:abc')).toBe(3);
    expect(getShotCount('pettit:tokyo')).toBe(1);
    expect(getShotCount('unknown')).toBe(0);
  });

  it('replaces the map wholesale on re-publish (profile switch)', () => {
    publishShotCounts(new Map([['a', 5]]));
    publishShotCounts(new Map([['b', 2]]));
    expect(getShotCount('a')).toBe(0); // prior profile's count gone
    expect(getShotCount('b')).toBe(2);
  });
});

describe('aggregateShootCounts', () => {
  it('counts only shoot events, by target_id', () => {
    const m = aggregateShootCounts([
      { action: 'shoot', target_id: 'a' },
      { action: 'skip', target_id: 'a' },
      { action: 'shoot', target_id: 'a' },
      { action: 'rate', target_id: 'a' },
      { action: 'shoot', target_id: 'b' },
    ]);
    expect(m.get('a')).toBe(2); // skip + rate excluded
    expect(m.get('b')).toBe(1);
    expect(m.has('skip')).toBe(false);
  });

  it('empty input → empty map', () => {
    expect(aggregateShootCounts([]).size).toBe(0);
  });
});

describe('claimMapShotFetch', () => {
  it('returns true once per profile, false after (no double-fetch)', () => {
    expect(claimMapShotFetch('jack')).toBe(true);
    expect(claimMapShotFetch('jack')).toBe(false);
    expect(claimMapShotFetch('anil')).toBe(true); // different profile claims independently
  });

  it('reset re-arms the claim', () => {
    claimMapShotFetch('jack');
    _resetShotCountsForTest();
    expect(claimMapShotFetch('jack')).toBe(true);
  });
});
