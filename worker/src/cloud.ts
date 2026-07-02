/**
 * Live current cloud-cover proxy — the "cloud now" reading for the map target
 * popup. Proxies Open-Meteo's current `cloud_cover` (modeled, global, so there
 * is always a number even over open ocean) behind an edge cache so per-tap
 * fetches don't storm the upstream — Open-Meteo has a real rate limit and bit
 * us once before (project_cupola_forecast_429).
 *
 * Contract (design-review-pinned):
 *  - Returns integer percent **0-100**, passed through from Open-Meteo
 *    unscaled, on the SAME scale as the at-pass cloud number already in the
 *    popup (review R4).
 *  - Edge key is the EXACT `.toFixed(4)` coord (matches worker/src/wx.ts — two
 *    distinct nearby targets must not share a cloud figure, Codex wx #4 / R3).
 *  - `cacheTtlByStatus` caches errors only briefly so an upstream 429 can't
 *    poison the 300s cache; a 429/5xx surfaces as a quiet 502 the frontend
 *    collapses to "no reading" (review R6/R14).
 */
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const EDGE_CACHE_TTL_SECONDS = 300;
const UPSTREAM_TIMEOUT_MS = 4000;

export interface CloudNowResponse {
  cloud_pct: number; // integer 0-100
  time: string; // Open-Meteo "current" timestamp (best-effort)
}

function corsHeaders(): Record<string, string> {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' };
}

function err(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}

/** GET /api/cloud?lat=&lon= — current modeled cloud-cover %, edge-cached. */
export async function handleCloudRequest(
  request: Request,
  _env: unknown,
  ctx: ExecutionContext,
  fetchImpl: typeof fetch = fetch,
  cacheImpl?: Cache,
): Promise<Response> {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return err(400, 'bad_coords');
  }

  const klat = lat.toFixed(4);
  const klon = lon.toFixed(4);
  const cache = cacheImpl ?? (typeof caches !== 'undefined' ? caches.default : undefined);
  const cacheKey = new Request(`https://cloud-cache-key/v1?lat=${klat}&lon=${klon}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    const upstream = await fetchImpl(
      `${OPEN_METEO_URL}?latitude=${klat}&longitude=${klon}&current=cloud_cover`,
      {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        cf: { cacheTtl: EDGE_CACHE_TTL_SECONDS, cacheTtlByStatus: { '200-299': EDGE_CACHE_TTL_SECONDS, '400-599': 60 } },
      } as RequestInit,
    );
    if (!upstream.ok) return err(502, 'cloud_unavailable'); // 429/5xx → quiet, uncached
    const data = (await upstream.json()) as { current?: { cloud_cover?: unknown; time?: unknown } };
    const raw = data.current?.cloud_cover;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return err(502, 'cloud_unavailable');

    const payload: CloudNowResponse = {
      cloud_pct: Math.max(0, Math.min(100, Math.round(raw))), // 0-100 integer, same scale as at-pass
      time: typeof data.current?.time === 'string' ? data.current.time : '',
    };
    const response = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${EDGE_CACHE_TTL_SECONDS}`, ...corsHeaders() },
    });
    if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch((e) => console.warn('[cloud] edge put failed:', (e as Error)?.message ?? e)));
    return response;
  } catch {
    return err(502, 'cloud_unavailable');
  }
}
