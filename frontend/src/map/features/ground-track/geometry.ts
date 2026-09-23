import { ISS_ORBIT_PERIOD_SECONDS } from '../../../iss';
import { issPositionWithAltSGP4 } from '../../../iss-sgp4';
import { classifyIssIllumination, type IssIllumination } from '../../../terminator';
import type { Track } from '../../../types';
import { buildLineFeatures } from '../../overlays/track-line';

const HALF_WINDOW_MINUTES = 45;

/** Bucket `k` holds samples with `t` in `[k * period, (k + 1) * period)`.
 *  A missing orbit is an empty bucket so indexes stay stable. */
export function splitTrackByOrbit(
  trackPoints: [number, number, number][],
  periodSeconds: number = ISS_ORBIT_PERIOD_SECONDS,
): [number, number, number][][] {
  const buckets: [number, number, number][][] = [];
  for (const point of trackPoints) {
    const t = point[0];
    const idx = Math.floor(t / periodSeconds);
    if (!buckets[idx]) buckets[idx] = [];
    buckets[idx].push(point);
  }
  for (let i = 0; i < buckets.length; i++) {
    if (!buckets[i]) buckets[i] = [];
  }
  return buckets;
}

/** Contiguous runs of one illumination. The boundary sample is repeated
 *  on the segment it closes so the two lines meet. */
export function splitByIllumination(
  samples: [number, number, number][],
  trackStartMs: number,
): { illumination: IssIllumination; coords: [number, number][] }[] {
  if (samples.length === 0) return [];
  const out: { illumination: IssIllumination; coords: [number, number][] }[] = [];
  let cur: { illumination: IssIllumination; coords: [number, number][] } | null = null;
  for (const [t, lat, lon] of samples) {
    const when = new Date(trackStartMs + t * 1000);
    const illum = classifyIssIllumination(when, lat, lon);
    if (cur === null || cur.illumination !== illum) {
      if (cur && cur.coords.length > 0) {
        cur.coords.push([lat, lon]);
        out.push(cur);
      } else if (cur) {
        out.push(cur);
      }
      cur = { illumination: illum, coords: [[lat, lon]] };
    } else {
      cur.coords.push([lat, lon]);
    }
  }
  if (cur && cur.coords.length > 0) out.push(cur);
  return out;
}

function orbitLines(
  samples: [number, number][],
  orbitIndex: number,
  illumination: IssIllumination = 'iss-day',
): GeoJSON.Feature[] {
  return buildLineFeatures(samples).map((feature) => ({
    ...feature,
    properties: {
      ...(feature.properties ?? {}),
      orbit_index: orbitIndex,
      illumination,
    },
  }));
}

function illuminated(
  samples: [number, number, number][],
  trackStartMs: number,
  orbitIndex: number,
): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  for (const segment of splitByIllumination(samples, trackStartMs)) {
    if (segment.coords.length < 2) continue;
    out.push(...orbitLines(segment.coords, orbitIndex, segment.illumination));
  }
  return out;
}

/** The current orbit, or every orbit when `multiOrbit` is set. No samples
 *  falls back to the polynomial, tagged as day. */
export function groundTrackFeatures(track: Track, multiOrbit: boolean): GeoJSON.Feature[] {
  if (track.track_points && track.track_points.length > 0) {
    const trackStartMs = Date.parse(track.iss_polynomial.start);
    if (multiOrbit) {
      const orbits = splitTrackByOrbit(track.track_points);
      const out: GeoJSON.Feature[] = [];
      for (let k = 0; k < orbits.length; k++) {
        const orbitSamples = orbits[k];
        if (!orbitSamples || orbitSamples.length < 2) continue;
        out.push(...illuminated(orbitSamples, trackStartMs, k));
      }
      return out;
    }
    const firstOrbit = track.track_points.filter(([t]) => t < ISS_ORBIT_PERIOD_SECONDS);
    return illuminated(firstOrbit, trackStartMs, 0);
  }
  const dur = track.iss_polynomial.duration_seconds;
  const stepSec = 30;
  const evalPoly = (coeffs: number[], t: number): number => {
    let acc = 0;
    for (const c of coeffs) acc = acc * t + c;
    return acc;
  };
  const out: [number, number][] = [];
  for (let t = 0; t <= dur; t += stepSec) {
    const lat = evalPoly(track.iss_polynomial.lat_coeffs, t);
    const lon = evalPoly(track.iss_polynomial.lon_coeffs, t);
    out.push([lat, lon]);
  }
  return orbitLines(out, 0);
}

/** `lookaheadMinutes` of 0 or less is the current track. Otherwise one
 *  orbit centered on `nowMs + lookahead`, sampled every 30 s across ±45 min. */
export function futureOrbitGroundTrackFeatures(
  track: Track,
  lookaheadMinutes: number,
  nowMs: number,
  multiOrbit: boolean,
): GeoJSON.Feature[] {
  if (lookaheadMinutes <= 0) return groundTrackFeatures(track, multiOrbit);
  const centerMs = nowMs + lookaheadMinutes * 60_000;
  const halfWindowMs = HALF_WINDOW_MINUTES * 60_000;
  const stepMs = 30_000;
  const trackStartMs = Date.parse(track.iss_polynomial.start);
  const samples: [number, number, number][] = [];
  for (let t = centerMs - halfWindowMs; t <= centerMs + halfWindowMs; t += stepMs) {
    const pos = issPositionWithAltSGP4(track, t);
    if (!pos) continue;
    const tSec = (t - trackStartMs) / 1000;
    samples.push([tSec, pos.lat, pos.lon]);
  }
  return illuminated(samples, trackStartMs, 0);
}
