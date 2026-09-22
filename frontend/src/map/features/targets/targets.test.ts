import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PassEntry } from '../../../types';
import { createVendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';

const NOW = Date.parse('2026-05-04T12:10:00Z');

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('targets module was not loaded');
  return mod;
}

beforeEach(async () => {
  vi.resetModules();
  loaded.mod = await import('./index');
});

describe('targets', () => {
  it('writes an in-window pass pin from the cached passes', () => {
    const vendor = createVendorDouble();
    const clock = createClock(() => NOW);
    const core = createMapCore(vendor, clock);
    api().bindTargetsClock(clock);
    api().noteTargetCore(core);
    api().setTargetPasses([{
      target_id: 'city',
      target_name: 'City',
      target_lat: 12,
      target_lon: -40,
      closest_approach: '2026-05-04T12:20:00Z',
      nadir_distance_km: 10,
      score: 80,
      cloud_fraction: 12,
      cloud_source: 'gibs',
      pass_regime: 'day',
      obstruction_class: 'clear',
    } as PassEntry]);
    api().refreshTargetsSource();
    const source = vendor.sources.get('targets');
    if (!source || source.type !== 'geojson' || typeof source.data === 'string') throw new Error('targets source missing');
    expect(source.data.features).toHaveLength(1);
    expect(source.data.features[0]?.geometry).toMatchObject({ type: 'Point', coordinates: [-40, 12] });
    expect(source.data.features[0]?.properties).toMatchObject({ in_window: true, has_pass: true });
  });
});
