import { vi } from 'vitest';

import type { Manifest, Track } from '../src/types';

export type LayerSpec = {
  id: string;
  type: string;
  source?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
};

export type Handler = (payload?: unknown) => void;

type SourceDouble = {
  spec: Record<string, unknown>;
  setData: (data: unknown) => void;
  setTiles: (tiles: string[]) => void;
};

/** Records every source, layer, handler and camera call `renderMap` makes.
 *
 *  `layerOrder` is the pin that matters: MapLibre paints the array bottom
 *  first and `addLayer(spec, beforeId)` splices rather than appends, so the
 *  order this double reports is the stacking the operator actually sees. */
export class RecordingMap {
  readonly options: Record<string, unknown>;
  readonly sources = new Map<string, SourceDouble>();
  readonly layerSpecs = new Map<string, LayerSpec>();
  readonly layerOrder: string[] = [];
  readonly addLayerCalls: { id: string; beforeId: string | undefined }[] = [];
  readonly handlers: { event: string; layerId?: string; handler: Handler }[] = [];
  readonly controls: { control: unknown; position?: string }[] = [];
  readonly cameraCalls: { method: string; args: unknown[] }[] = [];
  readonly canvas = document.createElement('canvas');
  readonly canvasContainer = document.createElement('div');
  private visibility = new Map<string, string>();
  private loadHandlers: Handler[] = [];

  constructor(options: Record<string, unknown>) {
    this.options = options;
    const style = options.style as { sources?: Record<string, Record<string, unknown>>; layers?: LayerSpec[] };
    for (const [id, spec] of Object.entries(style?.sources ?? {})) this.recordSource(id, spec);
    for (const layer of style?.layers ?? []) this.insertLayer(layer, undefined);
  }

  private recordSource(id: string, spec: Record<string, unknown>): void {
    this.sources.set(id, {
      spec,
      setData: vi.fn(),
      setTiles: vi.fn(),
    });
  }

  private insertLayer(spec: LayerSpec, beforeId: string | undefined): void {
    this.layerSpecs.set(spec.id, spec);
    this.visibility.set(spec.id, String(spec.layout?.visibility ?? 'visible'));
    const at = beforeId ? this.layerOrder.indexOf(beforeId) : -1;
    if (at === -1) this.layerOrder.push(spec.id);
    else this.layerOrder.splice(at, 0, spec.id);
  }

  addSource(id: string, spec: Record<string, unknown>): void {
    this.recordSource(id, spec);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  getSource(id: string): SourceDouble | undefined {
    return this.sources.get(id);
  }

  addLayer(spec: LayerSpec, beforeId?: string): void {
    this.addLayerCalls.push({ id: spec.id, beforeId });
    this.insertLayer(spec, beforeId);
  }

  removeLayer(id: string): void {
    this.layerSpecs.delete(id);
    this.visibility.delete(id);
    const at = this.layerOrder.indexOf(id);
    if (at !== -1) this.layerOrder.splice(at, 1);
  }

  getLayer(id: string): LayerSpec | undefined {
    return this.layerSpecs.get(id);
  }

  setLayoutProperty(id: string, key: string, value: string): void {
    if (key === 'visibility') this.visibility.set(id, value);
  }

  getLayoutProperty(id: string, key: string): string | undefined {
    return key === 'visibility' ? this.visibility.get(id) : undefined;
  }

  visibilityOf(id: string): string | undefined {
    return this.visibility.get(id);
  }

  on(event: string, layerIdOrHandler: string | Handler, maybeHandler?: Handler): void {
    if (typeof layerIdOrHandler === 'string') {
      this.handlers.push({ event, layerId: layerIdOrHandler, handler: maybeHandler as Handler });
    } else {
      this.handlers.push({ event, handler: layerIdOrHandler });
    }
  }

  off(event: string, layerIdOrHandler: string | Handler, maybeHandler?: Handler): void {
    const target = typeof layerIdOrHandler === 'string' ? maybeHandler : layerIdOrHandler;
    const at = this.handlers.findIndex((h) => h.event === event && h.handler === target);
    if (at !== -1) this.handlers.splice(at, 1);
  }

  once(event: string, handler: Handler): void {
    if (event === 'load') this.loadHandlers.push(handler);
  }

  /** Dispatch to the handlers bound for exactly this event and layer. A
   *  layerless fire reaches only the map-wide handlers, matching MapLibre. */
  fire(event: string, payload?: unknown, layerId?: string): void {
    for (const entry of [...this.handlers]) {
      if (entry.event === event && entry.layerId === layerId) entry.handler(payload);
    }
  }

  emitLoad(): void {
    const pending = this.loadHandlers;
    this.loadHandlers = [];
    for (const handler of pending) handler();
  }

  addControl(control: unknown, position?: string): void {
    this.controls.push({ control, position });
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getCanvasContainer(): HTMLElement {
    return this.canvasContainer;
  }

  getCenter(): { lng: number; lat: number } {
    return { lng: 0, lat: 0 };
  }

  getZoom(): number {
    return Number(this.options.zoom ?? 0);
  }

  getBearing(): number {
    return 0;
  }

  project(lngLat: [number, number]): { x: number; y: number } {
    return { x: lngLat[0], y: lngLat[1] };
  }

  renderedFeatures: Record<string, unknown[]> = {};
  readonly queryCalls: { layers: string[] }[] = [];

  queryRenderedFeatures(_bbox: unknown, options?: { layers?: string[] }): unknown[] {
    const layers = options?.layers ?? [];
    this.queryCalls.push({ layers });
    return layers.flatMap((id) => this.renderedFeatures[id] ?? []);
  }

  resize(): void {
    this.cameraCalls.push({ method: 'resize', args: [] });
  }

  setCenter(...args: unknown[]): void {
    this.cameraCalls.push({ method: 'setCenter', args });
  }

  easeTo(...args: unknown[]): void {
    this.cameraCalls.push({ method: 'easeTo', args });
  }

  flyTo(...args: unknown[]): void {
    this.cameraCalls.push({ method: 'flyTo', args });
  }

  fitBounds(...args: unknown[]): void {
    this.cameraCalls.push({ method: 'fitBounds', args });
  }

  setBearing(...args: unknown[]): void {
    this.cameraCalls.push({ method: 'setBearing', args });
  }
}

export class RecordingMarker {
  lngLat: [number, number] | null = null;
  added: RecordingMap | null = null;
  removed = false;
  constructor(readonly options: { element?: HTMLElement; anchor?: string } = {}) {}
  setLngLat(value: [number, number]): this {
    this.lngLat = value;
    return this;
  }
  getElement(): HTMLElement {
    return this.options.element ?? document.createElement('div');
  }
  addTo(map: RecordingMap): this {
    this.added = map;
    return this;
  }
  remove(): this {
    this.removed = true;
    this.added = null;
    return this;
  }
}

export class RecordingPopup {
  lngLat: [number, number] | null = null;
  content: HTMLElement | null = null;
  html: string | null = null;
  added: RecordingMap | null = null;
  removed = false;
  constructor(readonly options: Record<string, unknown> = {}) {}
  setLngLat(value: [number, number]): this {
    this.lngLat = value;
    return this;
  }
  setDOMContent(node: HTMLElement): this {
    this.content = node;
    return this;
  }
  setHTML(html: string): this {
    this.html = html;
    return this;
  }
  setMaxWidth(): this {
    return this;
  }
  addTo(map: RecordingMap): this {
    this.added = map;
    return this;
  }
  remove(): this {
    this.removed = true;
    this.added = null;
    return this;
  }
  isOpen(): boolean {
    return this.added !== null;
  }
  on(event: string, handler: Handler): this {
    (this.listeners[event] ??= []).push(handler);
    return this;
  }
  once(event: string, handler: Handler): this {
    return this.on(event, handler);
  }
  off(event: string, handler: Handler): this {
    const bound = this.listeners[event];
    if (bound) this.listeners[event] = bound.filter((entry) => entry !== handler);
    return this;
  }
  readonly listeners: Record<string, Handler[]> = {};
}

class RecordingLngLatBounds {
  readonly points: [number, number][] = [];
  constructor(a: [number, number], b: [number, number]) {
    this.points.push(a, b);
  }
  extend(point: [number, number]): this {
    this.points.push(point);
    return this;
  }
}

/** The whole maplibre-gl surface `src/map.ts` touches at runtime. */
function maplibreDouble() {
  const constructed: RecordingMap[] = [];
  const markers: RecordingMarker[] = [];
  const popups: RecordingPopup[] = [];
  const Map = vi.fn((options: Record<string, unknown>) => {
    const instance = new RecordingMap(options);
    constructed.push(instance);
    queueMicrotask(() => instance.emitLoad());
    return instance;
  });
  const Marker = vi.fn((options?: { element?: HTMLElement; anchor?: string }) => {
    const marker = new RecordingMarker(options);
    markers.push(marker);
    return marker;
  });
  const Popup = vi.fn((options?: Record<string, unknown>) => {
    const popup = new RecordingPopup(options);
    popups.push(popup);
    return popup;
  });
  const maplibregl = {
    Map,
    Marker,
    Popup,
    NavigationControl: vi.fn(function NavigationControl(this: unknown) { return this; }),
    LngLatBounds: RecordingLngLatBounds,
    addProtocol: vi.fn(),
    removeProtocol: vi.fn(),
  };
  return { maplibregl, constructed, markers, popups };
}

export type MaplibreDouble = ReturnType<typeof maplibreDouble>;

// vi.resetModules() gives the mock factory a different copy of this module
// than the test file imported, so the installed double lives on globalThis
// where both copies can reach it.
const SLOT = '__snapMaplibreDouble' as const;
type Slot = { [SLOT]?: MaplibreDouble };

/** The factory a test file hands to `vi.mock('maplibre-gl', ...)`.
 *
 *  map.ts registers the viirs-alpha protocol against the default export at
 *  import time, so a double has to exist before the module graph loads. The
 *  proxy keeps that captured binding pointing at whichever double the
 *  running test installed. */
export function maplibreModuleMock(): { default: unknown } {
  resetMaplibreDouble();
  return {
    default: new Proxy({}, {
      get: (_target, prop) => currentMaplibreDouble().maplibregl[prop as keyof MaplibreDouble['maplibregl']],
    }),
  };
}

export function resetMaplibreDouble(): MaplibreDouble {
  const installed = maplibreDouble();
  (globalThis as Slot)[SLOT] = installed;
  return installed;
}

export function currentMaplibreDouble(): MaplibreDouble {
  const installed = (globalThis as Slot)[SLOT];
  if (!installed) throw new Error('call resetMaplibreDouble() first');
  return installed;
}

/** The map `renderMap` constructed in this test. */
export function renderedMap(): RecordingMap {
  const [first] = currentMaplibreDouble().constructed;
  if (!first) throw new Error('renderMap constructed no map');
  return first;
}

const DOCK_BUTTON_IDS = [
  'toggle-clouds',
  'toggle-ir',
  'toggle-labels',
  'toggle-terminator',
  'toggle-night-lights',
  'toggle-multi-orbit',
  'toggle-follow-iss',
  'toggle-satellite-picker',
  'bearing-north',
  'bearing-iss',
] as const;

/** The map container plus the dock buttons `renderMap`'s bind* calls look
 *  for. Without them each binder silently returns and no toggle is wired. */
export function buildMapDock(): HTMLElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.id = 'map';
  document.body.append(container);
  for (const id of DOCK_BUTTON_IDS) {
    const button = document.createElement('button');
    button.id = id;
    document.body.append(button);
  }
  return container;
}

export const MANIFEST_FIXTURE: Manifest = {
  version: '20260504T120000Z',
  generated_at: '2026-05-04T12:00:00Z',
  tle_epoch: '2026-05-04T00:00:00Z',
  cloud_composite_hour: '2026-05-04T11:00:00Z',
  target_data_version: 'v1',
  build_version: '2.0.0.0',
  freshness: { tle_hours: 12, cloud_hours: 1, ok: true },
  artifacts: {
    passes: { path: 'passes.json', sha256: '', bytes: 2 },
    track: { path: 'track.json', sha256: '', bytes: 512 },
  },
};

export const TRACK_FIXTURE: Track = {
  iss_polynomial: {
    start: '2026-05-04T12:00:00Z',
    duration_seconds: 5400,
    lat_coeffs: [0, 0.01],
    lon_coeffs: [0, 0.06],
    polynomial_order: 1,
  },
  track_points: Array.from({ length: 40 }, (_, i) => [i * 60, i * 1.2 - 24, i * 4 - 80] as [number, number, number]),
  tle_epoch: '2026-05-04T00:00:00Z',
  tle_age_hours: 12,
  tle_freshness_factor: 1,
};

/** Serves the manifest's artifacts from an in-memory table. The manifest
 *  fixture declares empty sha256 strings so fetchArtifact skips the digest
 *  check, which SubtleCrypto in happy-dom would otherwise have to satisfy. */
export function stubArtifactFetch(bodies: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const key = Object.keys(bodies).find((name) => url.endsWith(name));
    if (key === undefined) return { ok: false, status: 404 };
    const bytes = new TextEncoder().encode(JSON.stringify(bodies[key]));
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
      json: async () => bodies[key],
      text: async () => JSON.stringify(bodies[key]),
    };
  }));
}
