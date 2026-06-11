import {
  eciToEcf,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec,
} from 'satellite.js';

import type { Track } from './types';
import { wrapLon } from './iss';

// Map-keyed (perf audit 2026-06-11): a single-entry cache thrashed during
// scrub drags whenever non-ISS satellites were selected — tier-2 satellite
// refreshes evicted the ISS satrec every ~150ms, forcing a twoline2satrec
// re-parse on the next per-frame marker update. Bounded: one entry per
// distinct TLE on the map (a handful of birds).
const cache = new Map<string, SatRec | null>();

/** Parse the TLE shipped on `track.tle` into a satellite.js satrec.
 *  Returns null on malformed input (caller falls back to polynomial only).
 *  Cached by (line1, line2) string equality so a stable track doesn't
 *  re-parse every tick.
 *
 *  Both lines are trimmed first — a TLE cache file edited on Windows or
 *  fetched through a proxy that injected `\r` would otherwise pass the
 *  prefix check but feed garbage into twoline2satrec, producing a satrec
 *  that propagates to wildly wrong positions silently.
 */
export function parseTLE(tle: { line1: string; line2: string } | undefined): SatRec | null {
  if (!tle) return null;
  const line1 = tle.line1.trim();
  const line2 = tle.line2.trim();
  const key = line1 + '\n' + line2;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let satrec: SatRec | null = null;
  // satellite.js's twoline2satrec is permissive — junk strings of the right
  // length parse to a satrec with error=0 and bogus orbital elements. Match
  // the Python parser's strict prefix check (orbit.py: TLE.from_text) so we
  // catch malformed input here instead of producing nonsense positions.
  if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
    try {
      const candidate = twoline2satrec(line1, line2);
      if (candidate.error === 0) satrec = candidate;
    } catch {
      satrec = null;
    }
  }
  cache.set(key, satrec);
  return satrec;
}

/** Reset the satrec cache. Test-only helper. */
export function _resetSatrecCacheForTests(): void {
  cache.clear();
}

/** Compute live ISS lat/lon at nowMs by SGP4-propagating the track's TLE.
 *  Used past the 120-min polynomial window AND when the polynomial path
 *  returns null for any reason. Returns null if the track has no TLE or
 *  the TLE is malformed.
 *
 *  Coordinate frame matches the Python generator (orbit.py:teme_to_geodetic):
 *  geocentric spherical lat/lon from the ECEF position vector. We deliberately
 *  do NOT use eciToGeodetic — that returns WGS-84 geodetic latitude, which
 *  differs from geocentric by up to ~0.19° at ISS altitudes. The polynomial
 *  was fit against geocentric values, so the handoff at the 120-min window
 *  edge is only seamless when both paths agree on the frame.
 */
/** Convert a satrec's parsed epoch (epochyr + epochdays) to a Date.
 *  Two-digit year follows TLE convention: 0–56 → 2000s, 57–99 → 1900s. */
function satrecEpochMs(satrec: SatRec): number {
  const yr = satrec.epochyr + (satrec.epochyr < 57 ? 2000 : 1900);
  return Date.UTC(yr, 0, 1) + (satrec.epochdays - 1) * 86_400_000;
}

/** Like liveIssPositionSGP4 but also returns altitude in km above Earth's
 *  centre-to-surface radius. Used by the photo-lookup tab (Pettit feedback
 *  2026-05-19) — KML output needs alt for the relativeToGround placemark
 *  rendering in Google Earth. Same epoch-mismatch guard + error code +
 *  NaN guards as the live caller. */
export function issPositionWithAltSGP4(
  track: Track,
  whenMs: number,
): { lat: number; lon: number; alt_km: number } | null {
  const satrec = parseTLE(track.tle);
  if (!satrec) return null;
  if (track.tle_epoch) {
    const declared = Date.parse(track.tle_epoch);
    if (Number.isFinite(declared)) {
      if (Math.abs(satrecEpochMs(satrec) - declared) > 2_000) return null;
    }
  }
  const when = new Date(whenMs);
  const result = propagate(satrec, when);
  if (!result || typeof result.position === 'boolean' || !result.position) return null;
  if (satrec.error !== 0) return null;
  const { x, y, z } = result.position;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const ecf = eciToEcf(result.position, gstime(when));
  const r = Math.sqrt(ecf.x * ecf.x + ecf.y * ecf.y + ecf.z * ecf.z);
  if (r === 0 || !Number.isFinite(r)) return null;
  const lat = (Math.asin(ecf.z / r) * 180) / Math.PI;
  const lon = (Math.atan2(ecf.y, ecf.x) * 180) / Math.PI;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Spherical Earth radius matches the Python generator's EARTH_RADIUS_KM
  // (orbit.py:8). r is from origin in km; subtract to get altitude.
  const EARTH_RADIUS_KM = 6378.137;
  return { lat, lon: wrapLon(lon), alt_km: r - EARTH_RADIUS_KM };
}

export function liveIssPositionSGP4(
  track: Track,
  nowMs: number,
): { lat: number; lon: number } | null {
  const satrec = parseTLE(track.tle);
  if (!satrec) return null;
  // Verify the satrec's parsed epoch matches what the manifest declared
  // for track.tle_epoch. Mismatch means the TLE bytes don't agree with
  // the surrounding metadata — could be a stale manifest, a partial
  // R2 deploy, or (worst case) an attacker-swapped TLE for a different
  // object that happens to parse cleanly. Tolerance is 2 seconds (the
  // Python parser computes epoch with float-day precision, so sub-second
  // drift between Python and JS is normal).
  if (track.tle_epoch) {
    const declared = Date.parse(track.tle_epoch);
    if (Number.isFinite(declared)) {
      if (Math.abs(satrecEpochMs(satrec) - declared) > 2_000) return null;
    }
  }
  const when = new Date(nowMs);
  const result = propagate(satrec, when);
  if (!result || typeof result.position === 'boolean' || !result.position) return null;
  // Re-check error after propagation — satrec.error is mutated each call.
  // SGP4 sets error=6 when an object has decayed (atmospheric reentry); the
  // ISS won't decay in the mission window, but a wildly stale TLE
  // propagated months past epoch can produce other non-zero error codes.
  if (satrec.error !== 0) return null;
  const { x, y, z } = result.position;
  // NaN-safe: an internally degenerate propagation can return finite-typed
  // NaN floats. A subsequent eciToEcf rotation propagates the NaN and the
  // user sees "NaN°N, NaN°W" in the topbar plus a wrong roughRegion. Better
  // to fall through to "live track expired" than to render garbage.
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const ecf = eciToEcf(result.position, gstime(when));
  const r = Math.sqrt(ecf.x * ecf.x + ecf.y * ecf.y + ecf.z * ecf.z);
  if (r === 0 || !Number.isFinite(r)) return null;
  const lat = (Math.asin(ecf.z / r) * 180) / Math.PI;
  const lon = (Math.atan2(ecf.y, ecf.x) * 180) / Math.PI;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon: wrapLon(lon) };
}
