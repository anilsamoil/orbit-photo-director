/** Tests for shotlist.ts — the localStorage-backed pass selection that feeds
 *  the .ics export. Mirrors the defensive read/write contract of sort-pref. */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearShotlist,
  getShotlist,
  isInShotlist,
  nextSequence,
  passKey,
  pruneExpired,
  shotlistCount,
  toggleShotlist,
} from '../src/shotlist';
import type { PassEntry } from '../src/types';

const NOW = Date.UTC(2026, 5, 7, 12, 0, 0);

function pass(o: Partial<PassEntry> = {}): PassEntry {
  return {
    target_id: 'tokyo',
    target_name: 'Tokyo',
    closest_approach: new Date(NOW + 30 * 60_000).toISOString(),
    angle_off_nadir_deg: 26,
    iss_relative_bearing_deg: 90,
    ...o,
  } as PassEntry;
}

beforeEach(() => {
  localStorage.clear();
});

describe('passKey', () => {
  it('is target_id + closest_approach', () => {
    expect(passKey(pass({ target_id: 'x', closest_approach: '2026-06-07T12:30:00.000Z' })))
      .toBe('x|2026-06-07T12:30:00.000Z');
  });
});

describe('toggleShotlist / isInShotlist', () => {
  it('adds on first toggle (returns true), removes on second (returns false)', () => {
    const p = pass();
    expect(isInShotlist(p)).toBe(false);
    expect(toggleShotlist(p)).toBe(true);
    expect(isInShotlist(p)).toBe(true);
    expect(toggleShotlist(p)).toBe(false);
    expect(isInShotlist(p)).toBe(false);
  });

  it('stores the fields the .ics builder needs', () => {
    toggleShotlist(pass({ target_id: 'kyoto', target_name: 'Kyoto', angle_off_nadir_deg: 40, iss_relative_bearing_deg: 270 }));
    const list = getShotlist();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      target_id: 'kyoto',
      target_name: 'Kyoto',
      angle_off_nadir_deg: 40,
      iss_relative_bearing_deg: 270,
    });
  });

  it('treats different passes of the same target as distinct', () => {
    toggleShotlist(pass({ closest_approach: '2026-06-07T12:30:00.000Z' }));
    toggleShotlist(pass({ closest_approach: '2026-06-07T14:05:00.000Z' }));
    expect(getShotlist()).toHaveLength(2);
  });

  it('persists across reads (survives a reload)', () => {
    toggleShotlist(pass());
    // A fresh getShotlist() reads from localStorage — simulates a new page load.
    expect(getShotlist()).toHaveLength(1);
  });
});

describe('clearShotlist', () => {
  it('empties the list', () => {
    toggleShotlist(pass({ target_id: 'a' }));
    toggleShotlist(pass({ target_id: 'b' }));
    clearShotlist();
    expect(getShotlist()).toHaveLength(0);
  });
});

describe('pruneExpired', () => {
  it('drops passes whose closest approach is past and persists the result', () => {
    toggleShotlist(pass({ target_id: 'past', closest_approach: new Date(NOW - 60_000).toISOString() }));
    toggleShotlist(pass({ target_id: 'future', closest_approach: new Date(NOW + 60_000).toISOString() }));
    const kept = pruneExpired(NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.target_id).toBe('future');
    // Persisted: a subsequent read also shows only the future pass.
    expect(getShotlist()).toHaveLength(1);
  });

  it('shotlistCount reflects the pruned size', () => {
    toggleShotlist(pass({ target_id: 'past', closest_approach: new Date(NOW - 1).toISOString() }));
    toggleShotlist(pass({ target_id: 'future', closest_approach: new Date(NOW + 60_000).toISOString() }));
    expect(shotlistCount(NOW)).toBe(1);
  });
});

describe('defensive storage', () => {
  it('returns [] on a malformed store instead of throwing', () => {
    localStorage.setItem('opd_shotlist_v1', 'not json');
    expect(getShotlist()).toEqual([]);
  });
  it('filters out malformed records', () => {
    localStorage.setItem('opd_shotlist_v1', JSON.stringify([{ key: 'ok', target_id: 'a', target_name: 'A', closest_approach: 'x' }, { junk: true }, null]));
    expect(getShotlist()).toHaveLength(1);
  });
});

describe('nextSequence', () => {
  it('is a monotonic, non-decreasing epoch-seconds value (no persisted counter to fail)', () => {
    const a = nextSequence();
    const b = nextSequence();
    expect(a).toBeGreaterThan(1_700_000_000); // epoch seconds (2023+)
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
