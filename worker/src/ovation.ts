/**
 * OVATION aurora-probability proxy — aurora v1.1 ("visible from ISS?").
 *
 * SWPC's OVATION model publishes a ~900KB 1° global grid of aurora
 * probabilities (https://services.swpc.noaa.gov/json/ovation_aurora_latest.json,
 * 65,160 [lon, lat, prob] triples). The frontend needs maybe 10KB of it to
 * answer one question — "is there aurora within the ISS's visible horizon
 * right now?" — so this route downsamples to a 5° MAX-pooled grid
 * (36 lat bins × 72 lon bins ≈ 9KB) before anything crosses the wire.
 *
 * Codex-folded requirements from the aurora v1 design review (2026-05-13):
 * - Worker downsamples; frontend runs visibility lookups against the
 *   compact grid. LOS resilience = the frontend's in-memory last-good
 *   grid (capped at this module's 24h policy) on top of the R2 last-good
 *   below; there is intentionally NO service-worker cache for /api/*.
 * - Durable last-good storage beyond the edge cache: the CALIB R2 bucket
 *   (already bound for /api/log) keeps the latest good grid; cold-colo +
 *   SWPC-outage serves it flagged `degraded: true`.
 * - Source-age display: `age_min` is the OVATION observation age, never
 *   the cache age — the operator cares how old the READING is.
 * - Schema-drift tolerance: OVATION is an experimental product; malformed
 *   payloads fail soft to last-good, never crash the route.
 *
 * MAX pooling (not mean) per 5° cell: the question is "could there be
 * aurora here", and washing a bright 1° filament out against 24 dark
 * neighbors would answer it wrongly.
 */

export const SWPC_OVATION_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

// 300s ≈ OVATION's own publish cadence (~5min product updates) — a
// fresher edge TTL buys nothing; a longer one delays storm onset.
const EDGE_CACHE_TTL_SECONDS = 300;

export const AURORA_GRID_STEP_DEG = 5;
export const AURORA_LAT_BINS = 36; // index 0 = [-90, -85)
export const AURORA_LON_BINS = 72; // index 0 = [0°E, 5°E)

const LAST_GOOD_KEY = 'aurora/ovation-last-good.json';
/** Serve last-good for at most this long. The oval moves with the solar
 *  wind on a scale of hours, so 24h data is NOT a current nowcast — what
 *  makes 24h defensible is that every consumer sees `degraded: true` plus
 *  the true source age in the tooltip, and same-UT-of-day oval geometry
 *  is at least the right shape. Beyond that, an honest 502 wins. */
const LAST_GOOD_MAX_AGE_MIN = 24 * 60;
/** Reject downsamples where fewer than this fraction of grid cells were
 *  populated — a truncated upstream body would otherwise look like a
 *  mostly-dark planet instead of an error. */
const MIN_CELL_COVERAGE = 0.8;

export interface AuroraGridResponse {
  /** OVATION observation timestamp (UTC ISO). */
  observation_time: string;
  /** OVATION forecast-valid timestamp (UTC ISO). */
  forecast_time: string;
  /** Minutes since observation_time — SOURCE age, not cache age. */
  age_min: number;
  grid_step: number;
  /** [AURORA_LAT_BINS][AURORA_LON_BINS] aurora probability 0-100,
   *  MAX-pooled per 5° cell. Row 0 spans latitude [-90, -85). */
  probs: number[][];
  /** Present + true when served from R2 last-good (upstream down). */
  degraded?: boolean;
}

interface OvationPayload {
  'Observation Time'?: unknown;
  'Forecast Time'?: unknown;
  coordinates?: unknown;
}

/** Downsample a raw OVATION payload to the compact 5° grid. Returns null
 *  on any shape violation (schema drift / truncation) so callers fail soft. */
export function downsampleOvation(
  payload: unknown,
  nowMs: number,
): AuroraGridResponse | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as OvationPayload;
  const obs = p['Observation Time'];
  const fcst = p['Forecast Time'];
  const coords = p.coordinates;
  if (typeof obs !== 'string' || typeof fcst !== 'string') return null;
  const obsMs = Date.parse(obs);
  if (Number.isNaN(obsMs)) return null;
  if (!Array.isArray(coords) || coords.length === 0) return null;

  const probs: number[][] = Array.from({ length: AURORA_LAT_BINS }, () =>
    new Array<number>(AURORA_LON_BINS).fill(0),
  );
  const touched: boolean[][] = Array.from({ length: AURORA_LAT_BINS }, () =>
    new Array<boolean>(AURORA_LON_BINS).fill(false),
  );
  let valid = 0;
  for (const row of coords) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const [lon, lat, prob] = row as [number, number, number];
    if (
      typeof lon !== 'number' || typeof lat !== 'number' || typeof prob !== 'number'
      || !Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(prob)
      || lat < -90 || lat > 90 || lon < 0 || lon > 360
    ) continue;
    const li = Math.min(AURORA_LAT_BINS - 1, Math.max(0, Math.floor((lat + 90) / AURORA_GRID_STEP_DEG)));
    const lj = Math.min(AURORA_LON_BINS - 1, Math.max(0, Math.floor((lon % 360) / AURORA_GRID_STEP_DEG)));
    const clamped = Math.min(100, Math.max(0, prob));
    const probRow = probs[li]!;
    if (clamped > probRow[lj]!) probRow[lj] = clamped;
    touched[li]![lj] = true;
    valid += 1;
  }
  const cellsTouched = touched.flat().filter(Boolean).length;
  if (valid === 0 || cellsTouched < AURORA_LAT_BINS * AURORA_LON_BINS * MIN_CELL_COVERAGE) {
    return null;
  }

  return {
    observation_time: obs,
    forecast_time: fcst,
    age_min: Math.max(0, Math.floor((nowMs - obsMs) / 60_000)),
    grid_step: AURORA_GRID_STEP_DEG,
    probs,
  };
}

/** Minimal structural slice of the R2 binding this module needs. */
interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

/** GET /api/aurora — downsampled OVATION grid with edge cache + R2 last-good.
 *
 *  Flow: edge cache → upstream fetch + downsample (success: persist R2
 *  last-good, edge-cache 5min) → on ANY failure: R2 last-good ≤24h marked
 *  degraded (never edge-cached, so recovery is immediate) → 502.
 */
export async function handleAuroraRequest(
  request: Request,
  env: { CALIB?: R2Like },
  ctx: ExecutionContext,
  fetchImpl: typeof fetch = fetch,
  cacheImpl?: Cache,
  nowMs: number = Date.now(),
): Promise<Response> {
  const cache = cacheImpl ?? (typeof caches !== 'undefined' ? caches.default : undefined);
  const cacheKey = new Request('https://aurora-cache-key/v1');

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let grid: AuroraGridResponse | null = null;
  try {
    const upstream = await fetchImpl(SWPC_OVATION_URL, {
      cf: {
        cacheTtl: EDGE_CACHE_TTL_SECONDS,
        cacheTtlByStatus: { '200-299': EDGE_CACHE_TTL_SECONDS, '400-599': 60 },
      },
    } as RequestInit);
    if (upstream.ok) {
      grid = downsampleOvation(await upstream.json(), nowMs);
      if (!grid) console.warn('[aurora] OVATION payload failed validation (schema drift / truncation)');
    } else {
      console.warn('[aurora] OVATION upstream status', upstream.status);
    }
  } catch (err) {
    // Observability (Codex req): fallback usage is visible in wrangler tail.
    console.warn('[aurora] OVATION fetch failed:', (err as Error)?.message ?? err);
    grid = null; // unreachable upstream → last-good path below
  }

  if (grid) {
    const body = JSON.stringify(grid);
    const response = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${EDGE_CACHE_TTL_SECONDS}`,
        ...corsHeaders(),
      },
    });
    // Both writes are best-effort: a failed put must neither fail the
    // request nor surface as an unhandled rejection — but it MUST be
    // visible in wrangler tail (a silently dead R2 write means no durable
    // fallback for the next outage).
    if (cache) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(
        (err) => console.warn('[aurora] edge cache put failed:', (err as Error)?.message ?? err),
      ));
    }
    if (env.CALIB) {
      ctx.waitUntil(Promise.resolve(env.CALIB.put(LAST_GOOD_KEY, body)).catch(
        (err) => console.warn('[aurora] R2 last-good put failed:', (err as Error)?.message ?? err),
      ));
    }
    return response;
  }

  // Upstream down or drifted: serve R2 last-good ≤24h, flagged + uncached.
  if (env.CALIB) {
    try {
      const stored = await env.CALIB.get(LAST_GOOD_KEY);
      if (stored) {
        const last = JSON.parse(await stored.text()) as AuroraGridResponse;
        const obsMs = Date.parse(last.observation_time);
        const ageMin = Math.max(0, Math.floor((nowMs - obsMs) / 60_000));
        if (!Number.isNaN(obsMs) && ageMin <= LAST_GOOD_MAX_AGE_MIN) {
          console.warn('[aurora] serving R2 last-good (degraded), source age', ageMin, 'min');
          return new Response(
            JSON.stringify({ ...last, age_min: ageMin, degraded: true }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'cache-control': 'no-store', // recover the moment SWPC does
                ...corsHeaders(),
              },
            },
          );
        }
      }
    } catch {
      /* last-good unreadable → fall through to 502 */
    }
  }

  return new Response(JSON.stringify({ error: 'ovation_unavailable' }), {
    status: 502,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}

function corsHeaders(): Record<string, string> {
  // Public read-only data — same posture as /api/kp.
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  };
}
