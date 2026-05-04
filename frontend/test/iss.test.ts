import { beforeEach, describe, expect, it } from 'vitest';

import { liveIssNow, liveIssPosition, wrapLon } from '../src/iss';
import { _resetSatrecCacheForTests } from '../src/iss-sgp4';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };
const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

describe('wrapLon', () => {
  it('passes through in-range', () => {
    expect(wrapLon(0)).toBe(0);
    expect(wrapLon(180)).toBe(180);
    expect(wrapLon(-180)).toBe(-180);
  });
  it('wraps positive past 180', () => {
    expect(wrapLon(200)).toBe(-160);
  });
  it('wraps negative past -180', () => {
    expect(wrapLon(-200)).toBe(160);
  });
  it('handles unwrapped multi-cycle', () => {
    expect(wrapLon(360)).toBe(0);
  });
});

describe('liveIssPosition', () => {
  const track: Track = {
    iss_polynomial: {
      start: '2024-10-17T12:00:00Z',
      duration_seconds: 1800,
      // simple linear-in-time polynomial: lat(t) = 0.01t (deg/sec), lon(t) = 0.04t
      // coeffs are highest-degree-first: [a5, a4, a3, a2, a1, a0]
      lat_coeffs: [0, 0, 0, 0, 0.01, 0],
      lon_coeffs: [0, 0, 0, 0, 0.04, 0],
      polynomial_order: 5,
    },
    tle_epoch: '2024-10-17T00:00:00Z',
    tle_age_hours: 12,
    tle_freshness_factor: 1,
  };

  it('returns null before start', () => {
    expect(liveIssPosition(track, Date.parse('2024-10-17T11:59:59Z'))).toBeNull();
  });

  it('returns null after window end', () => {
    expect(liveIssPosition(track, Date.parse('2024-10-17T12:30:01Z'))).toBeNull();
  });

  it('evaluates at t=0', () => {
    const p = liveIssPosition(track, Date.parse('2024-10-17T12:00:00Z'));
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(0, 9);
    expect(p!.lon).toBeCloseTo(0, 9);
  });

  it('evaluates at t=10s', () => {
    const p = liveIssPosition(track, Date.parse('2024-10-17T12:00:10Z'));
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(0.1, 6);
    expect(p!.lon).toBeCloseTo(0.4, 6);
  });

  it('wraps longitude when polynomial passes 180', () => {
    const wrapTrack: Track = {
      ...track,
      iss_polynomial: {
        ...track.iss_polynomial,
        // lon(t) = 200 (constant), should wrap to -160
        lon_coeffs: [0, 0, 0, 0, 0, 200],
      },
    };
    const p = liveIssPosition(wrapTrack, Date.parse('2024-10-17T12:00:05Z'));
    expect(p).not.toBeNull();
    expect(p!.lon).toBe(-160);
  });

  it('returns null on invalid start string', () => {
    const broken: Track = {
      ...track,
      iss_polynomial: { ...track.iss_polynomial, start: 'not-a-date' },
    };
    expect(liveIssPosition(broken, Date.now())).toBeNull();
  });
});

describe('liveIssNow (combined polynomial + SGP4 path)', () => {
  beforeEach(() => _resetSatrecCacheForTests());

  const startMs = Date.parse(fixture.start);
  const trackWithTle: Track = {
    iss_polynomial: fixture.iss_polynomial,
    tle: fixture.tle,
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 17,
    tle_freshness_factor: 1,
  };

  it('returns the polynomial result inside the window (cheap path)', () => {
    // 1 hour into the 2-hour window — polynomial should answer.
    const p = liveIssNow(trackWithTle, startMs + 3600_000);
    expect(p).not.toBeNull();
    // Confirm it's the polynomial path: matches liveIssPosition exactly.
    const direct = liveIssPosition(trackWithTle, startMs + 3600_000);
    expect(p).toEqual(direct);
  });

  it('falls through to SGP4 past the polynomial window', () => {
    // 30 min PAST the window end. Polynomial returns null; SGP4 keeps going.
    const pastWindow = startMs + (fixture.iss_polynomial.duration_seconds + 1800) * 1000;
    expect(liveIssPosition(trackWithTle, pastWindow)).toBeNull();
    const p = liveIssNow(trackWithTle, pastWindow);
    expect(p).not.toBeNull();
    expect(Math.abs(p!.lat)).toBeLessThan(53);
  });

  it('returns null past the window when track has no TLE (V1 manifests)', () => {
    const noTle: Track = { ...trackWithTle, tle: undefined };
    const pastWindow = startMs + (fixture.iss_polynomial.duration_seconds + 60) * 1000;
    expect(liveIssNow(noTle, pastWindow)).toBeNull();
  });
});
