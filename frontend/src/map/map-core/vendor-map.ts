import type { LayerId, SourceId } from './catalog';
import type { BBox, LngLat, Point } from './geometry';
import type { LayerSpec, SourceSpec, StyleSpec, Visibility } from './layer-spec';

/** A rendered feature under a query box or a tap. */
export type Hit = {
  properties: Record<string, unknown> | null;
  geometry: GeoJSON.Geometry;
};

export type Tap = { point: Point; lngLat: LngLat };

export type LayerTap = Tap & { features: Hit[] };

export type VendorEvents = {
  click: Tap;
  /** The adapter suppresses the browser menu before delivering this. */
  contextmenu: Tap;
  touchstart: { lngLat: LngLat; touches: Point[] };
  touchmove: { touches: Point[] };
  touchend: void;
  moveend: void;
  idle: void;
  styledata: void;
  dragstart: void;
  zoomstart: { byUser: boolean };
  error: { sourceId?: string };
  data: { sourceId?: string; tileLoaded: boolean };
};

export type LayerEvents = {
  click: LayerTap;
  mouseenter: void;
  mouseleave: void;
};

export type Unsubscribe = () => void;

export type CameraMove = {
  center?: LngLat;
  zoom?: number;
  bearing?: number;
  duration: number;
};

export type FitOptions = { padding: number; maxZoom: number; duration: number };

export type InitialCamera = { center: LngLat; zoom: number };

export type MarkerHandle = {
  setLngLat(at: LngLat): void;
  remove(): void;
};

export type PopupHandle = {
  remove(): void;
  onClose(listener: () => void): void;
};

export type Cursor = 'pointer' | '';

/** Everything the app asks of the map vendor, in domain types. The adapter
 *  is the only implementation and the only module that knows MapLibre. */
export interface VendorMap {
  whenLoaded(): Promise<void>;
  resize(): void;

  hasLayer(id: LayerId): boolean;
  paintedLayers(): LayerId[];
  addLayer(spec: LayerSpec, beforeId?: LayerId): void;
  removeLayer(id: LayerId): void;
  setVisibility(id: LayerId, visibility: Visibility): void;
  visibilityOf(id: LayerId): Visibility | undefined;

  hasSource(id: SourceId): boolean;
  addSource(id: SourceId, spec: SourceSpec): void;
  removeSource(id: SourceId): void;
  setGeoJson(id: SourceId, data: GeoJSON.FeatureCollection): void;
  setRasterTiles(id: SourceId, tiles: string[]): void;

  center(): LngLat;
  zoom(): number;
  bearing(): number;
  setCenter(at: LngLat): void;
  setBearing(degrees: number): void;
  easeTo(move: CameraMove): void;
  flyTo(move: CameraMove): void;
  fitBounds(box: BBox, options: FitOptions): void;
  project(at: LngLat): Point;

  on<K extends keyof VendorEvents>(event: K, handler: (payload: VendorEvents[K]) => void): Unsubscribe;
  onLayer<K extends keyof LayerEvents>(
    event: K,
    layer: LayerId,
    handler: (payload: LayerEvents[K]) => void,
  ): Unsubscribe;
  queryAt(box: [Point, Point], layers: LayerId[]): Hit[];
  setCursor(cursor: Cursor): void;

  addMarker(element: HTMLElement, at: LngLat): MarkerHandle;
  openPopup(options: { at: LngLat; content: HTMLElement; maxWidth?: string }): PopupHandle;
}

export type VendorMapOptions = {
  container: HTMLElement;
  style: StyleSpec;
  camera: InitialCamera;
};
