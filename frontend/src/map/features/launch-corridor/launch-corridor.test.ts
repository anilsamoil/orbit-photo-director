import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchCatalog } from '../../../launch-catalog';
import { renderMapLaunchBrief } from '../../../launch-map-brief';
import { parseLaunchArtifact } from '../../../launch-schema';
import { tiersAt } from '../../../launch-tiers';
import type { PassEntry } from '../../../types';
import { catalog, catalogItem, NOW, plannerCases, plannerFan, plannerItem, shot, state } from '../../../../test/launch-fixtures';
import { createVendorDouble } from '../../../../test/vendor-map-double';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';

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
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('launch-corridor', () => {
  it('draws the selected fan nominal, both edges, and their end chord with its provenance', () => {
    const first = plannerItem();
    const second = plannerItem({ event_id: 'other', name: 'Other launch' });
    const tiers = tiersAt(catalog([first, second]), NOW);
    if (!tiers) throw new Error('expected a current catalog');
    const drawn = api().buildTierMapFeatures(tiers, NOW, 'vulcan');
    expect(drawn.pads).toHaveLength(2);
    expect(drawn.lines).toHaveLength(12);
    expect(drawn.lines.filter((line) => line.properties?.role === 'model')).toHaveLength(3);
    expect(drawn.lines.filter((line) => line.properties?.role === 'edge')).toHaveLength(9);
    expect(drawn.lines.every((line) => line.properties?.event_id === 'vulcan'
      && line.properties?.grade === 'B' && line.properties?.source === 'Amazon Leo shell estimate')).toBe(true);
    expect(drawn.lines.some((line) => line.geometry.type === 'LineString'
      && JSON.stringify(line.geometry.coordinates) === JSON.stringify([[-79.2, 30.2], [-78.8, 29.8]]))).toBe(true);
  });

  it('draws unknown-orbit sector edges without a nominal track', () => {
    const unknown = plannerCases().find((entry) => entry.event_id === 'starbase');
    if (!unknown) throw new Error('missing unknown case');
    const tiers = tiersAt(catalog([unknown]), NOW);
    if (!tiers) throw new Error('expected a current catalog');
    const lines = api().buildTierMapFeatures(tiers, NOW, 'starbase').lines;
    expect(lines).toHaveLength(9);
    expect(lines.every((line) => line.properties?.role === 'edge')).toBe(true);
    expect(lines[0]?.properties?.source).toContain('UNVERIFIED');
  });

  it('frames selected fan edges across the antimeridian and captions its source', async () => {
    const crossing = plannerFan({
      track: [{ t_offset_s: 0, lat: 10, lon: 179, alt_km: 0 }, { t_offset_s: 60, lat: 12, lon: -179, alt_km: 50 }],
      low_track: [{ t_offset_s: 0, lat: 10, lon: 179, alt_km: 0 }, { t_offset_s: 60, lat: 13, lon: -178, alt_km: 50 }],
      high_track: [{ t_offset_s: 0, lat: 10, lon: 179, alt_km: 0 }, { t_offset_s: 60, lat: 11, lon: -177, alt_km: 50 }],
    });
    const launch = plannerItem({ site: { name: 'Test site', lat: 10, lon: 179 }, ascent: { grade: 'B', source: 'Unverified test sector', fans: [crossing] } });
    const tiers = tiersAt(catalog([launch]), NOW);
    if (!tiers) throw new Error('expected a current catalog');
    const { launchCatalog: currentCatalog } = await import('../../../launch-catalog');
    const corridor = await import('./index');
    const mode = await import('../../../map-launch-mode');
    vi.spyOn(currentCatalog, 'read').mockReturnValue(tiers);
    const empty = { type: 'FeatureCollection' as const, features: [] };
    const vendor = createVendorDouble({ sources: [
      ['ascent-pad', { type: 'geojson', data: empty }],
      ['ascent-trajectory', { type: 'geojson', data: empty }],
    ] });
    corridor.noteLaunchCore(createMapCore(vendor, createClock(() => NOW)));
    const pane = document.createElement('div');
    pane.id = 'map-pane';
    document.body.append(pane);
    expect(corridor.focusLaunchOnMap('vulcan')).toBe(true);
    const box = vendor.cameraCalls.find((call) => call.method === 'fitBounds')?.args[0] as { west: number; east: number } | undefined;
    expect(box?.east).toBe(183);
    expect(box?.west).toBe(179);
    const caption = document.getElementById('launch-ascent-caption');
    expect(caption?.hidden).toBe(false);
    expect(caption?.textContent).toContain('Vulcan VC6L | Amazon Leo, grade B');
    expect(caption?.textContent).toContain('Unverified test sector');
    expect(caption?.textContent).toContain("Only this launch's fans are shown");
    corridor.resetLaunchForTest();
    mode.setMapLaunchMode(false);
  });
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

  it('draws existing corridors for Shot and scheduled Watch with their actual labels', () => {
    const watch = catalogItem({ event_id: 'watch-1', tier: 'watch', name: 'Watch' });
    const ascent = catalogItem({ event_id: 'ascent', tier: 'shot', name: 'Ascent' });
    const tiers = tiersAt(catalog([watch, ascent]), NOW);
    if (!tiers) throw new Error('expected a current catalog');
    expect(tiers.groups.watch.map((launch) => launch.eventId)).toEqual(['watch-1']);
    expect(tiers.find('watch-1')?.corridor).not.toBeNull();
    const drawn = api().buildTierMapFeatures(tiers, NOW);
    expect(drawn.pads.map((feature) => feature.properties?.event_id)).toEqual(['ascent', 'watch-1']);
    expect(drawn.pads[1]?.properties?.label).toBe('LAUNCH / WATCH');
    expect(drawn.lines.length).toBeGreaterThan(0);
    expect(drawn.lines.every((feature) => feature.geometry.type === 'LineString')).toBe(true);
    expect(new Set(drawn.lines.map((feature) => feature.properties?.event_id))).toEqual(new Set(['ascent', 'watch-1']));
    expect(drawn.lines.every((feature) => feature.properties?.catalog === 'tier')).toBe(true);
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
