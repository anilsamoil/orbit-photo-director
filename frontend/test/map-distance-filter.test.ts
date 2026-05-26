/** Slot 7 of design rev 2 — distance-threshold filter.
 *
 *  Verifies the pure `filterPassesByDistance` helper (used by map.ts
 *  refreshTargetsSource AND main.ts queue/upcoming builders). The
 *  end-to-end map render is validated via /qa; here we just lock down
 *  the filter contract:
 *    - passes within the threshold pass through
 *    - passes beyond the threshold are excluded
 *    - non-finite / missing distance falls back to "render" (defensive)
 *    - invalid thresholds (NaN, 0, negative) disable the filter
 */

import { describe, expect, it } from 'vitest';
import { filterPassesByDistance } from '../src/map';
import type { PassEntry } from '../src/types';

function makePass(distanceKm: number, name = 'Test'): PassEntry {
  return {
    target_id: `tgt-${name}`,
    target_name: name,
    target_regime: 'any',
    target_priority: 5,
    target_lat: 0,
    target_lon: 0,
    closest_approach: '2026-05-22T18:00:00Z',
    nadir_distance_km: distanceKm,
    pass_regime: 'night',
    obstruction_class: 'clear',
    p_unobstructed: 80,
    cloud_fraction: 20,
    cloud_source: 'test',
    score: 50,
    score_components: {
      p_unobstructed: 1,
      regime_fit: 1,
      nadir_proximity: 1,
      priority_weight: 1,
      tle_freshness: 1,
    },
    iss_at_closest: { lat: 0, lon: 0, alt_km: 408 },
  };
}

describe('filterPassesByDistance', () => {
  it('passes within the threshold are kept', () => {
    const passes = [makePass(100), makePass(800), makePass(1499)];
    const out = filterPassesByDistance(passes, 1500);
    expect(out).toHaveLength(3);
  });

  it('passes beyond the threshold are excluded', () => {
    const passes = [makePass(100), makePass(800), makePass(1800)];
    const out = filterPassesByDistance(passes, 1500);
    expect(out.map((p) => p.nadir_distance_km)).toEqual([100, 800]);
  });

  it('exactly-at-threshold passes are kept (inclusive cap)', () => {
    const passes = [makePass(1500)];
    const out = filterPassesByDistance(passes, 1500);
    expect(out).toHaveLength(1);
  });

  it('tighter threshold excludes more passes', () => {
    const passes = [makePass(100), makePass(500), makePass(900), makePass(1400)];
    const out = filterPassesByDistance(passes, 700);
    expect(out.map((p) => p.nadir_distance_km)).toEqual([100, 500]);
  });

  it('non-finite distance is treated as "keep" (defensive default)', () => {
    // Missing distance from an older manifest shouldn't silently drop
    // the pass — show it and let the missing-distance UI signal that
    // the data is incomplete.
    const p = makePass(NaN);
    const out = filterPassesByDistance([p], 1500);
    expect(out).toHaveLength(1);
  });

  it('disables the filter when threshold is non-positive or non-finite', () => {
    const passes = [makePass(100), makePass(2000)];
    expect(filterPassesByDistance(passes, 0)).toEqual(passes);
    expect(filterPassesByDistance(passes, -100)).toEqual(passes);
    expect(filterPassesByDistance(passes, NaN)).toEqual(passes);
  });

  it('returns an empty array when every pass exceeds the threshold', () => {
    const passes = [makePass(1800), makePass(1900), makePass(2000)];
    expect(filterPassesByDistance(passes, 1500)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const passes = [makePass(100), makePass(2000)];
    const snapshot = passes.slice();
    filterPassesByDistance(passes, 500);
    expect(passes).toEqual(snapshot);
  });
});
