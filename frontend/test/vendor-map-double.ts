import { vi } from 'vitest';

import type { LayerId, SourceId } from '../src/map/map-core/catalog';
import type { LngLat } from '../src/map/map-core/geometry';
import type { LayerSpec, SourceSpec, Visibility } from '../src/map/map-core/layer-spec';
import type {
  LayerEvents,
  MarkerHandle,
  PopupHandle,
  VendorEvents,
  VendorMap,
} from '../src/map/map-core/vendor-map';

/** An in-memory VendorMap. Layers keep their paint order, sources keep their
 *  last data, and every handler is reachable through fire/fireLayer, so a
 *  test can drive map-core and features without MapLibre. */
export type VendorDouble = VendorMap & {
  layers: LayerSpec[];
  sources: Map<SourceId, SourceSpec>;
  visibility: Map<LayerId, Visibility>;
  tilesSetOn: Map<SourceId, string[][]>;
  markers: { element: HTMLElement; at: LngLat; removed: boolean }[];
  popups: { at: LngLat; content: HTMLElement; maxWidth?: string; removed: boolean; close: () => void }[];
  cameraCalls: { method: string; args: unknown[] }[];
  cursor: string;
  fire<K extends keyof VendorEvents>(event: K, payload: VendorEvents[K]): void;
  fireLayer<K extends keyof LayerEvents>(event: K, layer: LayerId, payload: LayerEvents[K]): void;
};

export function createVendorDouble(initial: { layers?: LayerSpec[]; sources?: [SourceId, SourceSpec][] } = {}): VendorDouble {
  const layers: LayerSpec[] = [...(initial.layers ?? [])];
  const sources = new Map<SourceId, SourceSpec>(initial.sources ?? []);
  const visibility = new Map<LayerId, Visibility>();
  for (const layer of layers) visibility.set(layer.id, layer.layout?.visibility ?? 'visible');
  const tilesSetOn = new Map<SourceId, string[][]>();
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const layerHandlers = new Map<string, Set<(payload: unknown) => void>>();
  let camera = { center: [0, 0] as LngLat, zoom: 2, bearing: 0 };

  const record = (method: string, ...args: unknown[]): void => {
    double.cameraCalls.push({ method, args });
  };

  const double: VendorDouble = {
    layers,
    sources,
    visibility,
    tilesSetOn,
    markers: [],
    popups: [],
    cameraCalls: [],
    cursor: '',

    whenLoaded: () => Promise.resolve(),
    resize: vi.fn(),

    hasLayer: (id) => layers.some((l) => l.id === id),
    paintedLayers: () => layers.map((l) => l.id),
    addLayer(spec, beforeId) {
      if (layers.some((l) => l.id === spec.id)) throw new Error(`layer ${spec.id} already exists`);
      const at = beforeId === undefined ? layers.length : layers.findIndex((l) => l.id === beforeId);
      if (at === -1) throw new Error(`beforeId ${beforeId} is not on the map`);
      layers.splice(at, 0, spec);
      visibility.set(spec.id, spec.layout?.visibility ?? 'visible');
    },
    removeLayer(id) {
      const at = layers.findIndex((l) => l.id === id);
      if (at === -1) throw new Error(`layer ${id} is not on the map`);
      layers.splice(at, 1);
      visibility.delete(id);
    },
    setVisibility(id, next) {
      if (!layers.some((l) => l.id === id)) throw new Error(`layer ${id} is not on the map`);
      visibility.set(id, next);
    },
    visibilityOf: (id) => visibility.get(id),

    hasSource: (id) => sources.has(id),
    addSource(id, spec) {
      if (sources.has(id)) throw new Error(`source ${id} already exists`);
      sources.set(id, spec);
    },
    removeSource(id) {
      if (!sources.has(id)) throw new Error(`source ${id} is not on the map`);
      sources.delete(id);
    },
    setGeoJson(id, data) {
      const source = sources.get(id);
      if (!source || source.type !== 'geojson') throw new Error(`${id} is not a geojson source`);
      sources.set(id, { ...source, data });
    },
    setRasterTiles(id, tiles) {
      const source = sources.get(id);
      if (!source || source.type !== 'raster') throw new Error(`${id} is not a raster source`);
      sources.set(id, { ...source, tiles });
      tilesSetOn.set(id, [...(tilesSetOn.get(id) ?? []), tiles]);
    },

    center: () => camera.center,
    zoom: () => camera.zoom,
    bearing: () => camera.bearing,
    setCenter(at) {
      camera = { ...camera, center: at };
      record('setCenter', at);
    },
    setBearing(degrees) {
      camera = { ...camera, bearing: degrees };
      record('setBearing', degrees);
    },
    easeTo(move) {
      camera = { ...camera, ...move };
      record('easeTo', move);
    },
    flyTo(move) {
      camera = { ...camera, ...move };
      record('flyTo', move);
    },
    fitBounds: (box, options) => record('fitBounds', box, options),
    project: ([lng, lat]) => ({ x: lng, y: lat }),

    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as (payload: unknown) => void);
      handlers.set(event, set);
      return () => { set.delete(handler as (payload: unknown) => void); };
    },
    onLayer(event, layer, handler) {
      const key = `${event}:${layer}`;
      const set = layerHandlers.get(key) ?? new Set();
      set.add(handler as (payload: unknown) => void);
      layerHandlers.set(key, set);
      return () => { set.delete(handler as (payload: unknown) => void); };
    },
    queryAt: () => [],
    setCursor(cursor) {
      double.cursor = cursor;
    },

    addMarker(element, at) {
      const marker = { element, at, removed: false };
      double.markers.push(marker);
      const handle: MarkerHandle = {
        setLngLat(next) { marker.at = next; },
        remove() { marker.removed = true; },
      };
      return handle;
    },
    openPopup(options) {
      const listeners: (() => void)[] = [];
      const popup = { ...options, removed: false, close: () => { for (const l of listeners) l(); } };
      double.popups.push(popup);
      const handle: PopupHandle = {
        remove() { popup.removed = true; },
        onClose(listener) { listeners.push(listener); },
      };
      return handle;
    },

    fire(event, payload) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
    fireLayer(event, layer, payload) {
      for (const handler of [...(layerHandlers.get(`${event}:${layer}`) ?? [])]) handler(payload);
    },
  };
  return double;
}
