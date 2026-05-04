import {
  eciToEcf,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec,
} from 'satellite.js';

import type { Track } from './types';
import { wrapLon } from './iss';

interface SatrecCacheEntry {
  line1: string;
  line2: string;
  satrec: SatRec | null;
}

let cache: SatrecCacheEntry | null = null;

/** Parse the TLE shipped on `track.tle` into a satellite.js satrec.
 *  Returns null on malformed input (caller falls back to polynomial only).
 *  Cached by (line1, line2) string equality so a stable track doesn't
 *  re-parse every tick.
 */
export function parseTLE(tle: { line1: string; line2: string } | undefined): SatRec | null {
  if (!tle) return null;
  if (cache && cache.line1 === tle.line1 && cache.line2 === tle.line2) {
    return cache.satrec;
  }
  let satrec: SatRec | null = null;
  // satellite.js's twoline2satrec is permissive — junk strings of the right
  // length parse to a satrec with error=0 and bogus orbital elements. Match
  // the Python parser's strict prefix check (orbit.py: TLE.from_text) so we
  // catch malformed input here instead of producing nonsense positions.
  if (tle.line1.startsWith('1 ') && tle.line2.startsWith('2 ')) {
    try {
      const candidate = twoline2satrec(tle.line1, tle.line2);
      if (candidate.error === 0) satrec = candidate;
    } catch {
      satrec = null;
    }
  }
  cache = { line1: tle.line1, line2: tle.line2, satrec };
  return satrec;
}

/** Reset the satrec cache. Test-only helper. */
export function _resetSatrecCacheForTests(): void {
  cache = null;
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
export function liveIssPositionSGP4(
  track: Track,
  nowMs: number,
): { lat: number; lon: number } | null {
  const satrec = parseTLE(track.tle);
  if (!satrec) return null;
  const when = new Date(nowMs);
  const result = propagate(satrec, when);
  if (!result || typeof result.position === 'boolean' || !result.position) return null;
  const ecf = eciToEcf(result.position, gstime(when));
  const r = Math.sqrt(ecf.x * ecf.x + ecf.y * ecf.y + ecf.z * ecf.z);
  if (r === 0) return null;
  const lat = (Math.asin(ecf.z / r) * 180) / Math.PI;
  const lon = (Math.atan2(ecf.y, ecf.x) * 180) / Math.PI;
  return { lat, lon: wrapLon(lon) };
}
