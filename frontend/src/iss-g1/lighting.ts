/** Day and night weights for one surface point.
 *
 *  Civil twilight is a solar elevation from -6 degrees to the horizon.
 *  Night emission is zero once the sun is up, so a day-side pixel cannot
 *  show city lights. */

import { greatCircleAngleDeg } from '../terminator';
import { WEB_MERCATOR_MAX_LAT_DEG } from './model';

export const TWILIGHT_DEG = 6;
export const LIGHTING_BUCKET_MS = 60_000;

export const BLUE_MARBLE_TEMPLATE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';

export const BLACK_MARBLE_2016_TEMPLATE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';

export type Rgb = { r: number; g: number; b: number };

export function lightingBucket(utcMs: number): number {
  return Math.floor(utcMs / LIGHTING_BUCKET_MS);
}

export function groundSunElevationDeg(latDeg: number, lonDeg: number, subLatDeg: number, subLonDeg: number): number {
  return 90 - greatCircleAngleDeg(latDeg, lonDeg, subLatDeg, subLonDeg);
}

/** 0 on the day side, 1 at and below civil twilight, smooth between. */
export function nightWeight(sunElevationDeg: number): number {
  if (sunElevationDeg >= 0) return 0;
  if (sunElevationDeg <= -TWILIGHT_DEG) return 1;
  const t = -sunElevationDeg / TWILIGHT_DEG;
  return t * t * (3 - 2 * t);
}

export function mixPixel(day: Rgb, night: Rgb, sunElevationDeg: number): Rgb {
  const nightPart = nightWeight(sunElevationDeg);
  const dayPart = 1 - nightPart;
  return {
    r: day.r * dayPart + night.r * nightPart,
    g: day.g * dayPart + night.g * nightPart,
    b: day.b * dayPart + night.b * nightPart,
  };
}

export function tilePixelLatLon(
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
  tileSize = 256,
): { latDeg: number; lonDeg: number } {
  const n = 2 ** z;
  const gx = (x + px / tileSize) / n;
  const gy = (y + py / tileSize) / n;
  const lonDeg = gx * 360 - 180;
  const latDeg = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180 / Math.PI;
  return { latDeg, lonDeg };
}

export function beyondRaster(latDeg: number): boolean {
  return Math.abs(latDeg) > WEB_MERCATOR_MAX_LAT_DEG;
}

export function compositeRgba(
  day: Uint8ClampedArray,
  night: Uint8ClampedArray,
  z: number,
  x: number,
  y: number,
  subsolar: { latDeg: number; lonDeg: number },
  tileSize = 256,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(day.length);
  const pixels = tileSize * tileSize;
  for (let i = 0; i < pixels; i += 1) {
    const px = (i % tileSize) + 0.5;
    const py = Math.floor(i / tileSize) + 0.5;
    const where = tilePixelLatLon(z, x, y, px, py, tileSize);
    const elevation = groundSunElevationDeg(where.latDeg, where.lonDeg, subsolar.latDeg, subsolar.lonDeg);
    const mixed = beyondRaster(where.latDeg)
      ? { r: 28, g: 32, b: 38 }
      : mixPixel(
        { r: day[i * 4] ?? 0, g: day[i * 4 + 1] ?? 0, b: day[i * 4 + 2] ?? 0 },
        { r: night[i * 4] ?? 0, g: night[i * 4 + 1] ?? 0, b: night[i * 4 + 2] ?? 0 },
        elevation,
      );
    const offset = i * 4;
    out[offset] = Math.round(mixed.r);
    out[offset + 1] = Math.round(mixed.g);
    out[offset + 2] = Math.round(mixed.b);
    out[offset + 3] = 255;
  }
  return out;
}

export function fillTileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
