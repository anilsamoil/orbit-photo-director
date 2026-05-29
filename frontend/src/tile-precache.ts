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

/** VIIRS Black Marble annual night-lights composite (v2 — Chris feedback
 *  2026-05-27). GIBS layer ID `VIIRS_Black_Marble` is published as an annual
 *  composite — date convention is YYYY-01-01 for the year's image.
 *
 *  Tile format: 8-bit RGB PNG, NO alpha channel. Non-illuminated areas
 *  render as opaque dark navy (~rgb 4,5,15), NOT transparent. Verified via
 *  curl + Pillow 2026-05-27. This matters: any layer above the basemap that
 *  uses this raster at high opacity will darken the entire scene, not just
 *  paint lights. The opacity of `viirs-night-lights-layer` in map.ts is
 *  sized accordingly (currently 0.55 — low enough that the dark background
 *  reads as a dim wash and the basemap/clouds show through).
 *
 *  If you ever need true alpha (lights opaque, dark areas transparent), use
 *  a `maplibregl.addProtocol` tile transformer to luminance-key each PNG.
 *  Don't change the opacity assuming the PNG is transparent.
 *
 *  Max zoom for this layer per GIBS catalog: GoogleMapsCompatible_Level8
 *  (i.e., z8). MapLibre overzooms above that.
 *
 *  yearIso = "YYYY-01-01"; the caller picks current year and walks back if
 *  the annual product hasn't published yet. */
export function gibsBlackMarbleUrl(yearIso: string): string {
  const layer = 'VIIRS_Black_Marble';
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${yearIso}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`;
}

/** Maxzoom for the VIIRS Black Marble annual composite (GIBS).
 *  Source caps at Level8; MapLibre overzooms above this with no extra fetch. */
export const VIIRS_BLACK_MARBLE_MAX_ZOOM = 8;

/** Number of top Queue targets to pre-cache. Higher = more coverage but
 *  more LRU eviction of user-pan tiles. 3 = the imminent passes that are
 *  visible on a single Queue screen. */
export const PRECACHE_TARGET_COUNT = 3;

/** Zoom levels to pre-cache. Picked to cover continent → region → metro
 *  in a single shot. Carto serves up to z20 so all three are real tiles;
 *  GIBS caps at z9 so z10 GIBS will overzoom from z9 (still cached). */
export const PRECACHE_ZOOM_LEVELS = [6, 8, 10];

/** Carto subdomain rotation must MATCH MapLibre's deterministic subdomain
 *  pick or the precache is wasted: the SW Cache API keys by full URL
 *  including hostname, so a tile pre-cached as `a.basemaps...` is a cache
 *  MISS when MapLibre asks for `b.basemaps...` for the same (x, y).
 *  MapLibre's source impl picks subdomain via `(x + y) % subdomains.length`
 *  — we compute the same subdomain when building precache URLs.
 *  Reviewed 2026-05-11; CARTO_SUBDOMAINS must stay in sync with the
 *  tiles[] array in map.ts buildStyle(). */
const CARTO_SUBDOMAINS = ['a', 'b', 'c', 'd'] as const;
function cartoTileUrl(z: number, x: number, y: number): string {
  const sub = CARTO_SUBDOMAINS[(x + y) % CARTO_SUBDOMAINS.length];
  return `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}@2x.png`;
}

/** GIBS maxzoom matches the source's `maxzoom` in map.ts buildStyle().
 *  Exported so map.ts (and any future consumer) can reference the same
 *  value rather than hardcoding 9 in two places. */
export const GIBS_MAX_ZOOM = 9;

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
 *  which also performs the fetches. Targets with non-finite coords are
 *  skipped (defensive guard against future schema drift / bad LL2 data;
 *  produces 'NaN' URLs that bypass the SW cache write but still consume
 *  fetch slots). */
export function buildPrecacheUrls(passes: PassEntry[], gibsTileUrlPattern: string): string[] {
  const urls: string[] = [];
  const top = passes.slice(0, PRECACHE_TARGET_COUNT);
  for (const p of top) {
    if (!Number.isFinite(p.target_lat) || !Number.isFinite(p.target_lon)) continue;
    for (const z of PRECACHE_ZOOM_LEVELS) {
      const { x, y } = lonLatToTile(p.target_lon, p.target_lat, z);
      urls.push(cartoTileUrl(z, x, y));
      // GIBS tiles at z>maxzoom overzoom from the maxzoom tile (we set
      // the same maxzoom in map.ts). Pre-caching the source-zoom tile
      // means the overzoom path during LOS finds it cached.
      const gibsZ = Math.min(z, GIBS_MAX_ZOOM);
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
 *  unreachable; the SW would 404 anyway). The fetch() promises swallow
 *  individual failures — the natural pan path will retry on demand.
 *
 *  In-flight dedup: simultaneous refresh ticks (visibility-resume + the
 *  poll interval can stack) would otherwise issue duplicate fetches for
 *  the same URL. PRECACHE_INFLIGHT tracks active URLs and skips repeats.
 *
 *  Default mode (`cors`, not `no-cors`): both cartocdn and gibs.earthdata
 *  serve `Access-Control-Allow-Origin: *`. With CORS the SW sees real
 *  status codes (not opaque 0), so cacheableResponse:[200] correctly
 *  filters out 404/429/5xx — opaque responses would have status 0 for
 *  ALL outcomes and a 429 from carto would get cached as a "valid" tile
 *  for 7 days, bricking the map.
 *
 *  Body cancellation: opaque/cors response bodies aren't read here, so
 *  without explicit `.body.cancel()` the buffer is held until GC. With
 *  18 tiles × 25 KB per refresh that's ~450 KB held for no benefit. */
const PRECACHE_INFLIGHT = new Set<string>();

export function precacheTilesForTargets(
  passes: PassEntry[],
  gibsTileUrlPattern: string,
  isOnlineFn: () => boolean = () => navigator.onLine,
): void {
  if (!isOnlineFn()) return;
  if (passes.length === 0) return;
  const urls = buildPrecacheUrls(passes, gibsTileUrlPattern);
  for (const url of urls) {
    if (PRECACHE_INFLIGHT.has(url)) continue;
    PRECACHE_INFLIGHT.add(url);
    fetch(url)
      .then((r) => {
        // Cancel the body stream so the buffer is freed immediately
        // instead of waiting on GC. We never read the body — the SW has
        // already had its chance to intercept and cache.
        r.body?.cancel?.().catch(() => { /* noop */ });
      })
      .catch(() => {
        // Swallow individual fetch failures; the natural pan path will
        // retry on demand. Logging would spam the console during LOS.
      })
      .finally(() => {
        PRECACHE_INFLIGHT.delete(url);
      });
  }
}

/** Test-only: clear in-flight tracking between vitest runs. */
export function _resetPrecacheInflightForTest(): void {
  PRECACHE_INFLIGHT.clear();
}
