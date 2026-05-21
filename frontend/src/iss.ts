import type { Track } from './types';
import { liveIssPositionSGP4 } from './iss-sgp4';

/** Evaluate a polynomial p(t) = c[0]*t^n + c[1]*t^(n-1) + ... + c[n]. */
function evalPoly(coeffs: number[], t: number): number {
  let acc = 0;
  for (const c of coeffs) {
    acc = acc * t + c;
  }
  return acc;
}

/** Wrap longitude to [-180, 180]. */
export function wrapLon(lon: number): number {
  let v = lon;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

/** Compute live ISS lat/lon at nowMs from the polynomial fit shipped in track.json.
 *  Returns null if the polynomial window doesn't cover nowMs.
 */
export function liveIssPosition(track: Track, nowMs: number): { lat: number; lon: number } | null {
  const startMs = Date.parse(track.iss_polynomial.start);
  if (Number.isNaN(startMs)) return null;
  const t = (nowMs - startMs) / 1000;
  if (t < 0 || t > track.iss_polynomial.duration_seconds) return null;
  const lat = evalPoly(track.iss_polynomial.lat_coeffs, t);
  const lon = wrapLon(evalPoly(track.iss_polynomial.lon_coeffs, t));
  return { lat, lon };
}

/** Best-effort live ISS position. SGP4 first (accurate), polynomial only
 *  as a legacy fallback for pre-V2 snapshots that don't carry a TLE.
 *
 *  v1.4.6.0 inverted the priority. Previously polynomial was the primary
 *  path because it was "cheap"; SGP4 was the past-window fall-through.
 *  /review measured the order-11 polynomial at up to 1.1° lat error vs
 *  SGP4 truth — about 120 km on the map. The live dot was visibly off
 *  truth INSIDE the 120-min window. satellite.js's `propagate` is
 *  sub-millisecond per call once the satrec is cached (we cache by
 *  TLE-string equality in iss-sgp4.ts), so 1Hz SGP4 in the browser is
 *  free in practice. The "expensive SGP4" framing applied to the
 *  Python generator daemon's per-tick load, not the browser.
 *
 *  - Track has TLE → SGP4 (accurate, ~km-level for fresh TLE).
 *  - Track has no TLE OR SGP4 returns null (malformed TLE, epoch
 *    mismatch, decayed object) → polynomial fallback inside its window.
 *  - Both null → returns null; caller renders the "live track expired"
 *    state.
 */
export function liveIssNow(track: Track, nowMs: number): { lat: number; lon: number } | null {
  const sgp4 = liveIssPositionSGP4(track, nowMs);
  if (sgp4) return sgp4;
  return liveIssPosition(track, nowMs);
}
