/** Pin-drop pass lookup — Pettit feedback #10 (v1.5.6.0).
 *
 *  Operator long-presses (touch) or right-clicks (desktop) anywhere on the
 *  map. We propagate ISS via SGP4 over the next 36h, find local minima in
 *  great-circle distance from ISS sub-point to the pin, and return up to
 *  5 closest-approach passes within the ISS horizon (~1500km).
 *
 *  This is the INVERSE of the existing photo-lookup feature:
 *    Lookup tab  : timestamp → where was ISS  (paste time, get pin)
 *    Map pin-drop: lat/lon  → when is ISS overhead next  (drop pin, get times)
 *
 *  All frontend-only — uses the existing iss-sgp4 SGP4 propagator + the
 *  classifyIssIllumination helper for the day/night regime tag.
 *
 *  Per /plan-eng-review 2026-05-21 recommendations:
 *    A1: parabolic interpolation at local minima (vs. plan's 5s refine)
 *    A2: explicit antimeridian test (see pin-drop.test.ts)
 *    A3: zoom-aware lat/lon precision is the caller's responsibility
 *    P1: ~4320 SGP4 calls per drop @ ~0.1ms = ~432ms (acceptable for one-shot)
 */

import { liveIssPositionSGP4 } from './iss-sgp4';
import { classifyIssIllumination, type IssIllumination } from './terminator';
import type { Track } from './types';

export interface UpcomingPass {
  /** ms-since-epoch of the local nadir-distance minimum (closest approach). */
  closestApproachMs: number;
  /** Great-circle distance from ISS sub-point to the pin at closest approach (km). */
  nadirKm: number;
  /** Illumination state at the pin's sub-point at closest approach.
   *  iss-day = ground sunlit; iss-twilight = ground dark + ISS still sunlit;
   *  iss-eclipse = both ISS and ground in shadow. */
  regime: IssIllumination;
}

/** Earth radius matching the Python generator's value (orbit.py:8). */
const EARTH_RADIUS_KM = 6378.137;

/** ISS horizon limit. At 408km altitude the geometric horizon is ~2200km;
 *  1500km is the conservative "the rocket / target is clearly inside the
 *  visible disk, not at the limb." Matches the value used by ASCENT geometry. */
export const ISS_HORIZON_KM = 1500;

/** Default forward scan window. Matches the existing Upcoming-tab horizon
 *  (`pass_window_hours = 36`) so the pin lookup answers the same
 *  "next 36h" question the rest of the app does. */
export const DEFAULT_HORIZON_HOURS = 36;

/** Scan cadence — coarse enough to be fast (~4320 samples), fine enough
 *  that local minima are not missed (ISS moves ~230km in 30s; a pass
 *  through the horizon is several minutes wide, so 30s sampling catches
 *  every minimum and parabolic interpolation refines the precise time. */
const SCAN_STEP_SECONDS = 30;

/** Max passes returned. Matches Queue tab convention. */
const MAX_PASSES = 5;

/** Great-circle distance in km between two (lat, lon) degree coordinates
 *  via the haversine formula. Handles antimeridian (longitude wrap) correctly.
 *  Exported for unit testing. */
export function greatCircleKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dphi = (lat2 - lat1) * toRad;
  const dlam = (lon2 - lon1) * toRad;
  const a = Math.sin(dphi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/** Parabolic minimum of three points (x_{i-1}, y_{i-1}), (x_i, y_i),
 *  (x_{i+1}, y_{i+1}) where x_{i-1} < x_i < x_{i+1} and y_i is the local
 *  minimum. Returns the refined x at the parabolic vertex. Used to refine
 *  the closest-approach time without burning extra SGP4 calls (A1 from
 *  /plan-eng-review). */
function parabolicMinimumTime(
  t0: number, n0: number,
  t1: number, n1: number,
  t2: number, n2: number,
): number {
  const denom = (n0 - 2 * n1 + n2);
  if (Math.abs(denom) < 1e-9) return t1;  // straight line — return middle
  const offset = 0.5 * (n0 - n2) / denom;
  // Convert the unit-offset (-1..+1) back into a time offset between the
  // three sample times (assumed roughly uniform around t1).
  const halfStep = (t2 - t0) / 2;
  return t1 + offset * halfStep;
}

/** Find the next N upcoming ISS passes over (pinLat, pinLon).
 *
 *  Returns 0-5 passes, sorted by closest-approach ascending. A "pass" is
 *  a local minimum in the great-circle distance from ISS sub-point to the
 *  pin where the minimum is ≤ ISS_HORIZON_KM (1500km).
 *
 *  Algorithm:
 *    1. Walk SGP4 from nowMs to nowMs + horizonHours at 30s cadence,
 *       computing nadir = greatCircleKm(iss, pin) at each sample.
 *    2. Detect local minima via sign-change in d(nadir)/dt (curr < prev
 *       AND curr < next).
 *    3. For each minimum, refine the closest-approach time via parabolic
 *       interpolation of the three surrounding nadir samples.
 *    4. Filter to minima ≤ ISS_HORIZON_KM.
 *    5. Sort ascending by time, cap at MAX_PASSES.
 *    6. Stamp each pass with its illumination regime via classifyIssIllumination.
 */
export function findUpcomingPasses(
  track: Track,
  pinLat: number,
  pinLon: number,
  nowMs: number,
  horizonHours: number = DEFAULT_HORIZON_HOURS,
): UpcomingPass[] {
  if (!Number.isFinite(pinLat) || !Number.isFinite(pinLon)) return [];
  const horizonMs = nowMs + horizonHours * 3600 * 1000;
  const stepMs = SCAN_STEP_SECONDS * 1000;

  // Collect nadir samples. We keep just the 3 most recent so memory is O(1)
  // not O(N) — local-minima detection only needs the immediate neighbors.
  type Sample = { tMs: number; nadirKm: number };
  let prev: Sample | null = null;
  let curr: Sample | null = null;
  const passes: UpcomingPass[] = [];

  for (let tMs = nowMs; tMs <= horizonMs; tMs += stepMs) {
    const iss = liveIssPositionSGP4(track, tMs);
    if (!iss) {
      // SGP4 propagation failed (malformed TLE, epoch mismatch). Bail with
      // whatever passes we have already detected.
      break;
    }
    const nadirKm = greatCircleKm(iss.lat, iss.lon, pinLat, pinLon);
    const next: Sample = { tMs, nadirKm };

    // Local minimum check: curr.nadir < prev.nadir AND curr.nadir < next.nadir
    // (strict < to avoid duplicate-detection at flat regions).
    if (prev && curr && curr.nadirKm < prev.nadirKm && curr.nadirKm < next.nadirKm) {
      // Refine the time via parabolic interpolation between prev, curr, next.
      const refinedTimeMs = parabolicMinimumTime(
        prev.tMs, prev.nadirKm,
        curr.tMs, curr.nadirKm,
        next.tMs, next.nadirKm,
      );
      // Compute the actual refined nadir at the refined time via one more
      // SGP4 call. This is the closest-approach truth.
      const refinedIss = liveIssPositionSGP4(track, refinedTimeMs);
      let refinedNadir = curr.nadirKm;
      if (refinedIss) {
        refinedNadir = greatCircleKm(refinedIss.lat, refinedIss.lon, pinLat, pinLon);
      }
      if (refinedNadir <= ISS_HORIZON_KM) {
        passes.push({
          closestApproachMs: refinedTimeMs,
          nadirKm: refinedNadir,
          regime: classifyIssIllumination(new Date(refinedTimeMs), pinLat, pinLon),
        });
      }
    }
    prev = curr;
    curr = next;
  }

  // Sort by closest-approach ascending (should already be in order but be safe).
  passes.sort((a, b) => a.closestApproachMs - b.closestApproachMs);
  return passes.slice(0, MAX_PASSES);
}

/** Round a lat/lon to the appropriate decimal precision for the map zoom
 *  level (A3 from /plan-eng-review). At wide zoom we don't know the exact
 *  point the operator meant; showing 4 decimals would overstate precision. */
export function roundForZoom(lat: number, lon: number, zoom: number): {
  lat: number; lon: number; precision: number;
} {
  // Empirical mapping: at z<6 we're showing >100km/pixel — whole degrees.
  // At z=6-10 we're showing 1-100 km/pixel — tenths.
  // At z>10 we're at <1km/pixel — hundredths or finer.
  const precision = zoom < 6 ? 0 : zoom < 10 ? 1 : 2;
  const factor = 10 ** precision;
  return {
    lat: Math.round(lat * factor) / factor,
    lon: Math.round(lon * factor) / factor,
    precision,
  };
}
