import type { Visibility } from '../../map-core/layer-spec';

export type BasemapState = {
  cloudsVisible: boolean;
  irVisible: boolean;
  forecastFrameActive: boolean;
  esriTilesFailed: boolean;
};

/** The one decision that picks the basemap and the cloud layers.
 *
 *  Clouds off, and IR off, shows Esri imagery. Clouds on, or IR on, shows
 *  the dark basemap, because both cloud layers are drawn for that backdrop.
 *  An active forecast frame replaces the observed cloud layer. A failed Esri
 *  session never swaps back to it. */
export function basemapVisibility(state: BasemapState): Record<
  'gibs-clouds-layer' | 'fcst-clouds-layer' | 'esri-imagery-layer' | 'carto-dark-layer',
  Visibility
> {
  const { cloudsVisible: clouds, irVisible: ir, forecastFrameActive: fcst } = state;
  const useEsri = !clouds && !ir && !state.esriTilesFailed;
  return {
    'gibs-clouds-layer': clouds && !fcst && !ir ? 'visible' : 'none',
    'fcst-clouds-layer': clouds && fcst && !ir ? 'visible' : 'none',
    'esri-imagery-layer': useEsri ? 'visible' : 'none',
    'carto-dark-layer': useEsri ? 'none' : 'visible',
  };
}
