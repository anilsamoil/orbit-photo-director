import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tiersAt } from '../../../launch-tiers';
import type { PassEntry } from '../../../types';
import { catalog, catalogItem, NOW, shot } from '../../../../test/launch-fixtures';

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

  it('draws a pad for a tier pin and no line when the corridor is absent', () => {
    const pad = catalogItem({
      event_id: 'pad-only',
      tier: 'likely',
      name: 'Pad only',
      direction: { kind: 'none', azimuth_deg: null, source: null, off_plane_deg: null },
      shots: [shot({ track: [] })],
    });
    const envelope = pad.shots[0];
    if (!envelope) throw new Error('missing shot');
    delete envelope.evaluated_at;
    delete envelope.direction;
    const tiers = tiersAt(catalog([pad]), NOW);
    if (!tiers) throw new Error('expected a current catalog');
    const drawn = api().buildTierMapFeatures(tiers);
    expect(drawn.pads).toHaveLength(1);
    expect(drawn.pads[0]?.properties).toMatchObject({
      event_id: 'pad-only',
      catalog: 'tier',
      label: 'LAUNCH / LIKELY',
    });
    expect(drawn.pads[0]?.geometry).toMatchObject({ type: 'Point' });
    expect(drawn.lines).toEqual([]);
  });

  it('draws a corridor line for a Shot pin and nothing for Watch', () => {
    const watch = catalogItem({ event_id: 'watch-1', tier: 'watch', name: 'Watch' });
    const ascent = catalogItem({ event_id: 'ascent', tier: 'shot', name: 'Ascent' });
    const tiers = tiersAt(catalog([watch, ascent]), NOW);
    if (!tiers) throw new Error('expected a current catalog');
    expect(tiers.groups.watch.map((launch) => launch.eventId)).toEqual(['watch-1']);
    expect(tiers.find('watch-1')?.corridor).not.toBeNull();
    const drawn = api().buildTierMapFeatures(tiers);
    expect(drawn.pads.map((feature) => feature.properties?.event_id)).toEqual(['ascent']);
    expect(drawn.lines.length).toBeGreaterThan(0);
    expect(drawn.lines.every((feature) => feature.geometry.type === 'LineString')).toBe(true);
    expect(drawn.lines.every((feature) => feature.properties?.event_id === 'ascent')).toBe(true);
    expect(drawn.lines.every((feature) => feature.properties?.catalog === 'tier')).toBe(true);
    expect(drawn.pads.some((feature) => feature.properties?.event_id === 'watch-1')).toBe(false);
  });
});
