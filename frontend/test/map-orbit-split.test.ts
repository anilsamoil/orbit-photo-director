import { describe, expect, it } from 'vitest';
import { splitTrackByOrbit } from '../src/map';

describe('splitTrackByOrbit (v1.5.0.0 multi-orbit display)', () => {
  it('returns empty when given no points', () => {
    expect(splitTrackByOrbit([])).toEqual([]);
  });

  it('buckets samples by orbit index using the period', () => {
    // v1.5.3.0: return type widened to keep `[t, lat, lon]` triples so
    // downstream illumination-state splitting has access to sample time.
    const period = 5568; // ISS_ORBIT_PERIOD_SECONDS
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [1000, 10, 20],
      [period - 1, 30, 40],   // still orbit 0
      [period, -10, 50],      // orbit 1 starts here
      [period * 2 - 1, 40, 60], // orbit 1 last
      [period * 2, -20, 70],  // orbit 2 starts here
    ];
    const buckets = splitTrackByOrbit(pts);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toHaveLength(3);
    expect(buckets[1]).toHaveLength(2);
    expect(buckets[2]).toHaveLength(1);
    expect(buckets[0]?.[0]).toEqual([0, 0, 0]);
    expect(buckets[1]?.[0]).toEqual([period, -10, 50]);
    expect(buckets[2]?.[0]).toEqual([period * 2, -20, 70]);
  });

  it('uses a custom period when provided', () => {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [50, 10, 20],
      [100, 20, 30],
      [150, 30, 40],
    ];
    const buckets = splitTrackByOrbit(pts, 100);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toHaveLength(2); // t=0, 50
    expect(buckets[1]).toHaveLength(2); // t=100, 150
  });

  it('handles samples that span exactly one orbit (no overflow)', () => {
    const period = 5568;
    const pts: [number, number, number][] = [];
    for (let t = 0; t < period; t += 30) pts.push([t, 0, 0]);
    const buckets = splitTrackByOrbit(pts);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.length).toBe(Math.ceil(period / 30));
  });

  it('handles 4-orbit synthetic input from a realistic track_points-length array', () => {
    // Simulates the generator producing 372 min @ 30s step = 745 samples
    // across roughly 4 orbits (372 / 92.8 ≈ 4.0).
    const period = 5568;
    const totalSec = 372 * 60;
    const stepSec = 30;
    const pts: [number, number, number][] = [];
    for (let t = 0; t <= totalSec; t += stepSec) {
      pts.push([t, Math.sin(t / 1000) * 51.6, ((t / 60) % 360) - 180]);
    }
    const buckets = splitTrackByOrbit(pts);
    // Expect 4 or 5 buckets (depending on whether totalSec lands inside
    // or past the 4th orbit boundary). Non-trailing buckets are within
    // ±1 of period/step samples; the asymmetry comes from sample
    // positions (multiples of 30s) drifting relative to orbit boundaries
    // (multiples of 5568s) — buckets[0] = 186, buckets[2] = 185, etc.
    const perOrbitApprox = period / stepSec; // 185.6
    expect(buckets.length).toBeGreaterThanOrEqual(4);
    for (let k = 0; k < 4; k++) {
      const len = buckets[k]?.length ?? 0;
      expect(Math.abs(len - perOrbitApprox)).toBeLessThan(1);
    }
  });

  it('fills empty buckets between sparse samples (index stability)', () => {
    // If a track has a gap (rare but possible with NaN-skipped samples),
    // the orbit index between sparse samples should still produce a
    // length-stable array so callers can `.map(buckets, k => ...)` without
    // skipping orbit indices.
    const period = 5568;
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [period * 2 + 100, 10, 20], // jumps from orbit 0 straight to orbit 2
    ];
    const buckets = splitTrackByOrbit(pts);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]?.length).toBe(1);
    expect(buckets[1]?.length).toBe(0); // empty bucket kept for index stability
    expect(buckets[2]?.length).toBe(1);
  });
});

import { splitByIllumination } from '../src/map';

describe('splitByIllumination (v1.5.3.0 — ISS illumination-aware track)', () => {
  // We use a known epoch where the subsolar point is near (0°, 0°) for
  // predictable classification. 2026-03-20T12:00:00Z is near the vernal
  // equinox at noon UTC, so subsolar is approximately (0°, 0°). Points
  // near the equator and prime meridian are 'iss-day'; antipodal points
  // are 'iss-eclipse'; the band ~90-110° away from subsolar is twilight.
  const equinoxStart = Date.parse('2026-03-20T12:00:00Z');

  it('returns empty for no samples', () => {
    expect(splitByIllumination([], equinoxStart)).toEqual([]);
  });

  it('classifies sub-point at subsolar as iss-day', () => {
    const segs = splitByIllumination([[0, 0, 0]], equinoxStart);
    expect(segs).toHaveLength(1);
    expect(segs[0]?.illumination).toBe('iss-day');
  });

  it('classifies antipodal sub-point as iss-eclipse', () => {
    // Subsolar near (0°, 0°) at vernal equinox noon UTC. Antipode = (0°, 180°).
    const segs = splitByIllumination([[0, 0, 180]], equinoxStart);
    expect(segs).toHaveLength(1);
    expect(segs[0]?.illumination).toBe('iss-eclipse');
  });

  it('produces a twilight segment in the ~90-110° band from subsolar', () => {
    // ~100° angular distance from (0°, 0°) → on the equator, lon ~= 100°.
    // Should classify as twilight (ISS sunlit, ground dark).
    const segs = splitByIllumination([[0, 0, 100]], equinoxStart);
    expect(segs).toHaveLength(1);
    expect(segs[0]?.illumination).toBe('iss-twilight');
  });

  it('splits a multi-state run into contiguous segments', () => {
    // A run that walks from day → twilight → eclipse.
    const samples: [number, number, number][] = [
      [0, 0, 0],    // day
      [10, 0, 30],  // day
      [20, 0, 95],  // twilight
      [30, 0, 100], // twilight
      [40, 0, 175], // eclipse
    ];
    const segs = splitByIllumination(samples, equinoxStart);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    // First segment is day, last is eclipse, twilight is in between.
    expect(segs[0]?.illumination).toBe('iss-day');
    expect(segs[segs.length - 1]?.illumination).toBe('iss-eclipse');
    const states = segs.map((s) => s.illumination);
    expect(states).toContain('iss-twilight');
  });

  it('boundary overlap: consecutive segments share a point for visual continuity', () => {
    // When the line color changes between segments, the rendered features
    // should connect at the transition (no visible gap). splitByIllumination
    // implements this by appending the boundary sample to BOTH segments.
    const samples: [number, number, number][] = [
      [0, 0, 80],   // day
      [10, 0, 95],  // twilight (boundary crossing here)
    ];
    const segs = splitByIllumination(samples, equinoxStart);
    expect(segs).toHaveLength(2);
    // The day segment ends with the twilight sample's coords (overlap)
    // The twilight segment starts with itself.
    const daySeg = segs[0];
    const twilightSeg = segs[1];
    expect(daySeg?.illumination).toBe('iss-day');
    expect(twilightSeg?.illumination).toBe('iss-twilight');
    // Day segment should end with the boundary coords.
    expect(daySeg?.coords[daySeg.coords.length - 1]).toEqual([0, 95]);
    // Twilight segment starts at boundary.
    expect(twilightSeg?.coords[0]).toEqual([0, 95]);
  });
});
