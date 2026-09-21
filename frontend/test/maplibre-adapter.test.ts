import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createVendorMap, maplibreMapOptions, maplibreStyle } from '../src/map/adapters/maplibre';
import type { StyleSpec } from '../src/map/map-core/layer-spec';
import type { Hit, VendorMap } from '../src/map/map-core/vendor-map';
import { currentMaplibreDouble, resetMaplibreDouble, type RecordingMap } from './maplibre-double';

vi.mock('maplibre-gl', async () => (await import('./maplibre-double')).maplibreModuleMock());

// The adapter is the one module allowed to know MapLibre. These tests hold
// each VendorMap method to the MapLibre call it stands for, observed on the
// recording double, so a feature written against VendorMap can trust what
// the vendor will be told.

const STYLE: StyleSpec = {
  sources: {
    'carto-dark': { type: 'raster', tiles: ['https://c/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 20, attribution: 'c' },
    'iss-track': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    { id: 'carto-dark-layer', type: 'raster', source: 'carto-dark' },
    { id: 'iss-track-layer', type: 'line', source: 'iss-track', paint: { 'line-color': '#0ff', 'line-width': 2 } },
  ],
};

let vendor: VendorMap;
let map: RecordingMap;

beforeEach(() => {
  resetMaplibreDouble();
  vendor = createVendorMap({
    container: document.createElement('div'),
    style: STYLE,
    camera: { center: [10, 20], zoom: 3 },
  });
  map = currentMaplibreDouble().constructed[0]!;
});

describe('construction', () => {
  it('hands MapLibre a version-8 style, the camera, every gesture on, and the compact attribution', () => {
    expect(map.options).toEqual({
      container: expect.any(HTMLDivElement),
      style: maplibreStyle(STYLE),
      ...maplibreMapOptions({ center: [10, 20], zoom: 3 }),
    });
    expect(maplibreStyle(STYLE)).toEqual({ version: 8, sources: STYLE.sources, layers: STYLE.layers });
    expect(maplibreMapOptions({ center: [1, 2], zoom: 4 })).toEqual({
      center: [1, 2],
      zoom: 4,
      attributionControl: { compact: true },
      renderWorldCopies: true,
      dragPan: true,
      dragRotate: true,
      scrollZoom: true,
      touchZoomRotate: true,
      touchPitch: true,
    });
  });

  it('adds the navigation control top-left', () => {
    expect(map.controls.map((entry) => entry.position)).toEqual(['top-left']);
    expect(currentMaplibreDouble().maplibregl.NavigationControl).toHaveBeenCalledTimes(1);
  });

  it('resolves whenLoaded on the load event and not before', async () => {
    let loaded = false;
    const pending = vendor.whenLoaded().then(() => {
      loaded = true;
    });
    expect(loaded).toBe(false);
    map.emitLoad();
    await pending;
    expect(loaded).toBe(true);
  });
});

describe('layers and sources', () => {
  it('reports what the style painted, adds below a beforeId, and removes', () => {
    expect(vendor.paintedLayers()).toEqual(['carto-dark-layer', 'iss-track-layer']);
    expect(vendor.hasLayer('iss-track-layer')).toBe(true);
    expect(vendor.hasLayer('targets-layer')).toBe(false);

    vendor.addLayer(
      { id: 'terminator-line-layer', type: 'line', source: 'iss-track', paint: { 'line-width': 1 } },
      'iss-track-layer',
    );
    expect(map.layerOrder).toEqual(['carto-dark-layer', 'terminator-line-layer', 'iss-track-layer']);
    expect(map.addLayerCalls).toEqual([{ id: 'terminator-line-layer', beforeId: 'iss-track-layer' }]);
    expect(map.getLayer('terminator-line-layer')).toEqual({
      id: 'terminator-line-layer',
      type: 'line',
      source: 'iss-track',
      paint: { 'line-width': 1 },
    });

    vendor.removeLayer('terminator-line-layer');
    expect(vendor.hasLayer('terminator-line-layer')).toBe(false);
    expect(map.layerOrder).toEqual(['carto-dark-layer', 'iss-track-layer']);
  });

  it('writes and reads layout visibility, reporting undefined where the style set none', () => {
    expect(vendor.visibilityOf('iss-track-layer')).toBe('visible');
    vendor.setVisibility('iss-track-layer', 'none');
    expect(vendor.visibilityOf('iss-track-layer')).toBe('none');
    expect(map.visibilityOf('iss-track-layer')).toBe('none');
    expect(vendor.visibilityOf('targets-layer')).toBeUndefined();
  });

  it('adds, finds, feeds and removes sources', () => {
    expect(vendor.hasSource('iss-track')).toBe(true);
    expect(vendor.hasSource('targets')).toBe(false);

    vendor.addSource('targets', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    expect(vendor.hasSource('targets')).toBe(true);
    expect(map.sources.get('targets')?.spec).toEqual({ type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } }],
    };
    vendor.setGeoJson('targets', data);
    expect(map.sources.get('targets')?.setData).toHaveBeenCalledWith(data);

    vendor.setRasterTiles('carto-dark', ['https://d/{z}/{x}/{y}.png']);
    expect(map.tilesSetOn('carto-dark')).toEqual([['https://d/{z}/{x}/{y}.png']]);

    vendor.removeSource('targets');
    expect(vendor.hasSource('targets')).toBe(false);
  });

  it('feeding a source that is not there is a no-op, as the app has always relied on', () => {
    vendor.setGeoJson('targets', { type: 'FeatureCollection', features: [] });
    vendor.setRasterTiles('geo-ir', ['x']);
    expect(map.tilesSetOn('geo-ir')).toEqual([]);
  });
});

describe('camera', () => {
  it('reads the camera in domain shapes', () => {
    map.center = { lng: -75, lat: 40 };
    expect(vendor.center()).toEqual([-75, 40]);
    expect(vendor.zoom()).toBe(3);
    expect(vendor.bearing()).toBe(0);
    expect(vendor.project([5, 6])).toEqual({ x: 5, y: 6 });
  });

  it('passes each move through, marks flyTo essential, and expands a BBox for fitBounds', () => {
    vendor.setCenter([1, 2]);
    vendor.setBearing(90);
    vendor.easeTo({ center: [3, 4], zoom: 5, duration: 600 });
    vendor.flyTo({ center: [6, 7], duration: 800 });
    vendor.fitBounds({ west: -10, south: -5, east: 10, north: 5 }, { padding: 50, maxZoom: 5, duration: 600 });
    vendor.resize();
    expect(map.cameraCalls).toEqual([
      { method: 'setCenter', args: [[1, 2]] },
      { method: 'setBearing', args: [90] },
      { method: 'easeTo', args: [{ center: [3, 4], zoom: 5, duration: 600 }] },
      { method: 'flyTo', args: [{ center: [6, 7], duration: 800, essential: true }] },
      { method: 'fitBounds', args: [[[-10, -5], [10, 5]], { padding: 50, maxZoom: 5, duration: 600 }] },
      { method: 'resize', args: [] },
    ]);
  });
});

describe('input', () => {
  it('delivers a tap as a screen point and a [lng, lat] pair', () => {
    const taps: unknown[] = [];
    vendor.on('click', (tap) => taps.push(tap));
    map.fire('click', { point: { x: 10, y: 20 }, lngLat: { lng: 30, lat: 40 } });
    expect(taps).toEqual([{ point: { x: 10, y: 20 }, lngLat: [30, 40] }]);
  });

  it('suppresses the browser menu on contextmenu before delivering it', () => {
    const preventDefault = vi.fn();
    const taps: unknown[] = [];
    vendor.on('contextmenu', (tap) => taps.push(tap));
    map.fire('contextmenu', { preventDefault, point: { x: 1, y: 2 }, lngLat: { lng: 3, lat: 4 } });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(taps).toEqual([{ point: { x: 1, y: 2 }, lngLat: [3, 4] }]);
  });

  it('flattens touches to client points', () => {
    const starts: unknown[] = [];
    const moves: unknown[] = [];
    vendor.on('touchstart', (touch) => starts.push(touch));
    vendor.on('touchmove', (touch) => moves.push(touch));
    map.fire('touchstart', { lngLat: { lng: 1, lat: 2 }, originalEvent: { touches: [{ clientX: 5, clientY: 6 }] } });
    map.fire('touchmove', { originalEvent: { touches: [{ clientX: 7, clientY: 8 }, { clientX: 9, clientY: 10 }] } });
    map.fire('touchstart', { lngLat: { lng: 1, lat: 2 } });
    expect(starts).toEqual([
      { lngLat: [1, 2], touches: [{ x: 5, y: 6 }] },
      { lngLat: [1, 2], touches: [] },
    ]);
    expect(moves).toEqual([{ touches: [{ x: 7, y: 8 }, { x: 9, y: 10 }] }]);
  });

  it('tells a user zoom from a programmatic one by the presence of an original event', () => {
    const zooms: unknown[] = [];
    vendor.on('zoomstart', (zoom) => zooms.push(zoom));
    map.fire('zoomstart', { originalEvent: new Event('wheel') });
    map.fire('zoomstart', {});
    map.fire('zoomstart', undefined);
    expect(zooms).toEqual([{ byUser: true }, { byUser: false }, { byUser: false }]);
  });

  it('reads the source id off error and data events, and whether a tile loaded', () => {
    const errors: unknown[] = [];
    const data: unknown[] = [];
    vendor.on('error', (error) => errors.push(error));
    vendor.on('data', (event) => data.push(event));
    map.fire('error', { sourceId: 'geo-ir', error: new Error('x') });
    map.fire('error', { error: new Error('y') });
    map.fire('data', { sourceId: 'geo-ir', tile: { state: 'loaded' } });
    map.fire('data', { sourceId: 'geo-ir', tile: { state: 'loading' } });
    map.fire('data', { dataType: 'style' });
    expect(errors).toEqual([{ sourceId: 'geo-ir' }, { sourceId: undefined }]);
    expect(data).toEqual([
      { sourceId: 'geo-ir', tileLoaded: true },
      { sourceId: 'geo-ir', tileLoaded: false },
      { sourceId: undefined, tileLoaded: false },
    ]);
  });

  it('delivers payload-free events and stops delivering after unsubscribe', () => {
    const seen: string[] = [];
    const stop = vendor.on('moveend', () => seen.push('moveend'));
    vendor.on('idle', () => seen.push('idle'));
    map.fire('moveend');
    map.fire('idle');
    stop();
    map.fire('moveend');
    map.fire('idle');
    expect(seen).toEqual(['moveend', 'idle', 'idle']);
  });

  it('binds layer events to that layer only and hands click the rendered features as hits', () => {
    const clicks: unknown[] = [];
    const hovers: string[] = [];
    vendor.onLayer('click', 'targets-layer', (tap) => clicks.push(tap));
    const stopHover = vendor.onLayer('mouseenter', 'targets-layer', () => hovers.push('enter'));
    vendor.onLayer('mouseleave', 'targets-layer', () => hovers.push('leave'));

    const feature = { properties: { score: 80 }, geometry: { type: 'Point', coordinates: [1, 2] }, layer: { id: 'targets-layer' } };
    map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 }, features: [feature] }, 'targets-layer');
    map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 } }, 'targets-layer');
    map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 2 }, features: [feature] });
    map.fire('mouseenter', undefined, 'targets-layer');
    stopHover();
    map.fire('mouseenter', undefined, 'targets-layer');
    map.fire('mouseleave', undefined, 'targets-layer');

    const hit: Hit = { properties: { score: 80 }, geometry: { type: 'Point', coordinates: [1, 2] } };
    expect(clicks).toEqual([
      { point: { x: 1, y: 1 }, lngLat: [1, 2], features: [hit] },
      { point: { x: 1, y: 1 }, lngLat: [1, 2], features: [] },
    ]);
    expect(hovers).toEqual(['enter', 'leave']);
  });

  it('queries a pixel box over named layers and returns hits', () => {
    map.renderedFeatures = {
      'targets-layer': [{ properties: { a: 1 }, geometry: { type: 'Point', coordinates: [0, 0] } }],
    };
    const hits = vendor.queryAt([{ x: 0, y: 0 }, { x: 10, y: 10 }], ['targets-layer', 'my-targets-layer']);
    expect(map.queryCalls).toEqual([{ layers: ['targets-layer', 'my-targets-layer'] }]);
    expect(hits).toEqual([{ properties: { a: 1 }, geometry: { type: 'Point', coordinates: [0, 0] } }]);
  });

  it('sets the canvas cursor', () => {
    vendor.setCursor('pointer');
    expect(map.getCanvas().style.cursor).toBe('pointer');
    vendor.setCursor('');
    expect(map.getCanvas().style.cursor).toBe('');
  });
});

describe('overlays', () => {
  it('places a centre-anchored marker on the map and moves or removes it through the handle', () => {
    const element = document.createElement('div');
    const handle = vendor.addMarker(element, [1, 2]);
    const marker = currentMaplibreDouble().markers[0]!;
    expect(marker.options).toEqual({ element, anchor: 'center' });
    expect(marker.lngLat).toEqual([1, 2]);
    expect(marker.added).toBe(map);
    handle.setLngLat([3, 4]);
    expect(marker.lngLat).toEqual([3, 4]);
    handle.remove();
    expect(marker.removed).toBe(true);
  });

  it('opens a popup with DOM content, an optional max width, and a close hook', () => {
    const content = document.createElement('div');
    const onClose = vi.fn();
    const handle = vendor.openPopup({ at: [5, 6], content, maxWidth: '360px' });
    vendor.openPopup({ at: [7, 8], content });
    const [wide, plain] = currentMaplibreDouble().popups;
    expect(wide?.options).toEqual({ maxWidth: '360px' });
    expect(plain?.options).toEqual({});
    expect(wide?.lngLat).toEqual([5, 6]);
    expect(wide?.content).toBe(content);
    expect(wide?.html).toBeNull();
    expect(wide?.added).toBe(map);

    handle.onClose(onClose);
    for (const listener of wide?.listeners.close ?? []) listener();
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.remove();
    expect(wide?.removed).toBe(true);
  });
});
