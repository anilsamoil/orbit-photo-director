import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({
  options: null as null | {
    minZoom?: number;
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
        paint?: { 'raster-opacity'?: number; 'text-color'?: string; 'fill-opacity'?: number };
        layout?: {
          'text-field'?: unknown;
          'text-font'?: string[];
          'text-allow-overlap'?: boolean;
          'text-ignore-placement'?: boolean;
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
  fitCount: 0,
  resizeCalls: 0,
  gestureStops: 0,
  gesturing: false,
  domClicks: 0,
  sources: new Map<string, { features?: unknown[] }>(),
  handlers: {} as Record<string, ((event: { originalEvent?: Event; preventDefault?: () => void }) => void)[]>,
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
      const canvas = document.createElement('canvas');
      options?.container?.append(canvas);
      canvas.addEventListener('click', () => {
        created.domClicks += 1;
        for (const fn of created.handlers.click ?? []) fn({});
      });
    }
    isStyleLoaded(): boolean { return true; }
    once(): void {}
    on(type: string, fn: (event: { originalEvent?: Event; preventDefault?: () => void }) => void): void {
      (created.handlers[type] ??= []).push(fn);
    }
    resize(): void {
      created.resizeCalls += 1;
      if (created.gesturing) created.gestureStops += 1;
    }
    getSource(id: string): { setData(data: { features?: unknown[] }): void } {
      return {
        setData(data) {
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
    expect(ids).toEqual([
      'inset-basemap',
      'inset-night',
      'inset-labels',
      'inset-track',
      'inset-countries',
      'inset-cities',
      'inset-towns',
    ]);
    expect(style?.layers.find((layer) => layer.id === 'inset-labels')?.paint?.['raster-opacity']).toBe(0.85);
    expect(style?.layers.find((layer) => layer.id === 'inset-night')?.paint?.['fill-opacity']).toBe(0.28);
    expect(style?.layers.find((layer) => layer.id === 'inset-cities')?.minzoom).toBe(3);
    expect(style?.layers.find((layer) => layer.id === 'inset-towns')?.minzoom).toBe(5);
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

  it('holds a gesture across ticks without resizing, and still resizes when the frame changes', () => {
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
    width = 400;
    inset.show(null, { lon: 3, lat: 3 }, when);
    expect(created.resizeCalls).toBe(armed + 1);
    const ratio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio === 2 ? 3 : 2 });
    inset.show(null, { lon: 3, lat: 3 }, when);
    expect(created.resizeCalls).toBe(armed + 2);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
    created.gesturing = false;
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
});
