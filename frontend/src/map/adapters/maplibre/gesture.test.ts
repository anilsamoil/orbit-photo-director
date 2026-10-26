import { describe, expect, it } from 'vitest';

import { gestureBlocksFollow, type GestureReading } from './gesture';

function reading(over: Partial<GestureReading> = {}): GestureReading {
  return {
    hidden: false,
    pending: false,
    dragRotate: false,
    dragPan: false,
    touchZoomRotate: false,
    touchPitch: false,
    keyboard: false,
    rotating: false,
    moving: false,
    userDriven: false,
    ...over,
  };
}

describe('gestureBlocksFollow', () => {
  it('lets a follow write through when no handler is active', () => {
    expect(gestureBlocksFollow(reading())).toBe(false);
  });

  it('holds a follow write while a rotate is pending its first move', () => {
    expect(gestureBlocksFollow(reading({ pending: true }))).toBe(true);
  });

  it.each([
    'dragRotate',
    'dragPan',
    'touchZoomRotate',
    'touchPitch',
    'keyboard',
  ] as const)('holds a follow write while %s is active', (handler) => {
    expect(gestureBlocksFollow(reading({ [handler]: true }))).toBe(true);
  });

  it('holds a follow write during a user camera ease', () => {
    expect(gestureBlocksFollow(reading({ rotating: true, userDriven: true }))).toBe(true);
    expect(gestureBlocksFollow(reading({ moving: true, userDriven: true }))).toBe(true);
  });

  it('lets the north ease recenter while the camera is rotating', () => {
    expect(gestureBlocksFollow(reading({ rotating: true, moving: true }))).toBe(false);
  });

  it('does not hold a follow write while the document is hidden', () => {
    expect(gestureBlocksFollow(reading({ hidden: true, dragRotate: true, rotating: true, userDriven: true }))).toBe(false);
  });
});
