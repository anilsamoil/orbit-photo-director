/**
 * Tests for the ISS-up bearing toggle (V4-P2 explainer follow-up).
 * Chris's mental model in WORF: "I'm looking down, this is what's coming
 * next." Map rotates so direction-of-travel is up.
 *
 * Coverage:
 * - greatCircleBearingDeg correctness on cardinal directions + a known
 *   non-trivial pair so refactors don't silently break the formula.
 * - Bearing range invariants (0..360, no NaN, handles antipodes).
 * - Persistence: localStorage round-trip on toggle (via integration tests
 *   in main-integration.test if needed; here we keep the unit-level math).
 */
import { describe, expect, it } from 'vitest';

import { greatCircleBearingDeg } from '../src/map';

describe('greatCircleBearingDeg', () => {
  it('due north → 0°', () => {
    // From equator at 0°E heading toward (10°N, 0°E)
    expect(greatCircleBearingDeg(0, 0, 10, 0)).toBeCloseTo(0, 1);
  });

  it('due south → 180°', () => {
    expect(greatCircleBearingDeg(10, 0, 0, 0)).toBeCloseTo(180, 1);
  });

  it('due east at the equator → 90°', () => {
    // Along the equator, east is 90° (true east, no convergence at equator)
    expect(greatCircleBearingDeg(0, 0, 0, 10)).toBeCloseTo(90, 1);
  });

  it('due west at the equator → 270°', () => {
    expect(greatCircleBearingDeg(0, 0, 0, -10)).toBeCloseTo(270, 1);
  });

  it('northeast diagonal at the equator → ~45°', () => {
    // Small displacement so spherical effects are minimal.
    const b = greatCircleBearingDeg(0, 0, 1, 1);
    expect(b).toBeGreaterThan(44);
    expect(b).toBeLessThan(46);
  });

  it('returns a value in [0, 360) for all inputs', () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 0, 10, 0],
      [0, 0, -10, 0],
      [0, 0, 0, 179],   // near antimeridian
      [0, 179, 0, -179],  // crossing antimeridian
      [89, 0, 89, 90],   // near pole
      [-89, 0, -89, 90],
      [51.6, 254, 51.6, 255],  // realistic ISS sample
    ];
    for (const [a, b, c, d] of cases) {
      const result = greatCircleBearingDeg(a, b, c, d);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(360);
      expect(Number.isFinite(result)).toBe(true);
    }
  });

  it('two consecutive ISS positions sample yields a sensible heading', () => {
    // ISS at ~51.6° inclination, traveling west-to-east across the equator.
    // From (50.5°N, 100°E) to (50.6°N, 100.5°E) over 30s ≈ heading roughly NE.
    const heading = greatCircleBearingDeg(50.5, 100, 50.6, 100.5);
    // Should be in the NE quadrant (0..90 or 270..360 if rounding wraps).
    expect(heading).toBeGreaterThan(60);
    expect(heading).toBeLessThan(80);
  });
});
