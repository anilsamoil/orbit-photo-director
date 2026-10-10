import './worker-url';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LayerSpecification, SourceSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

import {
  asLayerId,
  type GeoJsonSourceId,
  type LayerId,
  type RasterSourceId,
  type SourceId,
} from '../../map-core/catalog';
import type { BBox, LngLat, Point } from '../../map-core/geometry';
import type { LayerSpec, SourceSpec, StyleSpec, Visibility } from '../../map-core/layer-spec';
import type {
  CameraMove,
  Cursor,
  FitOptions,
  InitialCamera,
  LayerEvents,
  MarkerHandle,
  PopupHandle,
  Unsubscribe,
  VendorEvents,
  VendorMap,
  VendorMapOptions,
} from '../../map-core/vendor-map';
import { collapseAttribution } from './attribution';
import { layerListener, mapListener, toHit, toLngLat } from './events';

/** The MapLibre constructor options for an initial camera. Every gesture is
 *  on, the world repeats across the antimeridian, and the map page does not
 *  mount the attribution control. */
export function maplibreMapOptions(camera: InitialCamera): {
  center: LngLat;
  zoom: number;
  attributionControl: false;
  renderWorldCopies: true;
  dragPan: true;
  dragRotate: true;
  scrollZoom: true;
  touchZoomRotate: true;
  touchPitch: true;
} {
  return {
    center: camera.center,
    zoom: camera.zoom,
    attributionControl: false,
    renderWorldCopies: true,
    dragPan: true,
    dragRotate: true,
    scrollZoom: true,
    touchZoomRotate: true,
    touchPitch: true,
  };
}

/** The style as MapLibre receives it. Domain layer specs are a structural
 *  subset of the vendor's, differing only in how expressions are typed. */
export function maplibreStyle(style: StyleSpec): StyleSpecification {
  return {
    version: 8,
    sources: style.sources as StyleSpecification['sources'],
    layers: style.layers.map(toVendorLayer),
  };
}

function toVendorLayer(spec: LayerSpec): LayerSpecification {
  return spec as unknown as LayerSpecification;
}

function toVendorSource(spec: SourceSpec): SourceSpecification {
  return spec;
}

function mapInspector(map: maplibregl.Map): HTMLElement | null {
  if (typeof map.getContainer !== 'function') return null;
  return map.getContainer().closest('#map-pane')?.querySelector<HTMLElement>('#map-inspector') ?? null;
}

/** Park open popups outside the map's stacking context and reserve their space. */
function syncMapInspector(map: maplibregl.Map, applied: InspectorLayout): void {
  const slot = mapInspector(map);
  const pane = slot?.closest('#map-pane');
  if (!slot || !(pane instanceof HTMLElement)) return;
  for (const popup of map.getContainer().querySelectorAll('.maplibregl-popup')) slot.appendChild(popup);
  const open = slot.querySelector('.maplibregl-popup') !== null;
  pane.classList.toggle('map-inspector-open', open);
  slot.hidden = !open;
  if (open) boundMapInspector(map, applied);
  requestAnimationFrame(() => map.resize());
}

const INSPECTOR_CHROME = '.map-toolbar, .map-control-dock, .map-controls-time, #map-legend-toggle, #map-legend-panel, .maplibregl-ctrl-group, #map-chrome-toggle, #satellite-picker-panel, #map-launch-coverage';
const INSPECTOR_BANNERS = '#status-banner, #shotlist-bar';
const INSPECTOR_SURFACES = `${INSPECTOR_CHROME}, ${INSPECTOR_BANNERS}`;
/** Narrow maps keep this strip centered on the canvas so a framed drop stays on it.
 *  232px is `--map-hit-min` with a 0px safe area. */
const NARROW_HIT_BAND_PX = 232;

type InspectorRect = { left: number; top: number; right: number; bottom: number };
/** Preserve requested geometry alongside CSSOM's rounded pixel serialization. */
type InspectorLayout = Map<string, { value: number; serialized: string }>;

function inspectorChromeElements(pane: Element): Set<Element> {
  const chrome = [...pane.querySelectorAll(INSPECTOR_CHROME), ...document.querySelectorAll(INSPECTOR_BANNERS)];
  return new Set(chrome.flatMap((element) => [element, ...element.querySelectorAll('button, input, select, a')]));
}

function visibleInspectorRect(element: Element, clip: InspectorRect): InspectorRect | null {
  const rect = element.getBoundingClientRect();
  const result = {
    left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top),
    right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom),
  };
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return null;
    if (ancestor === element) continue;
    const bounds = ancestor.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      result.left = Math.max(result.left, bounds.left);
      result.right = Math.min(result.right, bounds.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      result.top = Math.max(result.top, bounds.top);
      result.bottom = Math.min(result.bottom, bounds.bottom);
    }
  }
  return result.right > result.left && result.bottom > result.top ? result : null;
}

/** Full-width band around the map center. Callers inflate it by the chrome gap. */
function narrowHitBand(mapRect: DOMRect): InspectorRect | null {
  if (mapRect.width <= 0 || mapRect.height <= 0) return null;
  const height = Math.min(NARROW_HIT_BAND_PX, mapRect.height);
  const top = mapRect.top + (mapRect.height - height) / 2;
  return { left: mapRect.left, top, right: mapRect.right, bottom: top + height };
}

/** Use painted chrome rectangles, including overflowing wrapped command children,
 *  without writing any chrome styles or changing its stacking order. */
function boundMapInspector(map: maplibregl.Map, applied: InspectorLayout): void {
  const slot = mapInspector(map);
  const pane = slot?.closest('#map-pane');
  if (!slot || !(pane instanceof HTMLElement) || slot.hidden) return;
  const paneRect = pane.getBoundingClientRect();
  const mapRect = map.getContainer().getBoundingClientRect();
  const gap = 8;
  const bounds = {
    left: Math.max(paneRect.left, mapRect.left, 0) + gap,
    top: Math.max(paneRect.top, mapRect.top, 0) + gap,
    right: Math.min(paneRect.right, mapRect.right, window.innerWidth) - gap,
    bottom: Math.min(paneRect.bottom, mapRect.bottom, window.innerHeight) - gap,
  };
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return;
  const obstacles = [...inspectorChromeElements(pane)].flatMap((element) => {
    const rect = visibleInspectorRect(element, bounds);
    return rect ? [{ left: rect.left - gap, top: rect.top - gap, right: rect.right + gap, bottom: rect.bottom + gap }] : [];
  });
  const narrow = paneRect.width < 900;
  if (narrow) {
    const band = narrowHitBand(mapRect);
    if (band) obstacles.push({ left: band.left - gap, top: band.top - gap, right: band.right + gap, bottom: band.bottom + gap });
  }
  const preferredWidth = narrow ? bounds.right - bounds.left : 320;
  const preferredHeight = narrow ? (paneRect.height <= 520 ? 120 : 260) : bounds.bottom - bounds.top;
  const lefts = [...new Set([bounds.left, ...obstacles.map((rect) => rect.right)])].filter((x) => x >= bounds.left && x < bounds.right);
  const rights = [...new Set([bounds.right, ...obstacles.map((rect) => rect.left)])].filter((x) => x > bounds.left && x <= bounds.right);
  let best: (InspectorRect & { score: number }) | null = null;
  for (const left of lefts) for (const right of rights) {
    const width = Math.min(preferredWidth, right - left);
    if (width <= 0) continue;
    const x = right - width;
    const blocked = obstacles.filter((rect) => rect.left < right && rect.right > x)
      .sort((a, b) => a.top - b.top);
    let top = bounds.top;
    for (const obstacle of [...blocked, { top: bounds.bottom, bottom: bounds.bottom }]) {
      const bottom = Math.min(bounds.bottom, obstacle.top);
      const height = Math.min(preferredHeight, bottom - top);
      if (height > 0) {
        const usable = width >= Math.min(240, preferredWidth) && height >= Math.min(96, preferredHeight);
        const score = (usable ? 1e9 : width >= 80 && height >= 80 ? 1e6 : 0) + width * Math.min(height, narrow ? preferredHeight : 600)
          + right / 1e4 + (narrow ? bottom * 1e3 : -top / 1e6);
        if (!best || score > best.score) best = {
          left: x, right, top: narrow ? bottom - height : top,
          bottom: narrow ? bottom : top + height, score,
        };
      }
      top = Math.max(top, obstacle.bottom);
    }
  }
  best ??= { left: bounds.left, right: bounds.left, top: bounds.top, bottom: bounds.top, score: 0 };
  const layout = {
    left: best.left - paneRect.left, top: best.top - paneRect.top,
    width: best.right - best.left, height: best.bottom - best.top,
  };
  for (const [property, value] of Object.entries(layout)) {
    const current = slot.style.getPropertyValue(property);
    const previous = applied.get(property);
    if (previous?.value === value && previous.serialized === current) continue;
    const pixels = `${value}px`;
    if (current !== pixels) slot.style.setProperty(property, pixels);
    applied.set(property, { value, serialized: slot.style.getPropertyValue(property) });
  }
}

/** Follow chrome and its layout ancestors only while a popup is open. Disclosure
 *  remeasures immediately and again after layout, so a later expand does not keep
 *  the collapsed shell. Inspector writes and map animation do not feed back, and
 *  updates never resize the map. */
function inspectorSync(map: maplibregl.Map): () => void {
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let observed = new Set<Element>();
  let pending = false;
  let dirty = false;
  let watching = false;
  let epoch = 0;
  const applied: InspectorLayout = new Map();
  const observeSizes = (): void => {
    const pane = mapInspector(map)?.closest('#map-pane');
    if (!pane) return;
    const next = new Set([pane, map.getContainer(), ...inspectorChromeElements(pane),
      ...pane.querySelectorAll('.map-controls-time > *')]);
    for (const element of [...next]) {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) next.add(ancestor);
    }
    for (const element of observed) if (!next.has(element)) resizeObserver?.unobserve(element);
    for (const element of next) if (!observed.has(element)) resizeObserver?.observe(element);
    observed = next;
  };
  const remeasure = (): void => {
    if (!watching) return;
    observeSizes();
    boundMapInspector(map, applied);
  };
  const schedule = (): void => {
    if (!watching) return;
    dirty = true;
    if (pending) return;
    pending = true;
    const scheduledEpoch = epoch;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scheduledEpoch !== epoch) return;
        pending = false;
        if (!watching || !dirty) return;
        dirty = false;
        remeasure();
        if (dirty) schedule();
      });
    });
  };
  const remeasureDisclosure = (): void => {
    remeasure();
    schedule();
  };
  const watchedChrome = (element: Element, slot: HTMLElement): boolean =>
    !slot.contains(element)
    && !element.matches('.maplibregl-ctrl-compass .maplibregl-ctrl-icon')
    && (observed.has(element) || element.closest(INSPECTOR_SURFACES) !== null || element.querySelector(INSPECTOR_SURFACES) !== null);
  return () => {
    syncMapInspector(map, applied);
    const slot = mapInspector(map);
    const pane = slot?.closest('#map-pane');
    if (!slot || !pane) return;
    if (slot.hidden) {
      watching = false;
      dirty = false;
      pending = false;
      epoch += 1;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = null;
      mutationObserver = null;
      observed.clear();
      window.removeEventListener('resize', schedule);
      return;
    }
    if (watching) return;
    watching = true;
    if (typeof ResizeObserver !== 'undefined') resizeObserver = new ResizeObserver(schedule);
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver((records) => {
        let disclosure = false;
        let later = false;
        for (const record of records) {
          const element = record.target instanceof Element ? record.target : record.target.parentElement;
          if (!element || !watchedChrome(element, slot)) continue;
          const attribute = record.attributeName;
          if (record.type === 'childList' || attribute === 'class' || attribute === 'hidden'
            || attribute === 'aria-expanded' || attribute === 'aria-hidden') disclosure = true;
          else later = true;
        }
        if (disclosure) remeasureDisclosure();
        else if (later) schedule();
      });
      mutationObserver.observe(pane, { attributes: true, childList: true, subtree: true, characterData: true });
      mutationObserver.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
      mutationObserver.observe(document.documentElement, { attributes: true });
    }
    observeSizes();
    window.addEventListener('resize', schedule);
    schedule();
  };
}

function exposeForEndToEnd(map: maplibregl.Map): void {
  if (typeof window === 'undefined') return;
  if (!new URLSearchParams(window.location.search).has('e2e')) return;
  (window as unknown as { __opdMap?: maplibregl.Map }).__opdMap = map;
}

export function createVendorMap(options: VendorMapOptions): VendorMap {
  const map = new maplibregl.Map({
    container: options.container,
    style: maplibreStyle(options.style),
    ...maplibreMapOptions(options.camera),
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-left');
  collapseAttribution(options.container);
  exposeForEndToEnd(map);
  const syncInspector = inspectorSync(map);

  return {
    whenLoaded: () => new Promise<void>((resolve) => map.once('load', () => resolve())),
    resize: () => map.resize(),

    hasLayer: (id: LayerId) => map.getLayer(id) !== undefined,
    paintedLayers: () => map.getStyle().layers.map((layer) => asLayerId(layer.id)),
    addLayer: (spec: LayerSpec, beforeId?: LayerId) => map.addLayer(toVendorLayer(spec), beforeId),
    removeLayer: (id: LayerId) => map.removeLayer(id),
    setVisibility: (id: LayerId, visibility: Visibility) => map.setLayoutProperty(id, 'visibility', visibility),
    visibilityOf: (id: LayerId) => map.getLayoutProperty(id, 'visibility') as Visibility | undefined,

    hasSource: (id: SourceId) => map.getSource(id) !== undefined,
    addSource: (id: SourceId, spec: SourceSpec) => map.addSource(id, toVendorSource(spec)),
    removeSource: (id: SourceId) => map.removeSource(id),
    setGeoJson: (id: GeoJsonSourceId, data: GeoJSON.FeatureCollection) => {
      const source = map.getSource(id);
      if (source && 'setData' in source) (source as maplibregl.GeoJSONSource).setData(data);
    },
    setRasterTiles: (id: RasterSourceId, tiles: string[]) => {
      const source = map.getSource(id);
      if (source && 'setTiles' in source) (source as maplibregl.RasterTileSource).setTiles(tiles);
    },

    center: () => toLngLat(map.getCenter()),
    zoom: () => map.getZoom(),
    bearing: () => map.getBearing(),
    setCenter: (at: LngLat) => map.setCenter(at),
    setBearing: (degrees: number) => map.setBearing(degrees),
    easeTo: (move: CameraMove) => map.easeTo(move),
    flyTo: (move: CameraMove) => map.flyTo({ ...move, essential: true }),
    fitBounds: (box: BBox, fit: FitOptions) =>
      map.fitBounds([[box.west, box.south], [box.east, box.north]], fit),
    project: (at: LngLat): Point => {
      const projected = map.project(at);
      return { x: projected.x, y: projected.y };
    },

    on: <K extends keyof VendorEvents>(event: K, handler: (payload: VendorEvents[K]) => void): Unsubscribe => {
      const listener = mapListener(event, handler);
      map.on(event, listener);
      return () => map.off(event, listener);
    },
    onLayer: <K extends keyof LayerEvents>(
      event: K,
      layer: LayerId,
      handler: (payload: LayerEvents[K]) => void,
    ): Unsubscribe => {
      const listener = layerListener(event, handler);
      map.on(event, layer, listener);
      return () => map.off(event, layer, listener);
    },
    queryAt: (box: [Point, Point], layers: LayerId[]) =>
      map.queryRenderedFeatures([[box[0].x, box[0].y], [box[1].x, box[1].y]], { layers }).map(toHit),
    setCursor: (cursor: Cursor) => {
      map.getCanvas().style.cursor = cursor;
    },

    addMarker: (element: HTMLElement, at: LngLat): MarkerHandle => {
      const marker = new maplibregl.Marker({ element, anchor: 'center' }).setLngLat(at).addTo(map);
      return {
        setLngLat: (next: LngLat) => {
          marker.setLngLat(next);
        },
        remove: () => {
          marker.remove();
        },
      };
    },
    openPopup: ({ at, content, maxWidth, closeOnClick }): PopupHandle => {
      const inspector = mapInspector(map);
      const popupOptions = {
        ...(maxWidth === undefined ? {} : { maxWidth }),
        ...(closeOnClick === undefined ? {} : { closeOnClick }),
        ...(inspector ? { focusAfterOpen: false } : {}),
      };
      const popup = new maplibregl.Popup(Object.keys(popupOptions).length === 0 ? undefined : popupOptions)
        .setLngLat(at)
        .setDOMContent(content)
        .addTo(map);
      const release = () => {
        syncInspector();
      };
      popup.on('close', release);
      syncInspector();
      if (inspector) {
        const element = popup.getElement();
        element.querySelector<HTMLElement>('.maplibregl-popup-close-button')?.focus({ preventScroll: true });
        const scroller = element.querySelector<HTMLElement>('.maplibregl-popup-content');
        if (scroller) scroller.scrollTop = 0;
      }
      return {
        remove: () => {
          popup.remove();
        },
        onClose: (listener: () => void) => {
          popup.once('close', listener);
        },
      };
    },
  };
}
