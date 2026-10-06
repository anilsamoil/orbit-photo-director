import { describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({
  options: null as null | {
    style: {
      sources: Record<string, { tiles?: string[]; maxzoom?: number }>;
      layers: { id: string; source?: string; paint?: { 'raster-opacity'?: number } }[];
    };
  },
  fit: null as null | { maxZoom?: number },
}));

vi.mock('maplibre-gl', () => {
  class Marker {
    setLngLat(): this { return this; }
    addTo(): this { return this; }
    remove(): void {}
  }
  class Map {
    constructor(public options: typeof created.options) {
      created.options = options;
    }
    isStyleLoaded(): boolean { return true; }
    once(): void {}
    on(): void {}
    resize(): void {}
    getSource(): { setData(): void } { return { setData() {} }; }
    fitBounds(_bounds: unknown, options: { maxZoom?: number }): void { created.fit = options; }
    jumpTo(): void {}
    remove(): void {}
  }
  return { Map, Marker };
});

import { createTrackInset } from '../src/map/adapters/maplibre/track-inset';

describe('plan inset labels', () => {
  it('draws the Esri reference raster above the basemap and lets a tighter track zoom past 2', () => {
    const frame = document.createElement('div');
    const marker = document.createElement('div');
    const inset = createTrackInset(frame, marker);
    const style = created.options?.style;
    expect(style?.sources['inset-labels']?.tiles?.[0]).toContain('World_Boundaries_and_Places');
    expect(style?.sources['inset-labels']?.maxzoom).toBeGreaterThan(2);
    const ids = style?.layers.map((layer) => layer.id);
    expect(ids).toEqual(['inset-basemap', 'inset-labels', 'inset-track']);
    expect(style?.layers[1]?.paint?.['raster-opacity']).toBe(0.85);
    expect(frame.dataset.insetLabelTiles).toBe('0');
    inset.show([{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10]] },
    }], { lon: 5, lat: 5 });
    expect(created.fit?.maxZoom).toBe(5);
    inset.destroy();
  });
});
