import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({
  options: null as null | {
    minZoom?: number;
    validateStyle?: boolean;
    renderWorldCopies?: boolean;
    transformConstrain?: (center: { lng: number; lat: number }, zoom: number) => { center: { lng: number; lat: number }; zoom: number };
    style: {
      glyphs?: string;
      sources: Record<string, { tiles?: string[]; maxzoom?: number; data?: { features?: { properties?: { name?: string } }[] } }>;
      layers: {
        id: string;
        type?: string;
        source?: string;
        paint?: { 'raster-opacity'?: number; 'text-color'?: string };
        minzoom?: number;
        maxzoom?: number;
        filter?: unknown;
        layout?: {
          'text-field'?: unknown;
          'text-font'?: string[];
          'text-allow-overlap'?: boolean;
          'text-ignore-placement'?: boolean;
        };
      }[];
    };
  },
  fit: null as null | { maxZoom?: number; padding?: number },
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

import countryRasterLevels from '../src/map/adapters/maplibre/country-raster-levels.json' with { type: 'json' };
import { createTrackInset, letterboxCamera } from '../src/map/adapters/maplibre/track-inset';

describe('plan inset labels', () => {
  it('draws the Esri reference raster above the basemap and lets a tighter track zoom past 2', () => {
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 274 });
    Object.defineProperty(frame, 'clientHeight', { value: 900 });
    const marker = document.createElement('div');
    const inset = createTrackInset(frame, marker);
    const center = { lng: 118.33, lat: 0 };
    expect(letterboxCamera(center as unknown as Parameters<typeof letterboxCamera>[0], -1.15)).toEqual({ center, zoom: -1.15 });
    expect(created.options?.minZoom).toBeLessThanOrEqual(-1);
    expect(created.options?.renderWorldCopies).toBe(false);
    expect(created.options?.transformConstrain).toBe(letterboxCamera);
    const style = created.options?.style;
    expect(style?.sources['inset-basemap']?.tiles).toEqual([
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    ]);
    expect(style?.sources['inset-labels']?.tiles?.[0]).toContain('World_Boundaries_and_Places');
    expect(style?.sources['inset-labels']?.maxzoom).toBeGreaterThan(2);
    const ids = style?.layers.map((layer) => layer.id);
    expect(ids?.slice(0, 3)).toEqual(['inset-basemap', 'inset-labels', 'inset-track']);
    expect(ids).toContain('inset-countries');
    expect(created.options?.validateStyle).toBe(false);
    expect(style?.layers[1]?.paint?.['raster-opacity']).toBe(0.85);
    expect(style?.glyphs).toBe('/glyphs/{fontstack}/{range}.pbf');
    const countries = style?.layers.find((layer) => layer.id === 'inset-countries');
    expect(countries?.type).toBe('symbol');
    expect(countries?.layout?.['text-field']).toEqual(['get', 'name']);
    expect(countries?.layout?.['text-font']).toEqual(['Open Sans Regular']);
    expect(countries?.layout?.['text-allow-overlap']).not.toBe(true);
    expect(countries?.layout?.['text-ignore-placement']).not.toBe(true);
    expect(style?.sources['inset-countries']?.data?.features?.some((feature) => feature.properties?.name === 'Brazil')).toBe(true);
    const glyphs = readFileSync(resolve(__dirname, '../public/glyphs/Open Sans Regular/0-255.pbf'));
    expect(glyphs.byteLength).toBeGreaterThan(10000);
    inset.show([{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10]] },
    }], { lon: 5, lat: 5 });
    expect(created.fit?.maxZoom).toBe(5);
    inset.destroy();
  });

  it('shows a centroid symbol only when that tile zoom is missing from the painted levels', () => {
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 274 });
    Object.defineProperty(frame, 'clientHeight', { value: 900 });
    const inset = createTrackInset(frame, document.createElement('div'));
    const layers = (created.options?.style?.layers ?? []).filter((layer) => layer.type === 'symbol' && layer.source === 'inset-countries');
    const listed = (layer: (typeof layers)[number]) => {
      const filter = layer.filter;
      if (!Array.isArray(filter) || filter[0] !== 'in' || !Array.isArray(filter[2]) || filter[2][0] !== 'literal' || !Array.isArray(filter[2][1])) {
        return [];
      }
      return filter[2][1].filter((name): name is string => typeof name === 'string');
    };
    const covers = (name: string, zoom: number) => layers.some((layer) => {
      if (!listed(layer).includes(name)) return false;
      const min = layer.minzoom ?? Number.NEGATIVE_INFINITY;
      const max = layer.maxzoom ?? Number.POSITIVE_INFINITY;
      return zoom >= min && zoom < max;
    });
    expect(covers('Australia', -0.227)).toBe(false);
    expect(covers('Australia', 1.49)).toBe(false);
    expect(covers('Australia', 1.5)).toBe(true);
    expect(covers('Australia', 2.49)).toBe(true);
    expect(covers('Australia', 2.5)).toBe(false);
    expect(covers('France', 1.49)).toBe(true);
    expect(covers('France', 1.5)).toBe(false);
    expect(covers('Japan', 1.49)).toBe(true);
    expect(covers('Japan', 1.5)).toBe(false);
    expect(covers('Kenya', 1.49)).toBe(true);
    expect(covers('Kenya', 2.49)).toBe(true);
    expect(covers('Kenya', 2.5)).toBe(false);
    const painted = countryRasterLevels.countries;
    for (const [name, levels] of Object.entries(painted)) {
      for (let step = -50; step <= 310; step += 5) {
        const zoom = step / 100;
        const tile = Math.max(0, Math.round(zoom + 1));
        const onRaster = tile <= countryRasterLevels.through
          ? levels.includes(tile)
          : levels.includes(countryRasterLevels.through);
        expect(covers(name, zoom), `${name} @ ${zoom}`).toBe(!onRaster);
      }
    }
    inset.destroy();
  });
});
