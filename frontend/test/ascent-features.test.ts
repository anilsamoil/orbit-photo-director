import { describe, expect, it } from 'vitest';
import { buildAscentFeatures } from '../src/map';
import type { PassEntry } from '../src/types';

// Regression: v1.6.1.0 — ASCENT trajectory map layer.
// Found by /qa on 2026-05-22.
// Report: .gstack/qa-reports/qa-report-localhost-2026-05-22.md
//
// These cover the pure geojson-building logic. The map-side rendering is
// validated end-to-end at /qa time (the toggle button + layer addLayer
// path is identical to the working terminator + multi-orbit toggles), but
// the source-shape contract belongs in unit tests so a future refactor
// can't silently break what MapLibre receives.

function makePass(overrides: Partial<PassEntry> = {}): PassEntry {
  return {
    target_id: 'launch:test:ascent',
    target_name: '🚀 Test Launch',
    target_regime: 'any',
    target_priority: 5,
    target_lat: 28.5,
    target_lon: -80.6,
    closest_approach: '2026-05-22T18:00:00Z',
    nadir_distance_km: 100,
    pass_regime: 'night',
    obstruction_class: 'clear',
    p_unobstructed: 80,
    cloud_fraction: 20,
    cloud_source: 'ascent-derived',
    score: 50,
    score_components: {
      p_unobstructed: 80,
      regime_fit: 100,
      nadir_proximity: 50,
      priority_weight: 100,
      tle_freshness: 1,
    },
    iss_at_closest: { lat: 28.5, lon: -80.6, alt_km: 420 },
    ...overrides,
  };
}

describe('buildAscentFeatures', () => {
  it('returns empty arrays for no passes', () => {
    const { lines, pads } = buildAscentFeatures([]);
    expect(lines).toEqual([]);
    expect(pads).toEqual([]);
  });

  it('skips passes without a launch field', () => {
    const { lines, pads } = buildAscentFeatures([makePass()]);
    expect(lines).toEqual([]);
    expect(pads).toEqual([]);
  });

  it('skips overhead launches (only ascent draws a trajectory)', () => {
    const p = makePass({
      launch: {
        name: 'F9 OVERHEAD',
        rocket_type: 'Falcon 9',
        geometry: 'overhead',
        kind: 'overhead',
        site_name: 'LC-39A',
        net_window_seconds: 0,
        t0: '2026-05-22T18:00:00Z',
        trajectory: [
          { t_offset_s: 0, lat: 28.5, lon: -80.6, alt_km: 0 },
          { t_offset_s: 30, lat: 28.6, lon: -80.5, alt_km: 5 },
        ],
      },
    });
    const { lines, pads } = buildAscentFeatures([p]);
    expect(lines).toEqual([]);
    expect(pads).toEqual([]);
  });

  it('skips ascent passes with a missing or short trajectory', () => {
    const p = makePass({
      launch: {
        name: 'F9 ASCENT',
        rocket_type: 'Falcon 9',
        geometry: 'ascent',
        kind: 'ascent',
        site_name: 'LC-39A',
        net_window_seconds: 0,
        t0: '2026-05-22T18:00:00Z',
        trajectory: [{ t_offset_s: 0, lat: 28.5, lon: -80.6, alt_km: 0 }],
      },
    });
    const { lines, pads } = buildAscentFeatures([p]);
    expect(lines).toEqual([]);
    expect(pads).toEqual([]);
  });

  it('emits one pad pin + N-1 line segments for an N-point trajectory', () => {
    const traj = [
      { t_offset_s: 0, lat: 28.5, lon: -80.6, alt_km: 0 },
      { t_offset_s: 30, lat: 28.6, lon: -80.5, alt_km: 5 },
      { t_offset_s: 60, lat: 28.8, lon: -80.3, alt_km: 30 },
      { t_offset_s: 120, lat: 29.2, lon: -79.5, alt_km: 100 },
    ];
    const p = makePass({
      launch: {
        name: 'Falcon 9',
        rocket_type: 'Falcon 9 Block 5',
        geometry: 'ascent',
        kind: 'ascent',
        site_name: 'LC-39A Kennedy',
        net_window_seconds: 0,
        t0: '2026-05-22T18:00:00Z',
        trajectory: traj,
      },
    });
    const { lines, pads } = buildAscentFeatures([p]);

    // 1 pad pin at the first trajectory point
    expect(pads).toHaveLength(1);
    expect(pads[0]?.geometry).toEqual({
      type: 'Point',
      coordinates: [-80.6, 28.5],
    });
    expect(pads[0]?.properties).toMatchObject({
      launch_name: 'Falcon 9',
      site_name: 'LC-39A Kennedy',
      t0: '2026-05-22T18:00:00Z',
    });

    // 3 segments (N-1=3), each duplicated to 3 features by world-copy
    // (original + lon-360 + lon+360 from buildLineFeatures) → 9 line features.
    expect(lines).toHaveLength(9);
    // Every segment carries the midpoint altitude and launch name.
    for (const f of lines) {
      expect(f.properties).toHaveProperty('alt_km');
      expect(f.properties).toHaveProperty('launch_name', 'Falcon 9');
      expect(f.geometry.type).toBe('LineString');
    }
    // Segment-0 midpoint altitude = (0 + 5) / 2 = 2.5
    // Find a feature with the original coords (lon ≈ -80.6, not ±360 copies).
    const orig0 = lines.find((f) => {
      const coords = (f.geometry as GeoJSON.LineString).coordinates;
      return coords[0]?.[0] === -80.6;
    });
    expect(orig0?.properties?.alt_km).toBe(2.5);
  });

  it('handles multiple ascent passes independently', () => {
    const mk = (name: string, lat: number, lon: number): PassEntry =>
      makePass({
        launch: {
          name,
          rocket_type: 'Falcon 9',
          geometry: 'ascent',
          kind: 'ascent',
          site_name: 'pad',
          net_window_seconds: 0,
          t0: '2026-05-22T18:00:00Z',
          trajectory: [
            { t_offset_s: 0, lat, lon, alt_km: 0 },
            { t_offset_s: 30, lat: lat + 0.1, lon: lon + 0.1, alt_km: 10 },
          ],
        },
      });
    const { lines, pads } = buildAscentFeatures([
      mk('Launch A', 28.5, -80.6),
      mk('Launch B', 34.6, -120.6),
    ]);
    expect(pads).toHaveLength(2);
    expect(pads.map((p) => p.properties?.launch_name).sort()).toEqual([
      'Launch A',
      'Launch B',
    ]);
    // 1 segment per launch × 3 world copies = 6 lines.
    expect(lines).toHaveLength(6);
  });
});
