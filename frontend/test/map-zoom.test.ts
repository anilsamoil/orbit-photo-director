import { describe, it, expect } from 'vitest';
import { initialZoomForViewport } from '../src/map';

// Web-mercator world width in CSS px at a given zoom (MapLibre 512px tile units).
const worldPx = (z: number) => 512 * 2 ** z;
const visibleFraction = (widthPx: number) =>
  widthPx / worldPx(initialZoomForViewport(widthPx));

describe('initialZoomForViewport', () => {
  it('keeps iPad and desktop framing exactly as-is', () => {
    // Regression guard: the 2026-05-17 operator tuning picked z=2 at iPad width.
    expect(initialZoomForViewport(1024)).toBe(2);
    // Wider screens clamp rather than zooming in past the tuned value.
    expect(initialZoomForViewport(1600)).toBe(2);
    expect(initialZoomForViewport(2560)).toBe(2);
  });

  it('zooms out on iPhone so the same slice of Earth is visible', () => {
    // The reported bug: at a fixed z=2 an iPhone saw ~19% of the world vs the
    // iPad's 50%, which reads as "zoomed in".
    const iphone = initialZoomForViewport(390);
    expect(iphone).toBeLessThan(2);
    expect(visibleFraction(390)).toBeCloseTo(visibleFraction(1024), 6);
  });

  it('holds the visible fraction constant across phone and tablet widths', () => {
    for (const w of [320, 390, 430, 768, 834, 1024]) {
      expect(visibleFraction(w)).toBeCloseTo(0.5, 6);
    }
  });

  it('never returns a negative or non-finite zoom', () => {
    for (const w of [0, -100, NaN, Infinity]) {
      const z = initialZoomForViewport(w);
      expect(Number.isFinite(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(0);
    }
  });
});
