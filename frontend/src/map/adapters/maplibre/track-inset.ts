import { Map, Marker, type LngLat, type Map as MapLibreMap } from 'maplibre-gl';
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

/** A 274px column needs a zoom below 0 to hold one orbit. */
const INSET_MIN_ZOOM = -2;

/** Half the 40px ISS marker, plus 2px, so the icon stays inside the canvas. */
const INSET_FIT_PADDING_PX = 22;

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

type InsetFrame = HTMLElement & { __opdTrackInset?: MapLibreMap };

export type TrackInset = {
  show(features: readonly GeoJSON.Feature[] | null, position: LonLat | null): void;
  destroy(): void;
};

/** Returns the requested camera. The default constrain fills a tall frame and pushes a full orbit off the canvas. */
export function letterboxCamera(center: LngLat, zoom: number): { center: LngLat; zoom: number } {
  return { center, zoom };
}

export function createTrackInset(frame: HTMLElement, markerElement: HTMLElement): TrackInset {
  const map: MapLibreMap = new Map({
    container: frame,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    minZoom: INSET_MIN_ZOOM,
    renderWorldCopies: false,
    transformConstrain: letterboxCamera,
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
  const insetFrame = frame as InsetFrame;
  insetFrame.__opdTrackInset = map;
  frame.dataset.insetLabelTiles = '0';
  map.on('sourcedata', (event) => {
    if (event.sourceId !== 'inset-labels' || event.tile == null) return;
    const count = Number(frame.dataset.insetLabelTiles ?? '0') + 1;
    frame.dataset.insetLabelTiles = String(count);
  });
  const marker = new Marker({ element: markerElement, anchor: 'center' });
  let removed = false;
  let track: readonly GeoJSON.Feature[] | null = null;
  let position: LonLat | null = null;
  let trackDirty = false;
  let fittedWidth = -1;
  let fittedHeight = -1;
  const apply = (): void => {
    if (removed || !map.isStyleLoaded()) return;
    map.resize();
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    const sizeChanged = width !== fittedWidth || height !== fittedHeight;
    const shouldFit = track !== null && (trackDirty || sizeChanged) && width >= 2 && height >= 2;
    if (track && trackDirty) {
      const source = map.getSource('inset-track');
      if (source && 'setData' in source && typeof source.setData === 'function') {
        source.setData({ type: 'FeatureCollection', features: track.slice() });
      }
      trackDirty = false;
    }
    if (shouldFit && track) {
      const bounds = insetTrackBounds(track, position);
      if (bounds) {
        map.fitBounds(bounds, { padding: INSET_FIT_PADDING_PX, maxZoom: INSET_FIT_MAX_ZOOM, animate: false });
        fittedWidth = width;
        fittedHeight = height;
      }
    }
    if (position) {
      marker.setLngLat([position.lon, position.lat]).addTo(map);
      if (fittedWidth < 0 && width >= 2 && height >= 2) {
        map.jumpTo({ center: [position.lon, position.lat], zoom: 1.4 });
        fittedWidth = width;
        fittedHeight = height;
      }
    }
  };
  if (map.isStyleLoaded()) apply();
  else map.once('load', apply);
  return {
    show(features, nextPosition) {
      if (removed) return;
      if (features) {
        track = features;
        trackDirty = true;
        fittedWidth = -1;
        fittedHeight = -1;
      }
      position = nextPosition;
      apply();
    },
    destroy() {
      if (removed) return;
      removed = true;
      marker.remove();
      map.remove();
      delete insetFrame.__opdTrackInset;
    },
  };
}
