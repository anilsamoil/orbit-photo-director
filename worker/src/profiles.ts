/**
 * Per-astronaut profile target CRUD — Slot 3 of design rev 2 (2026-05-26).
 *
 * Routes (all gated by `x-calib-token` shared secret, constant-time compared):
 *   GET    /api/profiles/<name>/targets       — list PersonalTarget[] from R2
 *   PUT    /api/profiles/<name>/targets       — replace entire list
 *   POST   /api/profiles/<name>/targets       — append a single target
 *   DELETE /api/profiles/<name>/targets/<id>  — remove one target by id
 *
 * Storage: r2:CALIB at key `profiles/<name>/targets.json`. R2-miss on GET
 * returns `[]` (empty list = "no targets yet" state, NOT a 404). The CALIB
 * bucket is reused so deploy-time wrangler.toml needs no change for v1.
 *
 * Auth: same `CALIB_TOKEN` shared secret as `/api/log`. Per-profile HMAC
 * tokens are a v2 TODO (design doc premise 12). All routes 401 on missing
 * or wrong token before any path validation runs — no info leakage about
 * which profiles exist.
 *
 * Concurrency: last-write-wins (design doc risk #4). Optimistic concurrency
 * via R2 ETag is deferred to v2. Two simultaneous PUTs interleave by
 * arrival order; one wins, the other is silently overwritten. Acceptable
 * because the trust model is "~5 astronauts who all know each other"
 * and the operator UI is single-pane-per-tab.
 *
 * Validation: each PersonalTarget must satisfy
 *   - id matches `personal:<profile-name>:<uuid>` (uuid v4 shape — 36 chars
 *     hex+hyphens — relaxed: any non-empty token with no `/` or whitespace
 *     so legitimate non-v4 ids the frontend produced still validate)
 *   - name: non-empty string, ≤ 200 chars
 *   - lat: number in [-90, 90]
 *   - lon: number in [-180, 180]
 *   - priority: integer in [1, 10]
 *   - createdAt: ISO 8601 Z (same regex as /api/log pass_time)
 *
 * Profile name validation: same regex as frontend/src/profile.ts
 * isValidProfileName — lowercase a-z + digits + hyphens, length 1-32,
 * leading char must be alphanumeric. Invalid → 400.
 */

import type { Env } from './index';
import { constantTimeEqual, isValidProfileName, jsonResponse } from './shared';

/** A target owned by a specific profile. Shape mirrors
 *  `frontend/src/profile.ts:PersonalTarget`. */
export interface PersonalTarget {
  id: string;
  name: string;
  lat: number;
  lon: number;
  priority: number;
  createdAt: string;
}

/** Cap on number of targets per profile. Bounds R2 object size + worst-case
 *  client render. 500 personal targets is ~50KB serialized — well within
 *  the 8KB body limit on a single POST + the few-MB R2 object ceiling. The
 *  curated list itself is 137 targets; 500 is ~3.6x that, comfortable. */
const MAX_TARGETS_PER_PROFILE = 500;

const TARGET_NAME_MAX_LEN = 200;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// id format: `personal:<profile-name>:<token>`. We accept any non-empty
// token after the second colon as long as it has no path separators or
// whitespace — the uuid format is enforced client-side, and a tighter
// server regex would brick legitimate client variants without value.
const ID_RE = /^personal:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,128}$/;

/** Validate a single PersonalTarget. Returns null on success, or an
 *  error string suitable for surfacing per-field. */
export function validateTarget(t: unknown, profileName: string): string | null {
  if (typeof t !== 'object' || t === null) return 'target_must_be_object';
  const v = t as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) return 'invalid_id';
  // The profile portion of the id MUST match the URL profile name —
  // prevents Jack POSTing an entry stamped `personal:chris:...` into his
  // own bucket. Cheap defense-in-depth.
  const idProfile = v.id.split(':')[1];
  if (idProfile !== profileName) return 'id_profile_mismatch';
  if (typeof v.name !== 'string') return 'name_must_be_string';
  if (v.name.length === 0) return 'name_empty';
  if (v.name.length > TARGET_NAME_MAX_LEN) return 'name_too_long';
  if (typeof v.lat !== 'number' || !Number.isFinite(v.lat)) return 'lat_must_be_finite_number';
  if (v.lat < -90 || v.lat > 90) return 'lat_out_of_range';
  if (typeof v.lon !== 'number' || !Number.isFinite(v.lon)) return 'lon_must_be_finite_number';
  if (v.lon < -180 || v.lon > 180) return 'lon_out_of_range';
  if (typeof v.priority !== 'number' || !Number.isInteger(v.priority)) {
    return 'priority_must_be_integer';
  }
  if (v.priority < 1 || v.priority > 10) return 'priority_out_of_range';
  if (typeof v.createdAt !== 'string' || !ISO_Z_RE.test(v.createdAt)) {
    return 'invalid_createdAt';
  }
  return null;
}

function targetsKey(profileName: string): string {
  return `profiles/${profileName}/targets.json`;
}

/** Read the stored target list. R2 miss → []. R2 read error → throws so
 *  caller can return 503. Parse error → throws with context (treat as
 *  corruption; operator will replace via PUT). */
async function readTargets(env: Env, profileName: string): Promise<PersonalTarget[]> {
  const obj = await env.CALIB.get(targetsKey(profileName));
  if (!obj) return [];
  const data = (await obj.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error(`stored profile targets for "${profileName}" is not an array`);
  }
  return data as PersonalTarget[];
}

async function writeTargets(env: Env, profileName: string, list: PersonalTarget[]): Promise<void> {
  await env.CALIB.put(targetsKey(profileName), JSON.stringify(list), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** Pure-function entry point used by `index.ts` router. Returns the
 *  Response with status + JSON body; CORS headers are merged downstream. */
export async function handleProfilesRequest(request: Request, env: Env): Promise<Response> {
  if (!env.CALIB_TOKEN) {
    return jsonResponse({ error: 'service_misconfigured' }, 503);
  }
  const token = request.headers.get('x-calib-token');
  if (!token || !constantTimeEqual(token, env.CALIB_TOKEN)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);
  // Routes: /api/profiles/<name>/targets [optional: /<id>]
  // Split & trim leading slash; then verify shape.
  const parts = url.pathname.split('/').filter(Boolean);
  // parts: ['api', 'profiles', '<name>', 'targets', '<id>?']
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'profiles' || parts[3] !== 'targets') {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  const profileName = parts[2] ?? '';
  if (!isValidProfileName(profileName)) {
    return jsonResponse({ error: 'invalid_profile_name' }, 400);
  }
  const targetId = parts[4]; // undefined when there's no /<id> segment

  try {
    if (request.method === 'GET' && targetId === undefined) {
      return await handleGetTargets(env, profileName);
    }
    if (request.method === 'PUT' && targetId === undefined) {
      return await handlePutTargets(request, env, profileName);
    }
    if (request.method === 'POST' && targetId === undefined) {
      return await handlePostTarget(request, env, profileName);
    }
    if (request.method === 'DELETE' && targetId !== undefined) {
      return await handleDeleteTarget(env, profileName, targetId);
    }
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  } catch (e) {
    console.error('profiles handler failed', e);
    return jsonResponse({ error: 'storage_unavailable' }, 503);
  }
}

async function handleGetTargets(env: Env, profileName: string): Promise<Response> {
  const list = await readTargets(env, profileName);
  return jsonResponse({ targets: list });
}

async function handlePutTargets(
  request: Request,
  env: Env,
  profileName: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (typeof body !== 'object' || body === null) {
    return jsonResponse({ error: 'invalid_payload' }, 400);
  }
  const targets = (body as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) {
    return jsonResponse({ error: 'targets_must_be_array' }, 400);
  }
  if (targets.length > MAX_TARGETS_PER_PROFILE) {
    return jsonResponse(
      { error: 'too_many_targets', max: MAX_TARGETS_PER_PROFILE },
      400,
    );
  }
  // Validate each entry; collect per-index errors so the client can show a
  // useful "row 3: lat_out_of_range" message instead of "something's wrong."
  const errors: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < targets.length; i++) {
    const e = validateTarget(targets[i], profileName);
    if (e) errors.push({ index: i, error: e });
  }
  if (errors.length > 0) {
    return jsonResponse({ error: 'invalid_targets', errors }, 400);
  }
  // Validate duplicate ids — keeps the daemon's downstream union(curated,
  // additions) walk well-defined.
  const seen = new Set<string>();
  for (const t of targets as PersonalTarget[]) {
    if (seen.has(t.id)) {
      return jsonResponse({ error: 'duplicate_id', id: t.id }, 400);
    }
    seen.add(t.id);
  }
  await writeTargets(env, profileName, targets as PersonalTarget[]);
  return jsonResponse({ ok: true, count: targets.length });
}

async function handlePostTarget(
  request: Request,
  env: Env,
  profileName: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  const err = validateTarget(body, profileName);
  if (err) {
    return jsonResponse({ error: 'invalid_target', detail: err }, 400);
  }
  const target = body as PersonalTarget;
  const existing = await readTargets(env, profileName);
  if (existing.length >= MAX_TARGETS_PER_PROFILE) {
    return jsonResponse(
      { error: 'too_many_targets', max: MAX_TARGETS_PER_PROFILE },
      400,
    );
  }
  // Reject duplicate id on append (idempotency: same id is treated as a
  // conflict, not a no-op, because PUT is the explicit "replace" verb).
  if (existing.some((t) => t.id === target.id)) {
    return jsonResponse({ error: 'duplicate_id', id: target.id }, 409);
  }
  const next = [...existing, target];
  await writeTargets(env, profileName, next);
  return jsonResponse({ ok: true, count: next.length });
}

/** DELETE is idempotent: missing id → 200 ok:true, removed:false.
 *  Document this in the design doc risk register; the alternative (404 on
 *  missing) makes retry-on-network-error harder for the frontend, and the
 *  data model has no semantic difference between "never existed" and
 *  "already deleted." */
async function handleDeleteTarget(
  env: Env,
  profileName: string,
  targetId: string,
): Promise<Response> {
  // The path-decoded id can carry URL-encoded chars; decode + re-validate
  // shape so a junk `/api/profiles/x/targets/%2E%2E%2F` can't hit storage.
  let decoded: string;
  try {
    decoded = decodeURIComponent(targetId);
  } catch {
    return jsonResponse({ error: 'invalid_id' }, 400);
  }
  if (!ID_RE.test(decoded)) {
    return jsonResponse({ error: 'invalid_id' }, 400);
  }
  const existing = await readTargets(env, profileName);
  const next = existing.filter((t) => t.id !== decoded);
  if (next.length === existing.length) {
    // Nothing removed; still write nothing (avoid spurious R2 churn).
    return jsonResponse({ ok: true, removed: false, count: existing.length });
  }
  await writeTargets(env, profileName, next);
  return jsonResponse({ ok: true, removed: true, count: next.length });
}
