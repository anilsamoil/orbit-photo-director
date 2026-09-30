import './worker-url';
import { LngLat, Map, Marker, addProtocol, type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { SkySpecification } from '@maplibre/maplibre-gl-style-spec';

import { TANGENT_PITCH_DEG } from '../../../iss-g1/model';
import { bucketFor, createComposer, type Composer, type DecodedTile } from '../../../iss-view/compose';
import type { ImageryState } from '../../../iss-view/model';
import { placeScreenLabels } from '../../../iss-view/label-layout';
import { placesOnDisk, type PlaceLabel } from '../../../iss-view/place-labels';
import type { IssAim, IssRenderer, IssRendererHooks } from '../../../iss-view/renderer';
import { collapseAttribution } from './attribution';

export const ISS_VIEW_MAX_PITCH_DEG = TANGENT_PITCH_DEG;

const PROTOCOL = 'iss-view';
const LIT_MAX_ZOOM = 8;

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

export function createIssRenderer(frame: HTMLElement, hooks: IssRendererHooks): IssRenderer {
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
  const armLabels = (): void => {
    frame.dataset.issPlaceLayers = 'country city water';
  };
  if (map.loaded()) armLabels();
  else map.once('load', armLabels);
  map.on('error', (event) => {
    const note = imageryNote(event.error);
    if (note) hooks.onImagery(note);
  });
  map.on('webglcontextlost', () => {
    hooks.onContextLost();
  });
  const removed = { done: false };
  let litTiles = '';

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
      map.resize();
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
      map.jumpTo({ ...solved, bearing: aim.pose.bearingDeg });
      syncPlaceMarkers(map, placeMarkers, aim);
      await idle(map);
    },
    destroy() {
      if (removed.done) return;
      removed.done = true;
      for (const entry of placeMarkers) entry.marker.remove();
      placeMarkers.splice(0, placeMarkers.length);
      map.remove();
    },
  };
}

function exposeIssForEndToEnd(map: MapLibreMap): void {
  if (typeof window === 'undefined') return;
  if (!new URLSearchParams(window.location.search).has('e2e')) return;
  (window as unknown as { __opdIss?: MapLibreMap }).__opdIss = map;
}

function syncPlaceMarkers(map: MapLibreMap, markers: { key: string; marker: Marker }[], aim: IssAim): void {
  const width = map.getCanvas().clientWidth;
  const height = map.getCanvas().clientHeight;
  if (width < 10 || height < 10) return;
  const candidates = placesOnDisk(
    aim.pose.camera.latDeg,
    aim.pose.camera.lonDeg,
    aim.pose.altitudeM,
    aim.pose.bearingDeg,
    aim.pose.analyticPitchDeg,
  );
  const chosen: { key: string; place: PlaceLabel; score: number; x: number; y: number }[] = [];
  for (const place of candidates) {
    const projected = map.project([place.lon, place.lat]);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
    if (projected.x < 18 || projected.y < 18 || projected.x > width - 18 || projected.y > height - 18) continue;
    const score = (projected.x - width / 2) ** 2 + (projected.y - height / 2) ** 2;
    const key = `${place.kind}:${place.name}`;
    const current = chosen.find((entry) => entry.key === key);
    if (!current) chosen.push({ key, place, score, x: projected.x, y: projected.y });
    else if (score < current.score) {
      current.place = place;
      current.score = score;
      current.x = projected.x;
      current.y = projected.y;
    }
  }
  const placed = placeScreenLabels(
    chosen.map((entry) => {
      const size = measurePlace(map.getContainer(), entry.place);
      return { kind: entry.place.kind, name: entry.place.name, x: entry.x, y: entry.y, width: size.width, height: size.height };
    }),
    { width, height },
  );
  const placedKeys = new Set(placed.map((label) => `${label.kind}:${label.name}`));
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const entry = markers[index];
    if (!entry || placedKeys.has(entry.key)) continue;
    entry.marker.remove();
    markers.splice(index, 1);
  }
  for (const label of placed) {
    const key = `${label.kind}:${label.name}`;
    const entry = chosen.find((item) => item.key === key);
    if (!entry) continue;
    const existing = markers.find((item) => item.key === key);
    if (existing) {
      existing.marker.setLngLat([entry.place.lon, entry.place.lat]);
      existing.marker.setOffset([label.offsetX, label.offsetY]);
      continue;
    }
    const node = document.createElement('span');
    node.className = `iss-place iss-place-${entry.place.kind}`;
    node.textContent = entry.place.name;
    markers.push({
      key,
      marker: new Marker({ element: node, anchor: 'top', offset: [label.offsetX, label.offsetY] })
        .setLngLat([entry.place.lon, entry.place.lat])
        .addTo(map),
    });
  }
}

function measurePlace(host: HTMLElement, place: PlaceLabel): { width: number; height: number } {
  const label = document.createElement('span');
  label.className = `iss-place iss-place-${place.kind}`;
  label.textContent = place.name;
  label.style.position = 'absolute';
  label.style.visibility = 'hidden';
  host.append(label);
  const width = label.offsetWidth;
  const height = label.offsetHeight;
  label.remove();
  return { width, height };
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
