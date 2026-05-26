/** Profile-targets API client — Slot 6 of design rev 2 (2026-05-26).
 *
 *  Thin wrapper over the Worker's `/api/profiles/<name>/targets` CRUD
 *  routes (Slot 3). Each call:
 *    - reads the calib token from localStorage (`opd-calib-token`, same
 *      shared secret the Shoot/Skip path uses)
 *    - sends `x-calib-token` header + JSON body
 *    - returns a discriminated `Result` the caller can switch on
 *
 *  The UI layer (profile-crud.ts) owns the optimistic-UI flow: mutate
 *  localStorage first, fire one of these calls, rollback on failure. So
 *  this module deliberately stays pure — no localStorage writes, no DOM,
 *  no toast. Returns network errors AND 4xx/5xx as `{ ok: false, ... }`
 *  with a stable `reason` discriminant so the caller's rollback path is
 *  branch-once.
 */

import type { PersonalTarget } from './profile';

/** Localized token reader — duplicated (not imported from calib.ts) so
 *  this module stays free of the calib.ts ↔ main.ts circular dependency.
 *  Same TOKEN_KEY string. If the token is missing OR localStorage throws
 *  (private-mode Safari), returns null and callers short-circuit with a
 *  `token_missing` reason. */
const TOKEN_KEY = 'opd-calib-token';
function readCalibToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Standard discriminated result. Successful flows return the parsed
 *  body shape; failures carry a stable `reason` and optional HTTP status
 *  / detail string so the toast layer can show a useful message. */
export type ApiResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; reason: 'token_missing' | 'network' | 'http' | 'validation'; status?: number; detail?: string };

/** Replace the entire target list for a profile (PUT). Used by
 *  bootstrap-style flows + as a recovery path. */
export async function putProfileTargets(
  profileName: string,
  targets: PersonalTarget[],
  baseUrl = '',
): Promise<ApiResult<{ count: number }>> {
  const token = readCalibToken();
  if (!token) return { ok: false, reason: 'token_missing' };
  try {
    const resp = await fetch(`${baseUrl}/api/profiles/${profileName}/targets`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-calib-token': token },
      body: JSON.stringify({ targets }),
    });
    return await parseJsonResult<{ count: number }>(resp);
  } catch (e) {
    return { ok: false, reason: 'network', detail: errMsg(e) };
  }
}

/** Append a single personal target (POST). Used by the Add-target form. */
export async function postProfileTarget(
  profileName: string,
  target: PersonalTarget,
  baseUrl = '',
): Promise<ApiResult<{ count: number }>> {
  const token = readCalibToken();
  if (!token) return { ok: false, reason: 'token_missing' };
  try {
    const resp = await fetch(`${baseUrl}/api/profiles/${profileName}/targets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-calib-token': token },
      body: JSON.stringify(target),
    });
    return await parseJsonResult<{ count: number }>(resp);
  } catch (e) {
    return { ok: false, reason: 'network', detail: errMsg(e) };
  }
}

/** Delete a single personal target by id (DELETE). DELETE is idempotent
 *  on the server (missing id → 200 ok:true, removed:false). */
export async function deleteProfileTarget(
  profileName: string,
  targetId: string,
  baseUrl = '',
): Promise<ApiResult<{ removed: boolean; count: number }>> {
  const token = readCalibToken();
  if (!token) return { ok: false, reason: 'token_missing' };
  try {
    // Path-encode the id; the worker's DELETE decodes + re-validates shape.
    const resp = await fetch(
      `${baseUrl}/api/profiles/${profileName}/targets/${encodeURIComponent(targetId)}`,
      { method: 'DELETE', headers: { 'x-calib-token': token } },
    );
    return await parseJsonResult<{ removed: boolean; count: number }>(resp);
  } catch (e) {
    return { ok: false, reason: 'network', detail: errMsg(e) };
  }
}

/** Parse a Response into the discriminated ApiResult shape. Non-OK
 *  responses are categorized: 4xx that match the worker's `invalid_*`
 *  surfaces become `validation`; everything else (incl. 5xx) is `http`.
 *  Body parse failures degrade to `http` with detail "bad_json". */
async function parseJsonResult<T>(resp: Response): Promise<ApiResult<T>> {
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  if (!resp.ok) {
    const err = (body && typeof body === 'object' && 'error' in body)
      ? String((body as { error: unknown }).error)
      : '';
    const isValidation = err.startsWith('invalid_')
      || err === 'targets_must_be_array'
      || err === 'too_many_targets'
      || err === 'duplicate_id';
    return {
      ok: false,
      reason: isValidation ? 'validation' : 'http',
      status: resp.status,
      detail: err || `http_${resp.status}`,
    };
  }
  return { ok: true, data: (body as T) ?? ({} as T) };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
