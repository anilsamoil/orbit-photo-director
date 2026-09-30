import { describe, expect, it } from 'vitest';

import {
  compositeRgba,
  groundSunElevationDeg,
  lightingBucket,
  mixPixel,
  nightWeight,
  tilePixelLatLon,
} from '../src/iss-g1/lighting';

describe('local day and night mix', () => {
  it('keeps city lights off the day side and on through civil twilight', () => {
    const day = { r: 40, g: 90, b: 180 };
    const night = { r: 255, g: 220, b: 80 };
    expect(nightWeight(12)).toBe(0);
    expect(nightWeight(0)).toBe(0);
    expect(nightWeight(-6)).toBe(1);
    expect(nightWeight(-9)).toBe(1);
    expect(nightWeight(-3)).toBeCloseTo(0.5, 6);
    expect(mixPixel(day, night, 12)).toEqual(day);
    expect(mixPixel(day, night, -9)).toEqual(night);
    expect(mixPixel(day, night, -3)).toEqual({ r: 147.5, g: 155, b: 130 });
    expect(groundSunElevationDeg(0, 0, 0, 0)).toBeCloseTo(90, 6);
    expect(groundSunElevationDeg(0, 90, 0, 0)).toBeCloseTo(0, 6);
  });

  it('agrees on the shared edge of two tiles and rolls the lighting bucket each minute', () => {
    const edge = tilePixelLatLon(3, 2, 1, 256, 40, 256);
    const next = tilePixelLatLon(3, 3, 1, 0, 40, 256);
    expect(edge.lonDeg).toBeCloseTo(next.lonDeg, 8);
    expect(edge.latDeg).toBeCloseTo(next.latDeg, 8);
    expect(Math.abs(tilePixelLatLon(0, 0, 0, 128, 0, 256).latDeg)).toBeLessThan(85.051129);
    expect(lightingBucket(59_999)).toBe(0);
    expect(lightingBucket(60_000)).toBe(1);
    expect(lightingBucket(119_999)).toBe(1);
  });

  it('mixes a tile so the subsolar pixel is day color and the opposite pixel is night color', () => {
    const day = new Uint8ClampedArray(4);
    const night = new Uint8ClampedArray(4);
    day.set([10, 20, 200, 255]);
    night.set([240, 200, 40, 255]);
    const noon = compositeRgba(day, night, 0, 0, 0, { latDeg: 0, lonDeg: 0 }, 1);
    const midnight = compositeRgba(day, night, 0, 0, 0, { latDeg: 0, lonDeg: 180 }, 1);
    expect([noon[0], noon[1], noon[2]]).toEqual([10, 20, 200]);
    expect([midnight[0], midnight[1], midnight[2]]).toEqual([240, 200, 40]);
  });
});
