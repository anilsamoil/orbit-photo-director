import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import { liveIssPositionSGP4 } from '../../../iss-sgp4';
import { fetchSatelliteTLE, type SatelliteMeta } from '../../../satellites';
import type { Track } from '../../../types';
import { createClock } from '../../map-core/clock';
import { createMapCore, type MapCore } from '../../map-core/core';
import type { LngLat } from '../../map-core/geometry';
import { satellites } from './index';
import { orbitTrackFeatures } from './layers';

vi.mock('../../../satellites', async (importActual) => ({
  ...(await importActual<typeof import('../../../satellites')>()),
  fetchSatelliteTLE: vi.fn(),
}));

const NOW = Date.parse('2026-05-04T12:10:00Z');

// Epoch 26124.5 = 2026-05-04T12:00Z, ten minutes before the test clock.
const TIANGONG = {
  line1: '1 48274U 21035A   26124.50000000  .00010000  00000-0  20000-3 0  9990',
  line2: '2 48274  41.4700  10.0000 0005000  86.0000 274.1000 15.60000000123456',
  name: 'CSS (TIANHE)',
};
const NOAA20 = {
  line1: '1 43013U 17073A   26124.50000000  .00000100  00000-0  10000-3 0  9990',
  line2: '2 43013  98.7000 100.0000 0001000  90.0000 270.0000 14.19500000123456',
  name: 'NOAA 20 (JPSS-1)',
};
const TLE_BY_CATNR: Record<number, typeof TIANGONG> = { 48274: TIANGONG, 43013: NOAA20 };

const SELECTION_KEY = 'opd-selected-satellites';

function subPointAt(lines: { line1: string; line2: string }, atMs: number): LngLat {
  const track = {
    tle: { line1: lines.line1, line2: lines.line2 },
    tle_epoch: '',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
    iss_polynomial: { start: '', duration_seconds: 0, lat_coeffs: [], lon_coeffs: [], polynomial_order: 0 },
  } as Track;
  const pos = liveIssPositionSGP4(track, atMs);
  if (!pos) throw new Error('fixture TLE does not propagate');
  return [pos.lon, pos.lat];
}

function pickerDom(): void {
  document.body.innerHTML = `
    <button id="toggle-satellite-picker" type="button"></button>
    <div id="satellite-picker-panel" hidden>
      <div id="satellite-picker-list"></div>
      <input id="satellite-picker-input" type="text" />
      <button id="satellite-picker-add" type="button">Add</button>
      <div id="satellite-picker-status"></div>
    </div>`;
}

function checkboxFor(name: string): HTMLInputElement {
  const row = [...document.querySelectorAll('#satellite-picker-list label')]
    .find((label) => label.textContent?.includes(name));
  if (!row) throw new Error(`no picker row for ${name}`);
  return row.querySelector('input')!;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function toggle(name: string): Promise<void> {
  const box = checkboxFor(name);
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
  await settle();
}

function mounted(): { vendor: VendorDouble; core: MapCore } {
  const vendor = createVendorDouble({
    layers: [{ id: 'esri-labels-reference-layer', type: 'raster', source: 'esri-labels-reference' }],
    sources: [['esri-labels-reference', { type: 'raster', tiles: ['https://l/{z}/{x}/{y}.png'], tileSize: 256 }]],
  });
  const core = createMapCore(vendor, createClock());
  satellites.mount(core);
  return { vendor, core };
}

async function mountedWith(...keys: string[]): Promise<{ vendor: VendorDouble; core: MapCore }> {
  localStorage.setItem(SELECTION_KEY, JSON.stringify(keys));
  const result = mounted();
  await settle();
  return result;
}

function trackStart(vendor: VendorDouble, key: string): LngLat | undefined {
  const source = vendor.sources.get(`sat-track-${key}`);
  if (!source || source.type !== 'geojson') return undefined;
  const line = (source.data as GeoJSON.FeatureCollection).features[0]?.geometry as GeoJSON.LineString | undefined;
  return line?.coordinates[0] as LngLat | undefined;
}

function markerFor(vendor: VendorDouble, title: string) {
  return vendor.markers.find((marker) => marker.element.title === title);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  pickerDom();
  vi.mocked(fetchSatelliteTLE).mockImplementation(async (meta: SatelliteMeta) => {
    const tle = meta.resolution.kind === 'catnr' ? TLE_BY_CATNR[meta.resolution.catnr] : undefined;
    return tle ? { tle, match_count: 1, stale: false } : null;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(fetchSatelliteTLE).mockReset();
  localStorage.clear();
});

describe('restoring a selection', () => {
  it('fetches each persisted satellite and paints its track above the labels, in the persisted order', async () => {
    const { vendor } = await mountedWith('48274', '43013');

    expect(vi.mocked(fetchSatelliteTLE).mock.calls.map(([meta]) => meta.name)).toEqual(['Tiangong (CSS)', 'NORAD 43013']);
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer', 'sat-track-layer-48274', 'sat-track-layer-43013']);
    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, NOW));
    expect(markerFor(vendor, '🛰 NORAD 43013')?.at).toEqual(subPointAt(NOAA20, NOW));
  });

  it('publishes every tracked satellite to the shared view, with the topbar label and an SGP4 track', async () => {
    const { core } = await mountedWith('48274');

    expect(core.view().satellites).toEqual([
      {
        name: 'Tiangong (CSS)',
        label: 'Tg',
        color: '#ff9e2c',
        track: expect.objectContaining({ tle: { line1: TIANGONG.line1, line2: TIANGONG.line2 } }),
      },
    ]);
  });

  it('drops a persisted key it cannot resolve and a satellite whose TLE cannot be fetched', async () => {
    const { vendor, core } = await mountedWith('not-a-key', '99999', '48274');

    expect(vi.mocked(fetchSatelliteTLE).mock.calls.map(([meta]) => meta.name)).toEqual(['NORAD 99999', 'Tiangong (CSS)']);
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer', 'sat-track-layer-48274']);
    expect(core.view().satellites.map((sat) => sat.name)).toEqual(['Tiangong (CSS)']);
    expect(localStorage.getItem(SELECTION_KEY)).toBe('["48274"]');
  });
});

describe('the picker', () => {
  it('checking a curated satellite tracks it and unchecking removes its track, source, marker and view entry', async () => {
    const { vendor, core } = mounted();
    document.getElementById('toggle-satellite-picker')!.click();

    await toggle('Tiangong');
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer', 'sat-track-layer-48274']);
    expect(core.view().satellites.map((sat) => sat.label)).toEqual(['Tg']);
    expect(localStorage.getItem(SELECTION_KEY)).toBe('["48274"]');

    await toggle('Tiangong');
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer']);
    expect(vendor.sources.has('sat-track-48274')).toBe(false);
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.removed).toBe(true);
    expect(core.view().satellites).toEqual([]);
    expect(localStorage.getItem(SELECTION_KEY)).toBe('[]');
  });

  it('typing the NORAD number of a satellite already tracked says so without fetching again', async () => {
    const { core } = await mountedWith('48274');
    document.getElementById('toggle-satellite-picker')!.click();
    expect(checkboxFor('Tiangong').checked).toBe(true);

    document.querySelector<HTMLInputElement>('#satellite-picker-input')!.value = '48274';
    document.getElementById('satellite-picker-add')!.click();
    await settle();

    expect(document.getElementById('satellite-picker-status')!.textContent).toBe('Already tracking');
    expect(fetchSatelliteTLE).toHaveBeenCalledTimes(1);
    expect(core.view().satellites).toHaveLength(1);
  });
});

describe('the clock', () => {
  it('a scrub moves the track window and the marker to the view instant', async () => {
    const { vendor, core } = await mountedWith('48274');
    const at = NOW + 6 * 3_600_000;

    core.clock.setViewTime({ kind: 'scrubbed', atMs: at });

    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, at));
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.at).toEqual(subPointAt(TIANGONG, at));
  });

  it('live, the marker moves every second and the window every minute', async () => {
    const { vendor } = await mountedWith('48274');

    vi.advanceTimersByTime(1_000);
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.at).toEqual(subPointAt(TIANGONG, NOW + 1_000));
    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, NOW));

    vi.advanceTimersByTime(59_000);
    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, NOW + 60_000));
  });

  it('scrubbed, the tickers leave both where the scrub put them', async () => {
    const { vendor, core } = await mountedWith('48274');
    const at = NOW + 6 * 3_600_000;
    core.clock.setViewTime({ kind: 'scrubbed', atMs: at });

    vi.advanceTimersByTime(60_000);

    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, at));
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.at).toEqual(subPointAt(TIANGONG, at));
  });

  it('back at live, both return to the wall clock', async () => {
    const { vendor, core } = await mountedWith('48274');
    core.clock.setViewTime({ kind: 'scrubbed', atMs: NOW + 6 * 3_600_000 });
    vi.setSystemTime(NOW + 30_000);

    core.clock.setViewTime({ kind: 'live' });

    expect(trackStart(vendor, '48274')).toEqual(subPointAt(TIANGONG, NOW + 30_000));
    expect(markerFor(vendor, '🇨🇳 Tiangong (CSS)')?.at).toEqual(subPointAt(TIANGONG, NOW + 30_000));
  });
});

describe('orbitTrackFeatures', () => {
  const first = (features: GeoJSON.Feature[]): number[] =>
    (features[0]!.geometry as GeoJSON.LineString).coordinates[0]!;

  it('is a pure function of the TLE and the window start', () => {
    expect(orbitTrackFeatures(TIANGONG, NOW)).toEqual(orbitTrackFeatures(TIANGONG, NOW));
    expect(first(orbitTrackFeatures(TIANGONG, NOW))).toEqual(subPointAt(TIANGONG, NOW));
  });

  it('starts the window at the instant asked for, not the wall clock', () => {
    const later = NOW + 6 * 3_600_000;
    expect(first(orbitTrackFeatures(TIANGONG, later))).toEqual(subPointAt(TIANGONG, later));
    expect(first(orbitTrackFeatures(TIANGONG, later))).not.toEqual(first(orbitTrackFeatures(TIANGONG, NOW)));
  });
});
