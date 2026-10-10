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
function syncMapInspector(map: maplibregl.Map): void {
  const slot = mapInspector(map);
  const pane = slot?.closest('#map-pane');
  if (!slot || !(pane instanceof HTMLElement)) return;
  for (const popup of map.getContainer().querySelectorAll('.maplibregl-popup')) slot.appendChild(popup);
  const open = slot.querySelector('.maplibregl-popup') !== null;
  pane.classList.toggle('map-inspector-open', open);
  slot.hidden = !open;
  requestAnimationFrame(() => map.resize());
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
        syncMapInspector(map);
      };
      popup.on('close', release);
      syncMapInspector(map);
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
