/** Multi-satellite tracking (v1.6.0.0 — Pettit feedback #6).
 *
 *  Curated hot-list + custom NORAD/name search. TLEs fetched from
 *  CelesTrak (free, CORS-enabled, no auth) and cached in localStorage
 *  with a 6h TTL. Pure-frontend: no generator/server changes.
 *
 *  Per /plan-eng-review 2026-05-22:
 *    A1: never block map render on CelesTrak; fetch lazily on selection
 *    A3: 3-line TLE parser (CelesTrak's FORMAT=TLE returns name + 2 data lines)
 *    A4: surface multi-match count to operator when name-search returns >1
 *    Q1: discriminated union for resolution (explicit > sentinel)
 */

/** TLE pair as the existing iss-sgp4.ts parser expects, plus the
 *  human-readable name from the optional 3-line "name" header. */
export interface TLEPair {
  line1: string;
  line2: string;
  /** Name from the 3LE header line. May differ from the operator's
   *  search query — useful for disambiguation in the picker. */
  name: string;
}

/** How a satellite's TLE is resolved. Discriminated union (Q1) — clearer
 *  at the call site than a sentinel `norad_id: 0`. */
export type SatelliteResolution =
  | { kind: 'catnr'; catnr: number }
  | { kind: 'name'; query: string };

export interface SatelliteMeta {
  /** Stable display name in the picker (e.g., "Tiangong (CSS)"). */
  name: string;
  /** Compact label for the topbar readout (≤3 chars). */
  short_label: string;
  /** Track polyline hex color. */
  track_color: string;
  /** Emoji shown in the picker. */
  icon: string;
  resolution: SatelliteResolution;
}

/** Curated hot-list. Order matters — picker renders in this order. */
export const CURATED_SATELLITES: SatelliteMeta[] = [
  {
    name: 'ISS (Zarya)',
    short_label: 'ISS',
    track_color: '#5cd0ff',
    icon: '🛰️',
    resolution: { kind: 'catnr', catnr: 25544 },
  },
  {
    name: 'Tiangong (CSS)',
    short_label: 'Tg',
    track_color: '#ff9e2c',
    icon: '🇨🇳',
    resolution: { kind: 'catnr', catnr: 48274 },
  },
  {
    name: 'Hubble (HST)',
    short_label: 'HST',
    track_color: '#b0ff5c',
    icon: '🔭',
    resolution: { kind: 'catnr', catnr: 20580 },
  },
  {
    name: 'X-37B',
    short_label: 'X37',
    track_color: '#ffd45c',
    icon: '🪐',
    // X-37B uses USA-XXX designations. Searching "USA" returns many
    // hits, but the most recent X-37B mission is usually at the top.
    resolution: { kind: 'name', query: 'USA' },
  },
  {
    name: 'Starship',
    short_label: 'SS',
    track_color: '#ff5c5c',
    icon: '🚀',
    resolution: { kind: 'name', query: 'STARSHIP' },
  },
];

/** Stable key for a SatelliteMeta — used as the cache key + the picker
 *  selection key. CATNR resolutions get the integer; name resolutions
 *  get "name:<query>". */
export function metaKey(meta: SatelliteMeta): string {
  return meta.resolution.kind === 'catnr'
    ? String(meta.resolution.catnr)
    : `name:${meta.resolution.query}`;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const FETCH_TIMEOUT_MS = 15_000;

interface CacheEntry {
  tle: TLEPair;
  /** How many satellites the CelesTrak NAME= response contained when
   *  this entry was cached. Surfaced in the UI when >1 (A4). */
  match_count?: number;
  fetchedAtMs: number;
}

function cacheKey(meta: SatelliteMeta): string {
  return `opd-tle-${metaKey(meta)}`;
}

function readCache(meta: SatelliteMeta): CacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(meta));
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(meta: SatelliteMeta, entry: CacheEntry): void {
  try {
    localStorage.setItem(cacheKey(meta), JSON.stringify(entry));
  } catch {
    /* quota exhausted or storage disabled — silently fall back to in-memory */
  }
}

/** Parse a CelesTrak FORMAT=TLE response. Supports both 2-line (just
 *  data lines) and 3-line (name header + 2 data lines) shapes.
 *
 *  When the response contains MULTIPLE satellites (NAME= search with
 *  N matches), returns the FIRST satellite plus a `match_count` so the
 *  caller can surface "1 of N matches" in the picker.
 *
 *  Returns null on parse failure. */
export function parseCelestrakTLE(text: string): { tle: TLEPair; match_count: number } | null {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length < 2) return null;
  // Count how many `1 ` lines appear — that's how many satellites are in the response.
  let match_count = 0;
  for (const ln of lines) if (ln.startsWith('1 ')) match_count++;
  if (match_count === 0) return null;
  // Find the first `1 ` line; the preceding line (if any and not starting
  // with `1 ` or `2 `) is the name; the following line should start with `2 `.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('1 ')) continue;
    const line1 = lines[i]!;
    const line2 = lines[i + 1];
    if (!line2 || !line2.startsWith('2 ')) continue;
    let name = 'UNKNOWN';
    if (i > 0 && !lines[i - 1]!.startsWith('1 ') && !lines[i - 1]!.startsWith('2 ')) {
      name = lines[i - 1]!;
    }
    return {
      tle: { line1, line2, name },
      match_count,
    };
  }
  return null;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve TLE for a curated SatelliteMeta. Uses localStorage cache
 *  (6h TTL) — returns cached entry if fresh, else fetches from
 *  CelesTrak. On network/parse failure with no cache, returns null.
 *  On network failure WITH cache (even stale), returns the stale entry
 *  so the operator's last-known orbit still renders.
 *
 *  Returned object includes `match_count` so the picker UI can surface
 *  ambiguity when a name-search returned multiple satellites (A4). */
export async function fetchSatelliteTLE(
  meta: SatelliteMeta,
): Promise<{ tle: TLEPair; match_count: number; stale: boolean } | null> {
  const now = Date.now();
  const cached = readCache(meta);
  // Fresh cache hit.
  if (cached && (now - cached.fetchedAtMs) < CACHE_TTL_MS) {
    return {
      tle: cached.tle,
      match_count: cached.match_count ?? 1,
      stale: false,
    };
  }

  // Cache miss or expired — try CelesTrak.
  const url = meta.resolution.kind === 'catnr'
    ? `${CELESTRAK_BASE}?CATNR=${meta.resolution.catnr}&FORMAT=TLE`
    : `${CELESTRAK_BASE}?NAME=${encodeURIComponent(meta.resolution.query)}&FORMAT=TLE`;

  let resp: Response;
  try {
    resp = await fetchWithTimeout(url);
  } catch {
    // Network error — fall back to stale cache if any.
    if (cached) return { tle: cached.tle, match_count: cached.match_count ?? 1, stale: true };
    return null;
  }
  if (!resp.ok) {
    if (cached) return { tle: cached.tle, match_count: cached.match_count ?? 1, stale: true };
    return null;
  }
  let body: string;
  try {
    body = await resp.text();
  } catch {
    if (cached) return { tle: cached.tle, match_count: cached.match_count ?? 1, stale: true };
    return null;
  }
  const parsed = parseCelestrakTLE(body);
  if (!parsed) {
    // CelesTrak responded but parse failed (corrupt body, no results).
    // For name searches that return zero results, the body may be empty
    // or contain only an HTML error page. Fall back to stale cache.
    if (cached) return { tle: cached.tle, match_count: cached.match_count ?? 1, stale: true };
    return null;
  }
  const entry: CacheEntry = {
    tle: parsed.tle,
    match_count: parsed.match_count,
    fetchedAtMs: now,
  };
  writeCache(meta, entry);
  return { tle: parsed.tle, match_count: parsed.match_count, stale: false };
}

/** Resolve a custom NORAD CATNR (operator-entered). Returns null on
 *  invalid input or network failure. */
export async function fetchTLEByCATNR(
  catnr: number,
): Promise<{ tle: TLEPair; match_count: number } | null> {
  if (!Number.isFinite(catnr) || catnr <= 0) return null;
  const meta: SatelliteMeta = {
    name: `NORAD ${catnr}`,
    short_label: `#${catnr}`,
    track_color: '#888',
    icon: '🛰',
    resolution: { kind: 'catnr', catnr },
  };
  const result = await fetchSatelliteTLE(meta);
  if (!result) return null;
  return { tle: result.tle, match_count: result.match_count };
}

/** Resolve a custom name fragment (operator-entered). Returns null on
 *  no results / network failure. */
export async function fetchTLEByName(
  name: string,
): Promise<{ tle: TLEPair; match_count: number } | null> {
  const q = name.trim();
  if (!q) return null;
  const meta: SatelliteMeta = {
    name: `Search: ${q}`,
    short_label: q.slice(0, 3),
    track_color: '#888',
    icon: '🔍',
    resolution: { kind: 'name', query: q },
  };
  const result = await fetchSatelliteTLE(meta);
  if (!result) return null;
  return { tle: result.tle, match_count: result.match_count };
}

/** Test-only helper — clear all cached TLEs from localStorage. */
export function _clearTLECacheForTests(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('opd-tle-')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* noop */
  }
}
