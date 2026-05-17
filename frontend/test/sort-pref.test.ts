/**
 * Tests for sort-pref.ts — Queue / Upcoming sort-order preference.
 *
 * Coverage:
 * - Default is 'time' (chronological — operator feedback 2026-05-16)
 * - Round-trip get/set
 * - localStorage failure modes (private-mode Safari) fall back to default
 * - sortPassesByOrder: pure function, doesn't mutate input
 * - 'time' order: ascending closest_approach
 * - 'score' order: descending score (matches generator's emitted order)
 * - Malformed timestamps don't fly to top/bottom on NaN
 * - Missing score field treated as 0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SORT_ORDER,
  flipSortOrder,
  getSortOrder,
  setSortOrder,
  sortPassesByOrder,
} from '../src/sort-pref';

const STORAGE_KEY = 'opd_queue_sort_v1';

describe('sort preference storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to time (chronological) when no preference saved', () => {
    expect(getSortOrder()).toBe('time');
    expect(DEFAULT_SORT_ORDER).toBe('time');
  });

  it('persists and reads back a score preference', () => {
    setSortOrder('score');
    expect(getSortOrder()).toBe('score');
  });

  it('persists and reads back a time preference', () => {
    setSortOrder('score');
    setSortOrder('time');
    expect(getSortOrder()).toBe('time');
  });

  it('falls back to time on malformed stored value', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-valid-order');
    expect(getSortOrder()).toBe('time');
  });

  it('returns time when localStorage.getItem throws', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('storage disabled (private-mode Safari)');
    });
    try {
      expect(getSortOrder()).toBe('time');
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  it('does not throw when localStorage.setItem fails (quota / private-mode)', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('quota exceeded');
    });
    try {
      expect(() => setSortOrder('score')).not.toThrow();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it('flipSortOrder returns the inverse of the current preference', () => {
    setSortOrder('time');
    expect(flipSortOrder()).toBe('score');
    setSortOrder('score');
    expect(flipSortOrder()).toBe('time');
  });
});

describe('sortPassesByOrder', () => {
  const passes = [
    { target_id: 'a', closest_approach: '2026-05-17T01:00:00Z', score: 50 },
    { target_id: 'b', closest_approach: '2026-05-17T00:15:00Z', score: 80 },
    { target_id: 'c', closest_approach: '2026-05-17T00:45:00Z', score: 30 },
  ];

  it('does not mutate the input array', () => {
    const original = passes.map((p) => ({ ...p }));
    sortPassesByOrder(passes, 'time');
    expect(passes).toEqual(original);
  });

  it("'time' returns ascending by closest_approach", () => {
    const sorted = sortPassesByOrder(passes, 'time');
    expect(sorted.map((p) => p.target_id)).toEqual(['b', 'c', 'a']);
  });

  it("'score' returns descending by score", () => {
    const sorted = sortPassesByOrder(passes, 'score');
    expect(sorted.map((p) => p.target_id)).toEqual(['b', 'a', 'c']);
  });

  it('treats missing score as 0 in score-sort', () => {
    const mixed = [
      { target_id: 'has-score', closest_approach: '2026-05-17T01:00:00Z', score: 50 },
      { target_id: 'no-score', closest_approach: '2026-05-17T02:00:00Z' },
    ];
    const sorted = sortPassesByOrder(mixed, 'score');
    expect(sorted.map((p) => p.target_id)).toEqual(['has-score', 'no-score']);
  });

  it('sinks malformed-timestamp rows to the bottom in time-sort', () => {
    const withBad = [
      { target_id: 'good', closest_approach: '2026-05-17T01:00:00Z', score: 50 },
      { target_id: 'bad', closest_approach: 'not-a-date', score: 80 },
      { target_id: 'good2', closest_approach: '2026-05-17T00:30:00Z', score: 30 },
    ];
    const sorted = sortPassesByOrder(withBad, 'time');
    // Good timestamps sort ascending, then NaN goes last.
    expect(sorted.map((p) => p.target_id)).toEqual(['good2', 'good', 'bad']);
  });

  it('falls back to score order when both timestamps are NaN', () => {
    const allBad = [
      { target_id: 'low', closest_approach: 'bad1', score: 10 },
      { target_id: 'high', closest_approach: 'bad2', score: 90 },
    ];
    const sorted = sortPassesByOrder(allBad, 'time');
    expect(sorted.map((p) => p.target_id)).toEqual(['high', 'low']);
  });

  it('returns empty for empty input', () => {
    expect(sortPassesByOrder([], 'time')).toEqual([]);
    expect(sortPassesByOrder([], 'score')).toEqual([]);
  });

  it('single-element input is returned as-is', () => {
    const single = [{ target_id: 'only', closest_approach: '2026-05-17T01:00:00Z', score: 50 }];
    expect(sortPassesByOrder(single, 'time')).toEqual(single);
    expect(sortPassesByOrder(single, 'score')).toEqual(single);
  });
});
