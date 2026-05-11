/**
 * Tests for tile-precache.ts (V4-P2 from Chris's 2026-05-05 feedback).
 *
 * Coverage:
 * - lonLatToTile: standard slippy-map projection sanity (origin, KSC,
 *   antimeridian, near-pole)
 * - fillTileUrl: {z}/{x}/{y} substitution
 * - buildPrecacheUrls: top-N filtering + zoom-level coverage + GIBS
 *   z-clamp + carto + gibs interleaving
 * - precacheTilesForTargets: skipped offline, fires when online,
 *   swallows errors, no-op on empty pass list
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  PRECACHE_TARGET_COUNT,
  PRECACHE_ZOOM_LEVELS,
  buildPrecacheUrls,
  fillTileUrl,
  gibsTrueColorUrl,
  lonLatToTile,
  precacheTilesForTargets,
} from '../src/tile-precache';
import type { PassEntry } from '../src/types';

const samplePass = (over: Partial<PassEntry> = {}): PassEntry => ({
  target_id: 't',
  target_name: 'T',
  target_regime: 'any',
  target_priority: 5,
  target_lat: 0,
  target_lon: 0,
  closest_approach: '2026-05-12T00:00:00Z',
  nadir_distance_km: 0,
  pass_regime: 'day',
  obstruction_class: 'clear',
  p_unobstructed: 1,
  cloud_fraction: 0,
  cloud_source: 'mock',
  score: 0,
  score_components: {
    p_unobstructed: 0, regime_fit: 0, nadir_proximity: 0,
    priority_weight: 0, tle_freshness: 0,
  },
  iss_at_closest: { lat: 0, lon: 0, alt_km: 410 },
  ...over,
});

describe('lonLatToTile (slippy-map projection)', () => {
  it('origin (0, 0) → middle tile at any zoom', () => {
    // At z=0 the world is 1 tile (0, 0). At z=1 the world is 4 tiles;
    // (0, 0) lon/lat falls on the boundary → tile (1, 1) by floor.
    expect(lonLatToTile(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(lonLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1 });
    expect(lonLatToTile(0, 0, 2)).toEqual({ x: 2, y: 2 });
  });

  it('KSC (28.6082°N, -80.6041°W) at z=8 → known tile', () => {
    // Cross-check against any standard slippy-tilename calculator for
    // (-80.6041, 28.6082, 8) → tile (70, 106).
    expect(lonLatToTile(-80.6041, 28.6082, 8)).toEqual({ x: 70, y: 106 });
  });

  it('Tokyo (139.69°E, 35.68°N) at z=10 → known tile', () => {
    expect(lonLatToTile(139.69, 35.68, 10)).toEqual({ x: 909, y: 403 });
  });

  it('clamps near-antimeridian to valid tile range', () => {
    // 180°E is the boundary; floor of 1.0*n gives x=n which we clamp to n-1.
    const t = lonLatToTile(180, 0, 5);
    const n = 2 ** 5;
    expect(t.x).toBeLessThan(n);
    expect(t.x).toBeGreaterThanOrEqual(0);
  });

  it('clamps near-pole to valid tile range', () => {
    const t = lonLatToTile(0, 89.99, 8);
    const n = 2 ** 8;
    expect(t.y).toBeLessThan(n);
    expect(t.y).toBeGreaterThanOrEqual(0);
  });
});

describe('fillTileUrl', () => {
  it('replaces all three placeholders', () => {
    const url = fillTileUrl('https://example.com/{z}/{x}/{y}.png', 8, 71, 110);
    expect(url).toBe('https://example.com/8/71/110.png');
  });

  it('handles GIBS-style {z}/{y}/{x} order (formula matches whatever the pattern says)', () => {
    // GIBS uses {z}/{y}/{x} order — the function does literal string
    // replacement so the caller decides the order via the pattern.
    const gibs = gibsTrueColorUrl('2026-05-10');
    const filled = fillTileUrl(gibs, 8, 110, 71);  // (z=8, x=110, y=71)
    expect(filled).toContain('/8/71/110.jpg');     // GIBS pattern is z/y/x
  });
});

describe('gibsTrueColorUrl', () => {
  it('embeds the date + EPSG:3857 + Level9 endpoint', () => {
    const url = gibsTrueColorUrl('2026-05-10');
    expect(url).toContain('gibs.earthdata.nasa.gov');
    expect(url).toContain('VIIRS_NOAA21_CorrectedReflectance_TrueColor');
    expect(url).toContain('/2026-05-10/');
    expect(url).toContain('GoogleMapsCompatible_Level9');
    expect(url).toContain('{z}/{y}/{x}.jpg');
  });
});

describe('buildPrecacheUrls', () => {
  const gibsPattern = gibsTrueColorUrl('2026-05-10');

  it('caps at PRECACHE_TARGET_COUNT targets', () => {
    const passes = Array.from({ length: 10 }, (_, i) =>
      samplePass({ target_id: `p${i}`, target_lat: i, target_lon: i }));
    const urls = buildPrecacheUrls(passes, gibsPattern);
    // Each target produces 2 URLs (carto + gibs) per zoom level.
    const expectedPerTarget = PRECACHE_ZOOM_LEVELS.length * 2;
    expect(urls.length).toBe(PRECACHE_TARGET_COUNT * expectedPerTarget);
  });

  it('produces both carto and gibs URLs for each (target, zoom)', () => {
    const urls = buildPrecacheUrls([samplePass({ target_lat: 28.6, target_lon: -80.6 })], gibsPattern);
    const cartoCount = urls.filter((u) => u.includes('cartocdn')).length;
    const gibsCount = urls.filter((u) => u.includes('gibs.earthdata')).length;
    expect(cartoCount).toBe(PRECACHE_ZOOM_LEVELS.length);
    expect(gibsCount).toBe(PRECACHE_ZOOM_LEVELS.length);
  });

  it('clamps GIBS zoom to 9 (matches map.ts maxzoom)', () => {
    // PRECACHE_ZOOM_LEVELS includes 10. GIBS only serves z9, so the z10
    // request should be clamped to z9.
    const urls = buildPrecacheUrls([samplePass({ target_lat: 28.6, target_lon: -80.6 })], gibsPattern);
    const gibsZooms = urls
      .filter((u) => u.includes('gibs.earthdata'))
      .map((u) => Number(u.match(/Level9\/(\d+)\//)?.[1]));
    expect(Math.max(...gibsZooms)).toBe(9);  // clamped from 10
  });

  it('returns empty array for no passes', () => {
    expect(buildPrecacheUrls([], gibsPattern)).toEqual([]);
  });

  it('uses the correct lat/lon for the tile coords (KSC)', () => {
    const urls = buildPrecacheUrls(
      [samplePass({ target_lat: 28.6082, target_lon: -80.6041 })],
      gibsPattern,
    );
    const cartoZ8 = urls.find((u) => u.includes('cartocdn') && u.includes('/8/'));
    // KSC at z=8 → tile (70, 106); carto pattern is /{z}/{x}/{y}@2x.png
    expect(cartoZ8).toContain('/8/70/106@2x.png');
  });
});

describe('precacheTilesForTargets', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips entirely when offline', () => {
    precacheTilesForTargets(
      [samplePass()],
      gibsTrueColorUrl('2026-05-10'),
      () => false,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips entirely when no passes', () => {
    precacheTilesForTargets([], gibsTrueColorUrl('2026-05-10'), () => true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fires N×Z×2 fetches when online with N passes', () => {
    const passes = [
      samplePass({ target_id: 'a', target_lat: 28.6, target_lon: -80.6 }),
      samplePass({ target_id: 'b', target_lat: 35.7, target_lon: 139.7 }),
    ];
    precacheTilesForTargets(passes, gibsTrueColorUrl('2026-05-10'), () => true);
    // 2 passes × 3 zoom levels × 2 sources = 12 fetches
    expect(fetchSpy).toHaveBeenCalledTimes(2 * PRECACHE_ZOOM_LEVELS.length * 2);
  });

  it('uses no-cors mode so cross-origin SW caching works', () => {
    precacheTilesForTargets(
      [samplePass()],
      gibsTrueColorUrl('2026-05-10'),
      () => true,
    );
    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall?.[1]).toEqual({ mode: 'no-cors' });
  });

  it('swallows individual fetch failures (no thrown error)', async () => {
    fetchSpy.mockRejectedValue(new Error('net down'));
    expect(() =>
      precacheTilesForTargets(
        [samplePass()],
        gibsTrueColorUrl('2026-05-10'),
        () => true,
      ),
    ).not.toThrow();
    // Yield to microtasks so the .catch() handler runs.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('caps at PRECACHE_TARGET_COUNT even with many passes', () => {
    const passes = Array.from({ length: 20 }, (_, i) =>
      samplePass({ target_id: `p${i}`, target_lat: i, target_lon: i }));
    precacheTilesForTargets(passes, gibsTrueColorUrl('2026-05-10'), () => true);
    expect(fetchSpy).toHaveBeenCalledTimes(
      PRECACHE_TARGET_COUNT * PRECACHE_ZOOM_LEVELS.length * 2,
    );
  });
});
