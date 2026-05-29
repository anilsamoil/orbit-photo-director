/** VIIRS Black Marble luminance-keying protocol for MapLibre (V4-P3 — Anil
 *  2026-05-29, ends the v2 → v3.1 → v3.3 → v3.4 → v3.5 opacity saga).
 *
 *  The problem: GIBS `VIIRS_Black_Marble` is an 8-bit RGB PNG with NO alpha
 *  channel and an opaque dark navy background (~rgb 4,5,15). At any
 *  non-trivial opacity that dark background darkens the basemap and clouds
 *  everywhere, not just where city lights are. v3.3/v3.4 muted the layer to
 *  0.55 opacity so the wash was tolerable, but that also dimmed the bright
 *  city pixels — the operator (Anil) reported lights are too dim when zoomed
 *  out at 0.55.
 *
 *  The fix (this file): register a `viirs-alpha://` MapLibre protocol that
 *  fetches the upstream PNG, walks pixels in a canvas, computes luminance
 *  (Rec. 601 weighted), and rewrites dark pixels to alpha=0 with a soft
 *  linear ramp at the threshold edge so cluster boundaries don't alias. The
 *  raster now has true alpha — dark areas are transparent — so the night-
 *  lights layer can paint at 0.95 opacity without darkening anything.
 *
 *  Why the canvas dance instead of `raster-color` paint expressions: the
 *  raster-color path requires a single-band `raster-array` source (FLOAT32
 *  GeoTIFF / Zarr / etc.), not the RGB PNGs GIBS publishes. addProtocol is
 *  the cleanest fix that works with the existing tile source. ~50 LoC.
 *
 *  Threshold tuning: the dark navy background is luminance ~8; dim city
 *  lights start around luminance 50+. Threshold 30 cleanly separates them.
 *  The 10-unit linear ramp above 30 soft-keys the edges so light clusters
 *  fade smoothly into transparency rather than producing aliased hard
 *  outlines.
 *
 *  Test environments (happy-dom) have neither OffscreenCanvas nor
 *  HTMLCanvasElement.getContext('2d') with real pixel buffers. The protocol
 *  handler gracefully falls back to passthrough (returns the original PNG
 *  bytes) when canvas APIs are missing — the pure pixel-walk function is
 *  unit-tested directly via `_keyAlphaForTest`.
 */

import type maplibregl from 'maplibre-gl';

import { gibsBlackMarbleUrl } from './tile-precache';

/** Pixel luminance below this becomes fully transparent. Dark navy
 *  background is ~8, dim city lights are ~50+, so 30 cleanly separates the
 *  two. Exported for unit testing. */
export const LUMINANCE_THRESHOLD = 30;

/** Soft-key band width above the threshold. Luminance values in
 *  [threshold, threshold+ramp] map linearly to alpha [0, 255] so the edge
 *  of city clusters fades smoothly rather than aliases hard. */
export const LUMINANCE_RAMP = 10;

/** Custom URL scheme MapLibre routes to our handler. URLs look like
 *  `viirs-alpha://https://gibs.earthdata.nasa.gov/...png`. */
export const VIIRS_ALPHA_PROTOCOL = 'viirs-alpha';

/** Build a MapLibre tile URL that routes through the luminance-key handler.
 *  Wraps `gibsBlackMarbleUrl` with the `viirs-alpha://` prefix; the
 *  registered handler strips the prefix and fetches the upstream GIBS URL
 *  with {z}/{y}/{x} already substituted by MapLibre. */
export function viirsAlphaUrl(yearIso: string): string {
  return `${VIIRS_ALPHA_PROTOCOL}://${gibsBlackMarbleUrl(yearIso)}`;
}

/** Pure pixel-walk that luminance-keys an RGBA buffer in place. Returns
 *  the same buffer (also mutated) so callers can chain. Exported for unit
 *  testing without needing a canvas context. */
export function _keyAlphaForTest(pixels: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < pixels.length; i += 4) {
    // Non-null-assert: the loop bound (i < pixels.length, step 4) guarantees
    // i, i+1, i+2 are in-range. TS's noUncheckedIndexedAccess can't see that.
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    // Rec. 601 luma — matches the perceptual weighting of human vision and
    // is the standard for "is this pixel bright?" decisions in image work.
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luminance < LUMINANCE_THRESHOLD) {
      pixels[i + 3] = 0;
    } else if (luminance < LUMINANCE_THRESHOLD + LUMINANCE_RAMP) {
      // Linear ramp: luminance threshold → 0, threshold+ramp → 255.
      const t = (luminance - LUMINANCE_THRESHOLD) / LUMINANCE_RAMP;
      pixels[i + 3] = Math.round(t * 255);
    }
    // else: leave alpha at 255 (bright pixel, full opacity).
  }
  return pixels;
}

/** Internal: decode → key → encode. Returns null when canvas APIs are
 *  unavailable (happy-dom in tests), signaling the caller to passthrough. */
async function keyTileBytes(bytes: ArrayBuffer): Promise<ArrayBuffer | null> {
  // createImageBitmap is the cheapest decode path. Both browsers and Node
  // 20+ support it; happy-dom does not.
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  } catch {
    return null;
  }

  const width = bitmap.width;
  const height = bitmap.height;

  // Prefer OffscreenCanvas (works off the main thread, no DOM); fall back
  // to HTMLCanvasElement when only the latter is available.
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const el = document.createElement('canvas');
    el.width = width;
    el.height = height;
    canvas = el;
  } else {
    return null;
  }

  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) return null;

  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  _keyAlphaForTest(imageData.data);
  ctx.putImageData(imageData, 0, 0);

  // OffscreenCanvas exposes convertToBlob; HTMLCanvasElement exposes toBlob
  // (callback-based — wrap in a promise).
  let blob: Blob | null;
  if ('convertToBlob' in canvas) {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    blob = await new Promise<Blob | null>((resolve) =>
      (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), 'image/png'),
    );
  }
  if (!blob) return null;
  return await blob.arrayBuffer();
}

let registered = false;

/** Register the `viirs-alpha://` protocol handler with MapLibre. Idempotent
 *  — calling more than once is a no-op so tests and hot-reload don't double-
 *  register. */
export function registerViirsAlphaProtocol(mapLibre: typeof maplibregl): void {
  if (registered) return;
  registered = true;
  mapLibre.addProtocol(VIIRS_ALPHA_PROTOCOL, async (params, _abortController) => {
    // Strip the `viirs-alpha://` prefix to recover the upstream GIBS URL.
    // MapLibre has already substituted {z}/{y}/{x} by this point.
    const upstream = params.url.replace(`${VIIRS_ALPHA_PROTOCOL}://`, '');
    const response = await fetch(upstream);
    if (!response.ok) {
      throw new Error(`viirs-alpha upstream fetch failed: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    const keyed = await keyTileBytes(bytes);
    return { data: keyed ?? bytes };
  });
}

/** Test-only: reset the registered flag so multiple test files can each
 *  call registerViirsAlphaProtocol against fresh mocks. */
export function _resetRegisteredForTest(): void {
  registered = false;
}
