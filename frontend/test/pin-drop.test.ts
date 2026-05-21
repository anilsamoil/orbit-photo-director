import { describe, expect, it } from 'vitest';
import { _resetSatrecCacheForTests } from '../src/iss-sgp4';
import {
  DEFAULT_HORIZON_HOURS,
  ISS_HORIZON_KM,
  findUpcomingPasses,
  greatCircleKm,
  roundForZoom,
} from '../src/pin-drop';
import type { Track } from '../src/types';

// ISS TLE fixture (matches existing tests in iss.test.ts / iss-sgp4.test.ts).
// Epoch: 2024-10-17T00:00:00Z-ish. ISS at i=51.6°, mean motion 15.5.
const FIXTURE_TLE = {
  line1: '1 25544U 98067A   24291.00000000  .00018000  00000-0  32500-3 0  9999',
  line2: '2 25544  51.6400  60.0000 0006000  90.0000 270.0000 15.50000000400000',
};
const FIXTURE_EPOCH_MS = Date.UTC(2024, 9, 17, 0, 0, 0);

function fixtureTrack(): Track {
  return {
    iss_polynomial: {
      start: new Date(FIXTURE_EPOCH_MS).toISOString(),
      duration_seconds: 7200,
      lat_coeffs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      lon_coeffs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      polynomial_order: 11,
    },
    tle: FIXTURE_TLE,
    tle_epoch: '2024-10-17T00:00:00.000Z',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
  };
}

describe('greatCircleKm', () => {
  it('returns 0 for identical points', () => {
    expect(greatCircleKm(30, -90, 30, -90)).toBe(0);
  });

  it('returns ~half-circumference for antipodal points', () => {
    // (0, 0) to (0, 180) — antipodal — should be ~π × 6378 = 20037 km
    expect(greatCircleKm(0, 0, 0, 180)).toBeCloseTo(20037, -1);
  });

  it('antimeridian-aware: (0, 179) to (0, -179) is 222 km, not 39805 km', () => {
    // 2° great-circle at equator ≈ 222 km. Without haversine wrap math
    // this would be 358° × 111km = 39805 km.
    expect(greatCircleKm(0, 179, 0, -179)).toBeCloseTo(222, -1);
  });

  it('1 degree at equator is ~111 km', () => {
    expect(greatCircleKm(0, 0, 0, 1)).toBeCloseTo(111, -1);
  });

  it('1 degree latitude is ~111 km regardless of longitude', () => {
    expect(greatCircleKm(50, -120, 51, -120)).toBeCloseTo(111, -1);
  });
});

describe('roundForZoom (A3 — pin precision should reflect map zoom)', () => {
  it('rounds to whole degrees at wide zoom (z<6)', () => {
    expect(roundForZoom(30.567, -90.234, 2)).toEqual({
      lat: 31, lon: -90, precision: 0,
    });
  });

  it('rounds to tenths at medium zoom (z=6-9)', () => {
    expect(roundForZoom(30.567, -90.234, 7)).toEqual({
      lat: 30.6, lon: -90.2, precision: 1,
    });
  });

  it('rounds to hundredths at close zoom (z>=10)', () => {
    expect(roundForZoom(30.567, -90.234, 12)).toEqual({
      lat: 30.57, lon: -90.23, precision: 2,
    });
  });
});

describe('findUpcomingPasses (v1.5.6.0 — Pettit #10)', () => {
  beforeEach(() => _resetSatrecCacheForTests());

  it('returns empty list for non-finite pin coords', () => {
    const track = fixtureTrack();
    expect(findUpcomingPasses(track, NaN, -90, FIXTURE_EPOCH_MS)).toEqual([]);
    expect(findUpcomingPasses(track, 30, NaN, FIXTURE_EPOCH_MS)).toEqual([]);
  });

  it('returns 0-5 passes within the 36h horizon', () => {
    // Pick a pin at ISS-typical latitude (40°N — passes regularly visible
    // because ISS orbit reaches 51.6°). Use a longitude where ISS sweeps
    // overhead multiple times in 36h.
    const passes = findUpcomingPasses(fixtureTrack(), 40, -90, FIXTURE_EPOCH_MS);
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.length).toBeLessThanOrEqual(5);
  });

  it('caps at 5 passes when many minima are within horizon (T6)', () => {
    // Equatorial point sees ISS overhead multiple times per day.
    const passes = findUpcomingPasses(fixtureTrack(), 0, 0, FIXTURE_EPOCH_MS);
    expect(passes.length).toBeLessThanOrEqual(5);
  });

  it('returns passes sorted by closest-approach time ascending (T5)', () => {
    const passes = findUpcomingPasses(fixtureTrack(), 35, -100, FIXTURE_EPOCH_MS);
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i]!.closestApproachMs).toBeGreaterThan(
        passes[i - 1]!.closestApproachMs,
      );
    }
  });

  it('all returned passes have nadir <= ISS_HORIZON_KM', () => {
    const passes = findUpcomingPasses(fixtureTrack(), 40, -90, FIXTURE_EPOCH_MS);
    for (const p of passes) {
      expect(p.nadirKm).toBeLessThanOrEqual(ISS_HORIZON_KM);
    }
  });

  it('returns 0 passes for a pin at exactly 89°S (ISS never visits the pole)', () => {
    // ISS orbital inclination is 51.6° — never gets within ~1500km of 89°S.
    const passes = findUpcomingPasses(fixtureTrack(), -89, 0, FIXTURE_EPOCH_MS);
    expect(passes.length).toBe(0);
  });

  it('antimeridian crossing: pin at (0°, 180°) finds passes (T4 — A2)', () => {
    // The detector should not be fooled when ISS lon wraps from +179 to -179
    // around the date line. Pin sits exactly on the antimeridian.
    const passes = findUpcomingPasses(fixtureTrack(), 0, 180, FIXTURE_EPOCH_MS);
    // Equator + antimeridian is well within ISS's orbit envelope — should
    // see at least one pass in 36h.
    expect(passes.length).toBeGreaterThan(0);
    // All passes within horizon.
    for (const p of passes) {
      expect(p.nadirKm).toBeLessThanOrEqual(ISS_HORIZON_KM);
    }
  });

  it('respects a shorter horizon (5 hours) and returns proportionally fewer passes', () => {
    const passes5h = findUpcomingPasses(fixtureTrack(), 40, -90, FIXTURE_EPOCH_MS, 5);
    const passes36h = findUpcomingPasses(fixtureTrack(), 40, -90, FIXTURE_EPOCH_MS, 36);
    // 5h covers ~3 orbits; 36h covers ~23 orbits. Expect fewer hits at 5h.
    expect(passes5h.length).toBeLessThanOrEqual(passes36h.length);
    // All 5h passes are within the 5h window from epoch.
    for (const p of passes5h) {
      expect(p.closestApproachMs).toBeLessThanOrEqual(FIXTURE_EPOCH_MS + 5 * 3600 * 1000);
    }
  });

  it('regime is always one of the three IssIllumination values', () => {
    const passes = findUpcomingPasses(fixtureTrack(), 35, -100, FIXTURE_EPOCH_MS);
    const validRegimes = new Set(['iss-day', 'iss-twilight', 'iss-eclipse']);
    for (const p of passes) {
      expect(validRegimes.has(p.regime)).toBe(true);
    }
  });

  it('uses default horizon when not specified', () => {
    expect(DEFAULT_HORIZON_HOURS).toBe(36);
  });

  it('returns empty when track has no TLE (graceful failure)', () => {
    const track = fixtureTrack();
    const noTle: Track = { ...track, tle: undefined };
    const passes = findUpcomingPasses(noTle, 40, -90, FIXTURE_EPOCH_MS);
    expect(passes).toEqual([]);
  });
});

// vitest auto-imports describe/it/expect; explicit beforeEach for clarity.
import { beforeEach } from 'vitest';
