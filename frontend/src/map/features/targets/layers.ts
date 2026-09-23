import { getMapLaunchMode } from '../../../map-launch-mode';
import type { CircleLayer } from '../../map-core/layer-spec';

/** Hollow ring under a personal target. Hidden while launch mode owns the map. */
export function myTargetsCasingLayer(): CircleLayer {
  return {
    id: 'my-targets-casing',
    type: 'circle',
    source: 'my-targets',
    layout: { visibility: getMapLaunchMode() ? 'none' : 'visible' },
    paint: {
      'circle-radius': 9,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#0b0d12',
      'circle-stroke-width': 4,
      'circle-stroke-opacity': 0.7,
    },
  };
}

/** White ring for every saved target, pass or not. */
export function myTargetsLayer(): CircleLayer {
  return {
    id: 'my-targets-layer',
    type: 'circle',
    source: 'my-targets',
    layout: { visibility: getMapLaunchMode() ? 'none' : 'visible' },
    paint: {
      'circle-radius': 9,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
      'circle-stroke-opacity': 0.95,
    },
  };
}

/** Score-colored pass pins. `in_window` selects full opacity versus dimmed. */
export function targetsLayer(): CircleLayer {
  return {
    id: 'targets-layer',
    type: 'circle',
    source: 'targets',
    layout: { visibility: getMapLaunchMode() ? 'none' : 'visible' },
    paint: {
      'circle-radius': 6,
      'circle-color': [
        'interpolate',
        ['linear'],
        ['get', 'score'],
        0, '#ff6464',
        30, '#ffce4d',
        60, '#5be37a',
      ],
      'circle-stroke-color': '#0b0d12',
      'circle-stroke-width': 1.5,
      'circle-opacity': [
        'case',
        ['==', ['get', 'in_window'], true], 0.95,
        0.25,
      ],
      'circle-stroke-opacity': [
        'case',
        ['==', ['get', 'in_window'], true], 1.0,
        0.3,
      ],
    },
  };
}
