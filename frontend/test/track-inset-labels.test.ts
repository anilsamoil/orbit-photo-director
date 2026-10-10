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
        paint?: { 'raster-opacity'?: number; 'text-color'?: string; 'text-opacity'?: unknown };
        minzoom?: number;
        maxzoom?: number;
        filter?: unknown;
        layout?: {
          'text-field'?: unknown;
          'text-font'?: string[];
          'text-allow-overlap'?: boolean;
          'text-ignore-placement'?: boolean;
          'text-variable-anchor-offset'?: unknown;
          'symbol-sort-key'?: unknown;
        };
      }[];
    };
  },
  fit: null as null | { maxZoom?: number; padding?: number },
  events: {} as Record<string, () => void>,
  zoom: 0,
  center: [-100, 50] as [number, number],
  size: [478, 690] as [number, number],
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
    on(event: string, handler: () => void): void { created.events[event] = handler; }
    getZoom(): number { return created.zoom; }
    project([lon, lat]: [number, number]): { x: number; y: number } {
      const y = (latitude: number) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
      const scale = 512 * 2 ** created.zoom;
      return { x: created.size[0] / 2 + (lon - created.center[0]) / 360 * scale, y: created.size[1] / 2 + (y(lat) - y(created.center[1])) * scale };
    }
    setFilter(id: string, filter: unknown): void {
      const layer = created.options?.style.layers.find((entry) => entry.id === id);
      if (layer) layer.filter = filter;
    }
    resize(): void {}
    getSource(): { setData(): void } { return { setData() {} }; }
    fitBounds(_bounds: unknown, options: { maxZoom?: number }): void { created.fit = options; }
    jumpTo(): void {}
    remove(): void {}
  }
  return { Map, Marker };
});

import countryRasterLevels from '../src/map/adapters/maplibre/country-raster-levels.json' with { type: 'json' };
import { createTrackInset, letterboxCamera, readableCountryName } from '../src/map/adapters/maplibre/track-inset';

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
    expect(style?.layers[1]?.paint?.['raster-opacity']).toBe(0.85);
    expect(style?.glyphs).toBe('/glyphs/{fontstack}/{range}.pbf');
    const countries = style?.layers.find((layer) => layer.id === 'inset-countries');
    expect(countries?.type).toBe('symbol');
    expect(countries?.layout?.['text-field']).toEqual(['get', 'name']);
    expect(countries?.layout?.['text-font']).toEqual(['Open Sans Regular']);
    expect(countries?.layout?.['text-allow-overlap']).not.toBe(true);
    expect(countries?.layout?.['text-ignore-placement']).not.toBe(true);
    expect(countries?.layout?.['text-variable-anchor-offset']).toEqual([
      'match', ['get', 'name'], 'Kenya',
      ['literal', expect.arrayContaining(['top', [0, 1.5], 'bottom', [0, -1.5]])],
      ['literal', expect.arrayContaining(['left', 'right', 'top', 'bottom'])],
    ]);
    expect(countries?.layout?.['symbol-sort-key']).toEqual(['match', ['get', 'name'], 'Nigeria', 0, 'Kenya', 1, 2]);
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
    const opacityOn = (layer: (typeof layers)[number], zoom: number) => {
      const opacity = layer.paint?.['text-opacity'];
      if (!Array.isArray(opacity) || opacity[0] !== 'step') return opacity !== 0;
      let value: unknown = opacity[2];
      for (let index = 3; index + 1 < opacity.length; index += 2) {
        if (zoom >= Number(opacity[index])) value = opacity[index + 1];
      }
      return value !== 0;
    };
    const covers = (name: string, zoom: number) => layers.some((layer) => {
      if (!listed(layer).includes(name) || !opacityOn(layer, zoom)) return false;
      const min = layer.minzoom ?? Number.NEGATIVE_INFINITY;
      const max = layer.maxzoom ?? Number.POSITIVE_INFINITY;
      return zoom >= min && zoom < max;
    });
    expect(layers.some((layer) => layer.maxzoom != null && layer.maxzoom <= 0)).toBe(false);
    expect(covers('Australia', -1)).toBe(true);
    expect(covers('Australia', -0.51)).toBe(true);
    expect(covers('Australia', -0.5)).toBe(false);
    expect(covers('Australia', -0.227)).toBe(false);
    expect(covers('Australia', 1.49)).toBe(false);
    expect(covers('Australia', 1.5)).toBe(false);
    expect(covers('Australia', 2.49)).toBe(false);
    expect(covers('Australia', 2.5)).toBe(false);
    for (const zoom of [3.49, 3.5, 4.49, 4.5, 5]) expect(covers('Australia', zoom), `Australia @ ${zoom}`).toBe(false);
    expect(covers('Brazil', 3.5)).toBe(false);
    expect(covers('India', 3.5)).toBe(false);
    expect(covers('Nigeria', 1.49)).toBe(true);
    expect(covers('Nigeria', 1.5)).toBe(false);
    expect(covers('Nigeria', 2.49)).toBe(false);
    expect(covers('France', 1.49)).toBe(true);
    expect(covers('France', 1.5)).toBe(false);
    expect(covers('Japan', 1.49)).toBe(true);
    expect(covers('Japan', 1.5)).toBe(false);
    expect(covers('Kenya', 1.49)).toBe(true);
    expect(covers('Kenya', 2.49)).toBe(true);
    expect(covers('Kenya', 2.5)).toBe(false);
    const auditedLevels: Record<string, number[]> = Object.fromEntries(
      ['Canada', 'Mexico', 'Brazil', 'Argentina', 'France', 'Egypt', 'Nigeria', 'Kenya', 'China', 'India', 'Japan', 'Australia']
        .map((name) => [name, name === 'Australia' ? [1, 2, 3, 4, 5, 6] : name === 'Kenya' ? [4, 5, 6] : [3, 4, 5, 6]]),
    );
    expect(countryRasterLevels.through).toBe(6);
    expect(countryRasterLevels.countries).toEqual(auditedLevels);
    const samples = new Set([-1.1497862143712645, -0.23372503287116042, 5]);
    for (let tile = 1; tile <= countryRasterLevels.through; tile += 1) {
      for (const delta of [-0.01, 0, 0.01]) samples.add(Number((tile - 1.5 + delta).toFixed(2)));
    }
    for (const layer of layers) {
      for (const edge of [layer.minzoom, layer.maxzoom]) {
        if (edge != null) for (const delta of [-0.01, 0, 0.01]) samples.add(edge + delta);
      }
    }
    for (const [name, levels] of Object.entries(auditedLevels)) {
      for (const zoom of samples) {
        const tile = Math.max(0, Math.round(zoom + 1));
        const onRaster = tile <= countryRasterLevels.through
          ? levels.includes(tile)
          : levels.includes(countryRasterLevels.through);
        expect(covers(name, zoom), `${name} @ ${zoom}`).toBe(!onRaster);
      }
    }
    inset.destroy();
  });

  it('requires the complete raster lettering inside the viewport and outside chrome', () => {
    const viewport = { left: 0, top: 0, right: 274, bottom: 984 };
    const canada = { left: 66, top: 95, right: 164, bottom: 109 };
    expect(readableCountryName(canada, viewport, [])).toBe(true);
    expect(readableCountryName(canada, viewport, [{ left: 21, top: 20, right: 220, bottom: 113 }])).toBe(false);
    expect(readableCountryName({ ...canada, top: -51, bottom: -37 }, { ...viewport, right: 478, bottom: 690 }, [])).toBe(false);
    expect(readableCountryName({ left: 252, top: 494, right: 335, bottom: 508 }, viewport, [])).toBe(false);
  });

  it('restores centered Canada and Brazil only when their audited raster name is clipped or covered', () => {
    for (const [name, center, size, chrome, expected] of [
      ['Canada', [-100, 50], [478, 690], false, true],
      ['Canada', [-100, 50], [274, 984], false, false],
      ['Canada', [-100, 50], [274, 984], true, true],
      ['Brazil', [-55, -10], [274, 984], false, true],
      ['Brazil', [-55, -10], [478, 690], false, false],
      ['Canada', [0, 0], [478, 690], false, false],
    ] as const) {
      created.zoom = 5;
      created.center = [...center];
      created.size = [...size];
      const frame = document.createElement('div');
      Object.defineProperty(frame, 'clientWidth', { value: size[0] });
      Object.defineProperty(frame, 'clientHeight', { value: size[1] });
      const cover = document.createElement('div');
      cover.dataset.issClock = '';
      if (chrome) {
        cover.getClientRects = () => [{ left: 20, top: 20, right: 250, bottom: 120 }] as unknown as DOMRectList;
        cover.getBoundingClientRect = () => ({ left: 20, top: 20, right: 250, bottom: 120 }) as DOMRect;
        document.body.append(cover);
      }
      const inset = createTrackInset(frame, document.createElement('div'));
      created.events.render?.();
      const filter = created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]];
      expect(filter[2][1].includes(name), `${name} ${size} chrome=${chrome}`).toBe(expected);
      if (chrome) {
        cover.style.visibility = 'hidden';
        created.events.render?.();
        const uncovered = created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]];
        expect(uncovered[2][1]).not.toContain(name);
      }
      cover.remove();
      inset.destroy();
    }
  });
});
