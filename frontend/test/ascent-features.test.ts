import { describe, expect, it } from 'vitest';
import { buildAscentFeatures, buildLaunchMapFeatures } from '../src/map';
import type { PassEntry } from '../src/types';
import { launch, NOW, state, supported } from './launch-fixtures';

describe('launch map layers', () => {
  it('keeps unknown-trajectory sites with no fabricated corridor', () => {
    const data = buildLaunchMapFeatures(state(), NOW);
    expect(data.pads).toHaveLength(1);
    expect(data.pads[0]?.properties).toMatchObject({ event_id: 'event-1', revision: 'event-r1', label: 'LAUNCH / MAP ONLY' });
    expect(data.pads[0]?.geometry).toEqual({ type: 'Point', coordinates: [-80.6, 28.5] });
    expect(data.lines).toEqual([]);
  });
  it('does not trust stray points when quality is unknown or source absent', () => {
    const item = launch({ trajectory: { ...supported().trajectory, quality: 'unknown' } });
    expect(buildLaunchMapFeatures(state([item]), NOW).lines).toEqual([]);
    item.trajectory.quality = 'approximate'; item.trajectory.source = null;
    expect(buildLaunchMapFeatures(state([item]), NOW).lines).toEqual([]);
  });
  it('draws a sourced trajectory, splitting the antimeridian and preserving identity', () => {
    const item = supported({ trajectory: { quality: 'verified', source: 'Mission source', points: [
      { lat: 28, lon: 179, alt_km: 0, t_offset_seconds: 0 },
      { lat: 29, lon: -179, alt_km: 50, t_offset_seconds: 60 },
    ] } });
    const data = buildLaunchMapFeatures(state([item]), NOW);
    expect(data.pads).toHaveLength(1);
    expect(data.lines.length).toBeGreaterThan(0);
    for (const feature of data.lines) {
      expect(feature.properties).toMatchObject({ event_id: 'event-1', revision: 'event-r1', quality: 'verified' });
      const coords = (feature.geometry as GeoJSON.LineString).coordinates;
      for (let i = 1; i < coords.length; i++) expect(Math.abs(coords[i]![0]! - coords[i - 1]![0]!)).toBeLessThanOrEqual(180);
    }
  });
  it('empty/missing v2 cannot break layer building', () => {
    expect(buildLaunchMapFeatures(state([], { artifact: null }), NOW)).toEqual({ lines: [], pads: [] });
    expect(buildAscentFeatures([])).toEqual({ lines: [], pads: [] });
  });
  it('legacy geometry is site-only and deduplicated', () => {
    const pass = { target_id: 'launch:test', target_lat: 28, target_lon: -80,
      launch: { name: 'Legacy', t0: '', geometry: 'ascent', site_name: 'Pad', trajectory: [
        { lat: 10, lon: 10, alt_km: 0, t_offset_s: 0 }, { lat: 20, lon: 20, alt_km: 5, t_offset_s: 10 },
      ] } } as PassEntry;
    const result = buildAscentFeatures([pass, pass]);
    expect(result.lines).toEqual([]);
    expect(result.pads).toHaveLength(1);
    expect(result.pads[0]?.geometry).toEqual({ type: 'Point', coordinates: [-80, 28] });
  });
});
