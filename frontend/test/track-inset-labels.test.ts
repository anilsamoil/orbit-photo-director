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
  paintWrites: [] as unknown[],
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
    setPaintProperty(id: string, key: string, value: unknown): void {
      const layer = created.options?.style.layers.find((entry) => entry.id === id);
      if (layer) layer.paint = { ...layer.paint, [key]: value };
      created.paintWrites.push(value);
    }
    jumpTo(): void {}
    remove(): void {}
  }
  return { Map, Marker };
});

import { canadaRasterView, createTrackInset, letterboxCamera, PLAN_WHEEL_RESIZE_CAP_MS, rasterShowsSameCountry } from '../src/map/adapters/maplibre/track-inset';

function project(lngLat: [number, number], center: [number, number], zoom: number, width: number, height: number): { x: number; y: number } {
  const yOf = (latitude: number) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
  const scale = 512 * 2 ** zoom;
  return {
    x: width / 2 + (lngLat[0] - center[0]) / 360 * scale,
    y: height / 2 + (yOf(lngLat[1]) - yOf(center[1])) * scale,
  };
}

function paint(): void {
  const handlers = created.handlers.render ?? [];
  handlers[handlers.length - 1]?.({});
}

function opacity(): unknown {
  return created.options?.style.layers.find((layer) => layer.id === 'inset-countries')?.paint?.['text-opacity'];
}

describe('plan inset labels', () => {
  it('draws the main country labels on the reference raster', () => {
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
    expect(style?.sources['inset-basemap']?.maxzoom).toBe(20);
    expect(style?.sources['inset-labels']?.tiles?.[0]).toContain('World_Boundaries_and_Places');
    expect(style?.sources['inset-labels']?.maxzoom).toBe(19);
    const ids = style?.layers.map((layer) => layer.id);
    expect(ids).toEqual(['inset-basemap', 'inset-night', 'inset-labels', 'inset-track', 'inset-countries']);
    expect(style?.sources['inset-label-mask']).toBeUndefined();
    expect(style?.sources['inset-country-fallbacks']).toBeUndefined();
    expect(style?.layers.find((layer) => layer.id === 'inset-labels')?.paint?.['raster-opacity']).toBe(0.85);
    expect(style?.layers.find((layer) => layer.id === 'inset-night')?.paint?.['fill-opacity']).toBe(0.28);
    expect(created.rotationLocks).toBe(2);
    expect(created.options?.interactive).toBe(true);
    expect(created.options?.scrollZoom).toBe(true);
    expect(created.options?.dragPan).toBe(true);
    expect(created.options?.doubleClickZoom).toBe(false);
    expect(created.options?.maxZoom).toBe(8);
    expect(style?.glyphs).toBe('/glyphs/{fontstack}/{range}.pbf');
    const countries = style?.layers.find((layer) => layer.id === 'inset-countries');
    expect(countries?.type).toBe('symbol');
    expect(countries?.maxzoom).toBe(3);
    expect(countries?.layout?.['text-field']).toEqual(['get', 'name']);
    expect(countries?.layout?.['text-font']).toEqual(['Open Sans Regular']);
    expect(countries?.layout?.['text-allow-overlap']).toBeUndefined();
    expect(countries?.layout?.['text-ignore-placement']).toBeUndefined();
    expect(countries?.layout?.['text-variable-anchor-offset']).toBeUndefined();
    expect(countries?.layout?.['symbol-sort-key']).toBeUndefined();
    expect(countries?.paint?.['text-opacity']).toBeUndefined();
    expect(style?.sources['inset-countries']?.data?.features?.map((feature) => feature.properties?.name)).toEqual([
      'Canada', 'Mexico', 'Brazil', 'Argentina', 'France', 'Egypt', 'Nigeria', 'Kenya', 'China', 'India', 'Japan', 'Australia',
    ]);
    const source = readFileSync(resolve(__dirname, '../src/map/adapters/maplibre/track-inset.ts'), 'utf8');
    expect(source).not.toContain('viewport.right >= 430');
    expect(source).not.toContain('inset-countries-viewport');
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

  it('hides a vector name only when the drawn reference tile shows that complete name', () => {
    const canada = { tile: 3, service: 'reference', ink: [0.205078125, 0.313476562, 0.236816406, 0.317871094] as const };
    const viewport = { left: 0, top: 0, right: 478, bottom: 690 };
    const at = (zoom: number, center: [number, number], width = 478, height = 690) => (lngLat: [number, number]) => project(lngLat, center, zoom, width, height);
    expect(rasterShowsSameCountry(1.5, 3, canada, at(1.5, [-100, 50]), viewport, [])).toBe(true);
    expect(rasterShowsSameCountry(1.5, 3, canada, at(1.5, [2, 46]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(1.5, 4, canada, at(1.5, [-100, 50]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(2.5, 4, canada, at(2.5, [-100, 50]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(2.99, 4, canada, at(2.99, [-100, 50]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(3, 4, canada, at(3, [-100, 50]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(3.01, 4, canada, at(3.01, [-100, 50]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(5, 6, canada, at(5, [-100, 50]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(1.5, 3, { ...canada, service: 'dark' }, at(1.5, [-100, 50]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(1.5, 3, undefined, at(1.5, [-100, 50]), viewport, [])).toBe(false);
    expect(rasterShowsSameCountry(1.5, 3, { ...canada, ink: [0.22, 0.31, 0.2201, 0.3101] }, at(1.5, [-100, 50]), viewport, [])).toBe(false);
    const covered = rasterShowsSameCountry(1.5, 3, canada, at(1.5, [-100, 50]), viewport, [{ left: 200, top: 300, right: 280, bottom: 330 }]);
    expect(covered).toBe(false);
    for (const width of [429, 430, 431]) {
      expect(rasterShowsSameCountry(1.5, 3, canada, at(1.5, [-100, 50], width, 800), { left: 0, top: 0, right: width, bottom: 800 }, [])).toBe(true);
    }
  });

  it('canadaRasterView is the frame rasterShowsSameCountry sees', () => {
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 478 });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 690 });
    const decide = (center: [number, number]) => {
      const map = {
        getZoom: () => 1.5,
        project: (lngLat: [number, number]) => project(lngLat, center, 1.5, 478, 690),
      };
      const view = canadaRasterView(map as unknown as Parameters<typeof canadaRasterView>[0], frame);
      expect(view).toBeTruthy();
      return rasterShowsSameCountry(view!.zoom, view!.drawn, view!.entry, view!.project, view!.viewport, view!.occlusions);
    };
    expect(decide([-100, 50])).toBe(true);
    expect(decide([2, 46])).toBe(false);
  });

  it('drops Canada at zoom 1.5 and puts the vector back when the raster name leaves the frame', () => {
    const mount = (zoom: number, center: [number, number], width: number, height: number) => {
      created.zoom = zoom;
      created.center = center;
      created.size = [width, height];
      created.paintWrites = [];
      const frame = document.createElement('div');
      Object.defineProperty(frame, 'clientWidth', { configurable: true, value: width });
      Object.defineProperty(frame, 'clientHeight', { configurable: true, value: height });
      const inset = createTrackInset(frame, document.createElement('div'));
      paint();
      return inset;
    };
    const canada = mount(1.5, [-100, 50], 478, 690);
    expect(opacity()).toEqual(['case', ['in', ['get', 'name'], ['literal', ['Canada']]], 0, 1]);
    expect(created.paintWrites).toHaveLength(1);
    paint();
    expect(created.paintWrites).toHaveLength(1);
    canada.destroy();

    for (const width of [429, 430, 431]) {
      const wide = mount(1.5, [-100, 50], width, 800);
      expect(opacity(), String(width)).toEqual(['case', ['in', ['get', 'name'], ['literal', ['Canada']]], 0, 1]);
      wide.destroy();
    }

    const away = mount(1.5, [2, 46], 478, 690);
    expect(created.paintWrites).toEqual([]);
    expect(opacity()).toBeUndefined();
    away.destroy();

    const hidden = mount(1.5, [-100, 50], 478, 690);
    expect(opacity()).toEqual(['case', ['in', ['get', 'name'], ['literal', ['Canada']]], 0, 1]);
    created.center = [2, 46];
    paint();
    expect(opacity()).toBe(1);
    hidden.destroy();

    for (const zoom of [2.5, 2.99, 3, 3.01, 5]) {
      const edge = mount(zoom, [-100, 50], 478, 690);
      expect(created.paintWrites, String(zoom)).toEqual([]);
      expect(created.options?.style.layers.find((layer) => layer.id === 'inset-countries')?.maxzoom).toBe(3);
      edge.destroy();
    }

    const france = mount(1.5, [2, 46], 478, 690);
    expect(created.paintWrites).toEqual([]);
    france.destroy();
    const high = mount(6.5, [2, 46], 435, 590);
    expect(created.paintWrites).toEqual([]);
    expect(created.options?.style.layers.map((layer) => layer.id)).not.toContain('inset-countries-viewport');
    high.destroy();
  });

  it('keeps the vector when chrome covers the raster name', () => {
    created.zoom = 1.5;
    created.center = [-100, 50];
    created.size = [478, 690];
    created.paintWrites = [];
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { value: 478 });
    Object.defineProperty(frame, 'clientHeight', { value: 690 });
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, right: 478, bottom: 690, width: 478, height: 690, x: 0, y: 0, toJSON: () => ({}) });
    const clock = document.createElement('div');
    clock.dataset.issClock = '';
    clock.getBoundingClientRect = () => ({ left: 200, top: 300, right: 280, bottom: 330, width: 80, height: 30, x: 200, y: 300, toJSON: () => ({}) });
    document.body.append(clock);
    const inset = createTrackInset(frame, document.createElement('div'));
    paint();
    expect(created.paintWrites).toEqual([]);
    expect(opacity()).toBeUndefined();
    clock.remove();
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

  it('holds a gesture across ticks, a size change, a pixel ratio change, and an automatic resize', async () => {
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
    expect(created.resizeCalls).toBe(armed);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(created.resizeCalls).toBe(armed + 1);
    expect(created.gestureStops).toBe(0);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
    inset.destroy();
  });

  it.each(['pointerup', 'blur'])('rearms a %s resize frame for a new gesture and cancels it on destroy', async (ending) => {
    created.resizeCalls = 0;
    created.handlers = {};
    created.zooming = false;
    vi.useFakeTimers();
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    const frame = document.createElement('div');
    Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 640 });
    const inset = createTrackInset(frame, document.createElement('div'));
    const canvas = frame.querySelector('canvas')!;
    const orbit = (frame as unknown as HTMLElement & { __opdTrackInset: { resize(): void } }).__opdTrackInset;
    const armed = created.resizeCalls;
    const down = (id: number): void => { canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: id })); };
    const end = (id: number): void => {
      if (ending === 'blur') window.dispatchEvent(new Event('blur'));
      else canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: id }));
    };
    try {
      down(1);
      orbit.resize();
      end(1);
      end(1);
      expect(requestFrame).toHaveBeenCalledTimes(1);
      down(2);
      expect(cancelFrame).toHaveBeenCalledWith(requestFrame.mock.results[0]?.value);
      end(2);
      expect(requestFrame).toHaveBeenCalledTimes(2);
      orbit.resize();
      expect(created.resizeCalls).toBe(armed);
      down(3);
      expect(cancelFrame).toHaveBeenCalledWith(requestFrame.mock.results[1]?.value);
      await vi.advanceTimersByTimeAsync(20);
      expect(created.resizeCalls).toBe(armed);
      end(3);
      await vi.advanceTimersByTimeAsync(20);
      expect(created.resizeCalls).toBe(armed + 1);
      down(4);
      orbit.resize();
      end(4);
      inset.destroy();
      expect(cancelFrame).toHaveBeenCalledWith(requestFrame.mock.results[3]?.value);
      await vi.advanceTimersByTimeAsync(20);
      expect(created.resizeCalls).toBe(armed + 1);
    } finally {
      inset.destroy();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
    }
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
    expect(heldCanvas.width).toBe(478);
    await vi.advanceTimersByTimeAsync(20);
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
    await vi.advanceTimersByTimeAsync(20);
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
