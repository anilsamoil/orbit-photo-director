import './worker-url';
import { LngLat, Map, addProtocol, type Map as MapLibreMap } from 'maplibre-gl';
import type { SkySpecification } from '@maplibre/maplibre-gl-style-spec';

import { TANGENT_PITCH_DEG } from '../../../iss-g1/model';
import { bucketFor, createComposer, type Composer, type DecodedTile } from '../../../iss-view/compose';
import type { ImageryState } from '../../../iss-view/model';
import type { IssAim, IssRenderer, IssRendererHooks } from '../../../iss-view/renderer';

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
  map.on('error', (event) => {
    const note = imageryNote(event.error);
    if (note) hooks.onImagery(note);
  });
  map.on('webglcontextlost', () => {
    hooks.onContextLost();
  });
  const removed = { done: false };

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
      const tiles = [`${PROTOCOL}://lit/${bucket}/{z}/{y}/{x}`];
      const existing = map.getSource('iss-lit');
      if (existing && 'setTiles' in existing && typeof existing.setTiles === 'function') {
        existing.setTiles(tiles);
      } else if (!existing) {
        map.addSource('iss-lit', {
          type: 'raster',
          tiles,
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
      }
      const solved = map.calculateCameraOptionsFromTo(
        new LngLat(aim.pose.camera.lonDeg, aim.pose.camera.latDeg),
        aim.pose.altitudeM,
        new LngLat(aim.pose.targetLonDeg, aim.pose.targetLatDeg),
        0,
      );
      map.jumpTo({ ...solved, bearing: aim.pose.bearingDeg });
      await idle(map);
    },
    destroy() {
      if (removed.done) return;
      removed.done = true;
      map.remove();
    },
  };
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
