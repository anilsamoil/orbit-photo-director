import { describe, expect, it } from 'vitest';

import { maplibreMapOptions } from '../src/map/adapters/maplibre';
import { initialCamera, initialZoomForViewport } from '../src/map/map-core/camera';

// Characterization of the camera the map is constructed with. The map opens
// at the null island, not at the ISS: main.ts's 1Hz applyFollowISS tick does
// the first recenter, because follow mode defaults on. Anything that moves
// the construction-time center changes what the operator sees for the first
// second after the Map tab opens.

describe('initialCamera', () => {
  it('opens at lon 0, lat 0 and lets the follow tick do the first recenter', () => {
    expect(initialCamera(1024).center).toEqual([0, 0]);
  });

  it('takes its zoom from the viewport width, holding the iPad framing', () => {
    expect(initialCamera(1024).zoom).toBe(2);
    expect(initialCamera(390).zoom).toBe(initialZoomForViewport(390));
    expect(initialCamera(390).zoom).toBeLessThan(2);
  });

  it('falls back to the reference zoom when the container reports no width', () => {
    expect(initialCamera(0).zoom).toBe(2);
  });
});

describe('maplibreMapOptions', () => {
  it('carries the camera through to the constructor unchanged', () => {
    expect(maplibreMapOptions(initialCamera(1024)).center).toEqual([0, 0]);
    expect(maplibreMapOptions(initialCamera(1024)).zoom).toBe(2);
    expect(maplibreMapOptions(initialCamera(390)).zoom).toBe(initialZoomForViewport(390));
  });

  it('renders world copies so the ground track is not clipped at the edge', () => {
    expect(maplibreMapOptions(initialCamera(1024)).renderWorldCopies).toBe(true);
  });

  it('states every gesture explicitly, so a MapLibre major cannot flip one', () => {
    const { dragPan, dragRotate, scrollZoom, touchZoomRotate, touchPitch } = maplibreMapOptions(initialCamera(1024));
    expect({ dragPan, dragRotate, scrollZoom, touchZoomRotate, touchPitch }).toEqual({
      dragPan: true,
      dragRotate: true,
      scrollZoom: true,
      touchZoomRotate: true,
      touchPitch: true,
    });
  });

  it('compacts the attribution control so it does not cover the dock', () => {
    expect(maplibreMapOptions(initialCamera(1024)).attributionControl).toEqual({ compact: true });
  });

  it('sets no projection, bearing, or pitch, inheriting mercator and zero', () => {
    const keys = Object.keys(maplibreMapOptions(initialCamera(1024)));
    expect(keys).not.toContain('projection');
    expect(keys).not.toContain('bearing');
    expect(keys).not.toContain('pitch');
    expect(keys).not.toContain('maxZoom');
    expect(keys).not.toContain('minZoom');
  });

  it('passes exactly the options the adapter spreads into the constructor, and no others', () => {
    expect(Object.keys(maplibreMapOptions(initialCamera(1024))).sort()).toEqual([
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
