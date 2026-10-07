import { Map, Marker, type LngLat, type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { insetTrackBounds, type LonLat } from '../../../insets/bounds';

const CARTO_TILES = [
  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
];

/** Reference raster. It draws boundaries at zoom 0–2 and country names only once the fit zooms in. */
const ESRI_LABEL_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
];

/** Caps the fit. A tighter track zooms in. A full orbit stays below zoom 2. */
const INSET_FIT_MAX_ZOOM = 5;

const INSET_GLYPHS = '/glyphs/{fontstack}/{range}.pbf';
const INSET_GLYPH_RANGE = '/glyphs/Open%20Sans%20Regular/0-255.pbf';

const COUNTRY_CENTROIDS: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Canada' }, geometry: { type: 'Point', coordinates: [-100, 50] } },
    { type: 'Feature', properties: { name: 'Mexico' }, geometry: { type: 'Point', coordinates: [-102, 23] } },
    { type: 'Feature', properties: { name: 'Brazil' }, geometry: { type: 'Point', coordinates: [-55, -10] } },
    { type: 'Feature', properties: { name: 'Argentina' }, geometry: { type: 'Point', coordinates: [-64, -34] } },
    { type: 'Feature', properties: { name: 'France' }, geometry: { type: 'Point', coordinates: [2, 46] } },
    { type: 'Feature', properties: { name: 'Egypt' }, geometry: { type: 'Point', coordinates: [30, 26] } },
    { type: 'Feature', properties: { name: 'Nigeria' }, geometry: { type: 'Point', coordinates: [8, 10] } },
    { type: 'Feature', properties: { name: 'Kenya' }, geometry: { type: 'Point', coordinates: [38, 1] } },
    { type: 'Feature', properties: { name: 'China' }, geometry: { type: 'Point', coordinates: [104, 35] } },
    { type: 'Feature', properties: { name: 'India' }, geometry: { type: 'Point', coordinates: [79, 22] } },
    { type: 'Feature', properties: { name: 'Japan' }, geometry: { type: 'Point', coordinates: [138, 36] } },
    { type: 'Feature', properties: { name: 'Australia' }, geometry: { type: 'Point', coordinates: [134, -25] } },
  ],
};

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
      glyphs: INSET_GLYPHS,
      sources: {
        'inset-basemap': { type: 'raster', tiles: CARTO_TILES, tileSize: 256 },
        'inset-labels': { type: 'raster', tiles: ESRI_LABEL_TILES, tileSize: 256, maxzoom: 19 },
        'inset-countries': { type: 'geojson', data: COUNTRY_CENTROIDS },
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
        {
          id: 'inset-countries',
          type: 'symbol',
          source: 'inset-countries',
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Open Sans Regular'],
            'text-size': 12,
          },
          paint: {
            'text-color': '#f7f4ea',
            'text-halo-color': '#02040c',
            'text-halo-width': 1.4,
          },
        },
      ],
    },
  });
  const insetFrame = frame as InsetFrame;
  insetFrame.__opdTrackInset = map;
  const marker = new Marker({ element: markerElement, anchor: 'center' });
  let removed = false;
  void fetch(INSET_GLYPH_RANGE)
    .then(async (response) => {
      if (!response.ok) return;
      const bytes = await response.arrayBuffer();
      if (removed || bytes.byteLength < 10000) return;
      frame.dataset.insetGlyphs = String(bytes.byteLength);
    })
    .catch(() => {});
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
