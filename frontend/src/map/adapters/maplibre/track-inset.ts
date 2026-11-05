import { Map, Marker, type LngLat, type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { insetTrackBounds, type LonLat } from '../../../insets/bounds';
import { PLAN_RASTER_NAME_ZOOM, planTier, type PlanPlace } from '../../../insets/plan-labels';
import { terminatorNightPolygonFeatures } from '../../../terminator';
import { countryLabelCounts, letteringOccluded } from './country-label-size';
import countryRasterLevels from './country-raster-levels.json' with { type: 'json' };

const ESRI_DARK_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
];

/** Reference raster. Painted tile zooms live in country-raster-levels.json. */
const ESRI_LABEL_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
];

type RasterInk = { service: string; box: readonly number[]; ink?: readonly number[] };

/** Audited national-name tile levels and their Mercator lettering bounds in each raster service. */
const COUNTRY_RASTER_LEVELS: {
  through: number;
  countries: Record<string, readonly number[]>;
  bounds?: Record<string, Record<string, readonly RasterInk[]>>;
} = countryRasterLevels;

/** Caps the fit. A tighter track zooms in. A full orbit stays below zoom 2. */
const INSET_FIT_MAX_ZOOM = 5;

/** Caps a pinch or a wheel. Past this the dark basemap is only pixels. */
const INSET_MAX_ZOOM = 8;

const INSET_BASEMAP_MAX_ZOOM = 20;

/** Label tiles follow main. Capping at the audit overzooms the z6 border names into a second complete label. */
const INSET_LABEL_MAX_ZOOM = 19;

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

type ScreenBox = { left: number; top: number; right: number; bottom: number };

/** Reference-raster names checked against main as a second copy of the vector label. */
const DEMONSTRATED_DUPLICATE_RASTER: readonly { name: string; tile: number; service: 'reference' }[] = [
  { name: 'Canada', tile: 3, service: 'reference' },
];

function collection(places: readonly PlanPlace[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: places.map((place) => ({
      type: 'Feature' as const,
      properties: { name: place.name },
      geometry: { type: 'Point' as const, coordinates: [place.lon, place.lat] },
    })),
  };
}

/** Main's country symbol layer: centered placement, collision on, and a hard stop at zoom 3. */
export function countryLabelLayer() {
  return nameLayer('inset-countries', 'inset-countries', undefined, PLAN_RASTER_NAME_ZOOM);
}

function nameLayer(id: string, source: string, minzoom?: number, maxzoom?: number) {
  return {
    id,
    type: 'symbol' as const,
    source,
    ...(minzoom === undefined ? {} : { minzoom }),
    ...(maxzoom === undefined ? {} : { maxzoom }),
    layout: {
      'text-field': ['get', 'name'] as ['get', 'name'],
      'text-font': ['Open Sans Regular'],
      'text-size': 12,
    },
    paint: {
      'text-color': '#f7f4ea',
      'text-halo-color': '#02040c',
      'text-halo-width': 1.4,
    },
  };
}

function drawnTile(zoom: number, maxzoom: number): number {
  return Math.min(maxzoom, Math.max(0, Math.round(zoom + 1)));
}

function mercatorLngLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}

function projectInk(ink: readonly number[], project: (lngLat: [number, number]) => { x: number; y: number }): ScreenBox {
  const start = project(mercatorLngLat(ink[0]!, ink[1]!));
  const end = project(mercatorLngLat(ink[2]!, ink[3]!));
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

/** The vector stays unless this frame shows that country's complete name on the drawn reference tile. */
export function rasterShowsSameCountry(
  zoom: number,
  drawn: number,
  entry: { tile: number; service: string; ink?: readonly number[] } | undefined,
  project: (lngLat: [number, number]) => { x: number; y: number },
  viewport: ScreenBox,
  occlusions: readonly ScreenBox[],
): boolean {
  if (!(zoom < PLAN_RASTER_NAME_ZOOM)) return false;
  if (!entry || entry.tile !== drawn || entry.service !== 'reference' || !entry.ink) return false;
  if (!countryLabelCounts({ width: entry.ink[2]! - entry.ink[0]!, height: entry.ink[3]! - entry.ink[1]! })) return false;
  const box = projectInk(entry.ink, project);
  const inside = box.left >= viewport.left && box.top >= viewport.top && box.right <= viewport.right && box.bottom <= viewport.bottom;
  return inside && !letteringOccluded(box, occlusions);
}

function frameOcclusions(frame: HTMLElement): ScreenBox[] {
  const frameBox = frame.getBoundingClientRect();
  return Array.from(frame.ownerDocument.querySelectorAll('[data-iss-clock], [data-iss-edition], [data-iss-split-chrome]'))
    .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left - frameBox.left, top: box.top - frameBox.top, right: box.right - frameBox.left, bottom: box.bottom - frameBox.top };
    });
}

function rasterDuplicateView(map: MapLibreMap, frame: HTMLElement, item: { name: string; tile: number; service: 'reference' }) {
  const zoom = map.getZoom();
  const entries = COUNTRY_RASTER_LEVELS.bounds?.[item.name]?.[String(item.tile)] ?? [];
  const ink = entries.find((entry) => entry.service === item.service);
  return {
    zoom,
    drawn: drawnTile(zoom, INSET_LABEL_MAX_ZOOM),
    entry: ink ? { tile: item.tile, service: item.service, ink: ink.ink } : undefined,
    project: (lngLat: [number, number]) => map.project(lngLat),
    viewport: { left: 0, top: 0, right: frame.clientWidth, bottom: frame.clientHeight },
    occlusions: frameOcclusions(frame),
  };
}

function hiddenCountryNames(map: MapLibreMap, frame: HTMLElement): string[] {
  const hidden: string[] = [];
  for (const item of DEMONSTRATED_DUPLICATE_RASTER) {
    const view = rasterDuplicateView(map, frame, item);
    if (rasterShowsSameCountry(view.zoom, view.drawn, view.entry, view.project, view.viewport, view.occlusions)) hidden.push(item.name);
  }
  return hidden;
}

/** The Canada duplicate, as rasterShowsSameCountry sees this frame. */
export function canadaRasterView(map: MapLibreMap, frame: HTMLElement) {
  const item = DEMONSTRATED_DUPLICATE_RASTER.find((entry) => entry.name === 'Canada');
  return item ? rasterDuplicateView(map, frame, item) : null;
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
        'inset-basemap': { type: 'raster', tiles: ESRI_DARK_TILES, tileSize: 256, maxzoom: INSET_BASEMAP_MAX_ZOOM },
        'inset-night': { type: 'geojson', data: EMPTY },
        'inset-labels': { type: 'raster', tiles: ESRI_LABEL_TILES, tileSize: 256, maxzoom: INSET_LABEL_MAX_ZOOM },
        'inset-countries': { type: 'geojson', data: collection(planTier(0)) },
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
        countryLabelLayer(),
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
  let hiddenKey = '';
  const syncDuplicateLabels = (): void => {
    if (removed || !map.isStyleLoaded() || frame.clientWidth < 2 || frame.clientHeight < 2) return;
    const hidden = hiddenCountryNames(map, frame);
    const key = hidden.join('|');
    if (key === hiddenKey) return;
    hiddenKey = key;
    frame.dataset.insetHiddenCountries = key;
    map.setPaintProperty('inset-countries', 'text-opacity', key === '' ? 1 : ['case', ['in', ['get', 'name'], ['literal', hidden]], 0, 1]);
  };
  map.on('render', syncDuplicateLabels);
  map.on('move', syncDuplicateLabels);
  map.on('moveend', syncDuplicateLabels);
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
