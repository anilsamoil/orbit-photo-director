import { describe, expect, it } from 'vitest';

import { initialZoomForViewport, mapCameraOptions } from '../src/map';

// Characterization of the camera the map is constructed with. The map opens
// at the null island, not at the ISS: main.ts's 1Hz applyFollowISS tick does
// the first recenter, because follow mode defaults on. Anything that moves
// the construction-time center changes what the operator sees for the first
// second after the Map tab opens.

describe('mapCameraOptions', () => {
  it('opens at lon 0, lat 0 and lets the follow tick do the first recenter', () => {
    expect(mapCameraOptions(1024).center).toEqual([0, 0]);
  });

  it('takes its zoom from the viewport width, holding the iPad framing', () => {
    expect(mapCameraOptions(1024).zoom).toBe(2);
    expect(mapCameraOptions(390).zoom).toBe(initialZoomForViewport(390));
    expect(mapCameraOptions(390).zoom).toBeLessThan(2);
  });

  it('falls back to the reference zoom when the container reports no width', () => {
    expect(mapCameraOptions(0).zoom).toBe(2);
  });

  it('renders world copies so the ground track is not clipped at the edge', () => {
    expect(mapCameraOptions(1024).renderWorldCopies).toBe(true);
  });

  it('states every gesture explicitly, so a MapLibre major cannot flip one', () => {
    const { dragPan, dragRotate, scrollZoom, touchZoomRotate, touchPitch } = mapCameraOptions(1024);
    expect({ dragPan, dragRotate, scrollZoom, touchZoomRotate, touchPitch }).toEqual({
      dragPan: true,
      dragRotate: true,
      scrollZoom: true,
      touchZoomRotate: true,
      touchPitch: true,
    });
  });

  it('compacts the attribution control so it does not cover the dock', () => {
    expect(mapCameraOptions(1024).attributionControl).toEqual({ compact: true });
  });

  it('sets no projection, bearing, or pitch, inheriting mercator and zero', () => {
    const keys = Object.keys(mapCameraOptions(1024));
    expect(keys).not.toContain('projection');
    expect(keys).not.toContain('bearing');
    expect(keys).not.toContain('pitch');
    expect(keys).not.toContain('maxZoom');
    expect(keys).not.toContain('minZoom');
  });

  it('passes exactly the options renderMap spreads, and no others', () => {
    expect(Object.keys(mapCameraOptions(1024)).sort()).toEqual([
      'attributionControl',
      'center',
      'dragPan',
      'dragRotate',
      'renderWorldCopies',
      'scrollZoom',
      'touchPitch',
      'touchZoomRotate',
      'zoom',
    ]);
  });
});
