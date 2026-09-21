import { beforeEach, describe, expect, it } from 'vitest';

import { LAYER_ORDER, satTrackLayerId, satTrackSourceId } from '../src/map/map-core/catalog';
import { createClock } from '../src/map/map-core/clock';
import { createMapCore, type MapCore } from '../src/map/map-core/core';
import type { LineLayer } from '../src/map/map-core/layer-spec';
import type { SelectedSatellite } from '../src/map/map-core/view';
import type { Track } from '../src/types';
import { createVendorDouble, type VendorDouble } from './vendor-map-double';

// MapCore is what a feature is handed. These tests hold each facade method
// to what it hides: the catalog placement, the existence guards, the
// add-or-set branch for GeoJSON, and the one-popup-per-owner rule.

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function line(id: LineLayer['id'], source: LineLayer['source']): LineLayer {
  return { id, type: 'line', source, paint: { 'line-color': '#fff' } };
}

const body = (): HTMLElement => document.createElement('div');

let vendor: VendorDouble;
let core: MapCore;

beforeEach(() => {
  vendor = createVendorDouble({
    layers: [
      { id: 'carto-dark-layer', type: 'raster', source: 'carto-dark' },
      { id: 'esri-labels-reference-layer', type: 'raster', source: 'esri-labels-reference', layout: { visibility: 'none' } },
    ],
    sources: [
      ['carto-dark', { type: 'raster', tiles: ['https://c/{z}/{x}/{y}.png'], tileSize: 256 }],
      ['esri-labels-reference', { type: 'raster', tiles: ['https://l/{z}/{x}/{y}.png'], tileSize: 256 }],
    ],
  });
  core = createMapCore(vendor, createClock());
});

describe('layers', () => {
  it('places a layer at its catalog position whatever order the callers add in', () => {
    core.setGeoJson('targets', EMPTY);
    core.setGeoJson('iss-track', EMPTY);
    core.setGeoJson('dropped-pin', EMPTY);
    core.ensureLayer(line('targets-layer', 'targets'));
    core.ensureLayer(line('dropped-pin-layer', 'dropped-pin'));
    core.ensureLayer(line('iss-track-layer', 'iss-track'));

    const painted = vendor.paintedLayers();
    const expected = LAYER_ORDER.filter((id) => (painted as string[]).includes(id));
    expect(painted).toEqual(expected);
  });

  it('adds a layer once', () => {
    core.setGeoJson('targets', EMPTY);
    core.ensureLayer(line('targets-layer', 'targets'));
    core.ensureLayer({ ...line('targets-layer', 'targets'), paint: { 'line-color': '#000' } });
    expect(vendor.layers.filter((l) => l.id === 'targets-layer')).toHaveLength(1);
    expect(vendor.layers.find((l) => l.id === 'targets-layer')).toMatchObject({ paint: { 'line-color': '#fff' } });
  });

  it('writes visibility to a painted layer and drops the write for an absent one', () => {
    core.setVisibility('esri-labels-reference-layer', 'visible');
    expect(vendor.visibility.get('esri-labels-reference-layer')).toBe('visible');
    expect(core.visibilityOf('esri-labels-reference-layer')).toBe('visible');

    expect(() => core.setVisibility('terminator-line-layer', 'none')).not.toThrow();
    expect(core.hasLayer('terminator-line-layer')).toBe(false);
    expect(core.visibilityOf('terminator-line-layer')).toBeUndefined();
  });

  it('removes a satellite track layer and source, and tolerates their absence', () => {
    const layer = satTrackLayerId('25544');
    const source = satTrackSourceId('25544');
    core.setGeoJson(source, EMPTY);
    core.ensureLayer(line(layer, source));
    expect(core.hasLayer(layer)).toBe(true);

    core.removeLayer(layer);
    core.removeSource(source);
    expect(core.hasLayer(layer)).toBe(false);
    expect(core.hasSource(source)).toBe(false);

    expect(() => core.removeLayer(layer)).not.toThrow();
    expect(() => core.removeSource(source)).not.toThrow();
  });

  it('only lets a satellite track be removed', () => {
    // @ts-expect-error the app removes no layer but satellite tracks
    const removeStatic = () => core.removeLayer('targets-layer');
    // @ts-expect-error the app removes no source but satellite tracks
    const removeStaticSource = () => core.removeSource('targets');
    expect(typeof removeStatic).toBe('function');
    expect(typeof removeStaticSource).toBe('function');
  });
});

describe('sources', () => {
  it('creates a GeoJSON source on first write and updates it after', () => {
    const one: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } }],
    };
    expect(core.hasSource('iss-track')).toBe(false);
    core.setGeoJson('iss-track', EMPTY);
    expect(vendor.sources.get('iss-track')).toEqual({ type: 'geojson', data: EMPTY });
    core.setGeoJson('iss-track', one);
    expect(vendor.sources.get('iss-track')).toEqual({ type: 'geojson', data: one });
    expect(vendor.sources.size).toBe(3);
  });

  it('re-points a raster source and adds a raster source by spec', () => {
    core.setRasterTiles('carto-dark', ['https://d/{z}/{x}/{y}.png']);
    expect(vendor.tilesSetOn.get('carto-dark')).toEqual([['https://d/{z}/{x}/{y}.png']]);

    core.addRasterSource('fcst-clouds', { type: 'raster', tiles: ['/clouds-fcst/x/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 4 });
    expect(vendor.sources.get('fcst-clouds')).toMatchObject({ type: 'raster', maxzoom: 4 });
  });

  it('does not let GeoJSON be written to a raster source or tiles to a GeoJSON one', () => {
    // @ts-expect-error gibs-clouds is a raster source
    const geoOnRaster = () => core.setGeoJson('gibs-clouds', EMPTY);
    // @ts-expect-error targets is a GeoJSON source
    const tilesOnGeo = () => core.setRasterTiles('targets', []);
    expect(typeof geoOnRaster).toBe('function');
    expect(typeof tilesOnGeo).toBe('function');
  });
});

describe('popups', () => {
  it('opens an unowned popup without touching the owned ones', () => {
    core.openPopup({ at: [0, 0], content: body(), owner: 'target' });
    core.openPopup({ at: [1, 1], content: body() });
    expect(vendor.popups.map((p) => p.removed)).toEqual([false, false]);
  });

  it('closes the previous popup of the same owner before opening the next', () => {
    core.openPopup({ at: [0, 0], content: body(), owner: 'target' });
    core.openPopup({ at: [1, 1], content: body(), owner: 'target' });
    expect(vendor.popups.map((p) => p.removed)).toEqual([true, false]);
    expect(vendor.popups[0]!.removed).toBe(true);
  });

  it('keeps owners apart', () => {
    core.openPopup({ at: [0, 0], content: body(), owner: 'target' });
    core.openPopup({ at: [1, 1], content: body(), owner: 'launch' });
    core.openPopup({ at: [2, 2], content: body(), owner: 'pin' });
    core.closePopup('target');
    expect(vendor.popups.map((p) => p.removed)).toEqual([true, false, false]);
    core.closePopup('launch');
    expect(vendor.popups.map((p) => p.removed)).toEqual([true, true, false]);
    core.closePopup('pin');
    expect(vendor.popups.map((p) => p.removed)).toEqual([true, true, true]);
  });

  it('does not let a late close from a replaced popup drop the replacement', () => {
    core.openPopup({ at: [0, 0], content: body(), owner: 'target' });
    core.openPopup({ at: [1, 1], content: body(), owner: 'target' });
    vendor.popups[0]!.close();
    core.closePopup('target');
    expect(vendor.popups[1]!.removed).toBe(true);
  });

  it('forgets a popup the user closed, so a later close does not remove it again', () => {
    core.openPopup({ at: [0, 0], content: body(), owner: 'target' });
    vendor.popups[0]!.close();
    core.closePopup('target');
    expect(vendor.popups[0]!.removed).toBe(false);
  });

  it('passes the popup options through unchanged', () => {
    const content = body();
    core.openPopup({ at: [3, 4], content, maxWidth: '360px', owner: 'target' });
    expect(vendor.popups[0]).toMatchObject({ at: [3, 4], content, maxWidth: '360px' });
    expect('owner' in vendor.popups[0]!).toBe(false);
  });
});

describe('view', () => {
  const track = { tle_epoch: '2026-05-04T00:00:00Z', tle_age_hours: 12 } as Track;
  const tiangong: SelectedSatellite = { name: 'Tiangong', label: 'Tg', color: '#ffb000', track };

  it('opens with no track and no satellites', () => {
    expect(core.view()).toEqual({ track: null, satellites: [] });
  });

  it('holds the last track and satellite list written, each write leaving the other alone', () => {
    core.setTrack(track);
    core.setSatellites([tiangong]);
    expect(core.view()).toEqual({ track, satellites: [tiangong] });
    core.setTrack(null);
    expect(core.view()).toEqual({ track: null, satellites: [tiangong] });
  });

  it('replaces the record instead of mutating what a reader already holds', () => {
    const before = core.view();
    core.setTrack(track);
    expect(before.track).toBeNull();
    expect(core.view()).not.toBe(before);
  });
});

describe('pass-through', () => {
  it('hands camera, input and overlay calls to the vendor', () => {
    core.setCenter([5, 6]);
    core.setBearing(90);
    core.easeTo({ center: [7, 8], duration: 600 });
    core.flyTo({ zoom: 4, duration: 1 });
    core.fitBounds({ west: 0, south: 0, east: 1, north: 1 }, { padding: 40, maxZoom: 6, duration: 800 });
    expect(vendor.cameraCalls.map((c) => c.method)).toEqual(['setCenter', 'setBearing', 'easeTo', 'flyTo', 'fitBounds']);
    expect(core.center()).toEqual([7, 8]);
    expect(core.zoom()).toBe(4);
    expect(core.bearing()).toBe(90);
    expect(core.project([1, 2])).toEqual({ x: 1, y: 2 });

    let taps = 0;
    core.on('click', () => { taps += 1; });
    vendor.fire('click', { point: { x: 0, y: 0 }, lngLat: [0, 0] });
    expect(taps).toBe(1);

    core.setCursor('pointer');
    expect(vendor.cursor).toBe('pointer');

    const marker = core.addMarker(body(), [1, 1]);
    marker.setLngLat([2, 2]);
    expect(vendor.markers[0]).toMatchObject({ at: [2, 2], removed: false });
  });

  it('exposes the clock it was built with', () => {
    const clock = createClock(() => 42);
    expect(createMapCore(vendor, clock).clock).toBe(clock);
  });
});
