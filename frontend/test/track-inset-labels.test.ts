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
        minzoom?: number;
        maxzoom?: number;
        filter?: unknown;
        paint?: { 'raster-opacity'?: number; 'text-color'?: string; 'text-opacity'?: unknown; 'fill-opacity'?: number };
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
    interactive?: boolean;
    scrollZoom?: boolean;
    dragPan?: boolean;
    doubleClickZoom?: boolean;
    maxZoom?: number;
    container?: HTMLElement;
  },
  fit: null as null | { maxZoom?: number; padding?: number },
  events: {} as Record<string, () => void>,
  zoom: 0,
  center: [-100, 50] as [number, number],
  size: [478, 690] as [number, number],
  fitCount: 0,
  resizeCalls: 0,
  gestureStops: 0,
  gesturing: false,
  rotationLocks: 0,
  domClicks: 0,
  zooming: false,
  staleDrag: false,
  sources: new Map<string, { features?: unknown[] }>(),
  setDataCalls: [] as string[],
  handlers: {} as Record<string, ((event: { originalEvent?: Event; preventDefault?: () => void }) => void)[]>,
}));

vi.mock('maplibre-gl', () => {
  class Marker {
    constructor(public options?: { element?: HTMLElement }) {}
    setLngLat(): this { return this; }
    addTo(map?: { options?: { container?: HTMLElement } }): this {
      const element = this.options?.element;
      const container = map?.options?.container;
      if (element && container) container.append(element);
      return this;
    }
    remove(): void { this.options?.element?.remove(); }
  }
  class Map {
    constructor(public options: typeof created.options) {
      created.options = options;
      const canvas = document.createElement('canvas');
      options?.container?.append(canvas);
      const frame = options?.container;
      frame?.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        created.staleDrag = true;
      }, true);
      const endOnFrame = (): void => {
        created.staleDrag = false;
      };
      frame?.addEventListener('pointerup', endOnFrame, true);
      frame?.addEventListener('pointercancel', endOnFrame, true);
      canvas.addEventListener('click', () => {
        created.domClicks += 1;
        for (const fn of created.handlers.click ?? []) fn({});
      });
    }
    dragRotate = { disable: () => { created.rotationLocks += 1; } };
    touchZoomRotate = { disableRotation: () => { created.rotationLocks += 1; }, isActive: () => false };
    scrollZoom = { isZooming: () => created.zooming };
    dragPan = { isActive: () => created.staleDrag };
    isStyleLoaded(): boolean { return true; }
    once(): void {}
    on(type: string, fn: (event: { originalEvent?: Event; preventDefault?: () => void }) => void): void {
      created.events[type] = fn as () => void;
      (created.handlers[type] ??= []).push(fn);
    }
    getZoom(): number { return created.zoom; }
    project([lon, lat]: [number, number]): { x: number; y: number } {
      const y = (latitude: number) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
      const scale = 512 * 2 ** created.zoom;
      return { x: created.size[0] / 2 + (lon - created.center[0]) / 360 * scale, y: created.size[1] / 2 + (y(lat) - y(created.center[1])) * scale };
    }
    unproject(point: { x: number; y: number } | readonly number[]): { lng: number; lat: number } {
      const pair: readonly number[] = 'x' in point ? [point.x, point.y] : point;
      const x = pair[0]!;
      const y = pair[1]!;
      const yOf = (latitude: number) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
      const latOf = (mercatorY: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI;
      const scale = 512 * 2 ** created.zoom;
      const mercatorY = yOf(created.center[1]) + (y - created.size[1] / 2) / scale;
      return { lng: created.center[0] + (x - created.size[0] / 2) / scale * 360, lat: latOf(mercatorY) };
    }
    setFilter(id: string, filter: unknown): void {
      const layer = created.options?.style.layers.find((entry) => entry.id === id);
      if (layer) layer.filter = filter;
    }
    resize(): void {
      created.resizeCalls += 1;
      if (created.gesturing) created.gestureStops += 1;
      const frame = this.options?.container;
      const canvas = frame?.querySelector('canvas');
      if (!frame || !canvas) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(frame.clientWidth * ratio);
      canvas.height = Math.round(frame.clientHeight * ratio);
      canvas.style.width = `${frame.clientWidth}px`;
      canvas.style.height = `${frame.clientHeight}px`;
    }
    getSource(id: string): { setData(data: { features?: unknown[] }): void } {
      return {
        setData(data) {
          created.setDataCalls.push(id);
          created.sources.set(id, data);
        },
      };
    }
    fitBounds(_bounds: unknown, options: { maxZoom?: number }): void {
      created.fit = options;
      created.fitCount += 1;
    }
    jumpTo(): void {}
    remove(): void {}
  }
  return { Map, Marker };
});

import countryRasterLevels from '../src/map/adapters/maplibre/country-raster-levels.json' with { type: 'json' };
import { countrySymbolBox, createTrackInset, fittedSymbolAnchor, keptLettering, letterboxCamera, PLAN_WHEEL_RESIZE_CAP_MS, readableCountryName, remnantCovers } from '../src/map/adapters/maplibre/track-inset';

function unprojectCover(x: number, y: number): { lng: number; lat: number } {
  const yOf = (latitude: number) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
  const latOf = (mercatorY: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI;
  const scale = 512 * 2 ** created.zoom;
  const mercatorY = yOf(created.center[1]) + (y - created.size[1] / 2) / scale;
  return { lng: created.center[0] + (x - created.size[0] / 2) / scale * 360, lat: latOf(mercatorY) };
}

function maskArea(ring: number[][]): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    sum += ring[index]![0]! * ring[index + 1]![1]! - ring[index + 1]![0]! * ring[index]![1]!;
  }
  return Math.abs(sum) / 2;
}

describe('plan inset labels', () => {
  it('draws the Esri reference raster above the basemap and lets a tighter track zoom past 2', () => {
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 274 });
    Object.defineProperty(frame, 'clientHeight', { value: 900 });
    const marker = document.createElement('div');
    created.rotationLocks = 0;
    const inset = createTrackInset(frame, marker);
    const center = { lng: 118.33, lat: 0 };
    expect(letterboxCamera(center as unknown as Parameters<typeof letterboxCamera>[0], -1.15)).toEqual({ center, zoom: -1.15 });
    expect(letterboxCamera(center as unknown as Parameters<typeof letterboxCamera>[0], 9).zoom).toBe(8);
    expect(letterboxCamera(center as unknown as Parameters<typeof letterboxCamera>[0], -3).zoom).toBe(-2);
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
    expect(ids?.slice(0, 5)).toEqual(['inset-basemap', 'inset-night', 'inset-labels', 'inset-label-mask', 'inset-track']);
    expect(ids).toContain('inset-countries');
    expect(ids).toContain('inset-countries-viewport');
    expect(style?.layers.find((layer) => layer.id === 'inset-labels')?.paint?.['raster-opacity']).toBe(0.85);
    expect(style?.layers.find((layer) => layer.id === 'inset-labels')?.maxzoom).toBeUndefined();
    expect(style?.layers.find((layer) => layer.id === 'inset-night')?.paint?.['fill-opacity']).toBe(0.28);
    expect(ids).not.toContain('inset-cities');
    expect(ids).not.toContain('inset-towns');
    expect(created.rotationLocks).toBe(2);
    expect(created.options?.interactive).toBe(true);
    expect(created.options?.scrollZoom).toBe(true);
    expect(created.options?.dragPan).toBe(true);
    expect(created.options?.doubleClickZoom).toBe(false);
    expect(created.options?.maxZoom).toBe(8);
    expect(style?.glyphs).toBe('/glyphs/{fontstack}/{range}.pbf');
    const countries = style?.layers.find((layer) => layer.id === 'inset-countries');
    expect(countries?.type).toBe('symbol');
    expect(countries?.layout?.['text-field']).toEqual(['get', 'name']);
    expect(countries?.layout?.['text-font']).toEqual(['Open Sans Regular']);
    expect(countries?.layout?.['text-allow-overlap']).not.toBe(true);
    expect(countries?.layout?.['text-ignore-placement']).not.toBe(true);
    expect(countries?.layout?.['text-variable-anchor-offset']).toEqual([
      'match', ['get', 'name'], 'Kenya',
      ['literal', expect.arrayContaining(['bottom', [0, -1.5], 'top', [0, 1.5]])],
      ['literal', expect.arrayContaining(['left', 'right', 'top', 'bottom'])],
    ]);
    const kenyaAnchors = (countries?.layout?.['text-variable-anchor-offset'] as [string, unknown, string, [string, string[]]])[3][1];
    expect(kenyaAnchors[0]).toBe('bottom');
    expect(kenyaAnchors[1]).toEqual([0, -1.5]);
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

  it('draws one France symbol on a centered high-zoom plan and none when the word cannot fit', () => {
    const names = () => {
      const filter = created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]];
      return filter[2][1];
    };
    for (const zoom of [5.5, 6.5, 8]) {
      created.zoom = zoom;
      created.center = [2, 46];
      created.size = [1600, 1600];
      const frame = document.createElement('div');
      Object.defineProperty(frame, 'clientWidth', { value: 1600 });
      Object.defineProperty(frame, 'clientHeight', { value: 1600 });
      const inset = createTrackInset(frame, document.createElement('div'));
      created.events.render?.();
      expect(names(), `France @ ${zoom}`).toEqual(zoom >= 6.5 ? ['France'] : []);
      inset.destroy();
    }
    created.zoom = 5;
    created.center = [2, 46];
    created.size = [40, 40];
    const clipped = document.createElement('div');
    Object.defineProperty(clipped, 'clientWidth', { value: 40 });
    Object.defineProperty(clipped, 'clientHeight', { value: 40 });
    const inset = createTrackInset(clipped, document.createElement('div'));
    created.events.render?.();
    expect(names()).not.toContain('France');
    inset.destroy();
  });

  it('paints off-centroid names once and keeps the track above a clipped raster', () => {
    const names = () => {
      const filter = created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]];
      return filter[2][1];
    };
    const order = () => (created.options?.style.layers ?? []).map((layer) => layer.id);
    const mount = (zoom: number, center: [number, number], size: [number, number]) => {
      created.zoom = zoom;
      created.center = center;
      created.size = size;
      const frame = document.createElement('div');
      const marker = document.createElement('div');
      Object.defineProperty(frame, 'clientWidth', { value: size[0] });
      Object.defineProperty(frame, 'clientHeight', { value: size[1] });
      const inset = createTrackInset(frame, marker);
      inset.show([{
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[center[0] - 1, center[1]], [center[0] + 1, center[1]]] },
      }], { lon: center[0], lat: center[1] });
      created.events.render?.();
      return { frame, inset, marker };
    };
    const assertStack = (frame: HTMLElement, label: string) => {
      const ids = order();
      expect(ids.indexOf('inset-label-mask'), label).toBeGreaterThan(ids.indexOf('inset-labels'));
      expect(ids.indexOf('inset-track'), label).toBeGreaterThan(ids.indexOf('inset-label-mask'));
      expect(frame.querySelectorAll('[data-inset-label-cover]'), label).toHaveLength(0);
      expect(created.sources.get('inset-track')?.features?.length, label).toBeGreaterThan(0);
    };
    const france = mount(5, [-0.33, 46], [492, 690]);
    expect(names(), 'France pan 5.5').not.toContain('France');
    assertStack(france.frame, 'France pan 5.5');
    france.inset.destroy();
    for (const [center, size] of [
      [[131.772, -25], [478, 690]],
      [[132.723, -25], [274, 984]],
    ] as const) {
      const australia = mount(5.49, [center[0], center[1]], [size[0], size[1]]);
      expect(names(), `Australia ${size.join('x')}`).toEqual(['Australia']);
      assertStack(australia.frame, `Australia ${size.join('x')}`);
      const mask = created.sources.get('inset-label-mask') as { features?: { geometry: { coordinates: number[][][] } }[] } | undefined;
      expect(mask?.features?.length, `Australia ${size.join('x')}`).toBeGreaterThan(0);
      const ring = mask?.features?.[0]?.geometry.coordinates[0] ?? [];
      expect(ring.length, `Australia ${size.join('x')} ring`).toBeGreaterThan(3);
      expect(ring.every((pair) => pair.every((value) => Number.isFinite(value))), `Australia ${size.join('x')} coords`).toBe(true);
      expect(maskArea(ring), `Australia ${size.join('x')} area`).toBeGreaterThan(0);
      const cover = (australia.frame as HTMLElement & { __opdTrackInset?: { __opdLabelMasks?: { left: number; top: number; right: number; bottom: number }[] } }).__opdTrackInset?.__opdLabelMasks?.[0];
      expect(cover, `Australia ${size.join('x')} cover`).toBeTruthy();
      const corner = unprojectCover(cover!.left, cover!.top);
      expect(Math.abs(ring[0]![0]! - corner.lng)).toBeLessThan(0.01);
      expect(Math.abs(ring[0]![1]! - corner.lat)).toBeLessThan(0.01);
      australia.inset.destroy();
    }
    for (const zoom of [6.5, 6.51] as const) {
      created.sources.delete('inset-label-mask');
      created.zoom = zoom;
      created.center = [79, 22];
      created.size = [478, 690];
      const frame = document.createElement('div');
      Object.defineProperty(frame, 'clientWidth', { value: 478 });
      Object.defineProperty(frame, 'clientHeight', { value: 690 });
      const inset = createTrackInset(frame, document.createElement('div'));
      created.events.render?.();
      expect(names().filter((name) => name === 'India'), `India ${zoom}`).toEqual(['India']);
      expect((created.sources.get('inset-label-mask') as { features?: unknown[] } | undefined)?.features ?? [], `India ${zoom}`).toEqual([]);
      inset.destroy();
    }
    const argentina = mount(6.5, [-63.36, -34], [478, 690]);
    expect(names(), 'Argentina').toEqual([]);
    assertStack(argentina.frame, 'Argentina');
    expect(argentina.marker.isConnected || argentina.frame.contains(argentina.marker), 'Argentina marker').toBe(true);
    argentina.inset.destroy();
  });

  it('covers the dark Nigeria remnant that sticks out above the reference mask', () => {
    created.zoom = 6.5;
    created.center = [8, 10];
    created.size = [274, 984];
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 274 });
    Object.defineProperty(frame, 'clientHeight', { value: 984 });
    const inset = createTrackInset(frame, document.createElement('div'));
    created.events.render?.();
    const names = (created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]])[2][1];
    expect(names).not.toContain('Nigeria');
    inset.destroy();
  });

  it('covers the dark India ink left of the reference name at zoom 6.51', () => {
    created.zoom = 6.51;
    created.center = [79, 22];
    created.size = [410, 624];
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 410 });
    Object.defineProperty(frame, 'clientHeight', { value: 624 });
    const inset = createTrackInset(frame, document.createElement('div'));
    created.events.render?.();
    const names = (created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]])[2][1];
    expect(names).not.toContain('India');
    inset.destroy();
  });

  it('masks the dark-raster name when the reference name is already on the narrow plan', () => {
    created.zoom = 6.5;
    created.center = [8.6386, 10];
    created.size = [274, 984];
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 274 });
    Object.defineProperty(frame, 'clientHeight', { value: 984 });
    const inset = createTrackInset(frame, document.createElement('div'));
    created.events.render?.();
    const names = (created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]])[2][1];
    expect(names).not.toContain('Nigeria');
    expect(names.filter((entry) => entry === 'Nigeria')).toHaveLength(0);
    inset.destroy();
  });

  it('keeps one name at 410 and 435 and does not leave partial ink', () => {
    const names = () => {
      const filter = created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]];
      return filter[2][1];
    };
    const cases = [
      { country: 'France', center: [2, 46] as [number, number], zoom: 6.51, allowEmpty: false },
      { country: 'France', center: [-0.33, 46] as [number, number], zoom: 5.5, allowEmpty: true },
      { country: 'Australia', center: [134, -25] as [number, number], zoom: 6.51, allowEmpty: false },
      { country: 'Australia', center: [131.772, -25] as [number, number], zoom: 5.5, allowEmpty: true },
      { country: 'Argentina', center: [-64, -34] as [number, number], zoom: 6.5, allowEmpty: false },
    ];
    for (const size of [[410, 624], [435, 700]] as const) {
      for (const item of cases) {
        created.zoom = item.zoom;
        created.center = [...item.center];
        created.size = [...size];
        const frame = document.createElement('div');
        Object.defineProperty(frame, 'clientWidth', { value: size[0] });
        Object.defineProperty(frame, 'clientHeight', { value: size[1] });
        const inset = createTrackInset(frame, document.createElement('div'));
        created.events.render?.();
        const symbol = names().filter((name) => name === item.country).length;
        const raster = (frame as HTMLElement & { __opdTrackInset?: { __opdRasterCount?: number } }).__opdTrackInset?.__opdRasterCount ?? 0;
        const features = (created.sources.get('inset-label-mask') as { features?: { geometry: { coordinates: number[][][] } }[] } | undefined)?.features ?? [];
        for (const feature of features) expect(maskArea(feature.geometry.coordinates[0] ?? []), `${item.country} ${size.join('x')}`).toBeGreaterThan(0);
        expect(symbol + raster, `${item.country} ${size.join('x')} z${item.zoom}`).toBeLessThan(2);
        if (!item.allowEmpty && item.zoom < 6.5) expect(symbol + raster, `${item.country} ${size.join('x')} z${item.zoom}`).toBe(1);
        if (symbol === 1) expect(raster).toBe(0);
        inset.destroy();
      }
    }
  });

  it('does not stack a fallback on Nigeria or Kenya border cameras at 274x984', () => {
    const names = () => {
      const filter = created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]];
      return filter[2][1];
    };
    const cameras = [
      { country: 'Nigeria', center: [9, 10] as [number, number] },
      { country: 'Nigeria', center: [8.5, 11] as [number, number] },
      { country: 'Nigeria', center: [8.6386, 10] as [number, number] },
      { country: 'Kenya', center: [37.5, 2] as [number, number] },
      { country: 'Kenya', center: [37, 1] as [number, number] },
    ];
    for (const zoom of [6.5, 6.51]) {
      for (const camera of cameras) {
        created.zoom = zoom;
        created.center = [...camera.center];
        created.size = [274, 984];
        const frame = document.createElement('div');
        Object.defineProperty(frame, 'clientWidth', { value: 274 });
        Object.defineProperty(frame, 'clientHeight', { value: 984 });
        const inset = createTrackInset(frame, document.createElement('div'));
        created.events.render?.();
        const symbol = names().filter((name) => name === camera.country).length;
        const raster = (frame as HTMLElement & { __opdTrackInset?: { __opdRasterCount?: number } }).__opdTrackInset?.__opdRasterCount ?? 0;
        expect(symbol, `${camera.country} ${camera.center.join(',')} z${zoom}`).toBe(0);
        expect(raster, `${camera.country} ${camera.center.join(',')} z${zoom}`).toBe(0);
        inset.destroy();
      }
    }
  });

  it('reaches idle because a repeated render does not send the same label data', () => {
    created.setDataCalls = [];
    created.zoom = 6.51;
    created.center = [2, 46];
    created.size = [435, 590];
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 435 });
    Object.defineProperty(frame, 'clientHeight', { value: 590 });
    const inset = createTrackInset(frame, document.createElement('div'));
    const paint = () => {
      const handlers = created.handlers.render ?? [];
      handlers[handlers.length - 1]?.({} as Event);
    };
    let writes = 0;
    let idle = false;
    for (let frameIndex = 0; frameIndex < 8; frameIndex += 1) {
      const before = created.setDataCalls.length;
      paint();
      if (created.setDataCalls.length === before) {
        idle = true;
        break;
      }
      writes += 1;
    }
    expect(idle).toBe(true);
    expect(writes).toBe(1);
    const fallbackWrites = created.setDataCalls.filter((id) => id === 'inset-country-fallbacks').length;
    expect(fallbackWrites).toBe(1);
    paint();
    expect(created.setDataCalls.filter((id) => id === 'inset-country-fallbacks').length).toBe(1);
    inset.destroy();
  });

  it('covers remnant halos and stays off the kept name', () => {
    const viewport = { left: 0, top: 0, right: 274, bottom: 984 };
    const extent = { left: 20, top: 20, right: 80, bottom: 40 };
    const open = remnantCovers(extent, null, viewport);
    expect(open[0]?.left).toBe(16);
    expect(open[0]?.right).toBe(84);
    const kept = { left: 40, top: 36, right: 140, bottom: 70 };
    const covers = remnantCovers(extent, kept, viewport);
    for (const cover of covers) {
      const overlapW = Math.min(cover.right, kept.right) - Math.max(cover.left, kept.left);
      const overlapH = Math.min(cover.bottom, kept.bottom) - Math.max(cover.top, kept.top);
      expect(overlapW > 0 && overlapH > 0).toBe(false);
    }
    expect(covers.some((cover) => cover.bottom <= 32 && cover.top < kept.top)).toBe(true);
  });

  it('shifts a symbol that would be clipped by the plan edge', () => {
    const viewport = { left: 0, top: 0, right: 274, bottom: 984 };
    const fitted = fittedSymbolAnchor('Nigeria', { x: 8, y: 400 }, viewport);
    expect(fitted).toBeTruthy();
    const box = countrySymbolBox('Nigeria', fitted!);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(274);
    const keny = fittedSymbolAnchor('Kenya', { x: 260, y: 400 }, viewport);
    expect(keny).toBeTruthy();
    expect(countrySymbolBox('Kenya', keny!).right).toBeLessThanOrEqual(274);
  });

  it('keeps one complete name and masks the smaller border names', () => {
    const decision = keptLettering([
      { complete: true, area: 10 },
      { complete: true, area: 40 },
      { complete: true, area: 4 },
    ]);
    expect(decision.keep).toBe(1);
    expect(decision.mask).toEqual([0, 2]);
  });

  it('recomputes the label mask when the camera pans', () => {
    created.zoom = 5.49;
    created.center = [-63.7, -36.42];
    created.size = [120, 200];
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 120 });
    Object.defineProperty(frame, 'clientHeight', { value: 200 });
    const inset = createTrackInset(frame, document.createElement('div'));
    created.events.render?.();
    const before = JSON.stringify(created.sources.get('inset-label-mask'));
    created.center = [-63.96, -36.42];
    const move = created.handlers.move?.at(-1);
    expect(typeof move).toBe('function');
    move?.({} as Event);
    const after = JSON.stringify(created.sources.get('inset-label-mask'));
    const left = (raw: string) => (JSON.parse(raw) as { features: { geometry: { coordinates: number[][][] } }[] }).features[0]?.geometry.coordinates[0]?.[0]?.[0];
    expect(Number.isFinite(left(before))).toBe(true);
    expect(Number.isFinite(left(after))).toBe(true);
    expect(left(after)).not.toBe(left(before));
    const ring = (JSON.parse(after) as { features: { geometry: { coordinates: number[][][] } }[] }).features[0]?.geometry.coordinates[0] ?? [];
    expect(maskArea(ring)).toBeGreaterThan(0);
    inset.destroy();
  });

  it('restores Kenya and Nigeria at zoom 5.49 when only a stale dark z6 box is inside the canvas', () => {
    const names = () => {
      const filter = created.options?.style.layers.find((layer) => layer.id === 'inset-countries-viewport')?.filter as [string, unknown, [string, string[]]];
      return filter[2][1];
    };
    for (const [name, center, size] of [
      ['Kenya', [38.4677, 0.7652], [100, 80]],
      ['Nigeria', [8.9, 11.02], [120, 140]],
    ] as const) {
      created.zoom = 5.49;
      created.center = [...center];
      created.size = [...size];
      const frame = document.createElement('div');
      Object.defineProperty(frame, 'clientWidth', { value: size[0] });
      Object.defineProperty(frame, 'clientHeight', { value: size[1] });
      const inset = createTrackInset(frame, document.createElement('div'));
      created.events.render?.();
      expect(names(), name).toContain(name);
      inset.destroy();
    }
  });

  it('lets the label raster use the same tile levels as the basemap above the audit', () => {
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 800 });
    Object.defineProperty(frame, 'clientHeight', { value: 800 });
    const inset = createTrackInset(frame, document.createElement('div'));
    expect(created.options?.style.sources['inset-labels']?.maxzoom).toBe(19);
    inset.destroy();
  });

  it('keeps a pinch or a pan, recenters on a double click, and moves the night with the clock', () => {
    created.fitCount = 0;
    created.sources.clear();
    created.handlers = {};
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 320 });
    Object.defineProperty(frame, 'clientHeight', { value: 640 });
    const marker = document.createElement('div');
    const inset = createTrackInset(frame, marker);
    const track = [{
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: [[0, 0], [10, 10]] },
    }];
    const june = new Date('2024-06-21T18:00:00Z');
    inset.show(track, { lon: 5, lat: 5 }, june);
    expect(created.fitCount).toBe(1);
    const night = created.sources.get('inset-night');
    expect(night?.features?.length).toBeGreaterThan(0);
    created.handlers.movestart?.[0]?.({ originalEvent: new Event('wheel') });
    inset.show(track, { lon: 6, lat: 6 }, june);
    expect(created.fitCount).toBe(1);
    created.handlers.dblclick?.[0]?.({ preventDefault() {} });
    expect(created.fitCount).toBe(2);
    const december = new Date('2024-12-21T18:00:00Z');
    inset.show(null, { lon: 6, lat: 6 }, december);
    expect(created.sources.get('inset-night')).not.toEqual(night);
    inset.destroy();
  });

  it('holds a gesture across ticks, a size change, a pixel ratio change, and an automatic resize', () => {
    created.resizeCalls = 0;
    created.gestureStops = 0;
    created.gesturing = false;
    created.handlers = {};
    const frame = document.createElement('div');
    let width = 320;
    let height = 640;
    Object.defineProperty(frame, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, get: () => height });
    const inset = createTrackInset(frame, document.createElement('div'));
    const armed = created.resizeCalls;
    expect(armed).toBeGreaterThan(0);
    const canvas = frame.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('plan canvas missing');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20, pointerId: 1 }));
    created.gesturing = true;
    created.handlers.movestart?.[0]?.({ originalEvent: new Event('pointerdown') });
    const when = new Date('2024-06-21T18:00:00Z');
    const track = [{
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: [[0, 0], [10, 10]] },
    }];
    inset.show(track, { lon: 1, lat: 1 }, when);
    inset.show(null, { lon: 2, lat: 2 }, when);
    inset.show(null, { lon: 3, lat: 3 }, when);
    expect(created.gestureStops).toBe(0);
    expect(created.resizeCalls).toBe(armed);
    width = 280;
    inset.show(null, { lon: 3, lat: 3 }, when);
    const ratio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio === 2 ? 3 : 2 });
    inset.show(null, { lon: 4, lat: 4 }, when);
    inset.show(null, { lon: 5, lat: 5 }, when);
    const held = frame as HTMLElement & { __opdTrackInset?: { resize(): void } };
    held.__opdTrackInset?.resize();
    expect(created.resizeCalls).toBe(armed);
    expect(created.gestureStops).toBe(0);
    created.gesturing = false;
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 80, clientY: 20, pointerId: 1 }));
    expect(created.resizeCalls).toBe(armed + 1);
    expect(created.gestureStops).toBe(0);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
    inset.destroy();
  });

  it('lets MapLibre see a canvas click, then opens the map once', async () => {
    created.domClicks = 0;
    created.handlers = {};
    vi.useFakeTimers();
    const button = document.createElement('button');
    const frame = document.createElement('div');
    button.append(frame);
    document.body.append(button);
    let opens = 0;
    button.addEventListener('click', () => { opens += 1; });
    const inset = createTrackInset(frame, document.createElement('div'));
    const canvas = frame.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('plan canvas missing');
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(created.domClicks).toBe(1);
    expect(opens).toBe(0);
    await vi.advanceTimersByTimeAsync(280);
    expect(opens).toBe(1);
    inset.destroy();
    button.remove();
    vi.useRealTimers();
  });

  it('keeps the first wheel zoom when the next track rebuild has no movestart', () => {
    created.fitCount = 0;
    created.handlers = {};
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 640 });
    const inset = createTrackInset(frame, document.createElement('div'));
    const track = [{
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: [[0, 0], [10, 10]] },
    }];
    inset.show(track, { lon: 5, lat: 5 });
    expect(created.fitCount).toBe(1);
    const canvas = frame.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('plan canvas missing');
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    inset.show(track, { lon: 6, lat: 6 });
    expect(created.fitCount).toBe(1);
    inset.destroy();
  });

  it('does not open the map after a short move or a second touch', async () => {
    created.handlers = {};
    vi.useFakeTimers();
    const button = document.createElement('button');
    const frame = document.createElement('div');
    button.append(frame);
    document.body.append(button);
    let opens = 0;
    button.addEventListener('click', () => { opens += 1; });
    const inset = createTrackInset(frame, document.createElement('div'));
    const canvas = frame.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('plan canvas missing');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 40, pointerId: 4 }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 32, clientY: 40, pointerId: 4 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 32, clientY: 40, pointerId: 4 }));
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(280);
    expect(opens).toBe(0);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 40, pointerId: 5 }));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 70, clientY: 40, pointerId: 6 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 30, clientY: 40, pointerId: 5 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 70, clientY: 40, pointerId: 6 }));
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(280);
    expect(opens).toBe(0);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(280);
    expect(opens).toBe(1);
    inset.destroy();
    button.remove();
    vi.useRealTimers();
  });

  it('paints a wheel-only resize within 1000ms across a size and pixel-ratio change, and holds a drag or a pinch', async () => {
    expect(PLAN_WHEEL_RESIZE_CAP_MS).toBe(1000);
    created.resizeCalls = 0;
    created.zooming = false;
    created.staleDrag = false;
    created.handlers = {};
    vi.useFakeTimers();
    const frame = document.createElement('div');
    let width = 478;
    let height = 690;
    Object.defineProperty(frame, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, get: () => height });
    document.body.append(frame);
    const ratio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    const inset = createTrackInset(frame, document.createElement('div'));
    const canvas = frame.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('plan canvas missing');
    expect(canvas.style.width).toBe('478px');
    expect(canvas.style.height).toBe('690px');
    expect(canvas.width).toBe(478);
    expect(canvas.height).toBe(690);
    const paintBefore = created.resizeCalls;
    created.zooming = true;
    width = 449;
    height = 620;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const when = new Date('2024-06-21T18:00:00Z');
    const wheelFor = async (ms: number): Promise<void> => {
      let left = ms;
      while (left > 0) {
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
        const step = Math.min(50, left);
        await vi.advanceTimersByTimeAsync(step);
        left -= step;
      }
    };
    inset.show(null, { lon: 1, lat: 1 }, when);
    inset.show(null, { lon: 2, lat: 2 }, when);
    inset.show(null, { lon: 3, lat: 3 }, when);
    expect(created.resizeCalls).toBe(paintBefore);
    await wheelFor(PLAN_WHEEL_RESIZE_CAP_MS - 1);
    inset.show(null, { lon: 4, lat: 4 }, when);
    expect(canvas.style.width).toBe('478px');
    expect(canvas.style.height).toBe('690px');
    expect(canvas.width).toBe(478);
    expect(canvas.height).toBe(690);
    expect(created.zooming).toBe(true);
    await wheelFor(1);
    expect(canvas.style.width).toBe('449px');
    expect(canvas.style.height).toBe('620px');
    expect(canvas.width).toBe(898);
    expect(canvas.height).toBe(1240);
    await wheelFor(4000);
    expect(canvas.style.width).toBe('449px');
    expect(canvas.style.height).toBe('620px');
    expect(canvas.width).toBe(898);
    expect(canvas.height).toBe(1240);
    expect(created.zooming).toBe(true);
    created.zooming = false;
    inset.destroy();
    const held = document.createElement('div');
    let heldWidth = 478;
    let heldHeight = 690;
    Object.defineProperty(held, 'clientWidth', { configurable: true, get: () => heldWidth });
    Object.defineProperty(held, 'clientHeight', { configurable: true, get: () => heldHeight });
    document.body.append(held);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    const heldInset = createTrackInset(held, document.createElement('div'));
    const heldCanvas = held.querySelector('canvas');
    if (!(heldCanvas instanceof HTMLCanvasElement)) throw new Error('plan canvas missing');
    expect(heldCanvas.width).toBe(478);
    expect(heldCanvas.height).toBe(690);
    heldCanvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 40, pointerId: 21, pointerType: 'touch' }));
    heldWidth = 449;
    heldHeight = 620;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    heldInset.show(null, { lon: 1, lat: 1 }, when);
    await vi.advanceTimersByTimeAsync(5000);
    expect(heldCanvas.style.width).toBe('478px');
    expect(heldCanvas.style.height).toBe('690px');
    expect(heldCanvas.width).toBe(478);
    expect(heldCanvas.height).toBe(690);
    heldCanvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 80, clientY: 40, pointerId: 22, pointerType: 'touch' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(heldCanvas.width).toBe(478);
    expect(heldCanvas.height).toBe(690);
    heldCanvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 80, clientY: 40, pointerId: 22, pointerType: 'touch' }));
    expect(heldCanvas.width).toBe(478);
    expect(heldCanvas.height).toBe(690);
    heldCanvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 30, clientY: 40, pointerId: 21, pointerType: 'touch' }));
    expect(heldCanvas.style.width).toBe('449px');
    expect(heldCanvas.style.height).toBe('620px');
    expect(heldCanvas.width).toBe(898);
    expect(heldCanvas.height).toBe(1240);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
    created.zooming = false;
    created.staleDrag = false;
    heldInset.destroy();
    frame.remove();
    held.remove();
    vi.useRealTimers();
  });

  it.each([
    ['pointerup', 449, 620, 898, 1240],
    ['pointercancel', 303, 914, 606, 1828],
    ['lostpointercapture', 375, 554, 750, 1108],
    ['blur', 464, 650, 928, 1300],
  ])('resizes after a %s that ends outside the frame, then a plain click opens the map', async (ending, nextWidth, nextHeight, backingWidth, backingHeight) => {
    created.resizeCalls = 0;
    created.gesturing = false;
    created.zooming = false;
    created.staleDrag = false;
    created.handlers = {};
    vi.useFakeTimers();
    const button = document.createElement('button');
    const frame = document.createElement('div');
    let width = 478;
    let height = 690;
    Object.defineProperty(frame, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, get: () => height });
    button.append(frame);
    document.body.append(button);
    let opens = 0;
    button.addEventListener('click', () => { opens += 1; });
    const ratio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    const inset = createTrackInset(frame, document.createElement('div'));
    const canvas = frame.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('plan canvas missing');
    expect(canvas.width).toBe(478);
    expect(canvas.height).toBe(690);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 40, pointerId: 9 }));
    document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 420, clientY: 40, pointerId: 9 }));
    if (ending === 'blur') window.dispatchEvent(new Event('blur'));
    else document.body.dispatchEvent(new PointerEvent(ending, { bubbles: ending !== 'lostpointercapture', clientX: 420, clientY: 40, pointerId: 9 }));
    if (ending === 'pointerup' || ending === 'pointercancel') {
      const orbit = (frame as HTMLElement & { __opdTrackInset?: { dragPan: { isActive(): boolean } } }).__opdTrackInset;
      expect(orbit?.dragPan.isActive()).toBe(true);
    }
    width = nextWidth;
    height = nextHeight;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const when = new Date('2024-06-21T18:00:00Z');
    inset.show(null, { lon: 1, lat: 1 }, when);
    inset.show(null, { lon: 2, lat: 2 }, when);
    inset.show(null, { lon: 3, lat: 3 }, when);
    expect(canvas.style.width).toBe(`${nextWidth}px`);
    expect(canvas.style.height).toBe(`${nextHeight}px`);
    expect(canvas.width).toBe(backingWidth);
    expect(canvas.height).toBe(backingHeight);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 24, clientY: 24, pointerId: 11 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 24, clientY: 24, pointerId: 11 }));
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(280);
    expect(opens).toBe(1);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
    inset.destroy();
    button.remove();
    vi.useRealTimers();
  });

  it('marks the frame when the glyph file is large enough to draw names', async () => {
    const bytes = new Uint8Array(10001);
    const fetchGlyphs = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }));
    vi.stubGlobal('fetch', fetchGlyphs);
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 274 });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 900 });
    const inset = createTrackInset(frame, document.createElement('div'));
    await vi.waitFor(() => {
      expect(Number(frame.dataset.insetGlyphs)).toBeGreaterThanOrEqual(10000);
    });
    expect(fetchGlyphs).toHaveBeenCalled();
    inset.destroy();
    vi.unstubAllGlobals();
  });
});
