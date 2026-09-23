import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PassEntry } from '../../../types';

const loaded: { mod: typeof import('./geometry') | null } = { mod: null };

function api(): typeof import('./geometry') {
  const mod = loaded.mod;
  if (!mod) throw new Error('launch geometry was not loaded');
  return mod;
}

beforeEach(async () => {
  vi.resetModules();
  loaded.mod = await import('./geometry');
});

describe('launch-corridor', () => {
  it('keeps one pad per launch and does not invent a corridor from a legacy row', () => {
    const pass = {
      target_id: 'pad',
      target_lat: 28.5,
      target_lon: -80.6,
      launch: { name: 'Falcon', t0: '2026-05-04T12:00:00Z', pad_lat: 28.5, pad_lon: -80.6 },
    } as PassEntry;
    const features = api().buildAscentFeatures([pass, pass]);
    expect(features.lines).toEqual([]);
    expect(features.pads).toHaveLength(1);
    expect(features.pads[0]?.geometry).toMatchObject({ type: 'Point', coordinates: [-80.6, 28.5] });
  });
});
