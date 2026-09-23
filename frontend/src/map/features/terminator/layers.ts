import type { CircleLayer, FillLayer, LineLayer } from '../../map-core/layer-spec';

export const TERMINATOR_FILL_LAYER: FillLayer = {
  id: 'terminator-night-fill-layer',
  type: 'fill',
  source: 'terminator-night-fill',
  paint: {
    'fill-color': '#000000',
    'fill-opacity': 0.30,
    'fill-antialias': true,
  },
};

export const TERMINATOR_LINE_LAYER: LineLayer = {
  id: 'terminator-line-layer',
  type: 'line',
  source: 'terminator-line',
  paint: {
    'line-color': '#ffd45c',
    'line-width': 1.4,
    'line-opacity': 0.7,
    'line-dasharray': [3, 2],
    'line-blur': 40,
  },
};

export const SUBSOLAR_LAYER: CircleLayer = {
  id: 'subsolar-point-layer',
  type: 'circle',
  source: 'subsolar-point',
  paint: {
    'circle-radius': 8,
    'circle-color': '#ffd45c',
    'circle-stroke-color': '#0b0d12',
    'circle-stroke-width': 1.5,
    'circle-opacity': 0.95,
  },
};
