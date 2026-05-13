/**
 * Orbit Photo Director — Cloudflare Worker.
 *
 * Three endpoints:
 *   POST /api/log     — calibration ingest. Requires X-Calib-Token header. Appends one
 *                        JSONL record per request to r2:CALIB/log/<yyyymm>/<random>.jsonl.
 *                        Idempotent on a client-supplied dedupe_key.
 *   GET  /api/health  — reads manifest.json from r2:SITE; returns 200 if last_run is
 *                        within STALE_THRESHOLD_SECONDS, else 503. UptimeRobot polls this.
 *   GET  /api/kp      — proxies SWPC's planetary K-index, edge-cached 5min. V4-P2 aurora
 *                        indicator. See worker/src/aurora.ts.
 *
 * Static assets (manifest.json, /v/.../*) are NOT served by this Worker — they're served
 * directly from the R2 bucket bound to the custom domain. The Worker only handles /api/*.
 */

import { handleKpRequest } from './aurora';

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

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

const ALLOWED_ORIGINS = new Set([
  'https://map.astroanil.dev',
  'http://localhost:5173', // vite dev server
  'http://127.0.0.1:5173',
]);

const MAX_BODY_BYTES = 8 * 1024; // 8 KB cap on /api/log payloads
const MAX_FIELD_LEN = 200;
// Bound abuse if the calibration token is ever leaked. Personal use is
// ~3-5 POSTs/day; 200/day is ~50× headroom, then 429 + retry-after.
// TOCTOU on the counter object is acceptable for an abuse cap (off by
// at most the concurrency).
const RATE_LIMIT_PER_DAY = 200;
const VALID_OBSTRUCTIONS = new Set([
  'clear',
  'cloudy',
  'sun-glint',
  'thin cirrus',
  'haze',
  'other',
]);

function corsHeaders(origin: string | null): HeadersInit {
  // Only echo trusted origins; otherwise omit ACAO entirely (browser blocks).
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-calib-token',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (allowed) {
    headers['access-control-allow-origin'] = allowed;
  }
  return headers;
}

/** Constant-time string compare; avoids token-timing leaks across requests. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Day's rate-limit counter: read-only check, used BEFORE the conditional
 *  put to gate over-limit traffic. The bump happens AFTER a successful
 *  first-time write — duplicate-dedupe retries (which return a no-op
 *  204-equivalent) don't consume budget. This matters because the
 *  frontend's drainQueue replays offline writes on every visit; a flaky
 *  network would otherwise burn the daily 200 cap on dedupe-no-ops.
 *
 *  Counter key: `_meta/ratelimit/YYYYMMDD.json` with `{count: N}`.
 *  Resets at next UTC midnight by virtue of the new key.
 */
function rateLimitKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `_meta/ratelimit/${y}${m}${d}.json`;
}

async function readRateLimitCount(env: Env, now: Date): Promise<number> {
  try {
    const obj = await env.CALIB.get(rateLimitKey(now));
    if (!obj) return 0;
    const data = (await obj.json()) as { count?: number };
    return typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : 0;
  } catch (e) {
    // Read failure → fail open for availability; the cap is best-effort.
    console.error('rate limit read failed', e);
    return 0;
  }
}

async function checkRateLimit(
  env: Env, now: Date
): Promise<{ ok: true; count: number } | { ok: false; resetAt: string }> {
  const count = await readRateLimitCount(env, now);
  if (count >= RATE_LIMIT_PER_DAY) {
    const reset = new Date(now);
    reset.setUTCDate(reset.getUTCDate() + 1);
    reset.setUTCHours(0, 0, 0, 0);
    return { ok: false, resetAt: reset.toISOString() };
  }
  return { ok: true, count };
}

async function bumpRateLimit(env: Env, now: Date): Promise<void> {
  // Read-modify-write is racy under concurrency; that's acceptable for an
  // abuse cap. Cloudflare Rate Limiting binding (paid) or KV with TTL
  // would be strict, but this is sufficient for a single-user mission.
  const count = await readRateLimitCount(env, now);
  try {
    await env.CALIB.put(rateLimitKey(now), JSON.stringify({ count: count + 1 }), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    console.error('rate limit write failed', e);
  }
}

/** Strip dedupe_key down to URL- and bucket-safe characters; cap length.
 *  Excludes `.` so a key like `../../../foo` cannot survive as `....foo` and
 *  produce path-like substrings in the R2 object key.
 */
function sanitizeDedupeKey(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_\-|]/g, '').slice(0, 128);
  return cleaned || crypto.randomUUID();
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

// Strict ISO 8601 UTC matcher: 2024-10-17T12:00:00Z or 2024-10-17T12:00:00.123Z.
// The prior check (endsWith('Z') + length cap) accepted "AAAAAAAAZ" — the
// frontend would later show "Invalid Date" for those rows.
const PASS_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isLogRequest(value: unknown): value is LogRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.target_id !== 'string' || v.target_id.length === 0) return false;
  if (v.target_id.length > MAX_FIELD_LEN) return false;
  if (typeof v.pass_time !== 'string' || !PASS_TIME_RE.test(v.pass_time)) return false;
  if (v.pass_time.length > MAX_FIELD_LEN) return false;
  if (v.action !== 'shoot' && v.action !== 'skip' && v.action !== 'rate') return false;
  if (v.action === 'rate') {
    if (typeof v.rating !== 'number' || v.rating < 1 || v.rating > 5) return false;
  }
  if (v.observed_obstruction !== undefined) {
    if (typeof v.observed_obstruction !== 'string') return false;
    if (!VALID_OBSTRUCTIONS.has(v.observed_obstruction)) return false;
  }
  if (v.dedupe_key !== undefined) {
    if (typeof v.dedupe_key !== 'string' || v.dedupe_key.length > MAX_FIELD_LEN) return false;
  }
  return true;
}

async function handleLog(request: Request, env: Env): Promise<Response> {
  // Guard against secret deletion / deploy misconfig: an undefined CALIB_TOKEN
  // would crash constantTimeEqual on `undefined.length`. Return 503 so the
  // client knows the server is misconfigured rather than seeing a 500.
  if (!env.CALIB_TOKEN) {
    return jsonResponse({ error: 'service_misconfigured' }, 503);
  }
  const token = request.headers.get('x-calib-token');
  if (!token || !constantTimeEqual(token, env.CALIB_TOKEN)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  // Reject oversized bodies BEFORE buffering. Cloudflare's body parser will also
  // refuse very large requests, but Content-Length lets us short-circuit cheaply.
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'payload_too_large' }, 413);
    }
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

  // Rate-limit CHECK runs after auth + payload validation. The BUMP happens
  // after a successful first-time write below, so dedupe-no-op retries
  // (drainQueue replays on flaky network) don't consume budget.
  const now = new Date();
  const rate = await checkRateLimit(env, now);
  if (!rate.ok) {
    return jsonResponse(
      { error: 'rate_limited', reset_at: rate.resetAt, limit: RATE_LIMIT_PER_DAY },
      429,
    );
  }

  // Object key: log/YYYYMM/<sanitized-dedupe_key or uuid>.json
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = payload.dedupe_key ? sanitizeDedupeKey(payload.dedupe_key) : crypto.randomUUID();
  const objectKey = `log/${yyyymm}/${key}.json`;

  try {
    // Atomic dedupe via R2 conditional put — `onlyIf: { etagDoesNotMatch: '*' }`
    // means "only put if the key does NOT already exist." Replaces the prior
    // HEAD-then-PUT pattern which had a TOCTOU race: two concurrent requests
    // with the same dedupe_key could both pass HEAD-not-found and the second
    // PUT would silently overwrite the first.
    //
    // R2 returns null on conditional-put miss (key already exists with any
    // etag); we surface that as `deduped: true` to the client.
    const record = {
      ...payload,
      received_at: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    };
    const result = await env.CALIB.put(objectKey, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (result === null) {
      // Key already exists — duplicate. The first writer's record stands.
      // Do NOT bump the rate-limit counter for dedupes.
      return jsonResponse({ ok: true, deduped: true, key: objectKey });
    }
    // First-time write succeeded — count it toward the daily cap.
    await bumpRateLimit(env, now);
    return jsonResponse({ ok: true, deduped: false, key: objectKey });
  } catch (e) {
    // R2 transient failures: surface 503 (frontend will queue + retry) instead of
    // a generic 500 (which the frontend would also queue, but with worse signal).
    console.error('R2 write failed', e);
    return jsonResponse({ error: 'storage_unavailable' }, 503);
  }
}

/** Map a request path to its R2 object key. `/` becomes `index.html`; trailing `/` adds it. */
function pathToKey(pathname: string): string {
  let p = pathname.replace(/^\/+/, ''); // strip leading slashes
  if (p === '' || p.endsWith('/')) {
    p = `${p}index.html`;
  }
  return p;
}

const CACHE_BY_EXT: Record<string, string> = {
  html: 'public, max-age=60',
  json: 'public, max-age=10',
  css: 'public, max-age=31536000, immutable',
  js: 'public, max-age=31536000, immutable',
  map: 'public, max-age=31536000, immutable',
  png: 'public, max-age=86400',
  svg: 'public, max-age=86400',
  woff: 'public, max-age=31536000, immutable',
  woff2: 'public, max-age=31536000, immutable',
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  map: 'application/json',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

async function handleStatic(pathname: string, env: Env): Promise<Response> {
  const key = pathToKey(pathname);
  // Defense-in-depth: never serve internal calibration prefixes from the SITE bucket
  // (the bucket doesn't host them anyway, but a future misconfig shouldn't expose them).
  if (key.startsWith('log/')) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  let obj: R2ObjectBody | null;
  try {
    obj = await env.SITE.get(key);
  } catch (e) {
    console.error('R2 get failed', e);
    return jsonResponse({ error: 'storage_unavailable' }, 503);
  }
  if (!obj) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const ct = obj.httpMetadata?.contentType ?? CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
  const cc = obj.httpMetadata?.cacheControl ?? CACHE_BY_EXT[ext] ?? 'public, max-age=300';
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': ct,
      'cache-control': cc,
      etag: obj.httpEtag,
    },
  });
}

/** GET /api/log — list recent calibration log entries.
 *
 *  Reads from r2:CALIB. Token-gated (same X-Calib-Token as POST). Returns up to
 *  `limit` (default 50, max 50) entries from the current month, ordered by
 *  received_at descending. If the current month has fewer entries than limit,
 *  also reads from the previous month.
 *
 *  Each entry is the JSON object exactly as written by handleLog.
 *
 *  The 50-cap is the Workers Free subrequest budget per invocation. Each
 *  entry costs 1 R2 .get() = 1 subrequest, plus 1-2 .list() calls. Returning
 *  more than 50 would force users on the free tier into silent truncation
 *  partway through. A V3 fix is to denormalize: store entries inline in the
 *  list response or include customMetadata so the per-key get isn't needed.
 */
async function handleLogList(request: Request, env: Env): Promise<Response> {
  if (!env.CALIB_TOKEN) {
    return jsonResponse({ error: 'service_misconfigured' }, 503);
  }
  const token = request.headers.get('x-calib-token');
  if (!token || !constantTimeEqual(token, env.CALIB_TOKEN)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? '50');
  const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));

  const now = new Date();
  const monthKeys = [
    `log/${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}/`,
  ];
  // Include previous month so user opening the page on the 1st still sees data.
  const prev = new Date(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  monthKeys.push(
    `log/${prev.getUTCFullYear()}${String(prev.getUTCMonth() + 1).padStart(2, '0')}/`,
  );

  const entries: Array<Record<string, unknown>> = [];
  try {
    for (const prefix of monthKeys) {
      if (entries.length >= limit) break;
      const list = await env.CALIB.list({
        prefix,
        limit: Math.min(50, limit - entries.length + 10),
      });
      for (const obj of list.objects) {
        if (entries.length >= limit) break;
        const body = await env.CALIB.get(obj.key);
        if (!body) continue;
        try {
          const json = (await body.json()) as Record<string, unknown>;
          entries.push(json);
        } catch {
          // skip unparseable entries
        }
      }
    }
  } catch (e) {
    console.error('R2 list failed', e);
    return jsonResponse({ error: 'storage_unavailable' }, 503);
  }

  // Sort by received_at desc; missing received_at sinks to the bottom.
  entries.sort((a, b) => {
    const ar = typeof a.received_at === 'string' ? a.received_at : '';
    const br = typeof b.received_at === 'string' ? b.received_at : '';
    return br.localeCompare(ar);
  });

  return jsonResponse({ entries: entries.slice(0, limit), count: entries.length });
}


async function handleHealth(env: Env): Promise<Response> {
  let obj: R2ObjectBody | null;
  try {
    obj = await env.SITE.get('manifest.json');
  } catch (e) {
    console.error('R2 read failed', e);
    return jsonResponse({ ok: false, reason: 'storage_unavailable' }, 503);
  }
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    } else if (
      url.pathname === '/api/log' &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      response = await handleLogList(request, env);
      if (request.method === 'HEAD') {
        response = new Response(null, { status: response.status, headers: response.headers });
      }
    } else if (
      url.pathname === '/api/health' &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      response = await handleHealth(env);
      if (request.method === 'HEAD') {
        response = new Response(null, { status: response.status, headers: response.headers });
      }
    } else if (
      url.pathname === '/api/kp' &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      // V4-P2 aurora indicator: SWPC Kp-index proxy with edge cache.
      response = await handleKpRequest(request, env, ctx);
      if (request.method === 'HEAD') {
        response = new Response(null, { status: response.status, headers: response.headers });
      }
    } else if (request.method === 'GET' || request.method === 'HEAD') {
      // Static fallback: serve any non-/api GET from the SITE bucket. Maps
      // `/` to `index.html`. Returns 404 if the object doesn't exist in R2.
      response = await handleStatic(url.pathname, env);
      if (request.method === 'HEAD') {
        response = new Response(null, { status: response.status, headers: response.headers });
      }
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
