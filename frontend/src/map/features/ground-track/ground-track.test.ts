import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Track } from '../../../types';
import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';
import { PREF_KEYS } from '../../map-core/prefs';

const NOW = Date.parse('2026-05-04T12:10:00Z');

function sample(t: number): [number, number, number] {
  return [t, 10, t / 100];
}

const WIDE_TRACK: Track = {
  iss_polynomial: {
    start: '2026-05-04T12:00:00Z',
    duration_seconds: 5400,
    lat_coeffs: [0],
    lon_coeffs: [0],
    polynomial_order: 0,
  },
  track_points: [
    sample(0), sample(1800), sample(3600), sample(5400),
    sample(5568), sample(7000),
  ],
  tle: {
    line1: '1 25544U 98067A   26161.50000000  .00016717  00000-0  30771-3 0  9991',
    line2: '2 25544  51.6400  10.0000 0003000  86.0000 274.1000 15.50000000123456',
  },
  tle_epoch: '',
  tle_age_hours: 0,
  tle_freshness_factor: 1,
};

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('ground-track module was not loaded');
  return mod;
}

function click(): void {
  document.getElementById('toggle-multi-orbit')!.dispatchEvent(new Event('click'));
}

function featuresOf(vendor: VendorDouble): GeoJSON.Feature[] {
  const source = vendor.sources.get('iss-track');
  if (!source || source.type !== 'geojson' || typeof source.data === 'string') {
    throw new Error('iss-track source missing');
  }
  return source.data.features;
}

function orbitIndexes(vendor: VendorDouble): number[] {
  return [...new Set(featuresOf(vendor).map((feature) => Number(feature.properties?.orbit_index)))].sort((a, b) => a - b);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  document.body.innerHTML = '<button id="toggle-multi-orbit" type="button"></button>';
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
  loaded.mod = null;
});

describe('ground-track', () => {
  it('draws the current orbit at 85% until the operator asks for more', () => {
    const vendor = createVendorDouble();
    const clock = createClock(() => NOW);
    api().bindGroundTrackClock(clock);
    const core = createMapCore(vendor, clock);
    core.setTrack(WIDE_TRACK);
    api().groundTrack.mount(core);
    const layer = vendor.layers.find((entry) => entry.id === 'iss-track-layer');
    expect(layer?.paint && 'line-opacity' in layer.paint ? layer.paint['line-opacity'] : undefined).toEqual([
      'match',
      ['coalesce', ['get', 'orbit_index'], 0],
      0, 0.85,
      1, 0.55,
      2, 0.35,
      3, 0.2,
      0.12,
    ]);
    expect(orbitIndexes(vendor)).toEqual([0]);
    expect(document.getElementById('toggle-multi-orbit')?.getAttribute('aria-pressed')).toBe('false');
    click();
    expect(orbitIndexes(vendor)).toEqual([0, 1]);
    expect(localStorage.getItem(PREF_KEYS.multiOrbitVisible)).toBe('1');
  });

  it('collapses to one orbit around the scrubbed instant', () => {
    const vendor = createVendorDouble();
    const clock = createClock(() => NOW);
    api().bindGroundTrackClock(clock);
    const core = createMapCore(vendor, clock);
    core.setTrack(WIDE_TRACK);
    api().groundTrack.mount(core);
    click();
    clock.setViewTime({ kind: 'scrubbed', atMs: NOW + 90 * 60_000 });
    expect(orbitIndexes(vendor)).toEqual([0]);
    expect(featuresOf(vendor).length).toBeGreaterThan(0);
  });
});
