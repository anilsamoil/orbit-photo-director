/** Beta-angle blackout forecast (photography arc Unit 2).
 *
 *  The beta angle β is the angle between the ISS orbit plane and the sun
 *  direction. It drifts with nodal regression (~−5°/day) + the seasonal
 *  sun, cycling over ~2 months. When |β| exceeds ~70° (at ISS altitude)
 *  the station never enters Earth's shadow: NO orbital night for days —
 *  aurora, cities-at-night, star fields, and sprites are all unavailable,
 *  and the same days give continuous low-sun terminator lighting (Pettit:
 *  "during some orbital phases, the sun never sinks below the horizon").
 *
 *  Everything is client-side from data already in hand: the TLE the map
 *  carries (inclination, RAAN, nodal-regression rate, mean motion via
 *  satellite.js's satrec) and the same low-precision solar ephemeris the
 *  terminator uses. 14 daily evaluations per refresh — microseconds.
 *
 *      TLE ──► n̂(t) orbit normal (Ω linearly regressed)   ┐
 *                                                          ├─► β(t) = asin(n̂·ŝ)
 *      date ─► ŝ(t) sun unit vector (subsolar + GMST)      ┘      │
 *                                                                  ▼
 *                                        nightMinutesPerOrbit(β, h, period)
 *                                                                  │
 *                                        scanBlackoutWindows (14 days)
 */

import { gstime, propagate } from 'satellite.js';
import type { Track } from './types';
import { parseTLE } from './iss-sgp4';
import { subsolarPoint } from './terminator';

/** Mean Earth radius, km — same constant family as the slant-range math. */
const EARTH_RADIUS_KM = 6371;
/** "Effectively no night" floor, minutes per orbit. The night window
 *  shrinks continuously as |β| rises; below this floor the dark phase is
 *  too short for any night genre (camera settling alone eats minutes), so
 *  the blackout window opens here rather than at the hard zero. */
export const NIGHT_FLOOR_MIN = 15;
/** Forecast horizon, days. TLE linear RAAN regression holds easily here. */
export const SCAN_DAYS = 14;
/** "Approaching" notice lead, days. */
export const APPROACH_DAYS = 7;

/** Sun unit vector in the TEME/ECI frame at `when`. Built from the
 *  subsolar point (lat = solar declination; lon + GMST = right ascension)
 *  so the solar model stays IDENTICAL to the terminator's — the two
 *  surfaces can never disagree about where the sun is. */
export function sunUnitVectorEci(when: Date): { x: number; y: number; z: number } {
  const sub = subsolarPoint(when);
  const dec = (sub.lat * Math.PI) / 180;
  const ra = gstime(when) + (sub.lon * Math.PI) / 180;
  return {
    x: Math.cos(dec) * Math.cos(ra),
    y: Math.cos(dec) * Math.sin(ra),
    z: Math.sin(dec),
  };
}

/** β (degrees) at `when`: SGP4-propagate the satrec, take the orbit
 *  normal from ĥ = r̂×v̂ (TEME), and dot it with the sun vector built in
 *  the SAME GMST-referenced equatorial frame. Outside-voice revision
 *  (Codex 2026-06-11): propagating beats linearly regressing RAAN from
 *  satrec.nodedot — it stays inside the SGP4 model TLEs are bound to and
 *  eliminates any element-convention/frame mismatch. Cost: one
 *  propagation per sample, ~µs. Returns null if propagation fails. */
export function betaAngleDeg(
  satrec: Parameters<typeof propagate>[0],
  when: Date,
): number | null {
  let pv;
  try {
    pv = propagate(satrec, when);
  } catch {
    return null;
  }
  const r = pv?.position;
  const v = pv?.velocity;
  if (!r || typeof r === 'boolean' || !v || typeof v === 'boolean') return null;
  const h = {
    x: r.y * v.z - r.z * v.y,
    y: r.z * v.x - r.x * v.z,
    z: r.x * v.y - r.y * v.x,
  };
  const hm = Math.hypot(h.x, h.y, h.z);
  if (!(hm > 0)) return null;
  const s = sunUnitVectorEci(when);
  const dot = (h.x * s.x + h.y * s.y + h.z * s.z) / hm;
  return (Math.asin(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** Minutes of orbital night per orbit at beta angle `betaDeg`, altitude
 *  `altKm`, period `periodMin`. Cylindrical-shadow model — the standard
 *  first-order eclipse-fraction formula:
 *      fE = (1/π)·acos( √(h² + 2Rh) / ((R+h)·cos β) )
 *  Zero when the acos argument ≥ 1, i.e. |β| ≥ βcrit ≈ 69.7° at 420 km
 *  (βcrit = asin(R/(R+h)) — same identity). Cylindrical shadow ignores
 *  the umbra/penumbra cone: error is a fraction of a minute at LEO,
 *  irrelevant for a planning notice. Anchors (pinned in tests):
 *  β=0 → ≈36.0 min; β=60° → ≈23.9 min. */
export function nightMinutesPerOrbit(
  betaDeg: number,
  altKm: number,
  periodMin: number,
): number {
  const r = EARTH_RADIUS_KM;
  const h = altKm;
  const cosB = Math.cos((betaDeg * Math.PI) / 180);
  const horizon = Math.sqrt(h * h + 2 * r * h) / ((r + h) * cosB);
  if (!Number.isFinite(horizon) || horizon >= 1) return 0;
  return (Math.acos(horizon) / Math.PI) * periodMin;
}

/** The β above which there is NO orbital night at `altKm` (≈69.7° @ 420). */
export function betaCriticalDeg(altKm: number): number {
  const r = EARTH_RADIUS_KM;
  return (Math.acos(Math.sqrt(altKm * altKm + 2 * r * altKm) / (r + altKm)) * 180) / Math.PI;
}

export interface BetaDay {
  dayStartMs: number;
  betaDeg: number;
  nightMin: number;
}

export interface BlackoutWindow {
  /** First day (UTC midnight ms) with nightMin < NIGHT_FLOOR_MIN. */
  startMs: number;
  /** Last such day (inclusive). Open-ended when the window runs past the
   *  scan horizon — `endsBeyondScan` says so and the copy says "through
   *  at least <date>". */
  endMs: number;
  endsBeyondScan: boolean;
  peakBetaDeg: number;
  /** Shortest night inside the window: 0 ⇒ true full-sun days exist; the
   *  copy must NOT claim "no orbital night" otherwise (outside voice:
   *  the 15-min floor opens the window around |β|≈67°, before hard zero). */
  minNightMin: number;
}

export interface BetaForecast {
  days: BetaDay[];
  windows: BlackoutWindow[];
  /** Today's numbers (first scan day). */
  todayBetaDeg: number;
  todayNightMin: number;
}

/** Scan the next SCAN_DAYS days. Returns null when the track carries no
 *  usable TLE (legacy snapshots) — silence, never a guess. */
export function scanBetaForecast(track: Track | null, nowMs: number): BetaForecast | null {
  const satrec = track?.tle ? parseTLE(track.tle) : null;
  if (!satrec) return null;
  // Period from mean motion (no_kozai, rad/min); altitude from the
  // semi-major axis it implies (a = (μ/n²)^⅓), both TLE-derived.
  const nRadMin = (satrec as { no_kozai?: number; no?: number }).no_kozai
    ?? (satrec as { no?: number }).no ?? 0;
  if (!(nRadMin > 0)) return null;
  const periodMin = (2 * Math.PI) / nRadMin;
  const MU = 398600.4418; // km³/s²
  const nRadS = nRadMin / 60;
  const aKm = Math.cbrt(MU / (nRadS * nRadS));
  const altKm = aKm - EARTH_RADIUS_KM;

  // 6-hourly samples aggregated per UTC day (outside voice: daily
  // sampling is too coarse for honest start/end dates). A day's nightMin
  // is its MINIMUM sample (the planning-relevant bound); its betaDeg the
  // max-|β| sample.
  const days: BetaDay[] = [];
  for (let d = 0; d < SCAN_DAYS; d++) {
    const t0 = new Date(nowMs + d * 86400_000);
    let worstNight = Infinity;
    let peakBeta: number | null = null;
    for (let q = 0; q < 4; q++) {
      const t = new Date(nowMs + d * 86400_000 + q * 21600_000);
      const b = betaAngleDeg(satrec, t);
      if (b === null) continue;
      const n = nightMinutesPerOrbit(b, altKm, periodMin);
      if (n < worstNight) worstNight = n;
      if (peakBeta === null || Math.abs(b) > Math.abs(peakBeta)) peakBeta = b;
    }
    if (peakBeta === null) continue; // propagation failed all day — skip
    days.push({
      dayStartMs: Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate()),
      betaDeg: peakBeta,
      nightMin: worstNight,
    });
  }
  if (days.length === 0) return null;

  const windows: BlackoutWindow[] = [];
  let open: BlackoutWindow | null = null;
  for (const day of days) {
    if (day.nightMin < NIGHT_FLOOR_MIN) {
      if (!open) {
        open = {
          startMs: day.dayStartMs,
          endMs: day.dayStartMs,
          endsBeyondScan: false,
          peakBetaDeg: Math.abs(day.betaDeg),
          minNightMin: day.nightMin,
        };
        windows.push(open);
      } else {
        open.endMs = day.dayStartMs;
        open.peakBetaDeg = Math.max(open.peakBetaDeg, Math.abs(day.betaDeg));
        open.minNightMin = Math.min(open.minNightMin, day.nightMin);
      }
    } else {
      open = null;
    }
  }
  const last = days[days.length - 1];
  if (open && last && open.endMs === last.dayStartMs) open.endsBeyondScan = true;

  return {
    days,
    windows,
    todayBetaDeg: days[0]?.betaDeg ?? 0,
    todayNightMin: days[0]?.nightMin ?? 0,
  };
}

/** UTC "Jun 24" style label. */
function shortDate(ms: number): string {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The Upcoming-header notice for a forecast, or null for silence (rule 5).
 *  Inside a window → the blackout line; a window starting within
 *  APPROACH_DAYS → the approach line; otherwise null. */
export function betaNoticeText(fc: BetaForecast | null, nowMs: number): string | null {
  if (!fc || fc.windows.length === 0) return null;
  const todayMs = Date.UTC(
    new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate(),
  );
  const w = fc.windows[0]!;
  if (todayMs >= w.startMs && todayMs <= w.endMs) {
    const until = w.endsBeyondScan ? `at least ${shortDate(w.endMs)}` : shortDate(w.endMs);
    // Two-state honesty (outside voice): "no orbital night" ONLY when the
    // window truly contains full-sun days; shoulder-only windows say what
    // is actually true — the night is too short to use.
    if (w.minNightMin <= 0) {
      return `☀️ No orbital night through ${until} (β ${Math.round(w.peakBetaDeg)}°) — `
        + 'night photography unavailable; continuous low-sun views instead';
    }
    return `☀️ Orbital night under ${NIGHT_FLOOR_MIN}min through ${until}`
      + ` (β ${Math.round(w.peakBetaDeg)}°) — night genres effectively unavailable`;
  }
  const daysUntil = Math.round((w.startMs - todayMs) / 86400_000);
  if (daysUntil > 0 && daysUntil <= APPROACH_DAYS) {
    const verb = w.minNightMin <= 0 ? 'disappears' : `shrinks under ${NIGHT_FLOOR_MIN}min`;
    return `🌗 Orbital night ${verb} ${shortDate(w.startMs)}–${shortDate(w.endMs)}`
      + ` (β peaks ${Math.round(w.peakBetaDeg)}°) — night-genre window closes in ${daysUntil}d`;
  }
  return null;
}
