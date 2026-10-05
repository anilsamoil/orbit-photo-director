import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANILS_TARGET_PAINT, ANILS_TARGETS_CATEGORY } from '../../../category-style';
import { saveProfile } from '../../../profile';
import type { PassEntry } from '../../../types';
import { createVendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';

vi.mock('../../../cloud', () => ({ fetchLiveCloud: async () => null }));

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

  it('omits a curated pin whose id is in removedCuratedIds', () => {
    history.replaceState(null, '', '/?u=anil');
    saveProfile({
      version: 1,
      name: 'anil',
      additions: [],
      removedCuratedIds: ['city'],
      distanceThresholdKm: 1500,
      instantBuffer: [],
    });
    const vendor = createVendorDouble();
    const clock = createClock(() => NOW);
    const core = createMapCore(vendor, clock);
    api().bindTargetsClock(clock);
    api().noteTargetCore(core);
    api().setTargetPasses([
      {
        target_id: 'city',
        target_name: 'City',
        target_lat: 12,
        target_lon: -40,
        closest_approach: '2026-05-04T12:20:00Z',
        nadir_distance_km: 10,
        score: 80,
      } as PassEntry,
      {
        target_id: 'kept',
        target_name: 'Kept',
        target_lat: 1,
        target_lon: 2,
        closest_approach: '2026-05-04T12:20:00Z',
        nadir_distance_km: 10,
        score: 40,
      } as PassEntry,
    ]);
    api().refreshTargetsSource();
    const source = vendor.sources.get('targets');
    if (!source || source.type !== 'geojson' || typeof source.data === 'string') throw new Error('targets source missing');
    const ids = source.data.features.map((feature) => feature.properties?.target_id);
    expect(ids).toEqual(['kept']);
  });

  it('carries the category onto the pin and paints Anil\'s targets in the category color', () => {
    const vendor = createVendorDouble();
    const clock = createClock(() => NOW);
    const core = createMapCore(vendor, clock);
    api().bindTargetsClock(clock);
    api().noteTargetCore(core);
    api().setTargetPasses([{
      target_id: 'k2',
      target_name: 'K2',
      target_lat: 35.88,
      target_lon: 76.51,
      closest_approach: '2026-05-04T12:20:00Z',
      nadir_distance_km: 10,
      score: 80,
      category: ANILS_TARGETS_CATEGORY,
    } as PassEntry]);
    api().refreshTargetsSource();
    const source = vendor.sources.get('targets');
    if (!source || source.type !== 'geojson' || typeof source.data === 'string') throw new Error('targets source missing');
    expect(source.data.features[0]?.properties).toMatchObject({ category: ANILS_TARGETS_CATEGORY });
    const layer = api().targetsLayer();
    if (!layer.paint) throw new Error('targets layer has no paint');
    const encoded = JSON.stringify(layer.paint['circle-color']);
    expect(encoded).toContain(ANILS_TARGETS_CATEGORY);
    expect(encoded).toContain(ANILS_TARGET_PAINT.color);
  });

  it.each([
    ['/?u=anil', 'personal:anil:harbor', ['Edit target']],
    ['/?u=watkins', 'personal:watkins:grand-canyon-arizona', []],
  ])('a personal pin tapped on %s offers %j', (url, targetId, editButtons) => {
    history.replaceState(null, '', url);
    const vendor = createVendorDouble({ layers: [api().myTargetsLayer()] });
    vendor.queryAt = (_box, layers) => layers.includes('my-targets-layer')
      ? [{
          properties: { target_id: targetId, target_name: 'Site', lat: 36.1, lon: -112.1, priority: 2, has_pass: false, is_personal: true },
          geometry: { type: 'Point', coordinates: [-112.1, 36.1] },
        }]
      : [];
    const clock = createClock(() => NOW);
    const core = createMapCore(vendor, clock);
    api().bindTargetsClock(clock);
    api().noteTargetCore(core);
    api().bindTargetInteractions(core);
    vendor.fire('click', { point: { x: -112.1, y: 36.1 }, lngLat: [-112.1, 36.1] });
    expect(vendor.popups).toHaveLength(1);
    const buttons = [...vendor.popups[0]!.content.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons.filter((text) => text === 'Edit target')).toEqual(editButtons);
  });
});
