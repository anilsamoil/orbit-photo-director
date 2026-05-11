/** Tile pre-caching for upcoming Queue targets (V4-P2 from Chris's
 *  2026-05-05 feedback: "the map doesn't work when you are LOS but you
 *  still get the upcoming targets").
 *
 *  Strategy: when online, after each successful refresh, fire-and-forget
 *  fetch the basemap + cloud tiles for the top-N Queue targets at a few
 *  fixed zoom levels. The SW's existing CacheFirst rules for cartocdn +
 *  gibs.earthdata write the responses to its tile caches automatically.
 *  Next time the operator opens the Map tab during LOS over one of those
 *  targets, the wider-context tiles (z6/z8/z10) are already there.
 *
 *  Budget reasoning:
 *    - Lane F caps tile caches at 100 carto / 200 gibs entries (LRU).
 *    - Pre-caching too aggressively evicts tiles the user actually panned
 *      to. We deliberately fetch ONE tile per (zoom, target, source) — not
 *      a 3×3 grid — to leave room for natural-pan tiles in the LRU.
 *    - Top-3 targets × 3 zoom levels × 2 sources = 18 tile fetches per
 *      refresh. With manifest published hourly, that's 18 fetches/h ÷ ISS
 *      mission ~5800h = ~100K total fetches. Comfortably below the carto
 *      free-tier rate limit.
 *    - z6 = continent / country scale (~150 km/tile mid-lat)
 *    - z8 = regional scale (~40 km/tile)
 *    - z10 = metro scale (~10 km/tile)
 *      These cover the operator's "where is this on the planet" → "what
 *      city / region" → "specific terrain features" zoom progression.
 */

import type { PassEntry } from './types';

/** GIBS true-color tile URL pattern. {date} is replaced per render.
 *  Lives here (not map.ts) so main.ts can call it without dragging in
 *  the heavy MapLibre import. map.ts re-imports from here. */
export function gibsTrueColorUrl(dateIso: string): string {
  const layer = 'VIIRS_NOAA21_CorrectedReflectance_TrueColor';
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${dateIso}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
}

/** Yesterday's date in YYYY-MM-DD; today's GIBS product may not be
 *  published yet. Same lazy-load consideration as gibsTrueColorUrl. */
export function yesterdayIso(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Number of top Queue targets to pre-cache. Higher = more coverage but
 *  more LRU eviction of user-pan tiles. 3 = the imminent passes that are
 *  visible on a single Queue screen. */
export const PRECACHE_TARGET_COUNT = 3;

/** Zoom levels to pre-cache. Picked to cover continent → region → metro
 *  in a single shot. Carto serves up to z20 so all three are real tiles;
 *  GIBS caps at z9 so z10 GIBS will overzoom from z9 (still cached). */
export const PRECACHE_ZOOM_LEVELS = [6, 8, 10];

/** Carto subdomain rotation matches the rotation in map.ts (tiles[]).
 *  The browser will use whichever subdomain happens; pre-caching to ANY
 *  of them populates the same SW cache (the cache is keyed by URL
 *  including subdomain — but we just pick one for pre-caching, and the
 *  user's natural panning may hit a different subdomain. That's a known
 *  small inefficiency; the alternative is to pre-fetch all 4 subdomains
 *  per tile, which 4xs the request budget for marginal benefit). */
const CARTO_TILE_URL = 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png';

/** Convert (lon, lat) to (x, y) tile coordinates at zoom `z` using the
 *  Web Mercator (EPSG:3857) projection. Standard slippy-map formula —
 *  same one MapLibre uses internally to choose which tile URL to fetch
 *  for a given screen pixel. Pure function so it's trivially testable. */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  // Clamp to valid tile range — MapLibre clamps internally but we may be
  // called with edge-case coords (poles, antimeridian) where the math
  // produces n or -1.
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

/** Substitute {z}/{x}/{y} into a tile URL pattern. Same templating
 *  MapLibre uses internally; kept stand-alone here so we don't pull in
 *  the heavy MapLibre import for what's a 3-replace operation. */
export function fillTileUrl(pattern: string, z: number, x: number, y: number): string {
  return pattern
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/** Build the full set of tile URLs to pre-cache for the given passes.
 *  Exposed for testing — production code uses `precacheTilesForTargets`
 *  which also performs the fetches. */
export function buildPrecacheUrls(passes: PassEntry[], gibsTileUrlPattern: string): string[] {
  const urls: string[] = [];
  const top = passes.slice(0, PRECACHE_TARGET_COUNT);
  for (const p of top) {
    for (const z of PRECACHE_ZOOM_LEVELS) {
      const { x, y } = lonLatToTile(p.target_lon, p.target_lat, z);
      urls.push(fillTileUrl(CARTO_TILE_URL, z, x, y));
      // GIBS tiles at z>9 overzoom from z9 (we set maxzoom=9 in map.ts).
      // Pre-caching the source-zoom tile means the overzoom path during
      // LOS finds it cached. So clamp gibs zoom to 9 max.
      const gibsZ = Math.min(z, 9);
      const gibsTile = lonLatToTile(p.target_lon, p.target_lat, gibsZ);
      urls.push(fillTileUrl(gibsTileUrlPattern, gibsZ, gibsTile.x, gibsTile.y));
    }
  }
  return urls;
}

/** Fire-and-forget pre-cache. Returns immediately; the fetches resolve in
 *  the background. The SW's CacheFirst rules for cartocdn + gibs write
 *  the responses to the tile caches automatically.
 *
 *  Skipped entirely when offline (no point hitting the network when it's
 *  unreachable; the SW would 404 anyway). The fetch() promises are
 *  swallowed — we don't care about individual failures because the
 *  natural pan path will retry on demand. */
export function precacheTilesForTargets(
  passes: PassEntry[],
  gibsTileUrlPattern: string,
  isOnlineFn: () => boolean = () => navigator.onLine,
): void {
  if (!isOnlineFn()) return;
  if (passes.length === 0) return;
  const urls = buildPrecacheUrls(passes, gibsTileUrlPattern);
  for (const url of urls) {
    // mode: 'no-cors' lets the SW intercept + cache cross-origin tiles
    // even when CORS isn't configured upstream. Same posture MapLibre
    // uses for these raster sources. We don't need the response body —
    // just the side effect of the SW caching it.
    fetch(url, { mode: 'no-cors' }).catch(() => {
      // Swallow individual fetch failures; the natural pan path will
      // retry on demand. Logging would spam the console during LOS.
    });
  }
}
