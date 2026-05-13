/**
 * Aurora (Kp index) proxy — V4-P2 v1.
 *
 * Fetches NOAA SWPC's planetary K-index from
 * https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
 * and returns the latest sample. Kp is a 0-9 quasi-logarithmic index of
 * geomagnetic activity, smoothed over 3-hour windows; values >=5 indicate
 * a geomagnetic storm and aurora visible from lower latitudes.
 *
 * Why this exists (operator context): Chris Williams (ISS, 8-month mission)
 * visits SWPC's aurora dashboard daily to check whether tonight's pass is
 * worth a cupola visit. Surfacing Kp on map.astroanil.dev eliminates that
 * tab. v1 ships the headline number only — visibility prediction and the
 * OVATION oval are deferred to v1.1 pending operator feedback.
 *
 * Caching strategy: edge-cache the SWPC response with a 5-minute TTL. The
 * underlying 1-min cadence file is small (~27KB) but we don't need 1-min
 * freshness for a 3-hour-smoothed quantity. SWPC outage → cache serves
 * last good for the TTL; after expiry, the route returns 5xx and the
 * frontend hides the widget (SW cache serves last good there too).
 *
 * Response shape: { kp: number, timestamp: string, age_min: number }
 * Tiny payload (~80 bytes) — frontend just renders a single number with
 * a click-through to the SWPC dashboard.
 */

const SWPC_KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

/** Edge cache TTL for the upstream SWPC response. 5 min balances staleness
 *  vs upstream load — Kp itself is a 3h smoothed value so 5-min freshness
 *  is well over-spec for the headline use case. */
const EDGE_CACHE_TTL_SECONDS = 300;

/** SWPC publishes an array of {time_tag, kp_index, ...} objects, newest
 *  last. We only care about the most recent sample. */
interface SwpcKpRow {
  time_tag: string;
  kp_index: number;
  estimated_kp?: number;
  kp?: string;
}

export interface KpResponse {
  /** Latest Kp value, 0-9 quasi-logarithmic. */
  kp: number;
  /** SWPC time_tag of the latest sample (ISO 8601). */
  timestamp: string;
  /** Minutes since the SWPC sample was recorded. Distinct from edge
   *  cache age — this is the SOURCE age, what the operator cares about. */
  age_min: number;
}

/** SWPC's planetary_k_index_1m.json returns timestamps without a timezone
 *  suffix (e.g., "2026-05-13T15:51:00"). ECMAScript's behavior for parsing
 *  date-time strings without offset is engine-defined: V8 happens to treat
 *  it as UTC (matching SWPC's intent), but Safari and older engines treat
 *  it as local time, which would shift age_min by the runtime's UTC offset.
 *  Cloudflare Workers run on V8 so today this is correct; the explicit Z
 *  guards against future runtime changes and any frontend re-parse. */
export function normalizeSwpcTimestamp(ts: string): string {
  // Already has Z, +HH:MM, +HHMM, -HH:MM, or -HHMM offset → leave alone.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(ts)) return ts;
  return ts + 'Z';
}

/** Parse SWPC's planetary_k_index_1m.json response into our compact shape.
 *  Returns null on malformed input (empty array, missing fields, NaN Kp,
 *  bad timestamps) so callers can fail soft instead of crashing.
 *
 *  Schema-drift tolerance: SWPC's "experimental" endpoints have changed
 *  field names in the past. We accept either `kp_index` or `kp` (string
 *  form), and skip rows missing both. Timestamps are normalized to UTC
 *  via normalizeSwpcTimestamp() so age_min is portable across runtimes. */
export function parseKp(payload: unknown, nowMs: number): KpResponse | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  // Walk from the end (newest) and return the first valid row. Defensive
  // against trailing partial samples that SWPC has occasionally emitted.
  for (let i = payload.length - 1; i >= 0; i--) {
    const row = payload[i] as SwpcKpRow;
    if (!row || typeof row !== 'object') continue;
    const ts = row.time_tag;
    if (typeof ts !== 'string') continue;
    const normalizedTs = normalizeSwpcTimestamp(ts);
    const tsMs = Date.parse(normalizedTs);
    if (Number.isNaN(tsMs)) continue;
    let kp: number = NaN;
    if (typeof row.kp_index === 'number' && Number.isFinite(row.kp_index)) {
      kp = row.kp_index;
    } else if (typeof row.kp === 'string') {
      const parsed = parseFloat(row.kp);
      if (Number.isFinite(parsed)) kp = parsed;
    }
    if (!Number.isFinite(kp) || kp < 0 || kp > 9) continue;
    const age_min = Math.max(0, Math.floor((nowMs - tsMs) / 60_000));
    // Return the NORMALIZED timestamp so any consumer (frontend tooltip,
    // log aggregator, future caller) gets an unambiguous UTC instant.
    return { kp, timestamp: normalizedTs, age_min };
  }
  return null;
}

/** GET /api/kp — proxy + edge-cache SWPC's planetary K-index.
 *
 *  Cache flow:
 *  1. Check Cloudflare edge cache for a cached response (5-min TTL).
 *  2. On miss: fetch SWPC, parse latest row, JSON-encode, cache, return.
 *  3. On SWPC failure or parse failure: return 5xx without caching the
 *     error response (the frontend's SW + browser cache hold last good).
 *
 *  CORS: open to the public origin map.astroanil.dev. The response is
 *  not user-specific so we can serve any origin safely. */
export async function handleKpRequest(
  request: Request,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _env: unknown,
  ctx: ExecutionContext,
  fetchImpl: typeof fetch = fetch,
  cacheImpl?: Cache,
): Promise<Response> {
  const cache = cacheImpl ?? (typeof caches !== 'undefined' ? caches.default : undefined);
  const cacheKey = new Request('https://kp-cache-key/v1');

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(SWPC_KP_URL, {
      // cf.cacheTtlByStatus: don't poison the edge with error responses
      // for the full TTL — limit 4xx/5xx caching to 60s so we recover
      // from transient SWPC blips faster than from healthy fetches.
      cf: {
        cacheTtl: EDGE_CACHE_TTL_SECONDS,
        cacheTtlByStatus: { '200-299': EDGE_CACHE_TTL_SECONDS, '400-599': 60 },
      },
    } as RequestInit);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'swpc_unreachable' }), {
      status: 502,
      headers: { 'content-type': 'application/json', ...corsHeadersForKp(request) },
    });
  }

  if (!upstream.ok) {
    return new Response(JSON.stringify({ error: 'swpc_status', status: upstream.status }), {
      status: 502,
      headers: { 'content-type': 'application/json', ...corsHeadersForKp(request) },
    });
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'swpc_parse' }), {
      status: 502,
      headers: { 'content-type': 'application/json', ...corsHeadersForKp(request) },
    });
  }

  const parsed = parseKp(payload, Date.now());
  if (!parsed) {
    return new Response(JSON.stringify({ error: 'swpc_no_data' }), {
      status: 502,
      headers: { 'content-type': 'application/json', ...corsHeadersForKp(request) },
    });
  }

  const responseBody = JSON.stringify(parsed);
  const response = new Response(responseBody, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${EDGE_CACHE_TTL_SECONDS}`,
      ...corsHeadersForKp(request),
    },
  });

  // ctx.waitUntil keeps the cache write alive after the response is sent.
  if (cache) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}

function corsHeadersForKp(_request: Request): Record<string, string> {
  // Kp is public data; allow any origin. Matches the existing pattern
  // for /api/health which is similarly read-only and non-sensitive.
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  };
}
