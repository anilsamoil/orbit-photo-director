import { describe, expect, it } from 'vitest';

import { clampOpticalFov, MIN_OPTICAL_FOV_DEG } from '../src/iss-view/fov';

describe('ISS optical field clamp', () => {
  const lens = 81.2;

  it('accepts a field inside the old 12° stop and rejects one past the imagery floor', () => {
    expect(clampOpticalFov(6, lens, lens)).toBe(6);
    expect(clampOpticalFov(12, lens, lens)).toBe(12);
    expect(clampOpticalFov(0.2, lens, lens)).toBe(MIN_OPTICAL_FOV_DEG);
    expect(clampOpticalFov(0.2, lens, lens)).toBeLessThan(12);
    expect(clampOpticalFov(200, lens, lens)).toBe(lens);
    expect(clampOpticalFov(Number.NaN, lens, 40)).toBe(40);
  });
});
