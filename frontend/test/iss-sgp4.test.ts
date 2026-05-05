import { beforeEach, describe, expect, it } from 'vitest';

import { _resetSatrecCacheForTests, liveIssPositionSGP4, parseTLE } from '../src/iss-sgp4';
import { liveIssPosition } from '../src/iss';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

interface Fixture {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
  sgp4_truth: { t_sec: number; lat: number; lon: number }[];
}
const fixture = fixtureRaw as Fixture;

const startMs = Date.parse(fixture.start);

function buildTrack(overrides: Partial<Track> = {}): Track {
  return {
    iss_polynomial: fixture.iss_polynomial,
    tle: fixture.tle,
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 17,
    tle_freshness_factor: 1,
    ...overrides,
  };
}

beforeEach(() => _resetSatrecCacheForTests());

describe('parseTLE', () => {
  it('returns a satrec for a valid TLE', () => {
    const satrec = parseTLE(fixture.tle);
    expect(satrec).not.toBeNull();
    expect(satrec!.error).toBe(0);
  });

  it('returns null for undefined TLE (older manifests)', () => {
    expect(parseTLE(undefined)).toBeNull();
  });

  it('returns null for a malformed TLE without throwing', () => {
    const bad = { line1: 'not a tle', line2: 'also not' };
    expect(parseTLE(bad)).toBeNull();
  });

  it('caches the satrec when called twice with the same TLE', () => {
    const a = parseTLE(fixture.tle);
    const b = parseTLE(fixture.tle);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('rebuilds the satrec when the TLE changes', () => {
    const a = parseTLE(fixture.tle);
    const otherTle = {
      line1: '1 25544U 98067A   24291.50000000  .00031560  00000-0  56270-3 0  9999',
      line2: fixture.tle.line2,
    };
    const b = parseTLE(otherTle);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe('liveIssPositionSGP4', () => {
  it('returns null when the track has no TLE', () => {
    const track = buildTrack({ tle: undefined });
    expect(liveIssPositionSGP4(track, startMs)).toBeNull();
  });

  it('returns lat/lon inside the ISS envelope (|lat| < 53)', () => {
    const track = buildTrack();
    const p = liveIssPositionSGP4(track, startMs + 60_000);
    expect(p).not.toBeNull();
    expect(Math.abs(p!.lat)).toBeLessThan(53);
    expect(p!.lon).toBeGreaterThanOrEqual(-180);
    expect(p!.lon).toBeLessThanOrEqual(180);
  });

  it('matches the Python SGP4 ground truth within 0.01° at every fixture point', () => {
    const track = buildTrack();
    for (const truth of fixture.sgp4_truth) {
      const p = liveIssPositionSGP4(track, startMs + truth.t_sec * 1000);
      expect(p, `t=${truth.t_sec}s`).not.toBeNull();
      expect(p!.lat, `lat at t=${truth.t_sec}s`).toBeCloseTo(truth.lat, 2);
      // Longitude wraps near antimeridian; compare the wrapped delta, not raw values.
      const dLon = ((p!.lon - truth.lon + 540) % 360) - 180;
      expect(Math.abs(dLon), `lon at t=${truth.t_sec}s`).toBeLessThan(0.01);
    }
  });

  it('agrees with the polynomial within ~2° inside the polynomial window', () => {
    // The order-11 polynomial fit over 120 min has up to ~1.1° lat error vs
    // SGP4 truth (Runge wobble near the window edges, see orbit.py:_POLYNOMIAL_ORDER_CAP).
    // The 2° bound here documents real polynomial accuracy, not a target. SGP4
    // is the MORE accurate path even inside the window — the polynomial drives
    // the live dot only because it's cheaper to evaluate every second. Tighten
    // this bound only if the polynomial fit is reworked (e.g. two shorter fits).
    const track = buildTrack();
    for (let i = 1; i <= 10; i++) {
      const tSec = (i / 10) * track.iss_polynomial.duration_seconds * 0.99;
      const tMs = startMs + tSec * 1000;
      const sgp4 = liveIssPositionSGP4(track, tMs);
      const poly = liveIssPosition(track, tMs);
      expect(sgp4, `sgp4 at t=${tSec}s`).not.toBeNull();
      expect(poly, `poly at t=${tSec}s`).not.toBeNull();
      expect(Math.abs(sgp4!.lat - poly!.lat), `lat agreement at t=${tSec}s`).toBeLessThan(2.0);
      const dLon = ((sgp4!.lon - poly!.lon + 540) % 360) - 180;
      expect(Math.abs(dLon), `lon agreement at t=${tSec}s`).toBeLessThan(2.0);
    }
  });

  it('continuity at the polynomial boundary: SGP4 stays smooth across t=120min', () => {
    const track = buildTrack();
    const windowEndSec = track.iss_polynomial.duration_seconds;
    const before = liveIssPositionSGP4(track, startMs + (windowEndSec - 1) * 1000);
    const after = liveIssPositionSGP4(track, startMs + (windowEndSec + 1) * 1000);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // ISS ground speed ~7.66 km/s ≈ 0.069°/s in latitude; over 2s, ~0.14° max
    expect(Math.abs(after!.lat - before!.lat)).toBeLessThan(0.2);
    const dLon = ((after!.lon - before!.lon + 540) % 360) - 180;
    expect(Math.abs(dLon)).toBeLessThan(0.2);
  });

  it('still returns a position past the polynomial window (the whole point of SGP4)', () => {
    const track = buildTrack();
    const past = liveIssPositionSGP4(
      track,
      startMs + (track.iss_polynomial.duration_seconds + 3600) * 1000,
    );
    expect(past).not.toBeNull();
    expect(Math.abs(past!.lat)).toBeLessThan(53);
  });
});
