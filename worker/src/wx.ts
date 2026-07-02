/**
 * Nearest-station weather proxy — METAR (current) + TAF (forecast) for the
 * CEO zoom panel. Answers Jack's "is the sky actually clear over this city
 * right now, and is it about to change?" with airport ground-truth that
 * complements the satellite/IR cloud picture (a station looks UP and measures
 * the ceiling directly, catching low stratus/fog the satellite misses).
 *
 * Design-review-folded requirements (cloud-confidence loop, 2026-06-21):
 *  - METAR is the decisive read; TAF is supporting trend, rendered in plain
 *    language. TEMPO/PROB/BECMG groups are QUALIFIED ("temporarily", "30%
 *    chance", "gradually by") — never stated as definite future fact (R4).
 *  - Honest-quiet over ocean/remote: no cover figure for a station >150km;
 *    nothing at all when the box is empty. METAR is a point obs — a station
 *    140km away has little bearing on the target's sky (R6).
 *  - Antimeridian-safe nearest-station (split the bbox across ±180) (R5).
 *  - METAR + TAF fetched CONCURRENTLY, each with a hard timeout; a single
 *    upstream failure still yields 200 with the other product (R2).
 *  - Edge cache keyed on rounded lat/lon; R2 last-good per rounded coord so a
 *    flaky aviationweather.gov degrades to a flagged stale read, not a 502.
 *
 * Upstream: NOAA Aviation Weather Center Data API (free, no auth).
 *   METAR https://aviationweather.gov/api/data/metar?bbox=la0,lo0,la1,lo1&format=json
 *   TAF   https://aviationweather.gov/api/data/taf?bbox=la0,lo0,la1,lo1&format=json
 */

const METAR_URL = 'https://aviationweather.gov/api/data/metar';
const TAF_URL = 'https://aviationweather.gov/api/data/taf';

/** Half-width of the station search box (deg). ~275km at the equator — wide
 *  enough to find a nearby station (and a "distant" one for honest dim text)
 *  without dragging back hundreds of stations over dense land. */
const SEARCH_HALF_DEG = 2.5;
/** Beyond this, a station's sky says little about the target — show only its
 *  name+distance, never a cover figure (R6). */
const DISTANT_KM = 150;
/** Edge-cache + upstream TTL. METAR updates ~hourly (SPECI on change); 300s
 *  keeps it fresh without hammering AWC across many card opens. */
const EDGE_CACHE_TTL_SECONDS = 300;
/** Per-call upstream timeout. AWC is frequently slow; a hung subrequest must
 *  not hold the Worker (the card-side fetch has its own 2.5s abort too). */
const UPSTREAM_TIMEOUT_MS = 4000;
/** Serve R2 last-good at most this old, flagged degraded with true age. */
const LAST_GOOD_MAX_AGE_MIN = 6 * 60;

export interface WxCloudLayer {
  cover: string; // FEW | SCT | BKN | OVC | OVX | CLR | SKC
  base_ft: number | null;
}

export interface WxMetar {
  station: string;
  name: string;
  distance_km: number;
  distant: boolean; // >150km — caller must NOT show a cover figure
  age_min: number; // SOURCE age of the observation, not cache age
  flt_cat: string | null; // VFR | MVFR | IFR | LIFR
  summary: string; // human ceiling phrase, e.g. "broken 1,700 ft"
  clouds: WxCloudLayer[];
}

export interface WxTaf {
  station: string;
  name: string;
  distance_km: number;
  distant: boolean;
  issued_age_min: number;
  lines: string[]; // 1-2 plain-language lines; TEMPO/PROB/BECMG qualified
}

export interface WxResponse {
  metar: WxMetar | null;
  taf: WxTaf | null;
  stations_found: number; // METAR stations in the search box; 0 ⇒ render nothing
  degraded?: boolean;
}

interface AwcStation {
  icaoId?: unknown;
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
}
interface AwcMetar extends AwcStation {
  obsTime?: unknown;
  fltCat?: unknown;
  clouds?: unknown;
  visib?: unknown; // statute miles (number, or "10+", "1 1/2")
}
interface AwcTafFcst {
  timeFrom?: unknown;
  timeTo?: unknown;
  timeBec?: unknown;
  fcstChange?: unknown;
  probability?: unknown;
  clouds?: unknown;
  wxString?: unknown;
}
interface AwcTaf extends AwcStation {
  issueTime?: unknown;
  fcsts?: unknown;
}

const COVER_WORD: Record<string, string> = {
  FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast',
  OVX: 'obscured', CLR: 'clear', SKC: 'clear', CAVOK: 'clear', NSC: 'clear',
};
const COVER_RANK: Record<string, number> = { FEW: 1, SCT: 2, BKN: 3, OVC: 4, OVX: 5 };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  // Shortest longitude delta, antimeridian-aware.
  let dLon = Math.abs(lon2 - lon1) % 360;
  if (dLon > 180) dLon = 360 - dLon;
  dLon = toRad(dLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Parse the AWC clouds array into structured layers (skip junk). */
function parseClouds(raw: unknown): WxCloudLayer[] {
  if (!Array.isArray(raw)) return [];
  const out: WxCloudLayer[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const cover = String((c as { cover?: unknown }).cover ?? '').toUpperCase();
    if (!cover) continue;
    out.push({ cover, base_ft: num((c as { base?: unknown }).base) });
  }
  return out;
}

/** Lowest ceiling (BKN/OVC) base, or null if none — that's what blocks a shot. */
function ceilingFt(clouds: WxCloudLayer[]): number | null {
  let lowest: number | null = null;
  for (const c of clouds) {
    if ((c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'OVX') && c.base_ft != null) {
      if (lowest == null || c.base_ft < lowest) lowest = c.base_ft;
    }
  }
  return lowest;
}

function fmtFt(ft: number | null): string {
  return ft == null ? '' : `${Math.round(ft).toLocaleString('en-US')} ft`;
}

/** Short human cloud phrase from a layer set. "clear" / "broken 1,700 ft". */
function cloudPhrase(clouds: WxCloudLayer[]): string {
  if (clouds.length === 0) return 'clear';
  // Most significant layer (highest cover rank); ties → lowest base.
  let best: WxCloudLayer | null = null;
  for (const c of clouds) {
    const r = COVER_RANK[c.cover] ?? 0;
    if (r === 0) continue; // CLR/SKC/etc contribute nothing
    if (
      !best ||
      r > (COVER_RANK[best.cover] ?? 0) ||
      (r === (COVER_RANK[best.cover] ?? 0) && (c.base_ft ?? 1e9) < (best.base_ft ?? 1e9))
    ) {
      best = c;
    }
  }
  if (!best) return 'clear';
  const word = COVER_WORD[best.cover] ?? best.cover.toLowerCase();
  const ft = fmtFt(best.base_ft);
  return ft ? `${word} ${ft}` : word;
}

/** Zulu HHMMZ from epoch seconds, e.g. 1830 → "18:30Z". */
function zulu(epochSec: number | null): string {
  if (epochSec == null) return '';
  const d = new Date(epochSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}

/**
 * Plain-language TAF: line 1 = "Now"; line 2 = the FIRST significant future
 * change, QUALIFIED by group type so a 30%-chance or temporary condition is
 * never stated as a definite future fact (R4). Returns [] when no fcsts.
 */
export function tafToPlainLanguage(fcstsRaw: unknown, nowMs: number): string[] {
  if (!Array.isArray(fcstsRaw) || fcstsRaw.length === 0) return [];
  const fcsts = fcstsRaw as AwcTafFcst[];
  const nowSec = nowMs / 1000;

  // "Prevailing" groups (base + FM) form the exclusive timeline; TEMPO/BECMG/
  // PROB overlay it. The condition active NOW is the latest prevailing group
  // whose period has started — NOT array index 0 (a later FM may already be in
  // effect), so an astronaut deciding to shoot now isn't shown a stale base.
  const isPrevailing = (f: AwcTafFcst): boolean => {
    const c = String(f.fcstChange ?? '').toUpperCase();
    return c === '' || c === 'FM';
  };
  let current: AwcTafFcst = fcsts[0]!;
  for (const f of fcsts) {
    if (!isPrevailing(f)) continue;
    const tf = num(f.timeFrom);
    const tt = num(f.timeTo);
    // The period that CONTAINS now: started, and not yet expired.
    if ((tf == null || tf <= nowSec) && (tt == null || tt > nowSec)) current = f;
  }
  const currentPhrase = cloudPhrase(parseClouds(current.clouds));
  const lines: string[] = [`Now: ${currentPhrase}`];

  // Next significant change = earliest group that STARTS in the future.
  let next: AwcTafFcst | null = null;
  let nextFrom = Infinity;
  for (const f of fcsts) {
    const tf = num(f.timeFrom);
    if (tf == null || tf <= nowSec) continue;
    if (tf < nextFrom) { nextFrom = tf; next = f; }
  }
  if (next) {
    const phrase = cloudPhrase(parseClouds(next.clouds));
    const change = String(next.fcstChange ?? '').toUpperCase();
    const probMatch = /PROB(\d{2})/.exec(change);
    const prob = num(next.probability) ?? (probMatch ? Number(probMatch[1]) : null);
    const t = zulu(num(next.timeFrom));
    let line: string;
    if (prob != null && prob > 0) {
      line = `${prob}% chance ${phrase} around ${t}`;
    } else if (change === 'TEMPO') {
      line = `Temporarily ${phrase} (${t})`;
    } else if (change === 'BECMG') {
      line = `Gradually ${phrase} by ${zulu(num(next.timeBec) ?? num(next.timeTo))}`;
    } else if (change === 'FM') {
      line = `From ${t}: ${phrase}`; // FM is the ONLY hard, definite transition
    } else {
      // Unknown / missing group type — never assert it as fact; qualify.
      line = `Around ${t}: ${phrase}`;
    }
    // Show it if it changes the picture, or is a temporary/probabilistic risk.
    if (phrase !== currentPhrase || prob != null || change === 'TEMPO') lines.push(line);
  }
  return lines;
}

/** Nearest station to (lat,lon) by haversine; null if the array is empty. */
function nearest<T extends AwcStation>(
  stations: T[],
  lat: number,
  lon: number,
): { s: T; km: number } | null {
  let best: { s: T; km: number } | null = null;
  for (const s of stations) {
    const slat = num(s.lat);
    const slon = num(s.lon);
    if (slat == null || slon == null) continue;
    const km = haversineKm(lat, lon, slat, slon);
    if (!best || km < best.km) best = { s, km };
  }
  return best;
}

/** AWC bbox(es) for the station search area. The longitude half-span is
 *  latitude-corrected (1/cos lat) so a high-latitude target doesn't miss
 *  stations just east/west where lon-degrees collapse to a few km; split
 *  across the antimeridian, and a whole-longitude band at extreme latitudes. */
export function buildBboxes(lat: number, lon: number): string[] {
  const minLat = Math.max(-90, lat - SEARCH_HALF_DEG);
  const maxLat = Math.min(90, lat + SEARCH_HALF_DEG);
  const fmt = (a: number, b: number, c: number, d: number) =>
    `${a.toFixed(2)},${b.toFixed(2)},${c.toFixed(2)},${d.toFixed(2)}`;
  const lonHalf = Math.min(180, SEARCH_HALF_DEG / Math.max(Math.cos((lat * Math.PI) / 180), 0.05));
  if (lonHalf >= 180) return [fmt(minLat, -180, maxLat, 180)]; // extreme lat → all longitudes
  const lo = lon - lonHalf;
  const hi = lon + lonHalf;
  if (lo < -180) return [fmt(minLat, lo + 360, maxLat, 180), fmt(minLat, -180, maxLat, hi)];
  if (hi > 180) return [fmt(minLat, lo, maxLat, 180), fmt(minLat, -180, maxLat, hi - 360)];
  return [fmt(minLat, lo, maxLat, hi)];
}

async function fetchJson(
  base: string,
  bboxes: string[],
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (const bbox of bboxes) {
    const url = `${base}?bbox=${encodeURIComponent(bbox)}&format=json`;
    const resp = await fetchImpl(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheTtl: EDGE_CACHE_TTL_SECONDS, cacheTtlByStatus: { '200-299': EDGE_CACHE_TTL_SECONDS, '400-599': 30 } },
    } as RequestInit);
    if (!resp.ok) throw new Error(`${base} status ${resp.status}`);
    const body = await resp.json();
    if (Array.isArray(body)) all.push(...body);
  }
  return all;
}

/** Statute-mile visibility from the AWC field (number, or "10+", "1 1/2"). */
function parseVisib(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /(\d+(?:\.\d+)?)/.exec(v);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/** Current-conditions phrase. Clouds drive it, but "clear" is WITHHELD when
 *  visibility is low — fog/haze/smoke have no ceiling yet still block a shot,
 *  and an astronaut must never read fog as clear (Codex review #5). */
function metarSummary(clouds: WxCloudLayer[], fltCat: string | null, visib: unknown): string {
  const phrase = cloudPhrase(clouds);
  if (phrase !== 'clear') return phrase;
  const vis = parseVisib(visib);
  if (vis != null && vis < 3) return `low visibility (${vis} sm)`;
  if (fltCat === 'IFR' || fltCat === 'LIFR') return 'low visibility';
  return 'clear';
}

function buildMetar(stations: unknown[], lat: number, lon: number, nowMs: number): WxMetar | null {
  const list = stations.filter((s): s is AwcMetar => !!s && typeof s === 'object');
  const near = nearest(list, lat, lon);
  if (!near) return null;
  const s = near.s;
  const clouds = parseClouds(s.clouds);
  const obs = num(s.obsTime);
  const distant = near.km > DISTANT_KM;
  const fltCat = typeof s.fltCat === 'string' ? s.fltCat : null;
  return {
    station: String(s.icaoId ?? '—'),
    name: String(s.name ?? s.icaoId ?? ''),
    distance_km: Math.round(near.km),
    distant,
    age_min: obs != null ? Math.max(0, Math.floor((nowMs - obs * 1000) / 60_000)) : -1,
    flt_cat: fltCat,
    summary: distant ? '' : metarSummary(clouds, fltCat, s.visib), // honest-quiet beyond 150km
    clouds: distant ? [] : clouds,
  };
}

function buildTaf(stations: unknown[], lat: number, lon: number, nowMs: number): WxTaf | null {
  const list = stations.filter((s): s is AwcTaf => !!s && typeof s === 'object');
  const near = nearest(list, lat, lon);
  if (!near) return null;
  const s = near.s;
  const distant = near.km > DISTANT_KM;
  const issued = num(s.issueTime);
  return {
    station: String(s.icaoId ?? '—'),
    name: String(s.name ?? s.icaoId ?? ''),
    distance_km: Math.round(near.km),
    distant,
    issued_age_min: issued != null ? Math.max(0, Math.floor((nowMs - issued * 1000) / 60_000)) : -1,
    lines: distant ? [] : tafToPlainLanguage(s.fcsts, nowMs), // quiet beyond 150km
  };
}

interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

function corsHeaders(): Record<string, string> {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' };
}

/**
 * GET /api/wx?lat=&lon= — nearest-station METAR + TAF.
 * Flow: edge cache → concurrent METAR+TAF fetch (each timed out; partial
 * failure still 200) → persist R2 last-good + edge-cache → on TOTAL failure,
 * R2 last-good ≤6h flagged degraded → 502.
 */
export async function handleWxRequest(
  request: Request,
  env: { CALIB?: R2Like },
  ctx: ExecutionContext,
  fetchImpl: typeof fetch = fetch,
  cacheImpl?: Cache,
  nowMs: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return new Response(JSON.stringify({ error: 'bad_coords' }), {
      status: 400,
      headers: { 'content-type': 'application/json', ...corsHeaders() },
    });
  }

  // Per-target EXACT key — two distinct targets in the same coarse cell must
  // not share a cached distance/cover figure near the 150km gate (Codex #4).
  const klat = lat.toFixed(4);
  const klon = lon.toFixed(4);
  const cache = cacheImpl ?? (typeof caches !== 'undefined' ? caches.default : undefined);
  const cacheKey = new Request(`https://wx-cache-key/v1?lat=${klat}&lon=${klon}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const bboxes = buildBboxes(lat, lon);
  // Concurrent; a single product's failure must not sink the other (R2).
  const [metarRes, tafRes] = await Promise.allSettled([
    fetchJson(METAR_URL, bboxes, fetchImpl),
    fetchJson(TAF_URL, bboxes, fetchImpl),
  ]);

  const metarOk = metarRes.status === 'fulfilled';
  const tafOk = tafRes.status === 'fulfilled';

  if (metarOk || tafOk) {
    const metarStations = metarOk ? (metarRes as PromiseFulfilledResult<unknown[]>).value : [];
    const tafStations = tafOk ? (tafRes as PromiseFulfilledResult<unknown[]>).value : [];
    const payload: WxResponse = {
      metar: metarOk ? buildMetar(metarStations, lat, lon, nowMs) : null,
      taf: tafOk ? buildTaf(tafStations, lat, lon, nowMs) : null,
      // Any station (METAR OR TAF): 0 only when the box is truly empty, so a
      // TAF-only response over land isn't mislabeled "no stations" (Codex #3).
      stations_found: Math.max(metarStations.length, tafStations.length),
    };
    const body = JSON.stringify(payload);
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${EDGE_CACHE_TTL_SECONDS}`, ...corsHeaders() },
    });
    // Only cache/persist a FULLY-successful read; a partial stays uncached so
    // the missing product recovers on the next call.
    if (metarOk && tafOk) {
      if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch((e) => console.warn('[wx] edge put failed:', (e as Error)?.message ?? e)));
      if (env.CALIB) ctx.waitUntil(Promise.resolve(env.CALIB.put(`wx/${klat}_${klon}.json`, JSON.stringify({ ...payload, _t: nowMs }))).catch((e) => console.warn('[wx] R2 put failed:', (e as Error)?.message ?? e)));
    }
    return response;
  }

  // Both upstreams down: serve R2 last-good ≤6h, flagged + uncached.
  if (env.CALIB) {
    try {
      const stored = await env.CALIB.get(`wx/${klat}_${klon}.json`);
      if (stored) {
        const last = JSON.parse(await stored.text()) as WxResponse & { _t?: number };
        const ageMin = last._t ? Math.floor((nowMs - last._t) / 60_000) : Infinity;
        if (ageMin <= LAST_GOOD_MAX_AGE_MIN) {
          console.warn('[wx] serving R2 last-good (degraded), age', ageMin, 'min');
          return new Response(JSON.stringify({ metar: last.metar, taf: last.taf, stations_found: last.stations_found, degraded: true }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsHeaders() },
          });
        }
      }
    } catch {
      /* unreadable → 502 */
    }
  }

  return new Response(JSON.stringify({ error: 'wx_unavailable' }), {
    status: 502,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}
