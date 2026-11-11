import { addProtocol } from 'maplibre-gl';

import { nightLightsFade, nightLightsMinute } from '../../../night-lights';
import { subsolarPoint } from '../../../terminator';

export const VIIRS_ALPHA_PROTOCOL = 'viirs-alpha';
export const VIIRS_CACHE_MAX_TILES = 96;
export const VIIRS_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export type NightLightsTile = { z: number; x: number; y: number; atMs: number };
type TileTransform = (bytes: ArrayBuffer, tile: NightLightsTile, signal: AbortSignal) => Promise<ArrayBuffer | HTMLImageElement>;

/** Continuous light coverage removes opaque gray outskirts; source transparency is preserved. */
export function colorNightLightsPixels(pixels: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < pixels.length; i += 4) {
    const luminance = 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
    const intensity = Math.max(0, (luminance - 20) / 235);
    const warmth = Math.sqrt(intensity);
    pixels[i] = 255;
    pixels[i + 1] = Math.round(179 + 54 * warmth);
    pixels[i + 2] = Math.round(95 + 75 * warmth);
    pixels[i + 3] = Math.round(pixels[i + 3]! * 0.90 * Math.pow(intensity, 0.75));
  }
  return pixels;
}

/** Pixel centers use the same solar model as the terminator, independent of its guide visibility. */
export function maskNightLightsPixels(pixels: Uint8ClampedArray, width: number, height: number, tile: NightLightsTile): void {
  const sun = subsolarPoint(new Date(tile.atMs));
  const radians = Math.PI / 180;
  const sinDec = Math.sin(sun.lat * radians);
  const cosDec = Math.cos(sun.lat * radians);
  const world = 2 ** tile.z;
  const cosHour = Array.from({ length: width }, (_, col) => {
    const lon = (tile.x + (col + 0.5) / width) / world * 360 - 180;
    return Math.cos((lon - sun.lon) * radians);
  });
  const fullNight = Math.sin(-3 * radians);
  for (let row = 0; row < height; row += 1) {
    const mercatorY = (tile.y + (row + 0.5) / height) / world;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY)));
    const a = Math.sin(lat) * sinDec;
    const b = Math.cos(lat) * cosDec;
    for (let col = 0; col < width; col += 1) {
      const offset = (row * width + col) * 4 + 3;
      if (!pixels[offset]) continue;
      const sinElevation = a + b * cosHour[col]!;
      const fade = sinElevation >= 0 ? 0 : sinElevation <= fullNight ? 1
        : nightLightsFade(Math.asin(sinElevation) / radians);
      pixels[offset] = Math.round(pixels[offset]! * fade);
    }
  }
}

/** Decode and release the bitmap on every exit; unsupported canvas fails closed, never opaque. */
export async function renderNightLightsTile(bytes: ArrayBuffer, tile: NightLightsTile, signal: AbortSignal): Promise<HTMLImageElement> {
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    signal.throwIfAborted();
    const { width, height } = bitmap;
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Night lights require a 2D canvas');
    ctx.drawImage(bitmap, 0, 0);
    const frame = ctx.getImageData(0, 0, width, height);
    colorNightLightsPixels(frame.data);
    maskNightLightsPixels(frame.data, width, height, tile);
    ctx.putImageData(frame, 0, 0);
    const blob = 'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    signal.throwIfAborted();
    if (!blob) throw new Error('Night lights PNG encoding failed');
    const image = new Image();
    const url = URL.createObjectURL(blob);
    try {
      image.src = url;
      await image.decode();
      signal.throwIfAborted();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    bitmap.close();
  }
}

/** An eight-MiB LRU of raw public tiles survives mask ticks without retaining decoded bitmaps. */
export function createViirsAlphaHandler(viewMs: () => number, transform: TileTransform = renderNightLightsTile): Parameters<typeof addProtocol>[1] {
  const cache = new Map<string, ArrayBuffer>();
  let size = 0;
  return async (params, controller) => {
    const { signal } = controller;
    signal.throwIfAborted();
    const request = new URL(params.url.replace(`${VIIRS_ALPHA_PROTOCOL}://`, ''));
    const coordinates = request.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (!coordinates || !request.searchParams.has('night')) {
      throw new Error('Night lights require tile coordinates and a view instant');
    }
    const tile = { z: Number(coordinates[1]), y: Number(coordinates[2]), x: Number(coordinates[3]), atMs: nightLightsMinute(viewMs()) };
    request.searchParams.delete('night');
    const upstream = request.href;
    let bytes = cache.get(upstream);
    const alreadyCached = bytes !== undefined;
    if (bytes) {
      cache.delete(upstream);
      cache.set(upstream, bytes);
    } else {
      const response = await fetch(upstream, { signal });
      if (!response.ok) throw new Error(`viirs-alpha upstream fetch failed: ${response.status}`);
      bytes = await response.arrayBuffer();
      signal.throwIfAborted();
    }
    let remembered = alreadyCached;
    signal.throwIfAborted();
    for (;;) {
      tile.atMs = nightLightsMinute(viewMs());
      const data = await transform(bytes, { ...tile }, signal);
      signal.throwIfAborted();
      if (!remembered && bytes.byteLength <= VIIRS_CACHE_MAX_BYTES) {
        const previous = cache.get(upstream);
        if (previous) size -= previous.byteLength;
        cache.delete(upstream);
        cache.set(upstream, bytes);
        size += bytes.byteLength;
        while (cache.size > VIIRS_CACHE_MAX_TILES || size > VIIRS_CACHE_MAX_BYTES) {
          const oldest = cache.entries().next().value;
          if (!oldest) break;
          size -= oldest[1].byteLength;
          cache.delete(oldest[0]);
        }
        remembered = cache.has(upstream);
      }
      if (tile.atMs === nightLightsMinute(viewMs())) return { data };
    }
  };
}

export function registerViirsAlphaProtocol(viewMs: () => number): void {
  addProtocol(VIIRS_ALPHA_PROTOCOL, createViirsAlphaHandler(viewMs));
}
