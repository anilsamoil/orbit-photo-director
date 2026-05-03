/**
 * Orbit Photo Director — Cloudflare Worker.
 *
 * Two endpoints:
 *   POST /api/log     — calibration ingest. Requires X-Calib-Token header. Appends one
 *                        JSONL record per request to r2:CALIB/log/<yyyymm>/<random>.jsonl.
 *                        Idempotent on a client-supplied dedupe_key.
 *   GET  /api/health  — reads manifest.json from r2:SITE; returns 200 if last_run is
 *                        within STALE_THRESHOLD_SECONDS, else 503. UptimeRobot polls this.
 *
 * Static assets (manifest.json, /v/.../*) are NOT served by this Worker — they're served
 * directly from the R2 bucket bound to the custom domain. The Worker only handles /api/*.
 */

export interface Env {
  SITE: R2Bucket;
  CALIB: R2Bucket;
  CALIB_TOKEN: string; // wrangler secret
  STALE_THRESHOLD_SECONDS: string;
}

interface LogRequest {
  target_id: string;
  pass_time: string; // ISO 8601 Z
  action: 'shoot' | 'skip' | 'rate';
  score_at_time?: number;
  rating?: number; // 1-5, present when action === 'rate'
  observed_obstruction?: 'clear' | 'cloudy' | 'sun-glint' | 'thin cirrus' | 'haze' | 'other';
  dedupe_key?: string;
}

interface ManifestFreshness {
  tle_hours: number;
  cloud_hours: number;
  ok: boolean;
}

interface Manifest {
  version: string;
  generated_at: string;
  freshness: ManifestFreshness;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS']);

function corsHeaders(origin: string | null): HeadersInit {
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-calib-token',
    'access-control-max-age': '86400',
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function isLogRequest(value: unknown): value is LogRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.target_id !== 'string' || v.target_id.length === 0) return false;
  if (typeof v.pass_time !== 'string' || !v.pass_time.endsWith('Z')) return false;
  if (v.action !== 'shoot' && v.action !== 'skip' && v.action !== 'rate') return false;
  if (v.action === 'rate') {
    if (typeof v.rating !== 'number' || v.rating < 1 || v.rating > 5) return false;
  }
  return true;
}

async function handleLog(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('x-calib-token');
  if (!token || token !== env.CALIB_TOKEN) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (!isLogRequest(body)) {
    return jsonResponse({ error: 'invalid_payload' }, 400);
  }
  const payload = body as LogRequest;

  // Object key: log/YYYYMM/<dedupe_key or uuid>.json
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = payload.dedupe_key ?? crypto.randomUUID();
  const objectKey = `log/${yyyymm}/${key}.json`;

  // Idempotent: HEAD first; if exists, return 200 with no-op
  const existing = await env.CALIB.head(objectKey);
  if (existing) {
    return jsonResponse({ ok: true, deduped: true, key: objectKey });
  }

  const record = {
    ...payload,
    received_at: now.toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  await env.CALIB.put(objectKey, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
  });
  return jsonResponse({ ok: true, deduped: false, key: objectKey });
}

async function handleHealth(env: Env): Promise<Response> {
  const obj = await env.SITE.get('manifest.json');
  if (!obj) {
    return jsonResponse(
      { ok: false, reason: 'manifest_not_found' },
      503,
      { 'cache-control': 'no-store' }
    );
  }
  let manifest: Manifest;
  try {
    manifest = (await obj.json()) as Manifest;
  } catch {
    return jsonResponse({ ok: false, reason: 'manifest_unparseable' }, 503);
  }

  const generatedAt = Date.parse(manifest.generated_at);
  if (Number.isNaN(generatedAt)) {
    return jsonResponse({ ok: false, reason: 'manifest_invalid_timestamp' }, 503);
  }
  const ageSeconds = (Date.now() - generatedAt) / 1000;
  const threshold = Number(env.STALE_THRESHOLD_SECONDS) || 1800;
  const fresh = ageSeconds < threshold && manifest.freshness.ok;
  return jsonResponse(
    {
      ok: fresh,
      last_run: manifest.generated_at,
      age_seconds: Math.round(ageSeconds),
      threshold_seconds: threshold,
      version: manifest.version,
      freshness: manifest.freshness,
    },
    fresh ? 200 : 503
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!ALLOWED_METHODS.has(request.method)) {
      return new Response('method not allowed', { status: 405 });
    }
    const url = new URL(request.url);
    const origin = request.headers.get('origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    let response: Response;
    if (url.pathname === '/api/log' && request.method === 'POST') {
      response = await handleLog(request, env);
    } else if (url.pathname === '/api/health' && request.method === 'GET') {
      response = await handleHealth(env);
    } else {
      response = jsonResponse({ error: 'not_found' }, 404);
    }
    // Apply CORS to all API responses
    const merged = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      merged.set(k, v as string);
    }
    return new Response(response.body, {
      status: response.status,
      headers: merged,
    });
  },
} satisfies ExportedHandler<Env>;
