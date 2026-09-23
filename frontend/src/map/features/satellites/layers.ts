import { ISS_ORBIT_PERIOD_SECONDS } from '../../../iss';
import { liveIssPositionSGP4 } from '../../../iss-sgp4';
import type { SatelliteMeta, TLEPair } from '../../../satellites';
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

/** One orbit of 30 s samples starting at `fromMs`. */
export function orbitTrackFeatures(tle: TLEPair, fromMs: number): GeoJSON.Feature[] {
  const orbit = orbitOf(tle);
  const samples: [number, number][] = [];
  for (let t = 0; t <= ISS_ORBIT_PERIOD_SECONDS; t += SAMPLE_SECONDS) {
    const pos = liveIssPositionSGP4(orbit, fromMs + t * 1000);
    if (pos) samples.push([pos.lat, pos.lon]);
  }
  return buildLineFeatures(samples);
}

export function trackLayer(key: string, color: string): LineLayer {
  return {
    id: satTrackLayerId(key),
    type: 'line',
    source: satTrackSourceId(key),
    paint: {
      'line-color': color,
      'line-width': 1.6,
      'line-opacity': 0.7,
      'line-dasharray': [3, 2],
    },
  };
}

export function markerElement(meta: SatelliteMeta): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sat-marker';
  el.style.background = meta.track_color;
  el.title = `${meta.icon} ${meta.name}`;
  return el;
}
