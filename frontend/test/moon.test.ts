/**
 * Tests for frontend/src/moon.ts — lunar phase (true-elongation),
 * position, and the sky-state assessor (Unit 3).
 *
 * Phase anchors assert against the REAL June 2026 ephemeris instants, not
 * model-self-consistency — the multi-agent verification (2026-06-14)
 * caught that the original mean-synodic model erred ~8pp at the quarters
 * (exactly where the moonlit gate lives). The true-elongation model is
 * right at the quarters by construction; these tests prove it.
 * Position/GMST anchors are the values three independent agents recomputed.
 */
import { describe, expect, it } from 'vitest';

import {
  MOON_BRIGHT_ILLUM,
  assessMoon,
  gmstDeg,
  moonAltitudeDeg,
  moonIlluminatedFraction,
  moonIsWaning,
  moonPhaseGlyph,
  moonPhaseName,
  moonSubpoint,
  orbitalHorizonDipDeg,
} from '../src/moon';

const ms = (iso: string): number => Date.parse(iso);

describe('moonIlluminatedFraction (true sun-moon elongation)', () => {
  // Real 2026 phase instants (timeanddate/starwalk authoritative).
  it('≈0 at the real new moon (2026-06-15T02:54Z)', () => {
    expect(moonIlluminatedFraction(ms('2026-06-15T02:54:00Z'))).toBeLessThan(0.01);
  });

  it('≈0.5 at the real FIRST QUARTER — the bug the synodic model had (gave 0.42)', () => {
    expect(moonIlluminatedFraction(ms('2026-06-21T21:55:00Z'))).toBeCloseTo(0.5, 1);
    expect(moonIlluminatedFraction(ms('2026-06-21T21:55:00Z'))).toBeGreaterThan(0.47);
    expect(moonIlluminatedFraction(ms('2026-06-21T21:55:00Z'))).toBeLessThan(0.53);
  });

  it('≈0.5 at the real LAST QUARTER (2026-06-08T10:02Z)', () => {
    expect(moonIlluminatedFraction(ms('2026-06-08T10:02:00Z'))).toBeGreaterThan(0.47);
    expect(moonIlluminatedFraction(ms('2026-06-08T10:02:00Z'))).toBeLessThan(0.53);
  });

  it('≈1 at the real full moon (2026-06-29T23:57Z)', () => {
    expect(moonIlluminatedFraction(ms('2026-06-29T23:57:00Z'))).toBeGreaterThan(0.99);
  });

  it('stays in [0,1] across a synodic month', () => {
    const t0 = ms('2026-06-01T00:00:00Z');
    for (let d = 0; d < 30; d += 0.5) {
      const k = moonIlluminatedFraction(t0 + d * 86400_000);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
    }
  });
});

describe('moonIsWaning / moonPhaseName', () => {
  it('waxing through first quarter, waning through last quarter', () => {
    expect(moonIsWaning(ms('2026-06-21T21:55:00Z'))).toBe(false); // first qtr = waxing
    expect(moonIsWaning(ms('2026-06-08T10:02:00Z'))).toBe(true); // last qtr = waning
  });

  it('names the real phases correctly', () => {
    expect(moonPhaseName(ms('2026-06-15T02:54:00Z'))).toBe('new');
    expect(moonPhaseName(ms('2026-06-21T21:55:00Z'))).toBe('first-quarter');
    expect(moonPhaseName(ms('2026-06-29T23:57:00Z'))).toBe('full');
    expect(moonPhaseName(ms('2026-06-08T10:02:00Z'))).toBe('last-quarter');
  });

  it('maps every phase name to a distinct glyph', () => {
    const names = ['new', 'waxing-crescent', 'first-quarter', 'waxing-gibbous',
      'full', 'waning-gibbous', 'last-quarter', 'waning-crescent'] as const;
    const glyphs = names.map((n) => moonPhaseGlyph(n));
    expect(new Set(glyphs).size).toBe(8);
    expect(moonPhaseGlyph('full')).toBe('🌕');
    expect(moonPhaseGlyph('new')).toBe('🌑');
  });
});

describe('moon position (Meeus low-precision — values 3 agents recomputed)', () => {
  it('sub-point at 2026-06-14T00:00Z ≈ 26.38°N, 161.85°E', () => {
    const sp = moonSubpoint(ms('2026-06-14T00:00:00Z'));
    expect(sp.lat).toBeCloseTo(26.38, 1);
    expect(sp.lon).toBeCloseTo(161.85, 1);
  });

  it('sub-point at 2026-06-21T22:00Z ≈ −2.51°, −60.55°', () => {
    const sp = moonSubpoint(ms('2026-06-21T22:00:00Z'));
    expect(sp.lat).toBeCloseTo(-2.51, 1);
    expect(sp.lon).toBeCloseTo(-60.55, 1);
  });

  it('altitude at (40N,0E) on 2026-06-21T22:00Z ≈ 20.37°', () => {
    expect(moonAltitudeDeg(40, 0, ms('2026-06-21T22:00:00Z'))).toBeCloseTo(20.37, 0);
  });

  it('sub-point latitude stays within the lunar declination envelope', () => {
    const t0 = ms('2026-06-01T00:00:00Z');
    for (let d = 0; d < 30; d++) {
      const lat = moonSubpoint(t0 + d * 86400_000).lat;
      expect(Math.abs(lat)).toBeLessThan(28.6);
    }
  });

  it('GMST at J2000 noon = 280.4606°', () => {
    expect(gmstDeg((2451545.0 - 2440587.5) * 86400_000)).toBeCloseTo(280.4606, 3);
  });

  it('orbital horizon dip ≈ 20.3° at 420km, more at higher altitude', () => {
    expect(orbitalHorizonDipDeg(420)).toBeCloseTo(20.3, 0);
    expect(orbitalHorizonDipDeg(800)).toBeGreaterThan(orbitalHorizonDipDeg(420));
  });
});

describe('assessMoon (sky state)', () => {
  it('full Moon with observer AT its sub-point → moonlit (fixture the verifiers fixed)', () => {
    const full = ms('2026-06-29T23:57:00Z');
    const sp = moonSubpoint(full);
    const m = assessMoon(full, { lat: Math.round(sp.lat), lon: Math.round(sp.lon) });
    expect(m.skyState).toBe('moonlit');
    expect(m.illum).toBeGreaterThan(0.99);
    expect(m.glyph).toBe('🌕');
    expect(m.altitudeDeg).toBeGreaterThan(80);
  });

  it('full Moon but observer on the FAR side of Earth → dark', () => {
    const full = ms('2026-06-29T23:57:00Z');
    const sp = moonSubpoint(full);
    // antipode of the sub-point: Moon ~180° away, deep below the horizon.
    const m = assessMoon(full, { lat: -sp.lat, lon: sp.lon > 0 ? sp.lon - 180 : sp.lon + 180 });
    expect(m.skyState).toBe('dark');
  });

  it('bright Moon up but below 50% would not be moonlit; thin crescent up → up-faint', () => {
    // Near new (06-15), put the observer at the sub-point so the Moon is
    // overhead but barely lit → up-faint, never moonlit.
    const near = ms('2026-06-16T12:00:00Z'); // ~1.4 days past new, thin crescent
    const sp = moonSubpoint(near);
    const m = assessMoon(near, { lat: Math.round(sp.lat), lon: Math.round(sp.lon) });
    expect(m.altitudeDeg).toBeGreaterThan(60); // up
    expect(m.illum).toBeLessThan(MOON_BRIGHT_ILLUM);
    expect(m.skyState).toBe('up-faint');
  });

  it('null observer → dark, altitude unknown (never a false moonlit)', () => {
    const m = assessMoon(ms('2026-06-29T23:57:00Z'), null);
    expect(m.skyState).toBe('dark');
    expect(m.altitudeDeg).toBeNull();
    expect(m.illum).toBeGreaterThan(0.99); // phase still computed
  });

  it('the orbital-horizon gate lets the Moon count as up ~20° below the ground horizon', () => {
    // A Moon at ground-altitude between -20 and 0 is below the GROUND
    // horizon but above the station's orbital horizon → still "up".
    const full = ms('2026-06-29T23:57:00Z');
    const sp = moonSubpoint(full);
    // walk the observer away from the sub-point until ground-alt ≈ -15°.
    let lon = sp.lon;
    let obs = { lat: sp.lat, lon };
    for (let off = 0; off < 180; off += 1) {
      lon = sp.lon + off > 180 ? sp.lon + off - 360 : sp.lon + off;
      obs = { lat: sp.lat, lon };
      const alt = moonAltitudeDeg(obs.lat, obs.lon, full);
      if (alt <= -14 && alt >= -16) break;
    }
    const groundAlt = moonAltitudeDeg(obs.lat, obs.lon, full);
    expect(groundAlt).toBeLessThan(0); // below ground horizon
    // bright full Moon, -15° ground alt, 420km dip ~20° → still up → moonlit
    expect(assessMoon(full, obs, 420).skyState).toBe('moonlit');
  });
});
