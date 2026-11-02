import { Map, Marker, type LngLat, type Map as MapLibreMap, type SymbolLayerSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { insetTrackBounds, type LonLat } from '../../../insets/bounds';
import { terminatorNightPolygonFeatures } from '../../../terminator';
import countryRasterLevels from './country-raster-levels.json' with { type: 'json' };

const ESRI_DARK_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
];

/** Reference raster. Painted tile zooms live in country-raster-levels.json. */
const ESRI_LABEL_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
];

/** Audited national-name tile levels and their Mercator lettering bounds in each raster service. */
const COUNTRY_RASTER_LEVELS: {
  through: number;
  countries: Record<string, readonly number[]>;
  bounds?: Record<string, Record<string, readonly { service: string; box: readonly number[] }[]>>;
} = countryRasterLevels;

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

/** Caps the fit. A tighter track zooms in. A full orbit stays below zoom 2. */
const INSET_FIT_MAX_ZOOM = 5;

/** Caps a pinch or a wheel. Past this the dark basemap is only pixels. */
const INSET_MAX_ZOOM = 8;

const INSET_GLYPHS = '/glyphs/{fontstack}/{range}.pbf';
const INSET_GLYPH_RANGE = '/glyphs/Open%20Sans%20Regular/0-255.pbf';

/** A 274px column needs a zoom below 0 to hold one orbit. */
const INSET_MIN_ZOOM = -2;

/** Half the 40px ISS marker, plus 2px, so the icon stays inside the canvas. */
const INSET_FIT_PADDING_PX = 22;

/** One click opens the Map tab. A second click inside this window recenters instead. */
const PLAN_OPEN_DELAY_MS = 280;

/** A move past this, or a second touch, is a gesture. Releasing it does not open Map. */
const PLAN_NAV_SLOP_PX = 1;

/** A wheel can leave scroll-zoom active for as long as it keeps ticking. A deferred resize paints after this delay. A pointer that is still down waits until it ends. */
export const PLAN_WHEEL_RESIZE_CAP_MS = 1000;

const NIGHT_MINUTE_MS = 60_000;

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** A tile-0 hole cannot use maxzoom below 0. The geojson worker buckets overscaled zoom 0, and `isHidden(0)` drops that layer. */
const TILE_ZERO_HIDE_AT = -0.5;

type SymbolBand = { minzoom?: number; maxzoom?: number; hideAt?: number };

function holeBands(painted: readonly number[], through: number): SymbolBand[] {
  const has = new Set(painted);
  const holes: number[] = [];
  for (let tile = 0; tile <= through; tile += 1) {
    if (!has.has(tile)) holes.push(tile);
  }
  const bands: SymbolBand[] = [];
  let index = 0;
  while (index < holes.length) {
    let end = index;
    while (end + 1 < holes.length && holes[end + 1] === holes[end]! + 1) end += 1;
    const first = holes[index]!;
    const last = holes[end]!;
    const band: SymbolBand = {};
    if (first === 0 && last === 0) {
      band.hideAt = TILE_ZERO_HIDE_AT;
    } else {
      if (first > 0) band.minzoom = first - 1.5;
      if (!(last === through && !has.has(through))) band.maxzoom = last - 0.5;
    }
    bands.push(band);
    index = end + 1;
  }
  return bands;
}

function bandKey(band: SymbolBand): string {
  if (band.hideAt != null) return `hide-${String(band.hideAt).replace('-', 'n').replace('.', '-')}`;
  const min = band.minzoom == null ? 'floor' : String(band.minzoom).replace('-', 'n').replace('.', '-');
  const max = band.maxzoom == null ? 'ceil' : String(band.maxzoom).replace('-', 'n').replace('.', '-');
  return `${min}-${max}`;
}

function coversView(band: SymbolBand, zoom: number): boolean {
  if (band.hideAt != null && zoom >= band.hideAt) return false;
  const min = band.minzoom ?? Number.NEGATIVE_INFINITY;
  const max = band.maxzoom ?? Number.POSITIVE_INFINITY;
  return zoom >= min && zoom < max;
}

const COUNTRY_TEXT_LAYOUT: SymbolLayerSpecification['layout'] = {
  'text-field': ['get', 'name'],
  'text-font': ['Open Sans Regular'],
  'text-size': 12,
  'text-variable-anchor-offset': ['match', ['get', 'name'], 'Kenya',
    ['literal', ['top', [0, 1.5], 'bottom', [0, -1.5], ...countryPlacementCandidates()]],
    ['literal', countryPlacementCandidates()]],
  'symbol-sort-key': ['match', ['get', 'name'], 'Nigeria', 0, 'Kenya', 1, 2],
};

/** Try nearby free space before moving a crowded fitted-world label farther from its centroid. */
function countryPlacementCandidates(): Array<string | [number, number]> {
  const candidates: Array<string | [number, number]> = ['center', [0, 0]];
  for (const offset of [0.6, 1.5, 2]) {
    candidates.push('left', [offset, 0], 'right', [-offset, 0], 'top', [0, offset], 'bottom', [0, -offset],
      'top-left', [offset, offset], 'top-right', [-offset, offset], 'bottom-left', [offset, -offset], 'bottom-right', [-offset, -offset]);
  }
  return candidates;
}

const COUNTRY_TEXT_PAINT: SymbolLayerSpecification['paint'] = {
  'text-color': '#f7f4ea',
  'text-halo-color': '#02040c',
  'text-halo-width': 1.4,
};

/** Symbol layers for the centroid names. A layer is on only where round(viewZoom + 1) is missing from that country's painted tiles. */
function countrySymbolLayers() {
  const grouped: Record<string, { band: SymbolBand; names: string[] }> = {};
  for (const [name, painted] of Object.entries(COUNTRY_RASTER_LEVELS.countries)) {
    for (const band of holeBands(painted, COUNTRY_RASTER_LEVELS.through)) {
      const key = bandKey(band);
      const group = grouped[key] ?? { band, names: [] };
      group.names.push(name);
      grouped[key] = group;
    }
  }
  const groups = Object.values(grouped);
  const primary = groups.reduce((best, group) => {
    if (!coversView(group.band, 0)) return best;
    if (!best || group.names.length > best.names.length) return group;
    return best;
  }, null as { band: SymbolBand; names: string[] } | null);
  return groups
    .sort((left, right) => (left.band.minzoom ?? -Infinity) - (right.band.minzoom ?? -Infinity)
      || (left.band.maxzoom ?? Infinity) - (right.band.maxzoom ?? Infinity))
    .map((group) => ({
      id: group === primary ? 'inset-countries' : `inset-countries-${bandKey(group.band)}`,
      type: 'symbol' as const,
      source: 'inset-countries',
      ...(group.band.minzoom == null ? {} : { minzoom: group.band.minzoom }),
      ...(group.band.maxzoom == null ? {} : { maxzoom: group.band.maxzoom }),
      filter: ['in', ['get', 'name'], ['literal', group.names]] as ['in', ['get', 'name'], ['literal', string[]]],
      layout: COUNTRY_TEXT_LAYOUT,
      paint: {
        ...COUNTRY_TEXT_PAINT,
        ...(group.band.hideAt == null ? {} : { 'text-opacity': ['step', ['zoom'], 1, group.band.hideAt, 0] as ['step', ['zoom'], 1, number, 0] }),
      },
    }));
}

const COUNTRY_SYMBOL_LAYERS = countrySymbolLayers();

type ScreenBox = { left: number; top: number; right: number; bottom: number };

/** A raster name owns the label only when its complete lettering is visible above the inset chrome. */
export function readableCountryName(box: ScreenBox, viewport: ScreenBox, occlusions: readonly ScreenBox[]): boolean {
  return box.left >= viewport.left && box.top >= viewport.top
    && box.right <= viewport.right && box.bottom <= viewport.bottom
    && !occlusions.some((cover) => box.left < cover.right && box.right > cover.left
      && box.top < cover.bottom && box.bottom > cover.top);
}

function mercatorLngLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}

function viewportFallbacks(map: MapLibreMap, frame: HTMLElement): string[] {
  const zoom = map.getZoom();
  const tile = Math.min(COUNTRY_RASTER_LEVELS.through, Math.max(0, Math.round(zoom + 1)));
  const frameBox = frame.getBoundingClientRect();
  const viewport = { left: 0, top: 0, right: frame.clientWidth, bottom: frame.clientHeight };
  const occlusions = Array.from(frame.ownerDocument.querySelectorAll('[data-iss-clock], [data-iss-edition], [data-iss-split-chrome]'))
    .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left - frameBox.left, top: box.top - frameBox.top, right: box.right - frameBox.left, bottom: box.bottom - frameBox.top };
    });
  return COUNTRY_CENTROIDS.features.flatMap((feature) => {
    if (feature.geometry.type !== 'Point') return [];
    const name = String(feature.properties?.name);
    const painted = COUNTRY_RASTER_LEVELS.countries[name] ?? [];
    if (!painted.includes(tile)) return [];
    const anchor = map.project(feature.geometry.coordinates as [number, number]);
    if (anchor.x < 0 || anchor.y < 0 || anchor.x > viewport.right || anchor.y > viewport.bottom) return [];
    const readable = (COUNTRY_RASTER_LEVELS.bounds?.[name]?.[tile] ?? []).some(({ box }) => {
      const start = map.project(mercatorLngLat(box[0]!, box[1]!));
      const end = map.project(mercatorLngLat(box[2]!, box[3]!));
      return readableCountryName({ left: start.x, top: start.y, right: end.x, bottom: end.y }, viewport, occlusions);
    });
    return readable ? [] : [name];
  });
}

type InsetFrame = HTMLElement & { __opdTrackInset?: MapLibreMap };

export type TrackInset = {
  show(features: readonly GeoJSON.Feature[] | null, position: LonLat | null, when?: Date): void;
  destroy(): void;
};

/** Returns the requested center. Zoom stays inside the inset minimum and maximum. The default constrain fills a tall frame and pushes a full orbit off the canvas. */
export function letterboxCamera(center: LngLat, zoom: number): { center: LngLat; zoom: number } {
  const clamped = Math.min(INSET_MAX_ZOOM, Math.max(INSET_MIN_ZOOM, zoom));
  return { center, zoom: clamped };
}

/** A freed camera keeps the operator's zoom. A fresh track or a resize frames the orbit again. */
export function planShouldRefit(freed: boolean, trackDirty: boolean, sizeChanged: boolean): boolean {
  if (freed) return false;
  return trackDirty || sizeChanged;
}

export function createTrackInset(frame: HTMLElement, markerElement: HTMLElement): TrackInset {
  const map: MapLibreMap = new Map({
    container: frame,
    interactive: true,
    attributionControl: false,
    fadeDuration: 0,
    minZoom: INSET_MIN_ZOOM,
    maxZoom: INSET_MAX_ZOOM,
    scrollZoom: true,
    dragPan: true,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    touchZoomRotate: true,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    renderWorldCopies: false,
    transformConstrain: letterboxCamera,
    style: {
      version: 8,
      glyphs: INSET_GLYPHS,
      sources: {
        'inset-basemap': { type: 'raster', tiles: ESRI_DARK_TILES, tileSize: 256, maxzoom: 20 },
        'inset-night': { type: 'geojson', data: EMPTY },
        'inset-labels': { type: 'raster', tiles: ESRI_LABEL_TILES, tileSize: 256, maxzoom: 19 },
        'inset-countries': { type: 'geojson', data: COUNTRY_CENTROIDS },
        'inset-track': { type: 'geojson', data: EMPTY },
      },
      layers: [
        { id: 'inset-basemap', type: 'raster', source: 'inset-basemap' },
        {
          id: 'inset-night',
          type: 'fill',
          source: 'inset-night',
          paint: { 'fill-color': '#000000', 'fill-opacity': 0.28 },
        },
        { id: 'inset-labels', type: 'raster', source: 'inset-labels', paint: { 'raster-opacity': 0.85 } },
        {
          id: 'inset-track',
          type: 'line',
          source: 'inset-track',
          paint: { 'line-color': '#5cd0ff', 'line-width': 2 },
        },
        ...COUNTRY_SYMBOL_LAYERS,
        {
          id: 'inset-countries-viewport',
          type: 'symbol',
          source: 'inset-countries',
          filter: ['in', ['get', 'name'], ['literal', []]],
          layout: {
            ...COUNTRY_TEXT_LAYOUT,
            'text-variable-anchor-offset': ['top', [0, 1.5], 'bottom', [0, -1.5], ...countryPlacementCandidates()],
          },
          paint: COUNTRY_TEXT_PAINT,
        },
      ],
    },
  });
  const insetFrame = frame as InsetFrame;
  insetFrame.__opdTrackInset = map;
  if (map.dragRotate) map.dragRotate.disable();
  if (map.touchZoomRotate) map.touchZoomRotate.disableRotation();
  const marker = new Marker({ element: markerElement, anchor: 'center' });
  let removed = false;
  let freed = false;
  let openTimer = 0;
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
  let whenMs: number | null = null;
  let nightKey = Number.NaN;
  let trackDirty = false;
  let fittedWidth = -1;
  let fittedHeight = -1;
  let viewportNames = '';
  const syncCountryLabels = (): void => {
    if (removed || !map.isStyleLoaded() || frame.clientWidth < 2 || frame.clientHeight < 2) return;
    const names = viewportFallbacks(map, frame);
    const key = names.join('|');
    if (key === viewportNames) return;
    viewportNames = key;
    map.setFilter('inset-countries-viewport', ['in', ['get', 'name'], ['literal', names]]);
  };
  map.on('render', syncCountryLabels);
  let paintedWidth = -1;
  let paintedHeight = -1;
  let paintedRatio = -1;
  const activePointers = new Set<number>();
  let navMoved = false;
  let navMulti = false;
  let navOrigin: { x: number; y: number } | null = null;
  let resizeWaiting = false;
  let wheelCapTimer = 0;
  const resizeNow = map.resize.bind(map);
  const clearWheelCap = (): void => {
    window.clearTimeout(wheelCapTimer);
    wheelCapTimer = 0;
  };
  const armWheelCap = (): void => {
    if (wheelCapTimer !== 0 || removed) return;
    wheelCapTimer = window.setTimeout(() => {
      wheelCapTimer = 0;
      if (removed || !resizeWaiting || activePointers.size > 0) return;
      resizeWaiting = false;
      resizeNow();
    }, PLAN_WHEEL_RESIZE_CAP_MS);
  };
  const flushResize = (): void => {
    if (!resizeWaiting || activePointers.size > 0) return;
    if (map.scrollZoom?.isZooming()) {
      armWheelCap();
      return;
    }
    clearWheelCap();
    map.resize();
  };
  const settleResize = (): void => {
    flushResize();
    queueMicrotask(() => {
      if (activePointers.size === 0) flushResize();
    });
  };
  Object.defineProperty(map, 'resize', {
    configurable: true,
    value(eventData?: object, constrainTransform?: boolean) {
      if (activePointers.size > 0) {
        resizeWaiting = true;
        clearWheelCap();
        return map;
      }
      if (map.scrollZoom?.isZooming()) {
        resizeWaiting = true;
        armWheelCap();
        return map;
      }
      clearWheelCap();
      resizeWaiting = false;
      return resizeNow(eventData, constrainTransform);
    },
  });
  const stopClick = (event: Event): void => {
    event.stopPropagation();
  };
  const onWheel = (event: WheelEvent): void => {
    if (event.deltaX === 0 && event.deltaY === 0) return;
    freed = true;
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (activePointers.has(event.pointerId)) return;
    if (activePointers.size === 0) {
      navMoved = false;
      navMulti = false;
      navOrigin = { x: event.clientX, y: event.clientY };
    } else {
      navMulti = true;
    }
    activePointers.add(event.pointerId);
    clearWheelCap();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!navOrigin || !activePointers.has(event.pointerId)) return;
    const dx = event.clientX - navOrigin.x;
    const dy = event.clientY - navOrigin.y;
    if (dx * dx + dy * dy > PLAN_NAV_SLOP_PX * PLAN_NAV_SLOP_PX) navMoved = true;
  };
  const onPointerEnd = (event: PointerEvent): void => {
    if (!activePointers.delete(event.pointerId)) return;
    if (activePointers.size === 0) settleResize();
  };
  const onWindowBlur = (): void => {
    if (activePointers.size === 0) return;
    activePointers.clear();
    settleResize();
  };
  frame.addEventListener('click', stopClick);
  frame.addEventListener('wheel', onWheel, { capture: true, passive: true });
  frame.addEventListener('pointerdown', onPointerDown, true);
  frame.addEventListener('pointermove', onPointerMove, true);
  frame.addEventListener('pointerup', onPointerEnd, true);
  frame.addEventListener('pointercancel', onPointerEnd, true);
  frame.addEventListener('lostpointercapture', onPointerEnd, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerEnd, true);
  window.addEventListener('pointercancel', onPointerEnd, true);
  window.addEventListener('lostpointercapture', onPointerEnd, true);
  window.addEventListener('blur', onWindowBlur);
  const openPlan = (): void => {
    const button = frame.closest('button');
    if (button instanceof HTMLButtonElement) button.click();
  };
  const refit = (): void => {
    freed = false;
    fittedWidth = -1;
    fittedHeight = -1;
    apply();
  };
  map.on('movestart', (event) => {
    if (event.originalEvent) freed = true;
  });
  map.on('moveend', () => {
    flushResize();
  });
  map.on('click', () => {
    if (navMoved || navMulti) {
      navMoved = false;
      navMulti = false;
      navOrigin = null;
      return;
    }
    window.clearTimeout(openTimer);
    openTimer = window.setTimeout(openPlan, PLAN_OPEN_DELAY_MS);
  });
  map.on('dblclick', (event) => {
    window.clearTimeout(openTimer);
    openTimer = 0;
    event.preventDefault();
    refit();
  });
  const apply = (): void => {
    if (removed || !map.isStyleLoaded()) return;
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    const ratio = window.devicePixelRatio;
    if (width !== paintedWidth || height !== paintedHeight || ratio !== paintedRatio) {
      paintedWidth = width;
      paintedHeight = height;
      paintedRatio = ratio;
      map.resize();
    }
    const sizeChanged = width !== fittedWidth || height !== fittedHeight;
    if (track && trackDirty) {
      const source = map.getSource('inset-track');
      if (source && 'setData' in source && typeof source.setData === 'function') {
        source.setData({ type: 'FeatureCollection', features: track.slice() });
      }
      trackDirty = false;
    }
    if (whenMs !== null) {
      const key = Math.floor(whenMs / NIGHT_MINUTE_MS);
      if (key !== nightKey) {
        nightKey = key;
        const source = map.getSource('inset-night');
        if (source && 'setData' in source && typeof source.setData === 'function') {
          source.setData({
            type: 'FeatureCollection',
            features: terminatorNightPolygonFeatures(new Date(whenMs)),
          });
        }
      }
    }
    if (planShouldRefit(freed, track !== null && fittedWidth < 0, sizeChanged) && track && width >= 2 && height >= 2) {
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
    show(features, nextPosition, when) {
      if (removed) return;
      if (features) {
        track = features;
        trackDirty = true;
        if (!freed) {
          fittedWidth = -1;
          fittedHeight = -1;
        }
      }
      position = nextPosition;
      if (when) whenMs = when.getTime();
      apply();
    },
    destroy() {
      if (removed) return;
      removed = true;
      window.clearTimeout(openTimer);
      clearWheelCap();
      frame.removeEventListener('click', stopClick);
      frame.removeEventListener('wheel', onWheel, true);
      frame.removeEventListener('pointerdown', onPointerDown, true);
      frame.removeEventListener('pointermove', onPointerMove, true);
      frame.removeEventListener('pointerup', onPointerEnd, true);
      frame.removeEventListener('pointercancel', onPointerEnd, true);
      frame.removeEventListener('lostpointercapture', onPointerEnd, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('lostpointercapture', onPointerEnd, true);
      window.removeEventListener('blur', onWindowBlur);
      marker.remove();
      map.remove();
      delete insetFrame.__opdTrackInset;
    },
  };
}
