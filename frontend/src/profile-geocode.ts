/** v3 — Component B (Anil 2026-05-26): Nominatim geocoding helper for
 *  the Profile-tab "Add target by name" mode. The operator types
 *  "San Diego," hits Search, picks a match → form autofills lat/lon.
 *  Solves the lat/lon-typed-into-name-field UX hazard (the "(0,0)"
 *  pin-in-the-Atlantic bug Anil hit on his first add).
 *
 *  No new external dependencies — native `fetch`, `AbortController`,
 *  `URLSearchParams`, and a plain JSON localStorage cache. Nominatim's
 *  ToS tolerates browser-direct fetches; we add Accept header + obey
 *  the 1-req-per-sec rate limit via UI-side debounce. Attribution is
 *  rendered as a required caption below results in profile-crud.ts.
 */

/** Normalized geocoding result shape. Stripped down from Nominatim's
 *  verbose response to just what the UI needs. */
export interface GeocodeResult {
  /** Full Nominatim display name — long; used for the result tile. */
  displayName: string;
  /** Best-effort short name (city / town / first comma-segment) — used
   *  as a default to autofill into the operator's name field. */
  shortName: string;
  /** Country from `address.country`, or empty string if absent. */
  country: string;
  lat: number;
  lon: number;
}

/** Discriminated result, mirrors profile-api.ts's ApiResult pattern. */
export type GeocodeApiResult =
  | { ok: true; data: GeocodeResult[] }
  | {
      ok: false;
      reason: 'network' | 'http' | 'timeout' | 'bad_json' | 'empty_query';
      status?: number;
      detail?: string;
    };

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
const REQUEST_TIMEOUT_MS = 3_000;

/** localStorage cache. Bounded LRU by recency; 24-hour TTL per entry. */
const CACHE_KEY = 'opd-geocode-cache-v1';
const CACHE_MAX_ENTRIES = 100;
const CACHE_TTL_MS = 24 * 3_600_000;

interface CacheEntry {
  /** ms since epoch. Expired entries are evicted on read. */
  storedAt: number;
  data: GeocodeResult[];
}

interface CacheShape {
  /** Insertion-ordered: oldest key first, newest last. We rely on the
   *  JS object iteration order being stable for string keys (true since
   *  ES2015). Eviction drops the first key when over capacity. */
  [normalizedQuery: string]: CacheEntry;
}

/** Geocode `query` against Nominatim. Cache-first; falls back to the
 *  network on miss. Returns a discriminated result so callers can
 *  branch once on the failure mode. Empty / whitespace-only queries
 *  short-circuit with `empty_query` (no network call).
 *
 *  Cache key is lowercased + trimmed `query` — typing "San Diego" then
 *  "san diego" hits the cache the second time. Operator never sees the
 *  network round-trip on a repeat search.
 */
export async function geocode(query: string): Promise<GeocodeApiResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty_query' };
  }
  const cacheKey = trimmed.toLowerCase();

  const cached = readCache(cacheKey);
  if (cached) {
    return { ok: true, data: cached };
  }

  const url = `${NOMINATIM_BASE}?${new URLSearchParams({
    q: trimmed,
    format: 'json',
    limit: '5',
    addressdetails: '1',
  }).toString()}`;

  const controller = new AbortController();
  const timeoutHandle = (typeof window !== 'undefined' ? window : globalThis)
    .setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    (typeof window !== 'undefined' ? window : globalThis).clearTimeout(timeoutHandle);
    // AbortError from the timeout looks like a TypeError/DOMException
    // depending on the runtime — discriminate by name.
    if (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message))) {
      return { ok: false, reason: 'timeout', detail: `>${REQUEST_TIMEOUT_MS}ms` };
    }
    return { ok: false, reason: 'network', detail: errMsg(e) };
  }
  (typeof window !== 'undefined' ? window : globalThis).clearTimeout(timeoutHandle);

  if (!resp.ok) {
    return {
      ok: false,
      reason: 'http',
      status: resp.status,
      detail: `http_${resp.status}`,
    };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (e) {
    return { ok: false, reason: 'bad_json', detail: errMsg(e) };
  }
  if (!Array.isArray(body)) {
    return { ok: false, reason: 'bad_json', detail: 'expected JSON array' };
  }

  const normalized = body
    .map(normalizeNominatimEntry)
    .filter((r): r is GeocodeResult => r !== null);

  writeCache(cacheKey, normalized);
  return { ok: true, data: normalized };
}

/** Normalize a single Nominatim response entry into our trimmed shape.
 *  Returns null if the entry doesn't have parseable lat/lon (we drop it
 *  rather than render a broken result tile). */
function normalizeNominatimEntry(raw: unknown): GeocodeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const displayName = typeof r.display_name === 'string' ? r.display_name : '';
  // address sub-object holds normalized city / country fields.
  const address = (r.address && typeof r.address === 'object')
    ? (r.address as Record<string, unknown>)
    : {};
  const country = typeof address.country === 'string' ? address.country : '';
  // shortName preference: city > town > village > hamlet > suburb >
  // first comma-segment of display_name. Used to autofill the operator's
  // name field so they don't end up with "San Diego, San Diego County,
  // California, USA" pre-loaded.
  let shortName = '';
  for (const key of ['city', 'town', 'village', 'hamlet', 'suburb', 'state']) {
    const v = address[key];
    if (typeof v === 'string' && v.length > 0) {
      shortName = v;
      break;
    }
  }
  if (shortName.length === 0) {
    shortName = displayName.split(',')[0]?.trim() ?? '';
  }
  return { displayName, shortName, country, lat, lon };
}

function readCache(key: string): GeocodeResult[] | null {
  const cache = loadCache();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    // Expired — evict and miss. Re-save so the eviction sticks.
    delete cache[key];
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      // Quota / private mode — non-fatal; we still return null.
    }
    return null;
  }
  return entry.data;
}

function writeCache(key: string, data: GeocodeResult[]): void {
  const cache = loadCache();
  // Bump-to-end semantics: delete + re-set so this key is the newest
  // in insertion order. The first key is the LRU eviction candidate.
  delete cache[key];
  cache[key] = { storedAt: Date.now(), data };
  const keys = Object.keys(cache);
  while (keys.length > CACHE_MAX_ENTRIES) {
    const oldest = keys.shift();
    if (oldest) delete cache[oldest];
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota / private mode — non-fatal; the result still returns to
    // the caller, we just won't have it on the next page load.
  }
}

function loadCache(): CacheShape {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CACHE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CacheShape;
    }
    return {};
  } catch {
    return {};
  }
}

/** Test-only: clear the localStorage cache between tests so a stub
 *  from one test doesn't leak into the next. Production code never
 *  calls this. */
export function _clearGeocodeCacheForTest(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // happy-dom always has localStorage; nothing to do.
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
