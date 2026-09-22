import type { BackgroundLayer, RasterLayer } from '../../map-core/layer-spec';

/** Whole-map dim for lights-only mode. Hidden while the terminator's
 *  night fill is doing that job. */
export const GLOBAL_DIM_LAYER: BackgroundLayer = {
  id: 'night-lights-global-dim-layer',
  type: 'background',
  layout: { visibility: 'none' },
  paint: {
    'background-color': '#000000',
    'background-opacity': 0.30,
  },
};

/** VIIRS Black Marble. Hidden until the operator turns it on. The source
 *  is in `buildStyle`; this is the runtime layer. */
export const NIGHT_LIGHTS_LAYER: RasterLayer = {
  id: 'viirs-night-lights-layer',
  type: 'raster',
  source: 'viirs-night-lights',
  layout: { visibility: 'none' },
  paint: { 'raster-opacity': 0.95 },
};

export const CANONICAL_VIIRS_DATE = '2016-01-01';
