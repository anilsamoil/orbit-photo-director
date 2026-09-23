import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Track } from '../../../types';
import { createVendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';

const NOW = Date.parse('2026-05-04T12:10:00Z');

const TRACK: Track = {
  iss_polynomial: {
    start: '2026-05-04T12:00:00Z',
    duration_seconds: 7200,
    lat_coeffs: [12],
    lon_coeffs: [-40],
    polynomial_order: 0,
  },
  tle_epoch: '',
  tle_age_hours: 0,
  tle_freshness_factor: 1,
};

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('iss-marker module was not loaded');
  return mod;
}

beforeEach(async () => {
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  loaded.mod = null;
});

describe('iss-marker', () => {
  it('places one marker on the polynomial sub-point when the track has no TLE', () => {
    const vendor = createVendorDouble();
    const clock = createClock(() => NOW);
    const core = createMapCore(vendor, clock);
    core.setTrack(TRACK);
    api().issMarker.mount(core);
    expect(vendor.markers).toHaveLength(1);
    expect(vendor.markers[0]?.at).toEqual([-40, 12]);
    expect(vendor.markers[0]?.element.classList.contains('iss-marker')).toBe(true);
    expect(api().hasIssMarker()).toBe(true);
  });

  it('holds the scrubbed sub-point across a live tick', () => {
    const vendor = createVendorDouble();
    const clock = createClock(() => NOW);
    const core = createMapCore(vendor, clock);
    core.setTrack(TRACK);
    api().issMarker.mount(core);
    clock.setViewTime({ kind: 'scrubbed', atMs: NOW + 90 * 60_000 });
    api().moveIssMarkerToView();
    const parked = vendor.markers[0]?.at;
    api().tickIssMarker(NOW + 1000);
    expect(vendor.markers[0]?.at).toEqual(parked);
  });
});
