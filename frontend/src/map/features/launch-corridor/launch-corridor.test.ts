import { beforeEach, describe, expect, it, vi } from 'vitest';

import { launchCatalog } from '../../../launch-catalog';
import { renderMapLaunchBrief } from '../../../launch-map-brief';
import { parseLaunchArtifact } from '../../../launch-schema';
import { tiersAt } from '../../../launch-tiers';
import type { PassEntry } from '../../../types';
import { catalog, catalogItem, NOW, shot, state } from '../../../../test/launch-fixtures';

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
    const drawn = api().buildTierMapFeatures(tiers, NOW);
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
    const drawn = api().buildTierMapFeatures(tiers, NOW);
    expect(drawn.pads.map((feature) => feature.properties?.event_id)).toEqual(['ascent']);
    expect(drawn.lines.length).toBeGreaterThan(0);
    expect(drawn.lines.every((feature) => feature.geometry.type === 'LineString')).toBe(true);
    expect(drawn.lines.every((feature) => feature.properties?.event_id === 'ascent')).toBe(true);
    expect(drawn.lines.every((feature) => feature.properties?.catalog === 'tier')).toBe(true);
    expect(drawn.pads.some((feature) => feature.properties?.event_id === 'watch-1')).toBe(false);
  });

  const CRS35_ID = 'bf2c3027-a314-403e-a416-2bfd5d165ad1';
  const CRS35_NAME = 'Falcon 9 Block 5 | Dragon CRS-2 SpX-35';
  const CRS35_NET_MS = Date.parse('2026-10-13T10:33:44Z');
  const FORECAST_MS = 48 * 60 * 60 * 1000;

  function crs35At(
    now: number,
    schedule: {
      net: string;
      window_start: string | null;
      window_end: string | null;
      precision: string | null;
      status: string;
      destination: string | null;
    } = {
      net: '2026-10-13T10:33:44Z',
      window_start: '2026-10-13T10:33:44Z',
      window_end: '2026-10-13T10:33:44Z',
      precision: 'Second',
      status: 'Go',
      destination: 'ISS',
    },
    shotEndMs = 0,
  ): { label: unknown; summary: string | null | undefined; name: string | null | undefined } {
    const base = catalogItem({
      event_id: CRS35_ID,
      name: CRS35_NAME,
      tier: 'shot',
      site: { name: 'SLC-40', lat: 28.56194122, lon: -80.57735736 },
      schedule,
    });
    const item = shotEndMs === 0 ? base : {
      ...base,
      shots: base.shots.map((entry) => ({ ...entry, end: new Date(shotEndMs).toISOString() })),
    };
    const generated = now - 60_000;
    const body = catalog([item], {
      generated_at: new Date(generated).toISOString(),
      schedule_valid_until: new Date(generated + 75 * 60_000).toISOString(),
      geometry_valid_until: new Date(generated + 15 * 60_000).toISOString(),
    });
    expect(parseLaunchArtifact(body).schema_version).toBe(3);
    const tiers = tiersAt(body, now);
    if (!tiers) throw new Error('expected a current catalog');
    const drawn = api().buildTierMapFeatures(tiers, now);
    const container = document.createElement('div');
    const read = vi.spyOn(launchCatalog, 'read').mockReturnValue(tiers);
    try {
      renderMapLaunchBrief(container, state(), now, () => undefined);
    } finally {
      read.mockRestore();
    }
    return {
      label: drawn.pads[0]?.properties?.label,
      summary: container.querySelector('.map-launch-primary > summary')?.textContent,
      name: container.querySelector('.launch-name')?.textContent,
    };
  }

  it('labels CRS-35 Shot (forecast) up to 48 hours before liftoff', () => {
    const shown = crs35At(CRS35_NET_MS - FORECAST_MS);
    expect(shown.name).toBe(CRS35_NAME);
    expect(shown.label).toBe('Shot (forecast)');
    expect(shown.summary).toBe('Next launch · Shot (forecast)');
  });

  it('keeps the Shot label more than 48 hours before liftoff', () => {
    const shown = crs35At(CRS35_NET_MS - FORECAST_MS - 1000);
    expect(shown.name).toBe(CRS35_NAME);
    expect(shown.label).toBe('LAUNCH / SHOT');
    expect(shown.summary).toBe('Next launch · Shot');
  });

  it('drops the forecast label at liftoff and after it', () => {
    const atLiftoff = crs35At(CRS35_NET_MS, undefined, CRS35_NET_MS + 120_000);
    expect(atLiftoff.name).toBe(CRS35_NAME);
    expect(atLiftoff.label).toBe('LAUNCH / SHOT');
    expect(atLiftoff.summary).toBe('Next launch · Shot');
    const after = crs35At(CRS35_NET_MS + 1000, undefined, CRS35_NET_MS + 120_000);
    expect(after.label).toBe('LAUNCH / SHOT');
    expect(after.summary).toBe('Next launch · Shot');
  });

  it('labels Shot (forecast) from the window end when that is the liftoff', () => {
    const windowEnd = CRS35_NET_MS + 60 * 60 * 1000;
    const shown = crs35At(CRS35_NET_MS + 30 * 60 * 1000, {
      net: '2026-10-13T10:33:44Z',
      window_start: '2026-10-13T10:33:44Z',
      window_end: new Date(windowEnd).toISOString(),
      precision: 'Second',
      status: 'Go',
      destination: 'ISS',
    }, windowEnd + 120_000);
    expect(shown.name).toBe(CRS35_NAME);
    expect(shown.label).toBe('Shot (forecast)');
    expect(shown.summary).toBe('Next launch · Shot (forecast)');
  });
});
