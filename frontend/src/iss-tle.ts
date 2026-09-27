import { propagateIssDetailed, tleEpochMs } from './iss-sgp4';
import type { Track } from './types';

/** ISS element set for 2026-09-27T04:10:50Z.
 *  CelesTrak's TLS endpoint did not answer from this environment.
 *  These lines are the CelesTrak set republished by
 *  https://tle.ivanstanojevic.me/api/tle/25544 on 2026-09-27. */
export const BUNDLED_ISS_TLE = {
  line1: '1 25544U 98067A   26270.17419514  .00009528  00000+0  18291-3 0  9996',
  line2: '2 25544  51.6315 155.3455 0007168 193.0559 167.0244 15.48664528587569',
} as const;

const LAST_GOOD_KEY = 'opd-iss-tle-last-good';
const SATELLITE_CACHE_KEY = 'opd-tle-25544';

export interface IssTleCandidate {
  line1: string;
  line2: string;
  declaredEpoch?: string;
}

export type IssFix =
  | { ok: true; lat: number; lon: number; alt_km: number; epochMs: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' };

function readPair(raw: string | null): { line1: string; line2: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      line1?: unknown;
      line2?: unknown;
      tle?: { line1?: unknown; line2?: unknown };
    };
    const line1 = typeof parsed.line1 === 'string' ? parsed.line1 : parsed.tle?.line1;
    const line2 = typeof parsed.line2 === 'string' ? parsed.line2 : parsed.tle?.line2;
    if (typeof line1 !== 'string' || typeof line2 !== 'string') return null;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) return null;
    return { line1, line2 };
  } catch {
    return null;
  }
}

function readStored(key: string): { line1: string; line2: string } | null {
  try {
    return readPair(localStorage.getItem(key));
  } catch {
    return null;
  }
}

/** Keep a TLE that parsed and is newer than the one already stored. */
export function rememberIssTle(tle: { line1: string; line2: string }): void {
  const epoch = tleEpochMs(tle);
  if (epoch == null) return;
  const prev = readStored(LAST_GOOD_KEY);
  const prevEpoch = prev ? tleEpochMs(prev) : null;
  if (prevEpoch != null && prevEpoch >= epoch) return;
  try {
    localStorage.setItem(LAST_GOOD_KEY, JSON.stringify({ line1: tle.line1, line2: tle.line2 }));
  } catch {
    /* storage disabled — the in-memory candidate list still works this page */
  }
}

/** Remember the generator's TLE when it still propagates at its own epoch. */
export function rememberPublishedIssTle(track: Track | null): void {
  if (!track?.tle) return;
  const epochMs = Date.parse(track.tle_epoch);
  if (!Number.isFinite(epochMs)) return;
  const atEpoch = propagateIssDetailed(track, epochMs);
  if (!atEpoch.ok) return;
  rememberIssTle(track.tle);
}

export function issLookupCandidates(track: { tle?: { line1: string; line2: string }; tle_epoch?: string } | null): IssTleCandidate[] {
  const out: IssTleCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: IssTleCandidate | null) => {
    if (!candidate) return;
    const key = `${candidate.line1}\n${candidate.line2}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };
  push(readStored(LAST_GOOD_KEY));
  push(readStored(SATELLITE_CACHE_KEY));
  if (track?.tle?.line1 && track.tle.line2) {
    push({ line1: track.tle.line1, line2: track.tle.line2, declaredEpoch: track.tle_epoch });
  }
  push({ line1: BUNDLED_ISS_TLE.line1, line2: BUNDLED_ISS_TLE.line2 });
  return out;
}

function stubTrack(candidate: IssTleCandidate): Track {
  return {
    iss_polynomial: {
      start: '1970-01-01T00:00:00.000Z',
      duration_seconds: 0,
      lat_coeffs: [],
      lon_coeffs: [],
      polynomial_order: 0,
    },
    tle: { line1: candidate.line1, line2: candidate.line2 },
    tle_epoch: candidate.declaredEpoch ?? '',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
  };
}

/** Use the candidate whose epoch is closest to `whenMs` among those that propagate. */
export function propagateBestIssTle(candidates: readonly IssTleCandidate[], whenMs: number): IssFix {
  let best: { lat: number; lon: number; alt_km: number; epochMs: number; distance: number } | null = null;
  let sawMalformed = false;
  let sawStale = false;
  for (const candidate of candidates) {
    const epochMs = tleEpochMs(candidate);
    if (epochMs == null) {
      sawMalformed = true;
      continue;
    }
    const propagated = propagateIssDetailed(stubTrack(candidate), whenMs);
    if (!propagated.ok) {
      if (propagated.reason === 'stale') sawStale = true;
      else sawMalformed = true;
      continue;
    }
    const distance = Math.abs(whenMs - epochMs);
    if (!best || distance < best.distance) {
      best = { ...propagated, epochMs, distance };
    }
  }
  if (best) return { ok: true, lat: best.lat, lon: best.lon, alt_km: best.alt_km, epochMs: best.epochMs };
  if (sawStale) return { ok: false, reason: 'stale' };
  if (sawMalformed) return { ok: false, reason: 'malformed' };
  return { ok: false, reason: 'missing' };
}
