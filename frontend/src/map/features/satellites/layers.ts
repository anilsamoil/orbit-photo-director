import { liveIssPositionSGP4 } from '../../../iss-sgp4';
import type { SatelliteMeta, TLEPair } from '../../../satellites';
import { orbitPeriodSeconds } from '../../../tracked';
import type { Track } from '../../../types';
import { satTrackLayerId, satTrackSourceId } from '../../map-core/catalog';
import type { LngLat } from '../../map-core/geometry';
import type { LineLayer } from '../../map-core/layer-spec';
import { buildLineFeatures } from '../../overlays/track-line';

const SAMPLE_SECONDS = 30;

/** A Track the SGP4 propagator accepts. No polynomial: an orbit known only
 *  by its TLE has nothing to fall back to. */
export function orbitOf(tle: TLEPair): Track {
  return {
    tle: { line1: tle.line1, line2: tle.line2 },
    tle_epoch: '',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
    iss_polynomial: { start: '', duration_seconds: 0, lat_coeffs: [], lon_coeffs: [], polynomial_order: 0 },
  } as Track;
}

export function subPointAt(tle: TLEPair, atMs: number): LngLat | null {
  const pos = liveIssPositionSGP4(orbitOf(tle), atMs);
  return pos ? [pos.lon, pos.lat] : null;
}

/** One orbit of this satellite, by its own period, in 30 s samples from
 *  `fromMs`. No line when the mean motion does not read. */
export function orbitTrackFeatures(tle: TLEPair, fromMs: number): GeoJSON.Feature[] {
  const period = orbitPeriodSeconds(tle.line2);
  if (period === null) return [];
  const orbit = orbitOf(tle);
  const samples: [number, number][] = [];
  for (let t = 0; t <= period; t += SAMPLE_SECONDS) {
    const pos = liveIssPositionSGP4(orbit, fromMs + t * 1000);
    if (pos) samples.push([pos.lat, pos.lon]);
  }
  return buildLineFeatures(samples);
}

/** A published vehicle keeps the heavier dotted line it has always had. */
export function trackLayer(meta: SatelliteMeta, key: string): LineLayer {
  const published = meta.resolution.kind === 'published';
  return {
    id: satTrackLayerId(key),
    type: 'line',
    source: satTrackSourceId(key),
    paint: {
      'line-color': meta.track_color,
      'line-width': published ? 2.2 : 1.6,
      'line-opacity': published ? 0.9 : 0.7,
      'line-dasharray': published ? [1, 1.4] : [3, 2],
    },
  };
}

export function markerTitle(meta: SatelliteMeta, tle: TLEPair): string {
  return meta.resolution.kind === 'published' ? `${meta.name}: ${tle.name}` : `${meta.icon} ${meta.name}`;
}

/** A dot for a satellite. A labelled diamond for a published vehicle. */
export function markerElement(meta: SatelliteMeta, tle: TLEPair): HTMLElement {
  const el = document.createElement('div');
  el.title = markerTitle(meta, tle);
  if (meta.resolution.kind !== 'published') {
    el.className = 'sat-marker';
    el.style.background = meta.track_color;
    return el;
  }
  el.className = 'tracked-marker';
  el.style.setProperty('--tracked-color', meta.track_color);
  const dot = document.createElement('span');
  dot.className = 'tracked-marker-dot';
  const label = document.createElement('span');
  label.className = 'tracked-marker-label';
  label.textContent = meta.name;
  el.append(dot, label);
  return el;
}
