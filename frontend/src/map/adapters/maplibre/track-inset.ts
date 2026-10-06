import { Map, Marker, type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { insetTrackBounds, type LonLat } from '../../../insets/bounds';

const CARTO_TILES = [
  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
];

/** Same reference raster the map tab draws. CARTO country text starts at zoom 3, and a full orbit fits near zoom 2. */
const ESRI_LABEL_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
];

/** Caps the fit. A tighter track zooms in and the reference tiles get denser. A full orbit stays near zoom 2, where those tiles still name countries. */
const INSET_FIT_MAX_ZOOM = 5;

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export type TrackInset = {
  show(features: readonly GeoJSON.Feature[] | null, position: LonLat | null): void;
  destroy(): void;
};

export function createTrackInset(frame: HTMLElement, markerElement: HTMLElement): TrackInset {
  const map: MapLibreMap = new Map({
    container: frame,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    style: {
      version: 8,
      sources: {
        'inset-basemap': { type: 'raster', tiles: CARTO_TILES, tileSize: 256 },
        'inset-labels': { type: 'raster', tiles: ESRI_LABEL_TILES, tileSize: 256, maxzoom: 19 },
        'inset-track': { type: 'geojson', data: EMPTY },
      },
      layers: [
        { id: 'inset-basemap', type: 'raster', source: 'inset-basemap' },
        { id: 'inset-labels', type: 'raster', source: 'inset-labels', paint: { 'raster-opacity': 0.85 } },
        {
          id: 'inset-track',
          type: 'line',
          source: 'inset-track',
          paint: { 'line-color': '#5cd0ff', 'line-width': 2 },
        },
      ],
    },
  });
  frame.dataset.insetLabelTiles = '0';
  map.on('sourcedata', (event) => {
    if (event.sourceId !== 'inset-labels' || event.tile == null) return;
    const count = Number(frame.dataset.insetLabelTiles ?? '0') + 1;
    frame.dataset.insetLabelTiles = String(count);
  });
  const marker = new Marker({ element: markerElement, anchor: 'center' });
  let removed = false;
  let fitted = false;
  let pendingFeatures: readonly GeoJSON.Feature[] | null = null;
  let pendingPosition: LonLat | null = null;
  const apply = (): void => {
    if (removed || !map.isStyleLoaded()) return;
    map.resize();
    if (pendingFeatures) {
      const source = map.getSource('inset-track');
      if (source && 'setData' in source && typeof source.setData === 'function') {
        source.setData({ type: 'FeatureCollection', features: pendingFeatures.slice() });
      }
      const bounds = insetTrackBounds(pendingFeatures, pendingPosition);
      if (bounds) {
        map.fitBounds(bounds, { padding: 12, maxZoom: INSET_FIT_MAX_ZOOM, animate: false });
        fitted = true;
      }
      pendingFeatures = null;
    }
    if (pendingPosition) {
      marker.setLngLat([pendingPosition.lon, pendingPosition.lat]).addTo(map);
      if (!fitted) {
        map.jumpTo({ center: [pendingPosition.lon, pendingPosition.lat], zoom: 1.4 });
        fitted = true;
      }
    }
  };
  if (map.isStyleLoaded()) apply();
  else map.once('load', apply);
  return {
    show(features, position) {
      if (removed) return;
      if (features) {
        pendingFeatures = features;
        fitted = false;
      }
      pendingPosition = position;
      apply();
    },
    destroy() {
      if (removed) return;
      removed = true;
      marker.remove();
      map.remove();
    },
  };
}
