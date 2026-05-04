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

/** Best-effort live ISS position with SGP4 fall-through.
 *  - In window: polynomial (cheap to evaluate every second).
 *  - Past window OR polynomial-malformed: SGP4 from track.tle (slower but
 *    accurate for hours-to-days past the polynomial's 120-min cap).
 *  - Track has no TLE (older manifests pre-V2): polynomial only; returns
 *    null past the window.
 */
export function liveIssNow(track: Track, nowMs: number): { lat: number; lon: number } | null {
  const poly = liveIssPosition(track, nowMs);
  if (poly) return poly;
  return liveIssPositionSGP4(track, nowMs);
}
