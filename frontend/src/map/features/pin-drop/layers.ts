import type { CircleLayer } from '../../map-core/layer-spec';

export const DROPPED_PIN_LAYER: CircleLayer = {
  id: 'dropped-pin-layer',
  type: 'circle',
  source: 'dropped-pin',
  paint: {
    'circle-radius': 11,
    'circle-color': '#5cd0ff',
    'circle-stroke-color': '#0b0d12',
    'circle-stroke-width': 3,
    'circle-opacity': 1.0,
  },
};

export const NO_PIN: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export type Pin = { lat: number; lon: number; precision: number };

export function pinFeature({ lat, lon, precision }: Pin): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { lat, lon, precision },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    }],
  };
}
