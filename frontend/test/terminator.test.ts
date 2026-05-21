import { describe, expect, it } from 'vitest';
import {
  classifyIssIllumination,
  equationOfTimeMinutes,
  subsolarFeature,
  subsolarPoint,
  terminatorFeatures,
  terminatorLonAtLat,
} from '../src/terminator';

describe('equationOfTimeMinutes', () => {
  // Reference data from NOAA Solar Calculator (rounded).
  // Spencer's two-term approximation matches within ~1 minute of the
  // full ephemeris. We assert ±2 min as a sanity bound; the existing
  // Python implementation in generator/cloud.py uses the same formula.
  it('zero-crosses near April 16 (DOY ~106) — the first EoT zero of the year', () => {
    expect(Math.abs(equationOfTimeMinutes(106))).toBeLessThan(2);
  });

  it('is most negative near mid-February (~DOY 45)', () => {
    // Real EoT min is ~-14 min around Feb 12; Spencer's gives close.
    expect(equationOfTimeMinutes(45)).toBeLessThan(-5);
  });

  it('is most positive near early November (~DOY 305)', () => {
    // Real EoT max is ~+16 min around Nov 3.
    expect(equationOfTimeMinutes(305)).toBeGreaterThan(10);
  });
});

describe('subsolarPoint', () => {
  it('puts the sun at the equator near vernal equinox (March ~20)', () => {
    const when = new Date('2024-03-20T12:00:00Z');
    const s = subsolarPoint(when);
    expect(Math.abs(s.lat)).toBeLessThan(2);  // ≤ ±2°
  });

  it('puts the sun near +23.4° N at summer solstice (June ~21)', () => {
    const when = new Date('2024-06-21T12:00:00Z');
    const s = subsolarPoint(when);
    expect(s.lat).toBeGreaterThan(22);
    expect(s.lat).toBeLessThan(24);
  });

  it('puts the sun near -23.4° S at winter solstice (Dec ~21)', () => {
    const when = new Date('2024-12-21T12:00:00Z');
    const s = subsolarPoint(when);
    expect(s.lat).toBeLessThan(-22);
    expect(s.lat).toBeGreaterThan(-24);
  });

  it('subsolar longitude is near 0° at 12:00 UTC (apparent noon at prime meridian)', () => {
    // EoT correction shifts by up to ~4° — solstice/equinox dates close to zero EoT
    const when = new Date('2024-04-15T12:00:00Z');  // near EoT zero
    const s = subsolarPoint(when);
    expect(Math.abs(s.lon)).toBeLessThan(2);
  });

  it('subsolar longitude is near -90° at 18:00 UTC (apparent noon over 90°W)', () => {
    const when = new Date('2024-04-15T18:00:00Z');
    const s = subsolarPoint(when);
    // -15°/hour from noon → -90° at 18:00
    expect(s.lon).toBeGreaterThan(-95);
    expect(s.lon).toBeLessThan(-85);
  });

  it('subsolar longitude wraps into [-180, 180]', () => {
    // 00:00 UTC → -15 × (-12) = +180° before wrap; should wrap to ±180 range
    const when = new Date('2024-04-15T00:00:00Z');
    const s = subsolarPoint(when);
    expect(s.lon).toBeGreaterThanOrEqual(-180);
    expect(s.lon).toBeLessThanOrEqual(180);
  });
});

describe('terminatorLonAtLat', () => {
  it('returns null for polar-night latitudes when sun is in opposite hemisphere', () => {
    // Sun at +23.4° (summer solstice), polar-night zone is south of 90 - 23.4 = 66.6°S
    expect(terminatorLonAtLat(-70, 23.4, 0)).toBeNull();
    expect(terminatorLonAtLat(-89, 23.4, 0)).toBeNull();
  });

  it('returns null for polar-day latitudes when sun is in same hemisphere', () => {
    expect(terminatorLonAtLat(70, 23.4, 0)).toBeNull();
    expect(terminatorLonAtLat(89, 23.4, 0)).toBeNull();
  });

  it('returns two longitudes at the equator with sun at equator', () => {
    const result = terminatorLonAtLat(0, 0, 0);
    expect(result).not.toBeNull();
    if (result) {
      // At equinox at noon, terminator crosses equator at ±90° from subsolar
      const [a, b] = result;
      expect(Math.abs(Math.abs(a) - 90)).toBeLessThan(1);
      expect(Math.abs(Math.abs(b) - 90)).toBeLessThan(1);
    }
  });

  it('returns terminator with subsolar offset applied', () => {
    const result = terminatorLonAtLat(0, 0, 60);  // sun at 60°E
    expect(result).not.toBeNull();
    if (result) {
      // Terminator should cross equator at 60-90 = -30° and 60+90 = 150°
      const [a, b] = result;
      expect(a).toBeCloseTo(-30, 0);
      expect(b).toBeCloseTo(150, 0);
    }
  });
});

describe('terminatorFeatures', () => {
  it('produces non-empty LineString features for a typical date', () => {
    const features = terminatorFeatures(new Date('2024-10-17T12:00:00Z'));
    expect(features.length).toBeGreaterThan(0);
    for (const f of features) {
      expect(f.geometry.type).toBe('LineString');
    }
  });

  it('every feature has at least 2 vertices (no degenerate lines)', () => {
    const features = terminatorFeatures(new Date('2024-10-17T12:00:00Z'));
    for (const f of features) {
      const coords = (f.geometry as GeoJSON.LineString).coordinates;
      expect(coords.length).toBeGreaterThan(1);
    }
  });

  it('produces world-copy duplicates (3 lon offsets per segment)', () => {
    // Expect each base segment + lon+360 + lon-360 = features divisible by 3
    const features = terminatorFeatures(new Date('2024-10-17T12:00:00Z'));
    expect(features.length % 3).toBe(0);
  });
});

describe('subsolarFeature', () => {
  it('returns a Point geometry with valid lat/lon range', () => {
    const f = subsolarFeature(new Date('2024-10-17T12:00:00Z'));
    expect(f.geometry.type).toBe('Point');
    const coords = (f.geometry as GeoJSON.Point).coordinates;
    expect(coords[0]).toBeGreaterThanOrEqual(-180);
    expect(coords[0]).toBeLessThanOrEqual(180);
    expect(coords[1]).toBeGreaterThanOrEqual(-25);  // declination bounds
    expect(coords[1]).toBeLessThanOrEqual(25);
  });
});

describe('classifyIssIllumination (v1.5.3.0 — Chris ask)', () => {
  // Vernal equinox at 12:00 UTC: subsolar point is approximately (0°, 0°).
  // EoT correction near equinox is small (<1 min) and declination near
  // equinox is near 0°. Picking this time gives predictable classifications.
  const equinoxNoon = new Date('2026-03-20T12:00:00Z');

  it('returns iss-day at the subsolar point itself (θ=0)', () => {
    expect(classifyIssIllumination(equinoxNoon, 0, 0)).toBe('iss-day');
  });

  it('returns iss-day within ~89° of subsolar (ground sunlit)', () => {
    // 80° west of subsolar, on equator → θ=80°, ground sunlit.
    expect(classifyIssIllumination(equinoxNoon, 0, -80)).toBe('iss-day');
  });

  it('returns iss-twilight in the 90-110° band (ground dark, ISS sunlit)', () => {
    // ~95° from subsolar — well past terminator but ISS still sees sun.
    expect(classifyIssIllumination(equinoxNoon, 0, 95)).toBe('iss-twilight');
    expect(classifyIssIllumination(equinoxNoon, 0, -95)).toBe('iss-twilight');
  });

  it('returns iss-eclipse antipodal to subsolar', () => {
    expect(classifyIssIllumination(equinoxNoon, 0, 180)).toBe('iss-eclipse');
  });

  it('returns iss-eclipse past the ~110° threshold', () => {
    // 115° from subsolar — past ISS horizon, in Earth's shadow.
    expect(classifyIssIllumination(equinoxNoon, 0, 115)).toBe('iss-eclipse');
  });

  it('twilight band width is ~20° (90° to ~110°)', () => {
    // Sweep from 89° to 111° east of subsolar and count state changes.
    const states = new Set<string>();
    for (let lon = 88; lon <= 112; lon += 1) {
      states.add(classifyIssIllumination(equinoxNoon, 0, lon));
    }
    expect(states.has('iss-day')).toBe(true);
    expect(states.has('iss-twilight')).toBe(true);
    expect(states.has('iss-eclipse')).toBe(true);
  });

  it('classifies the exact 90° terminator as iss-day (A7 boundary policy)', () => {
    // Per A7 from /plan-eng-review 2026-05-21, use `<=` at the day
    // boundary so consecutive samples crossing don't flicker.
    expect(classifyIssIllumination(equinoxNoon, 0, 90)).toBe('iss-day');
  });

  it('high-latitude sub-points classify by sun-angle, not lat directly', () => {
    // Near the north pole (lat=80°) at equinox noon: sun is at the
    // equator, so θ ≈ 80°. That's still day-side. (Polar day in summer
    // would be similar; polar night in winter would be eclipse.)
    expect(classifyIssIllumination(equinoxNoon, 80, 0)).toBe('iss-day');
  });
});
