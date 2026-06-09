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
  GIBS_MAX_ZOOM,
  PRECACHE_TARGET_COUNT,
  PRECACHE_ZOOM_LEVELS,
  WORLD_BASE_ZOOM_LEVELS,
  _resetPrecacheInflightForTest,
  buildPrecacheUrls,
  buildWorldBaseUrls,
  buildWorldOverlayUrls,
  fillTileUrl,
  gibsTrueColorUrl,
  lonLatToTile,
  precacheTilesForTargets,
  precacheWorldBaseTiles,
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

  it('clamps GIBS zoom to GIBS_MAX_ZOOM (matches map.ts maxzoom)', () => {
    // PRECACHE_ZOOM_LEVELS includes 10. GIBS only serves z9, so the z10
    // request should be clamped to z9.
    const urls = buildPrecacheUrls([samplePass({ target_lat: 28.6, target_lon: -80.6 })], gibsPattern);
    const gibsZooms = urls
      .filter((u) => u.includes('gibs.earthdata'))
      .map((u) => Number(u.match(/Level9\/(\d+)\//)?.[1]));
    expect(Math.max(...gibsZooms)).toBe(GIBS_MAX_ZOOM);  // clamped from 10
  });

  it('returns empty array for no passes', () => {
    expect(buildPrecacheUrls([], gibsPattern)).toEqual([]);
  });

  it('uses the correct lat/lon for the tile coords (KSC)', () => {
    const urls = buildPrecacheUrls(
      [samplePass({ target_lat: 28.6082, target_lon: -80.6041 })],
      gibsPattern,
    );
    // KSC at z=8 → tile (70, 106); carto pattern is /{z}/{x}/{y}@2x.png
    // Subdomain is (x+y)%4 = (70+106)%4 = 176%4 = 0 → 'a'
    const cartoZ8 = urls.find((u) => u.includes('cartocdn') && u.includes('/8/'));
    expect(cartoZ8).toContain('/8/70/106@2x.png');
    expect(cartoZ8).toContain('https://a.basemaps.cartocdn.com/');
  });

  it('rotates carto subdomain via (x+y)%4 to match MapLibre', () => {
    // Tokyo at z=10 → tile (909, 403); (909+403)%4 = 1312%4 = 0 → 'a'
    const tokyo = buildPrecacheUrls(
      [samplePass({ target_lat: 35.68, target_lon: 139.69 })],
      gibsPattern,
    );
    const tokyoZ10 = tokyo.find((u) => u.includes('cartocdn') && u.includes('/10/'));
    expect(tokyoZ10).toContain('https://a.basemaps.cartocdn.com/');
    // Z=8 for Tokyo: tile (227, 100); (227+100)%4 = 327%4 = 3 → 'd'
    const tokyoZ8 = tokyo.find((u) => u.includes('cartocdn') && u.includes('/8/'));
    expect(tokyoZ8).toContain('https://d.basemaps.cartocdn.com/');
  });

  it('skips targets with non-finite lat/lon', () => {
    const passes = [
      samplePass({ target_id: 'good', target_lat: 0, target_lon: 0 }),
      samplePass({ target_id: 'bad-lat', target_lat: NaN, target_lon: 0 }),
      samplePass({ target_id: 'bad-lon', target_lat: 0, target_lon: Infinity }),
    ];
    const urls = buildPrecacheUrls(passes, gibsPattern);
    // Only 1 valid target × 3 zooms × 2 sources = 6 URLs.
    expect(urls.length).toBe(PRECACHE_ZOOM_LEVELS.length * 2);
  });
});

describe('buildWorldBaseUrls (z0-3 world-view basemap)', () => {
  it('produces exactly 85 tiles: z0(1)+z1(4)+z2(16)+z3(64)', () => {
    const urls = buildWorldBaseUrls();
    const expected = WORLD_BASE_ZOOM_LEVELS.reduce<number>((sum, z) => sum + 4 ** z, 0);
    expect(expected).toBe(85);
    expect(urls.length).toBe(85);
  });

  it('covers every tile at each zoom (z2 → all 16)', () => {
    const urls = buildWorldBaseUrls();
    const z2 = urls.filter((u) => /\/dark_all\/2\//.test(u));
    expect(z2.length).toBe(16);
    // Every (x,y) in the 4×4 z2 grid is present.
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        expect(z2.some((u) => u.includes(`/2/${x}/${y}@2x.png`))).toBe(true);
      }
    }
  });

  it('only emits carto dark_all base tiles (matches the SW base-cache route)', () => {
    for (const u of buildWorldBaseUrls()) {
      expect(u).toMatch(/^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/dark_all\/[0-3]\/\d+\/\d+@2x\.png$/);
    }
  });

  it('rotates subdomain via (x+y)%4 (same as the per-target precache)', () => {
    const urls = buildWorldBaseUrls();
    // z3 tile (2,1): (2+1)%4 = 3 → 'd'
    expect(urls).toContain('https://d.basemaps.cartocdn.com/dark_all/3/2/1@2x.png');
    // z3 tile (0,0): (0+0)%4 = 0 → 'a'
    expect(urls).toContain('https://a.basemaps.cartocdn.com/dark_all/3/0/0@2x.png');
  });
});

describe('buildWorldOverlayUrls (z0-3 switchable layers)', () => {
  it('produces 255 URLs: 85 tiles × 3 layers (Esri + clouds + VIIRS)', () => {
    expect(buildWorldOverlayUrls()).toHaveLength(85 * 3);
  });

  it('covers all three switchable layers at z0-3 only', () => {
    const urls = buildWorldOverlayUrls();
    const esri = urls.filter((u) => u.includes('arcgisonline.com'));
    const clouds = urls.filter((u) => u.includes('CorrectedReflectance_TrueColor'));
    const viirs = urls.filter((u) => u.includes('VIIRS_Black_Marble'));
    expect(esri).toHaveLength(85);
    expect(clouds).toHaveLength(85);
    expect(viirs).toHaveLength(85);
    // z0-3 only — the SW base-cache routes match /tile/[0-3]/ and Level\d/[0-3]/.
    expect(urls.some((u) => /\/MapServer\/tile\/[4-9]\//.test(u))).toBe(false);
  });

  it('emits the Esri {z}/{y}/{x} order and a real z3 tile', () => {
    // z3 tile (x=2,y=1): Esri path is /tile/{z}/{y}/{x} → /tile/3/1/2
    expect(buildWorldOverlayUrls()).toContain(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/1/2',
    );
  });
});

describe('precacheWorldBaseTiles', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetPrecacheInflightForTest();
    fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetPrecacheInflightForTest();
  });

  it('skips entirely when offline', () => {
    precacheWorldBaseTiles(() => false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fires carto base (85) + Esri/clouds/VIIRS overlays (255) = 340 when online', () => {
    precacheWorldBaseTiles(() => true);
    expect(fetchSpy).toHaveBeenCalledTimes(85 + 255);
  });

  it('dedupes against in-flight URLs from a prior call', async () => {
    let resolveAll: () => void = () => { /* noop */ };
    const block = new Promise<Response>((resolve) => {
      resolveAll = () => resolve(new Response('', { status: 200 }));
    });
    fetchSpy.mockImplementation(() => block);
    precacheWorldBaseTiles(() => true);
    const firstCount = fetchSpy.mock.calls.length;
    precacheWorldBaseTiles(() => true);  // before the first batch resolves
    expect(fetchSpy).toHaveBeenCalledTimes(firstCount);
    resolveAll();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('precacheTilesForTargets', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetPrecacheInflightForTest();
    fetchSpy = vi.fn().mockImplementation(
      () => Promise.resolve(new Response('', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetPrecacheInflightForTest();
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

  it('uses default CORS mode so SW sees real status codes', () => {
    // Opaque (no-cors) responses have status 0, which the Lane F SW
    // route's cacheableResponse:[0,200] would treat as cacheable for
    // ALL outcomes including 429/5xx. CORS gives us real statuses so
    // bad responses get filtered out instead of bricking the map.
    precacheTilesForTargets(
      [samplePass()],
      gibsTrueColorUrl('2026-05-10'),
      () => true,
    );
    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall?.[1]).toBeUndefined();
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
    // Spread coords across continents so the in-flight dedup doesn't
    // collapse adjacent targets onto the same low-zoom tile (e.g. two
    // targets 1° apart share a z6 tile — that's a real cache win, but
    // it'd mask the cap-at-N assertion this test is checking).
    const lats = [40, -30, 60, 0, 25, -45, 35, -10, 55, 15,
      -20, 50, 5, -40, 45, -25, 30, -50, 20, -5];
    const lons = [-100, 30, 120, -75, 60, -150, 0, 90, -60, 150,
      -120, 45, 80, -90, 15, -45, 100, -180, 75, -30];
    const passes = Array.from({ length: 20 }, (_, i) =>
      samplePass({ target_id: `p${i}`, target_lat: lats[i]!, target_lon: lons[i]! }));
    precacheTilesForTargets(passes, gibsTrueColorUrl('2026-05-10'), () => true);
    expect(fetchSpy).toHaveBeenCalledTimes(
      PRECACHE_TARGET_COUNT * PRECACHE_ZOOM_LEVELS.length * 2,
    );
  });

  it('dedupes in-flight URLs across overlapping calls', async () => {
    // Use a deferred promise so the first call's fetches stay in-flight
    // when the second call fires. Without dedup, the second call would
    // double-fire all 6 URLs.
    let resolveAll: () => void = () => { /* noop */ };
    const block = new Promise<Response>((resolve) => {
      resolveAll = () => resolve(new Response('', { status: 200 }));
    });
    fetchSpy.mockImplementation(() => block);

    const pass = samplePass({ target_lat: 28.6, target_lon: -80.6 });
    precacheTilesForTargets([pass], gibsTrueColorUrl('2026-05-10'), () => true);
    const firstCount = fetchSpy.mock.calls.length;
    // Second call before the first call's fetches resolve.
    precacheTilesForTargets([pass], gibsTrueColorUrl('2026-05-10'), () => true);
    expect(fetchSpy).toHaveBeenCalledTimes(firstCount);

    resolveAll();
    await Promise.resolve();
    await Promise.resolve();
  });
});
