/** The `viirs-alpha://` tile protocol. GIBS publishes VIIRS Black Marble as
 *  an RGB PNG with no alpha and an opaque dark-navy background (~rgb 4,5,15),
 *  so at any useful opacity the background dims the basemap everywhere. This
 *  handler fetches the PNG, keys dark pixels to alpha 0 through a canvas, and
 *  hands MapLibre a tile with true transparency. A `raster-color` paint
 *  expression cannot do this because it needs a single-band raster-array
 *  source, not an RGB PNG. Where canvas APIs are missing (happy-dom) the
 *  handler passes the original bytes through. */

import maplibregl from 'maplibre-gl';

import { gibsBlackMarbleUrl } from '../../../tile-precache';

/** Pixel luminance below this becomes fully transparent. Dark navy
 *  background is ~8, dim city lights are ~50+, so 30 cleanly separates the
 *  two. */
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

/** Luminance-key an RGBA buffer in place and return it. */
export function keyAlpha(pixels: Uint8ClampedArray): Uint8ClampedArray {
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
  keyAlpha(imageData.data);
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

export function registerViirsAlphaProtocol(): void {
  maplibregl.addProtocol(VIIRS_ALPHA_PROTOCOL, async (params, _abortController) => {
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

