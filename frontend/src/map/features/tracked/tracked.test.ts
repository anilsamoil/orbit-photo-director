import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { liveIssPositionSGP4 } from '../../../iss-sgp4';
import type { Track } from '../../../types';
import type { TrackedElements, TrackedRecord } from '../../../tracked';
import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore, type MapCore } from '../../map-core/core';
import type { LngLat } from '../../map-core/geometry';

const NOW = Date.parse('2026-05-04T12:10:00Z');

const LINES = {
  line1: '1 48274U 21035A   26124.50000000  .00010000  00000-0  20000-3 0  9990',
  line2: '2 48274  41.4700  10.0000 0005000  86.0000 274.1000 15.60000000123456',
};

const ELEMENTS: TrackedElements = {
  state: 'elements',
  id: 'starship',
  label: 'Starship',
  color: '#ff5c5c',
  source: 'supgp',
  name: 'STARSHIP S41',
  norad: 48274,
  intldes: '21035A',
  ...LINES,
  epoch: '2026-05-04T12:00:00Z',
  age_hours: 0.17,
};

const NO_ORBIT: TrackedRecord = {
  state: 'unavailable',
  id: 'starship',
  label: 'Starship',
  color: '#ff5c5c',
  reason: 'no_public_orbit',
};

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('tracked module was not loaded');
  return mod;
}

function propagated(atMs: number): LngLat {
  const pos = liveIssPositionSGP4({
    tle: LINES,
    tle_epoch: '',
    tle_age_hours: 0,
    tle_freshness_factor: 1,
    iss_polynomial: {
      start: '',
      duration_seconds: 0,
      lat_coeffs: [],
      lon_coeffs: [],
      polynomial_order: 0,
    },
  } as Track, atMs);
  if (!pos) throw new Error('fixture TLE did not propagate');
  return [pos.lon, pos.lat];
}

function mount(): { vendor: VendorDouble; core: MapCore } {
  const vendor = createVendorDouble({
    layers: [{ id: 'esri-labels-reference-layer', type: 'raster', source: 'esri-labels-reference' }],
    sources: [['esri-labels-reference', { type: 'raster', tiles: ['https://l/{z}/{x}/{y}.png'], tileSize: 256 }]],
  });
  const core = createMapCore(vendor, createClock());
  api().tracked.mount(core);
  return { vendor, core };
}

function markerFor(vendor: VendorDouble) {
  return vendor.markers.find((marker) => marker.element.classList.contains('tracked-marker'));
}

function trackStart(vendor: VendorDouble): LngLat | undefined {
  const source = vendor.sources.get('sat-track-starship');
  if (!source || source.type !== 'geojson') return undefined;
  const line = (source.data as GeoJSON.FeatureCollection).features[0]?.geometry as GeoJSON.LineString | undefined;
  return line?.coordinates[0] as LngLat | undefined;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  document.body.innerHTML = '';
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  loaded.mod = null;
  vi.useRealTimers();
});

describe('tracked vehicles', () => {
  it('draws the marker and one orbit when elements exist', () => {
    const { vendor, core } = mount();
    api().applyTracked(core, [ELEMENTS]);

    expect(vendor.paintedLayers()).toEqual([
      'esri-labels-reference-layer',
      'sat-track-layer-starship',
    ]);
    expect(markerFor(vendor)?.at).toEqual(propagated(NOW));
    expect(markerFor(vendor)?.element.title).toBe('Starship: STARSHIP S41');
    expect(markerFor(vendor)?.element.querySelector('.tracked-marker-label')?.textContent).toBe('Starship');
    expect(trackStart(vendor)).toEqual(propagated(NOW));
    expect(core.view().satellites).toEqual([]);
    expect(vendor.sources.has('iss-track')).toBe(false);
  });

  it('draws nothing when there is no public orbit', () => {
    const { vendor } = mount();

    expect(markerFor(vendor)).toBeUndefined();
    expect(vendor.sources.has('sat-track-starship')).toBe(false);
  });

  it('removes the marker and the track when the elements age out', () => {
    const { vendor, core } = mount();
    api().applyTracked(core, [ELEMENTS]);
    api().applyTracked(core, [{ ...NO_ORBIT, reason: 'aged_out' }]);

    expect(markerFor(vendor)?.removed).toBe(true);
    expect(vendor.sources.has('sat-track-starship')).toBe(false);
    expect(vendor.paintedLayers()).toEqual(['esri-labels-reference-layer']);
  });

  it('a scrub moves the track and the marker to the view instant', () => {
    const { vendor, core } = mount();
    api().applyTracked(core, [ELEMENTS]);
    const at = NOW + 6 * 3_600_000;

    core.clock.setViewTime({ kind: 'scrubbed', atMs: at });

    expect(trackStart(vendor)).toEqual(propagated(at));
    expect(markerFor(vendor)?.at).toEqual(propagated(at));
  });

  it('live, the marker moves every second and the window every minute', () => {
    const { vendor, core } = mount();
    api().applyTracked(core, [ELEMENTS]);

    vi.advanceTimersByTime(1_000);
    expect(markerFor(vendor)?.at).toEqual(propagated(NOW + 1_000));
    expect(trackStart(vendor)).toEqual(propagated(NOW));

    vi.advanceTimersByTime(59_000);
    expect(trackStart(vendor)).toEqual(propagated(NOW + 60_000));
  });

  it('scrubbed, the tickers leave both where the scrub put them', () => {
    const { vendor, core } = mount();
    api().applyTracked(core, [ELEMENTS]);
    const at = NOW + 6 * 3_600_000;
    core.clock.setViewTime({ kind: 'scrubbed', atMs: at });

    vi.advanceTimersByTime(60_000);

    expect(trackStart(vendor)).toEqual(propagated(at));
    expect(markerFor(vendor)?.at).toEqual(propagated(at));
  });
});
