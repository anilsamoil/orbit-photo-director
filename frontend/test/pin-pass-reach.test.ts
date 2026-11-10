import { describe, expect, it } from 'vitest';

import { passRowReachable } from './pin-pass-reach.mjs';

describe('pass row reachability', () => {
  it('rejects a 240px row that shows only 80px inside a wider sheet', () => {
    expect(passRowReachable(
      { rect: { width: 80, height: 32 }, rawWidth: 240, rawHeight: 32 },
      { width: 320, height: 400 },
    )).toBe(false);
  });

  it('accepts a row that fills the sheet on both axes', () => {
    expect(passRowReachable(
      { rect: { width: 80, height: 200 }, rawWidth: 240, rawHeight: 480 },
      { width: 80, height: 200 },
    )).toBe(true);
  });

  it('accepts a row that is fully inside the sheet', () => {
    expect(passRowReachable(
      { rect: { width: 240, height: 32 }, rawWidth: 240, rawHeight: 32 },
      { width: 320, height: 400 },
    )).toBe(true);
  });
});
