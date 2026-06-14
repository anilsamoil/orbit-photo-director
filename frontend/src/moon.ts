/** Moon planning (photography arc Unit 3).
 *
 *  Two photography facts, both Pettit-grounded: a bright Moon up in the
 *  sky floods the night-side Earth with light — great for cloud/ocean/
 *  terrain TEXTURE, but it drowns faint aurora and star fields (his Night
 *  Phenomena card: "Best during no Moonlight night passes"). A dark sky
 *  (Moon down or new) is the aurora/star window. This unit computes which,
 *  client-side, from the same orbit clock everything else uses, and lets
 *  the aurora note hedge its wording when the Moon is washing the sky.
 *
 *  Design verified by a multi-agent adversarial pass (2026-06-14). Two
 *  corrections that pass made vs the first draft are load-bearing:
 *   - Illuminated fraction is computed from the TRUE sun-moon elongation,
 *     not a mean-synodic-age cosine. The synodic shortcut erred ~8
 *     percentage points at the quarters — exactly where the moonlit gate
 *     lives — so a real 50%-lit quarter would mislabel. Elongation is
 *     right at the quarters by construction and costs one extra (cheap)
 *     solar position we already know how to compute.
 *   - "Moon up" is gated against the ISS ORBITAL horizon (dip ≈20° below
 *     the ground horizon at 420km), not a ground +10° airmass threshold
 *     (airmass/extinction is ground physics — meaningless from orbit,
 *     where a bright Moon anywhere above the station's horizon floods the
 *     scene equally). The dip is derived from the pass's own alt_km.
 */

import { greatCircleAngleDeg } from './terminator';
import { wrapLon } from './iss';

const DEG = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;
/** Mean obliquity, LOCKED to the rest of the app's solar model so the Moon
 *  and Sun ephemerides can never disagree about the sky. */
const OBLIQUITY_DEG = 23.44;
/** Default ISS altitude when a caller has no per-pass value (the live
 *  aurora path). */
const DEFAULT_ALT_KM = 420;

/** Illuminated fraction at/above which the Moon meaningfully floods the
 *  night sky. 0.5 = first/last quarter; gibbous-to-full is where the
 *  opposition surge makes the Moon ~10x brighter than a quarter.
 *  PROVISIONAL (no operator calibration) — same honesty class as the
 *  aurora thresholds; biased to under-claim "moonlit". */
export const MOON_BRIGHT_ILLUM = 0.5;
/** Mean lunar angular diameter, degrees — almanac copy only. */
export const MOON_ANGULAR_DIAM_DEG = 0.52;

export type MoonPhaseName =
  | 'new' | 'waxing-crescent' | 'first-quarter' | 'waxing-gibbous'
  | 'full' | 'waning-gibbous' | 'last-quarter' | 'waning-crescent';

export interface MoonState {
  phaseName: MoonPhaseName;
  glyph: string;
  /** 0 (new) .. 1 (full). */
  illum: number;
  waning: boolean;
  /** Geocentric altitude at the observer, degrees; null when no observer. */
  altitudeDeg: number | null;
  /** 'moonlit' = bright AND above the station's horizon → night genres
   *  washed. 'up-faint' = up but dim → soft fill light. 'dark' = below the
   *  station horizon or no observer → the aurora/star window. */
  skyState: 'dark' | 'moonlit' | 'up-faint';
}

function julianCenturies(whenMs: number): number {
  const jd = whenMs / 86400_000 + 2440587.5;
  return (jd - 2451545.0) / 36525.0;
}

/** Greenwich mean sidereal time, degrees [0,360) (Meeus 12.4). */
export function gmstDeg(whenMs: number): number {
  const jd = whenMs / 86400_000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525.0;
  const g = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * t * t - (t * t * t) / 38710000;
  return ((g % 360) + 360) % 360;
}

/** Sun apparent equatorial position (low precision, Meeus 25). One solar
 *  model, shared by the elongation phase + reused obliquity. */
function sunEquatorial(t: number): { raDeg: number; decDeg: number; eclLonDeg: number } {
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const m = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * DEG;
  const c = (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(m)
    + (0.019993 - 0.000101 * t) * Math.sin(2 * m)
    + 0.000289 * Math.sin(3 * m);
  const lon = (l0 + c) % 360;
  const lonR = lon * DEG;
  const eps = OBLIQUITY_DEG * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lonR), Math.cos(lonR)) / DEG;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lonR)) / DEG;
  return { raDeg: ((ra % 360) + 360) % 360, decDeg: dec, eclLonDeg: ((lon % 360) + 360) % 360 };
}

/** Moon apparent ecliptic + equatorial position (Meeus low precision,
 *  truncated ELP: 10 longitude / 6 latitude terms → <0.3°). */
function moonEquatorial(t: number): {
  raDeg: number; decDeg: number; eclLonDeg: number;
} {
  const lp = 218.3164477 + 481267.88123421 * t - 0.0015786 * t * t
    + (t * t * t) / 538841 - (t * t * t * t) / 65194000;
  const d = 297.8501921 + 445267.1114034 * t - 0.0018819 * t * t
    + (t * t * t) / 545868 - (t * t * t * t) / 113065000;
  const m = 357.5291092 + 35999.0502909 * t - 0.0001536 * t * t
    + (t * t * t) / 24490000;
  const mp = 134.9633964 + 477198.8675055 * t + 0.0087414 * t * t
    + (t * t * t) / 69699 - (t * t * t * t) / 14712000;
  const f = 93.2720950 + 483202.0175233 * t - 0.0036539 * t * t
    - (t * t * t) / 3526000 + (t * t * t * t) / 863310000;
  const D = d * DEG, M = m * DEG, Mp = mp * DEG, F = f * DEG;

  const lonSum =
    6.288774 * Math.sin(Mp)
    + 1.274027 * Math.sin(2 * D - Mp)
    + 0.658314 * Math.sin(2 * D)
    + 0.213618 * Math.sin(2 * Mp)
    - 0.185116 * Math.sin(M)
    - 0.114332 * Math.sin(2 * F)
    + 0.058793 * Math.sin(2 * D - 2 * Mp)
    + 0.057066 * Math.sin(2 * D - M - Mp)
    + 0.053322 * Math.sin(2 * D + Mp)
    + 0.045758 * Math.sin(2 * D - M);
  const latSum =
    5.128122 * Math.sin(F)
    + 0.280602 * Math.sin(Mp + F)
    + 0.277693 * Math.sin(Mp - F)
    + 0.173237 * Math.sin(2 * D - F)
    + 0.055413 * Math.sin(2 * D - Mp + F)
    + 0.046271 * Math.sin(2 * D - Mp - F);

  const lambda = (((lp + lonSum) % 360) + 360) % 360;
  const beta = latSum;
  const lamR = lambda * DEG, betR = beta * DEG, eps = OBLIQUITY_DEG * DEG;
  const ra = Math.atan2(
    Math.sin(lamR) * Math.cos(eps) - Math.tan(betR) * Math.sin(eps),
    Math.cos(lamR),
  ) / DEG;
  const dec = Math.asin(
    Math.sin(betR) * Math.cos(eps) + Math.cos(betR) * Math.sin(eps) * Math.sin(lamR),
  ) / DEG;
  return { raDeg: ((ra % 360) + 360) % 360, decDeg: dec, eclLonDeg: lambda };
}

/** Illuminated fraction from the TRUE geocentric sun-moon elongation:
 *  k = (1 − cos ψ)/2, ψ the angular separation. Right at the quarters
 *  (ψ=90° → k=0.5) where it matters; 0 at new, 1 at full. */
export function moonIlluminatedFraction(whenMs: number): number {
  const t = julianCenturies(whenMs);
  const s = sunEquatorial(t);
  const m = moonEquatorial(t);
  const cosPsi =
    Math.sin(s.decDeg * DEG) * Math.sin(m.decDeg * DEG)
    + Math.cos(s.decDeg * DEG) * Math.cos(m.decDeg * DEG)
      * Math.cos((s.raDeg - m.raDeg) * DEG);
  return (1 - Math.max(-1, Math.min(1, cosPsi))) / 2;
}

/** True when the Moon is waning (west of the Sun in ecliptic longitude). */
export function moonIsWaning(whenMs: number): boolean {
  const t = julianCenturies(whenMs);
  const d = (((moonEquatorial(t).eclLonDeg - sunEquatorial(t).eclLonDeg) % 360) + 360) % 360;
  return d >= 180;
}

export function moonPhaseName(whenMs: number): MoonPhaseName {
  const k = moonIlluminatedFraction(whenMs);
  if (k < 0.04) return 'new';
  if (k > 0.96) return 'full';
  const waning = moonIsWaning(whenMs);
  if (Math.abs(k - 0.5) <= 0.06) return waning ? 'last-quarter' : 'first-quarter';
  if (waning) return k > 0.5 ? 'waning-gibbous' : 'waning-crescent';
  return k < 0.5 ? 'waxing-crescent' : 'waxing-gibbous';
}

const GLYPHS: Record<MoonPhaseName, string> = {
  'new': '🌑', 'waxing-crescent': '🌒', 'first-quarter': '🌓', 'waxing-gibbous': '🌔',
  'full': '🌕', 'waning-gibbous': '🌖', 'last-quarter': '🌗', 'waning-crescent': '🌘',
};

export function moonPhaseGlyph(name: MoonPhaseName): string {
  return GLYPHS[name];
}

/** The Earth lat/lon the Moon is directly overhead. */
export function moonSubpoint(whenMs: number): { lat: number; lon: number } {
  const m = moonEquatorial(julianCenturies(whenMs));
  return { lat: m.decDeg, lon: wrapLon(m.raDeg - gmstDeg(whenMs)) };
}

/** Geocentric Moon altitude (degrees) at a ground point. Mirrors aurora.ts
 *  sunElevationDeg exactly: 90 − great-circle angle to the sub-point. */
export function moonAltitudeDeg(lat: number, lon: number, whenMs: number): number {
  const sub = moonSubpoint(whenMs);
  return 90 - greatCircleAngleDeg(lat, lon, sub.lat, sub.lon);
}

/** Angle (degrees) the station's orbital horizon dips below the ground
 *  horizon at altitude `altKm`: acos(R/(R+h)). ~20.3° at 420km. */
export function orbitalHorizonDipDeg(altKm: number): number {
  return Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm)) / DEG;
}

/** The one entry point both the condition provider and the aurora
 *  modulator call. `observer` null → altitude unknown → dark (never a
 *  false moonlit). `altKm` sets the orbital-horizon dip. */
export function assessMoon(
  whenMs: number,
  observer: { lat: number; lon: number } | null,
  altKm: number = DEFAULT_ALT_KM,
): MoonState {
  const illum = moonIlluminatedFraction(whenMs);
  const waning = moonIsWaning(whenMs);
  const phaseName = moonPhaseName(whenMs);
  const glyph = moonPhaseGlyph(phaseName);
  if (!observer) {
    return { phaseName, glyph, illum, waning, altitudeDeg: null, skyState: 'dark' };
  }
  const altitudeDeg = moonAltitudeDeg(observer.lat, observer.lon, whenMs);
  const up = altitudeDeg >= -orbitalHorizonDipDeg(altKm);
  const skyState = !up ? 'dark' : illum >= MOON_BRIGHT_ILLUM ? 'moonlit' : 'up-faint';
  return { phaseName, glyph, illum, waning, altitudeDeg, skyState };
}
