import { describe, expect, it } from 'vitest';

import {
  LUMINANCE_RAMP,
  LUMINANCE_THRESHOLD,
  VIIRS_ALPHA_PROTOCOL,
  _keyAlphaForTest,
  viirsAlphaUrl,
} from '../src/viirs-alpha-protocol';

// V4-P3 (v3.5, 2026-05-29): luminance-key protocol for the VIIRS Black
// Marble PNG. We can't test the actual MapLibre addProtocol registration
// here — happy-dom has neither OffscreenCanvas nor a real canvas 2d
// context with getImageData/putImageData. But the pixel-walk is a pure
// function, and that's where the interesting logic lives.

function rgba(r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a]);
}

describe('_keyAlphaForTest', () => {
  it('dark navy background pixel (rgb 4,5,15) becomes fully transparent', () => {
    // Background of the actual GIBS VIIRS_Black_Marble PNG. Luminance is
    // 0.299*4 + 0.587*5 + 0.114*15 ≈ 5.84 — well under the threshold.
    const px = rgba(4, 5, 15);
    _keyAlphaForTest(px);
    expect(px[3]).toBe(0);
  });

  it('bright city-lights pixel (rgb 255,235,150) stays fully opaque', () => {
    // A representative bright city pixel. Luminance ≈ 0.299*255 + 0.587*235
    // + 0.114*150 = 76.245 + 137.9 + 17.1 ≈ 231 — well above threshold+ramp.
    const px = rgba(255, 235, 150);
    _keyAlphaForTest(px);
    expect(px[3]).toBe(255);
  });

  it('pixel exactly at the threshold gets alpha=0 (strict less-than ramp)', () => {
    // Construct a pixel whose luminance is exactly LUMINANCE_THRESHOLD via
    // a pure-green color: 0.587 * g = threshold → g = threshold/0.587. The
    // ramp condition is `< threshold + ramp`; the threshold boundary itself
    // falls in the ramp (alpha ramps from 0). At the exact threshold the
    // ramp factor is 0 → alpha 0.
    const g = Math.round(LUMINANCE_THRESHOLD / 0.587);
    const px = rgba(0, g, 0);
    // Recompute and confirm: with rounding, luminance is at most a fraction
    // off the threshold. The test stays meaningful whether we end up just
    // above or just below — alpha must be 0 or near-0, never 255.
    _keyAlphaForTest(px);
    expect(px[3]).toBeLessThanOrEqual(20);
  });

  it('mid-ramp pixel (luminance halfway through ramp) gets alpha ≈ 127', () => {
    // Pure green at luminance threshold+ramp/2. With threshold=30, ramp=10
    // the midpoint is 35 → g ≈ 60. The ramp factor is 0.5 → alpha ≈ 127.5
    // → rounded to 128. Allow ±2 slack for the integer-rounding of g.
    const targetLum = LUMINANCE_THRESHOLD + LUMINANCE_RAMP / 2;
    const g = Math.round(targetLum / 0.587);
    const px = rgba(0, g, 0);
    _keyAlphaForTest(px);
    expect(px[3]).toBeGreaterThanOrEqual(120);
    expect(px[3]).toBeLessThanOrEqual(135);
  });

  it('multi-pixel buffer keys each pixel independently', () => {
    // Three pixels: dark, mid-ramp, bright. Each pixel is 4 bytes (RGBA).
    const targetMidLum = LUMINANCE_THRESHOLD + LUMINANCE_RAMP / 2;
    const gMid = Math.round(targetMidLum / 0.587);
    const buf = new Uint8ClampedArray([
      4, 5, 15, 255,          // dark — alpha → 0
      0, gMid, 0, 255,        // mid-ramp — alpha ≈ 127
      255, 235, 150, 255,     // bright — alpha stays 255
    ]);
    _keyAlphaForTest(buf);
    expect(buf[3]).toBe(0);
    expect(buf[7]).toBeGreaterThanOrEqual(120);
    expect(buf[7]).toBeLessThanOrEqual(135);
    expect(buf[11]).toBe(255);
  });

  it('returns the same buffer (mutates in place)', () => {
    const px = rgba(4, 5, 15);
    const result = _keyAlphaForTest(px);
    expect(result).toBe(px);
  });
});

describe('viirsAlphaUrl', () => {
  it('returns a string starting with the viirs-alpha:// scheme', () => {
    const url = viirsAlphaUrl('2016-01-01');
    expect(url.startsWith(`${VIIRS_ALPHA_PROTOCOL}://`)).toBe(true);
  });

  it('embeds the upstream GIBS URL without double-encoding', () => {
    const url = viirsAlphaUrl('2016-01-01');
    expect(url).toContain('https://gibs.earthdata.nasa.gov/');
    expect(url).toContain('VIIRS_Black_Marble');
    expect(url).toContain('/2016-01-01/');
    // No URL-encoding: the colon and slashes from the upstream URL must
    // pass through literally so the handler can strip the prefix cleanly.
    expect(url).not.toContain('%3A');
    expect(url).not.toContain('%2F');
  });
});
