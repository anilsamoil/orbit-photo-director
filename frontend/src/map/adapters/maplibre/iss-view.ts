import './worker-url';
import { LngLat, Map, Marker, addProtocol, type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { SkySpecification } from '@maplibre/maplibre-gl-style-spec';

import { TANGENT_PITCH_DEG } from '../../../iss-g1/model';
import { bucketFor, createComposer, type Composer, type DecodedTile } from '../../../iss-view/compose';
import { EARTH_VIEW_ROLL_DEG, type ImageryState } from '../../../iss-view/model';
import { placeScreenLabels } from '../../../iss-view/label-layout';
import {
  classifyLaunchSite,
  launchCorridorLines,
  siteOnDisk,
  type LaunchArrow,
  type LaunchPin,
  type LaunchSite,
} from '../../../iss-view/launches';
import { readCatalog } from '../../../iss-view/catalog-read';
import { fetchCatalog } from '../../../iss-view/catalog-load';
import { TOWN_LABEL_FOV_DEG } from '../../../iss-view/fov';
import { placesOnDisk, type CatalogPoint, type PlaceLabel } from '../../../iss-view/place-labels';
import type { IssAim, IssRenderer, IssRendererHooks, IssRendererOptions } from '../../../iss-view/renderer';
import { collapseAttribution } from './attribution';

export const ISS_VIEW_MAX_PITCH_DEG = TANGENT_PITCH_DEG;

const PROTOCOL = 'iss-view';
const LIT_MAX_ZOOM = 8;
const nearCatalogUrl = new URL('../../../iss-view/label-catalog.json', import.meta.url).href;
const townCatalogUrl = new URL('../../../iss-view/label-catalog-towns.json', import.meta.url).href;

const gate = { done: false };
const listeners: { current: IssRendererHooks | null } = { current: null };
const composer: Composer = createComposer({
  fetchBytes: fetchNasa,
  decode: decodeNasa,
  encode: encodePng,
});

export function cappedPixelRatio(deviceRatio: number): number {
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) return 1;
  return Math.min(1.5, deviceRatio);
}

export function createIssRenderer(
  frame: HTMLElement,
  hooks: IssRendererHooks,
  options?: IssRendererOptions,
): IssRenderer {
  const labels = options?.labels !== false;
  listeners.current = hooks;
  registerProtocol();
  let map: MapLibreMap;
  try {
    map = new Map({
      container: frame,
      pixelRatio: cappedPixelRatio(globalThis.devicePixelRatio),
      interactive: false,
      maxPitch: ISS_VIEW_MAX_PITCH_DEG,
      centerClampedToGround: false,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: false },
      style: {
        version: 8,
        projection: { type: 'vertical-perspective' },
        sky: sceneSky(),
        sources: {},
        layers: [
          { id: 'iss-ground', type: 'background', paint: { 'background-color': '#10141c' } },
        ],
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'GPUInitializationError') {
      throw new Error('WebGL2 is unavailable');
    }
    throw error;
  }
  map.setMaxPitch(ISS_VIEW_MAX_PITCH_DEG);
  collapseAttribution(frame);
  exposeIssForEndToEnd(map);
  const placeMarkers: { key: string; marker: Marker }[] = [];
  const launchMarkers: { key: string; marker: Marker }[] = [];
  const launchEdges: HTMLButtonElement[] = [];
  const launchState: { sites: readonly LaunchSite[]; aim: IssAim | null } = { sites: [], aim: null };
  const armLabels = (): void => {
    frame.dataset.issPlaceLayers = 'country city town region water';
  };
  if (labels) {
    if (map.loaded()) armLabels();
    else map.once('load', armLabels);
  }
  map.on('error', (event) => {
    const note = imageryNote(event.error);
    if (note) hooks.onImagery(note);
  });
  map.on('webglcontextlost', () => {
    hooks.onContextLost();
  });
  const removed = { done: false };
  let litTiles = '';
  let nearPoints: readonly CatalogPoint[] = [];
  let townPoints: readonly CatalogPoint[] = [];
  const nearLoad: ChunkSlot = { phase: 'idle', pause: 0, fails: 0 };
  const townLoad: ChunkSlot = { phase: 'idle', pause: 0, fails: 0 };
  const measured = new globalThis.Map<string, { width: number; height: number }>();
  const mergedCatalog = (): readonly CatalogPoint[] => (
    townPoints.length === 0 ? nearPoints : nearPoints.concat(townPoints)
  );
  const requestNear = (): void => {
    pullChunk(
      nearLoad,
      () => fetchCatalog(nearCatalogUrl).then(readCatalog),
      (points) => {
        nearPoints = points;
      },
    );
  };
  const requestTowns = (): void => {
    pullChunk(
      townLoad,
      () => fetchCatalog(townCatalogUrl).then(readCatalog),
      (points) => {
        townPoints = points;
      },
    );
  };
  if (labels) requestNear();

  return {
    ready() {
      if (map.loaded()) return Promise.resolve();
      return new Promise((resolve) => {
        map.once('load', () => resolve());
      });
    },
    resize(widthPx, heightPx) {
      frame.style.width = `${widthPx}px`;
      frame.style.height = `${heightPx}px`;
      const ratio = cappedPixelRatio(globalThis.devicePixelRatio);
      if (map.getPixelRatio() === ratio) map.resize();
      else map.setPixelRatio(ratio);
    },
    async aim(aim: IssAim) {
      map.setMaxPitch(ISS_VIEW_MAX_PITCH_DEG);
      map.setVerticalFieldOfView(aim.verticalFovDeg);
      const bucket = bucketFor(aim.lightingUtcMs);
      const tile = `${PROTOCOL}://lit/${bucket}/{z}/{y}/{x}`;
      const existing = map.getSource('iss-lit');
      if (existing && 'setTiles' in existing && typeof existing.setTiles === 'function') {
        if (litTiles !== tile) {
          existing.setTiles([tile]);
          litTiles = tile;
        }
      } else if (!existing) {
        map.addSource('iss-lit', {
          type: 'raster',
          tiles: [tile],
          tileSize: 256,
          maxzoom: LIT_MAX_ZOOM,
          attribution: 'NASA Blue Marble Next Generation and VIIRS Black Marble 2016',
        });
        map.addLayer({
          id: 'iss-lit',
          type: 'raster',
          source: 'iss-lit',
          paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
        });
        litTiles = tile;
      }
      const solved = map.calculateCameraOptionsFromTo(
        new LngLat(aim.pose.camera.lonDeg, aim.pose.camera.latDeg),
        aim.pose.altitudeM,
        new LngLat(aim.pose.targetLonDeg, aim.pose.targetLatDeg),
        0,
      );
      map.jumpTo({ ...solved, bearing: aim.pose.bearingDeg, roll: EARTH_VIEW_ROLL_DEG });
      launchState.aim = aim;
      if (labels) {
        requestNear();
        if (aim.verticalFovDeg <= TOWN_LABEL_FOV_DEG) requestTowns();
        syncPlaceMarkers(map, placeMarkers, aim, mergedCatalog(), measured);
      }
      syncLaunchOverlay(map, frame, launchMarkers, launchEdges, launchState, hooks);
      await idle(map);
    },
    showLaunches(sites) {
      launchState.sites = sites.slice(0, 1);
      syncLaunchOverlay(map, frame, launchMarkers, launchEdges, launchState, hooks);
    },
    destroy() {
      if (removed.done) return;
      removed.done = true;
      for (const entry of placeMarkers) entry.marker.remove();
      placeMarkers.splice(0, placeMarkers.length);
      clearLaunchMarks(launchMarkers, launchEdges);
      map.remove();
    },
  };
}

function exposeIssForEndToEnd(map: MapLibreMap): void {
  if (typeof window === 'undefined') return;
  if (!new URLSearchParams(window.location.search).has('e2e')) return;
  (window as unknown as { __opdIss?: MapLibreMap }).__opdIss = map;
}

function syncPlaceMarkers(
  map: MapLibreMap,
  markers: { key: string; marker: Marker }[],
  aim: IssAim,
  catalog: readonly CatalogPoint[],
  measured: globalThis.Map<string, { width: number; height: number }>,
): void {
  const width = map.getCanvas().clientWidth;
  const height = map.getCanvas().clientHeight;
  if (width < 10 || height < 10) return;
  const candidates = placesOnDisk(
    aim.pose.camera.latDeg,
    aim.pose.camera.lonDeg,
    aim.pose.altitudeM,
    aim.pose.bearingDeg,
    aim.pose.analyticPitchDeg,
    aim.verticalFovDeg,
    catalog,
  );
  const chosen = new globalThis.Map<string, { key: string; place: PlaceLabel; score: number; x: number; y: number }>();
  for (const place of candidates) {
    const projected = map.project([place.lon, place.lat]);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
    if (projected.x < 18 || projected.y < 18 || projected.x > width - 18 || projected.y > height - 18) continue;
    const score = (projected.x - width / 2) ** 2 + (projected.y - height / 2) ** 2;
    const key = place.rank === undefined
      ? `${place.kind}:${place.name}`
      : `${place.kind}:${place.name}:${place.lon.toFixed(2)}:${place.lat.toFixed(2)}`;
    const current = chosen.get(key);
    if (!current || score < current.score) chosen.set(key, { key, place, score, x: projected.x, y: projected.y });
  }
  const screened = [...chosen.values()].map((entry) => {
    const size = measurePlace(map.getContainer(), entry.place, measured);
    return {
      key: entry.key,
      place: entry.place,
      label: {
        kind: entry.place.kind,
        name: entry.place.name,
        x: entry.x,
        y: entry.y,
        width: size.width,
        height: size.height,
        maxFovDeg: entry.place.maxFovDeg,
        rank: entry.place.rank,
      },
    };
  });
  const laid = placeScreenLabels(screened.map((entry) => entry.label), { width, height });
  const placed = laid.flatMap((label) => {
    const source = screened.find((entry) => entry.label.kind === label.kind && entry.label.name === label.name && entry.label.x === label.x && entry.label.y === label.y);
    return source ? [{ key: source.key, place: source.place, label }] : [];
  });
  const placedKeys = new Set(placed.map((entry) => entry.key));
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const entry = markers[index];
    if (!entry || placedKeys.has(entry.key)) continue;
    entry.marker.remove();
    markers.splice(index, 1);
  }
  for (const item of placed) {
    const { key, place, label } = item;
    const existing = markers.find((marker) => marker.key === key);
    if (existing) {
      existing.marker.setLngLat([place.lon, place.lat]);
      existing.marker.setOffset([label.offsetX, label.offsetY]);
      continue;
    }
    const node = document.createElement('span');
    node.className = `iss-place iss-place-${place.kind}`;
    node.textContent = place.name;
    markers.push({
      key,
      marker: new Marker({ element: node, anchor: 'top', offset: [label.offsetX, label.offsetY] })
        .setLngLat([place.lon, place.lat])
        .addTo(map),
    });
  }
}

function syncLaunchOverlay(
  map: MapLibreMap,
  frame: HTMLElement,
  markers: { key: string; marker: Marker }[],
  edges: HTMLButtonElement[],
  launchState: { sites: readonly LaunchSite[]; aim: IssAim | null },
  hooks: IssRendererHooks,
): void {
  const aim = launchState.aim;
  const lines = launchCorridorLines(launchState.sites);
  syncLaunchCorridor(map, lines);
  frame.dataset.issLaunchCorridor = lines.length > 0 ? 'on' : 'off';
  if (!aim) {
    for (const site of launchState.sites) hooks.onLaunchVisibility?.(site.eventId, 'View unavailable');
    clearLaunchMarks(markers, edges);
    return;
  }
  const width = map.getCanvas().clientWidth;
  const height = map.getCanvas().clientHeight;
  const project = (lon: number, lat: number) => {
    const projected = map.project([lon, lat]);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
    return { x: projected.x, y: projected.y };
  };
  const pins: LaunchPin[] = [];
  const arrows: LaunchArrow[] = [];
  for (const site of launchState.sites) {
    const mark = classifyLaunchSite(
      site,
      siteOnDisk(aim.pose.camera.latDeg, aim.pose.camera.lonDeg, aim.pose.altitudeM, site.lat, site.lon),
      project,
      width,
      height,
    );
    hooks.onLaunchVisibility?.(site.eventId, mark.visibility);
    if (mark.pin) pins.push(mark.pin);
    if (mark.arrow) arrows.push(mark.arrow);
  }
  const placed = { pins, arrows };
  const pinKeys = new Set(placed.pins.map((pin) => pin.eventId));
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const entry = markers[index];
    if (!entry || pinKeys.has(entry.key)) continue;
    entry.marker.remove();
    markers.splice(index, 1);
  }
  for (const pin of placed.pins) {
    const existing = markers.find((item) => item.key === pin.eventId);
    if (existing) {
      existing.marker.setLngLat([pin.lon, pin.lat]);
      continue;
    }
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'iss-launch-pin';
    node.title = pin.siteName;
    node.setAttribute('aria-label', pin.siteName);
    node.addEventListener('pointerdown', (event) => event.stopPropagation());
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      hooks.onLaunchLook?.(pin.eventId);
    });
    markers.push({
      key: pin.eventId,
      marker: new Marker({ element: node, anchor: 'center' }).setLngLat([pin.lon, pin.lat]).addTo(map),
    });
  }
  for (const edge of edges) edge.remove();
  edges.splice(0, edges.length);
  for (const arrow of placed.arrows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.issLaunchEdge = arrow.eventId;
    button.title = `Look toward ${arrow.siteName}`;
    button.setAttribute('aria-label', `Look toward ${arrow.siteName}`);
    button.textContent = '↑';
    button.style.left = `${arrow.x}px`;
    button.style.top = `${arrow.y}px`;
    button.style.setProperty('--iss-launch-aim', `${arrow.deg.toFixed(1)}deg`);
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      hooks.onLaunchLook?.(arrow.eventId);
    });
    frame.append(button);
    edges.push(button);
  }
}

function syncLaunchCorridor(map: MapLibreMap, lines: [number, number][][]): void {
  const data = {
    type: 'FeatureCollection' as const,
    features: lines.map((coordinates) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates },
    })),
  };
  try {
    const existing = map.getSource('iss-launch-corridor');
    if (!existing) {
      map.addSource('iss-launch-corridor', { type: 'geojson', data });
      map.addLayer({
        id: 'iss-launch-corridor',
        type: 'line',
        source: 'iss-launch-corridor',
        paint: { 'line-color': '#ffd45c', 'line-width': 3, 'line-opacity': 0.9 },
      });
      return;
    }
    if ('setData' in existing && typeof existing.setData === 'function') existing.setData(data);
  } catch {
    return;
  }
}

function clearLaunchMarks(markers: { key: string; marker: Marker }[], edges: HTMLButtonElement[]): void {
  for (const entry of markers) entry.marker.remove();
  markers.splice(0, markers.length);
  for (const edge of edges) edge.remove();
  edges.splice(0, edges.length);
}

function measurePlace(
  host: HTMLElement,
  place: PlaceLabel,
  measured: globalThis.Map<string, { width: number; height: number }>,
): { width: number; height: number } {
  const key = `${place.kind}:${place.name}`;
  const cached = measured.get(key);
  if (cached) return cached;
  const label = document.createElement('span');
  label.className = `iss-place iss-place-${place.kind}`;
  label.textContent = place.name;
  label.style.position = 'absolute';
  label.style.visibility = 'hidden';
  host.append(label);
  const size = { width: label.offsetWidth, height: label.offsetHeight };
  label.remove();
  measured.set(key, size);
  return size;
}

type ChunkPhase = 'idle' | 'pending' | 'ready' | 'failed';

type ChunkSlot = {
  phase: ChunkPhase;
  pause: number;
  fails: number;
};

function pullChunk<T>(slot: ChunkSlot, load: () => Promise<T>, accept: (value: T) => void): void {
  if (slot.phase === 'ready' || slot.phase === 'pending') return;
  if (slot.phase === 'failed' && slot.pause > 0) {
    slot.pause -= 1;
    return;
  }
  slot.phase = 'pending';
  void load().then(
    (value) => {
      accept(value);
      slot.phase = 'ready';
    },
    () => {
      slot.fails += 1;
      slot.pause = Math.min(16, 2 ** (slot.fails - 1));
      slot.phase = 'failed';
    },
  );
}

function registerProtocol(): void {
  if (gate.done) return;
  gate.done = true;
  addProtocol(PROTOCOL, async (params, abortController) => {
    const match = params.url.match(/iss-view:\/\/lit\/(-?\d+)\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) throw new Error(`Unexpected lighting url ${params.url}`);
    const bucket = Number(match[1]);
    const z = Number(match[2]);
    const y = Number(match[3]);
    const x = Number(match[4]);
    const result = await composer.compose(z, x, y, bucket, abortController.signal);
    if (!result.ok) {
      if (result.reason === 'cancelled') {
        throw new DOMException('The lighting tile was cancelled', 'AbortError');
      }
      const missing = result.missing ? `:${result.missing}` : '';
      const error = new Error(`${result.reason}${missing}`);
      const note = imageryNote(error);
      if (note) listeners.current?.onImagery(note);
      throw error;
    }
    return { data: result.derived };
  });
}

function imageryNote(error: unknown): ImageryState | null {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('offline')) return { kind: 'offline' };
  if (message.startsWith('source:day')) return { kind: 'degraded', missing: 'day' };
  if (message.startsWith('source:night')) return { kind: 'degraded', missing: 'night' };
  if (message.startsWith('source')) return { kind: 'degraded', missing: 'day' };
  if (message.startsWith('decode') || message.startsWith('size') || message.startsWith('quota')) {
    return { kind: 'delayed' };
  }
  return null;
}

function sceneSky(): SkySpecification {
  return {
    'sky-color': '#02040c',
    'horizon-color': '#9eb6cc',
    'sky-horizon-blend': 0.45,
    'atmosphere-blend': 0.55,
  };
}

function idle(map: MapLibreMap): Promise<void> {
  if (map.loaded() && !map.isMoving()) return Promise.resolve();
  return new Promise((resolve) => {
    map.once('idle', () => resolve());
  });
}

async function fetchNasa(
  url: string,
  signal: AbortSignal,
): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; status: number }> {
  const response = await fetch(url, { signal });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, bytes: await response.arrayBuffer() };
}

async function decodeNasa(bytes: ArrayBuffer): Promise<DecodedTile> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The lighting tile could not be decoded');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const rgba = new Uint8ClampedArray(image.data);
    return { rgba, width: bitmap.width, height: bitmap.height, close() {} };
  } finally {
    bitmap.close();
  }
}

async function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The lighting tile could not be encoded');
  const copy = new Uint8ClampedArray(rgba);
  context.putImageData(new ImageData(copy, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}
