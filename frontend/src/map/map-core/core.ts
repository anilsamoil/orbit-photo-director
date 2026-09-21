import {
  beforeIdFor,
  type GeoJsonSourceId,
  type LayerId,
  type RasterSourceId,
  type SatTrackLayerId,
  type SatTrackSourceId,
  type SourceId,
} from './catalog';
import type { Clock } from './clock';
import type { BBox, LngLat, Point } from './geometry';
import type { LayerSpec, RasterSource, Visibility } from './layer-spec';
import type {
  CameraMove,
  Cursor,
  FitOptions,
  Hit,
  LayerEvents,
  MarkerHandle,
  PopupHandle,
  Unsubscribe,
  VendorEvents,
  VendorMap,
} from './vendor-map';

/** Popups the map owns one of at a time; opening another closes the last. */
export type PopupOwner = 'target' | 'launch';

export type PopupOptions = {
  at: LngLat;
  content: HTMLElement;
  maxWidth?: string;
  owner?: PopupOwner;
};

/** What a feature may ask of the map. Layers land at their catalog position,
 *  visibility writes to an absent layer are dropped, GeoJSON sources appear
 *  on first write, and only satellite tracks can be removed. */
export interface MapCore {
  readonly clock: Clock;

  ensureLayer(spec: LayerSpec): void;
  hasLayer(id: LayerId): boolean;
  setVisibility(id: LayerId, visibility: Visibility): void;
  visibilityOf(id: LayerId): Visibility | undefined;
  removeLayer(id: SatTrackLayerId): void;

  hasSource(id: SourceId): boolean;
  addRasterSource(id: RasterSourceId, spec: RasterSource): void;
  setGeoJson(id: GeoJsonSourceId, data: GeoJSON.FeatureCollection): void;
  setRasterTiles(id: RasterSourceId, tiles: string[]): void;
  removeSource(id: SatTrackSourceId): void;

  center(): LngLat;
  zoom(): number;
  bearing(): number;
  setCenter(at: LngLat): void;
  setBearing(degrees: number): void;
  easeTo(move: CameraMove): void;
  flyTo(move: CameraMove): void;
  fitBounds(box: BBox, options: FitOptions): void;
  project(at: LngLat): Point;
  resize(): void;

  on<K extends keyof VendorEvents>(event: K, handler: (payload: VendorEvents[K]) => void): Unsubscribe;
  onLayer<K extends keyof LayerEvents>(
    event: K,
    layer: LayerId,
    handler: (payload: LayerEvents[K]) => void,
  ): Unsubscribe;
  queryAt(box: [Point, Point], layers: LayerId[]): Hit[];
  setCursor(cursor: Cursor): void;

  addMarker(element: HTMLElement, at: LngLat): MarkerHandle;
  openPopup(options: PopupOptions): PopupHandle;
  closePopup(owner: PopupOwner): void;
}

export function createMapCore(vendor: VendorMap, clock: Clock): MapCore {
  const owned: Partial<Record<PopupOwner, PopupHandle>> = {};

  const closePopup = (owner: PopupOwner): void => {
    const popup = owned[owner];
    delete owned[owner];
    popup?.remove();
  };

  return {
    clock,

    ensureLayer(spec) {
      if (vendor.hasLayer(spec.id)) return;
      vendor.addLayer(spec, beforeIdFor(spec.id, vendor.paintedLayers()));
    },
    hasLayer: (id) => vendor.hasLayer(id),
    setVisibility(id, visibility) {
      if (vendor.hasLayer(id)) vendor.setVisibility(id, visibility);
    },
    visibilityOf: (id) => vendor.visibilityOf(id),
    removeLayer(id) {
      if (vendor.hasLayer(id)) vendor.removeLayer(id);
    },

    hasSource: (id) => vendor.hasSource(id),
    addRasterSource: (id, spec) => vendor.addSource(id, spec),
    setGeoJson(id, data) {
      if (vendor.hasSource(id)) vendor.setGeoJson(id, data);
      else vendor.addSource(id, { type: 'geojson', data });
    },
    setRasterTiles: (id, tiles) => vendor.setRasterTiles(id, tiles),
    removeSource(id) {
      if (vendor.hasSource(id)) vendor.removeSource(id);
    },

    center: () => vendor.center(),
    zoom: () => vendor.zoom(),
    bearing: () => vendor.bearing(),
    setCenter: (at) => vendor.setCenter(at),
    setBearing: (degrees) => vendor.setBearing(degrees),
    easeTo: (move) => vendor.easeTo(move),
    flyTo: (move) => vendor.flyTo(move),
    fitBounds: (box, options) => vendor.fitBounds(box, options),
    project: (at) => vendor.project(at),
    resize: () => vendor.resize(),

    on: (event, handler) => vendor.on(event, handler),
    onLayer: (event, layer, handler) => vendor.onLayer(event, layer, handler),
    queryAt: (box, layers) => vendor.queryAt(box, layers),
    setCursor: (cursor) => vendor.setCursor(cursor),

    addMarker: (element, at) => vendor.addMarker(element, at),
    openPopup({ owner, ...options }) {
      if (!owner) return vendor.openPopup(options);
      closePopup(owner);
      const popup = vendor.openPopup(options);
      owned[owner] = popup;
      popup.onClose(() => {
        if (owned[owner] === popup) delete owned[owner];
      });
      return popup;
    },
    closePopup,
  };
}
