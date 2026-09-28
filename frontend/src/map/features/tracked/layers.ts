import { liveIssPositionSGP4 } from '../../../iss-sgp4';
import type { Track } from '../../../types';
import { orbitPeriodSeconds, statusText, type TrackedElements } from '../../../tracked';
import { satTrackLayerId, satTrackSourceId } from '../../map-core/catalog';
import type { LngLat } from '../../map-core/geometry';
import type { LineLayer } from '../../map-core/layer-spec';
import { buildLineFeatures } from '../../overlays/track-line';

const SAMPLE_SECONDS = 30;

/** A Track the SGP4 propagator accepts. Empty `tle_epoch` skips the check
 *  that a published epoch still matches the lines, because these lines are
 *  the whole orbit. */
export function orbitOf(line1: string, line2: string): Track {
  return {
    tle: { line1, line2 },
    tle_epoch: '',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
    iss_polynomial: {
      start: '',
      duration_seconds: 0,
      lat_coeffs: [],
      lon_coeffs: [],
      polynomial_order: 0,
    },
  } as Track;
}

export function subPointAt(line1: string, line2: string, atMs: number): LngLat | null {
  const pos = liveIssPositionSGP4(orbitOf(line1, line2), atMs);
  return pos ? [pos.lon, pos.lat] : null;
}

/** One orbit of this vehicle, sampled from `fromMs`. */
export function trackedOrbitFeatures(
  line1: string,
  line2: string,
  fromMs: number,
): GeoJSON.Feature[] {
  const period = orbitPeriodSeconds(line2);
  if (period === null) return [];
  const orbit = orbitOf(line1, line2);
  const samples: [number, number][] = [];
  for (let t = 0; t <= period; t += SAMPLE_SECONDS) {
    const pos = liveIssPositionSGP4(orbit, fromMs + t * 1000);
    if (pos) samples.push([pos.lat, pos.lon]);
  }
  return buildLineFeatures(samples);
}

export function trackedTrackLayer(id: string, color: string): LineLayer {
  return {
    id: satTrackLayerId(id),
    type: 'line',
    source: satTrackSourceId(id),
    paint: {
      'line-color': color,
      'line-width': 2.2,
      'line-opacity': 0.9,
      'line-dasharray': [1, 1.4],
    },
  };
}

export function markerElement(record: TrackedElements): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tracked-marker';
  el.title = statusText(record);
  el.style.setProperty('--tracked-color', record.color);
  const dot = document.createElement('span');
  dot.className = 'tracked-marker-dot';
  const label = document.createElement('span');
  label.className = 'tracked-marker-label';
  label.textContent = record.label;
  el.append(dot, label);
  return el;
}
