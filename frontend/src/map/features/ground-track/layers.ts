import type { LineLayer } from '../../map-core/layer-spec';

/** ISS ground track. Illumination picks the hue, orbit index the shade
 *  and the opacity ramp. A feature with no illumination paints as day. */
export const ISS_TRACK_LAYER: LineLayer = {
  id: 'iss-track-layer',
  type: 'line',
  source: 'iss-track',
  paint: {
    'line-color': [
      'match',
      ['coalesce', ['get', 'illumination'], 'iss-day'],
      'iss-day', [
        'match', ['coalesce', ['get', 'orbit_index'], 0],
        0, '#5cd0ff',
        1, '#5ce0c8',
        2, '#7cd99c',
        3, '#a8d680',
        '#5cd0ff',
      ],
      'iss-twilight', [
        'match', ['coalesce', ['get', 'orbit_index'], 0],
        0, '#d65cff',
        1, '#d680e0',
        2, '#cc94c8',
        3, '#bca0a8',
        '#d65cff',
      ],
      'iss-eclipse', [
        'match', ['coalesce', ['get', 'orbit_index'], 0],
        0, '#7a8aa8',
        1, '#7392ac',
        2, '#6c9aac',
        3, '#65a0a0',
        '#7a8aa8',
      ],
      '#5cd0ff',
    ],
    'line-width': 2,
    'line-opacity': [
      'match',
      ['coalesce', ['get', 'orbit_index'], 0],
      0, 0.85,
      1, 0.55,
      2, 0.35,
      3, 0.2,
      0.12,
    ],
    'line-dasharray': [2, 1],
  },
};
