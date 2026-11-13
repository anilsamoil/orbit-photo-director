import { getMapLaunchMode } from '../../../map-launch-mode';
import type { CircleLayer, FillLayer, LineLayer } from '../../map-core/layer-spec';

/** Amber published-hazard fill. High-risk areas carry a higher fill_opacity. */
export function launchHazardFillLayer(): FillLayer {
  return {
    id: 'launch-hazard-fill-layer',
    type: 'fill',
    source: 'launch-hazards',
    layout: { visibility: getMapLaunchMode() ? 'visible' : 'none' },
    paint: {
      'fill-color': '#ffd45c',
      'fill-opacity': ['get', 'fill_opacity'],
    },
  };
}

/** Outline of the same polygons. Not a centreline or a ground track. */
export function launchHazardOutlineLayer(): LineLayer {
  return {
    id: 'launch-hazard-outline-layer',
    type: 'line',
    source: 'launch-hazards',
    layout: { visibility: getMapLaunchMode() ? 'visible' : 'none' },
    paint: {
      'line-color': '#ffd45c',
      'line-width': 1.5,
      'line-opacity': 0.95,
    },
  };
}

/** Gold corridor. Shown only while launch mode is on. */
export function ascentTrajectoryLayer(): LineLayer {
  return {
    id: 'ascent-trajectory-layer',
    type: 'line',
    source: 'ascent-trajectory',
    layout: { visibility: getMapLaunchMode() ? 'visible' : 'none' },
    paint: {
      'line-color': '#ffd45c',
      'line-width': 3,
      'line-opacity': 0.9,
    },
  };
}

/** Gold pad. Shown only while launch mode is on. */
export function ascentPadLayer(): CircleLayer {
  return {
    id: 'ascent-pad-layer',
    type: 'circle',
    source: 'ascent-pad',
    layout: { visibility: getMapLaunchMode() ? 'visible' : 'none' },
    paint: {
      'circle-radius': 7,
      'circle-color': '#ffd45c',
      'circle-stroke-color': '#0b0d12',
      'circle-stroke-width': 2,
      'circle-opacity': 0.95,
    },
  };
}
