/** Profile-target CRUD uses the map's Google session. No separate browser
 * key is needed. Redirects and malformed receipts are failures so optimistic
 * edits roll back instead of being acknowledged without server persistence.
 */
import type { PersonalTarget } from './profile';

const SESSION_REQUEST: RequestInit = {
  credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
};

/** Standard discriminated result. Successful flows return the parsed
 *  body shape; failures carry a stable `reason` and optional HTTP status
 *  / detail string so the toast layer can show a useful message. */
export type ApiResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; reason: 'authentication' | 'network' | 'http' | 'validation'; status?: number; detail?: string };

/** Fetch the current personal-target list for a profile (GET).
 *  Slot 6b — used by the Profile pane's first-render hydration so that
 *  a fresh device (empty localStorage) sees the targets the server
 *  already holds. The Worker handler (worker/src/profiles.ts) returns
 *  `{ ok: true, targets: PersonalTarget[] }`. */
export async function getProfileTargets(
  profileName: string,
  baseUrl = '',
): Promise<ApiResult<{ targets: PersonalTarget[] }>> {
  try {
    const resp = await fetch(`${baseUrl}/api/browser/profiles/${profileName}/targets`, {
      ...SESSION_REQUEST, method: 'GET',
    });
    const parsed = await parseJsonResult<{ targets: PersonalTarget[] }>(resp, false);
    if (!parsed.ok) return parsed;
    if (!Array.isArray(parsed.data?.targets)) {
      return { ok: false, reason: 'http', status: resp.status, detail: 'invalid_response' };
    }
    return { ok: true, data: { targets: parsed.data.targets } };
  } catch (e) {
    return { ok: false, reason: 'network', detail: errMsg(e) };
  }
}

/** Replace the entire target list for a profile (PUT). Used by
 *  bootstrap-style flows + as a recovery path. */
export async function putProfileTargets(
  profileName: string,
  targets: PersonalTarget[],
  baseUrl = '',
): Promise<ApiResult<{ count: number }>> {
  try {
    const resp = await fetch(`${baseUrl}/api/browser/profiles/${profileName}/targets`, {
      ...SESSION_REQUEST, method: 'PUT',
      headers: { 'content-type': 'application/json' },
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
  try {
    const resp = await fetch(`${baseUrl}/api/browser/profiles/${profileName}/targets`, {
      ...SESSION_REQUEST, method: 'POST',
      headers: { 'content-type': 'application/json' },
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
  try {
    // Path-encode the id; the worker's DELETE decodes + re-validates shape.
    const resp = await fetch(
      `${baseUrl}/api/browser/profiles/${profileName}/targets/${encodeURIComponent(targetId)}`,
      { ...SESSION_REQUEST, method: 'DELETE' },
    );
    return await parseJsonResult<{ removed: boolean; count: number }>(resp);
  } catch (e) {
    return { ok: false, reason: 'network', detail: errMsg(e) };
  }
}

/** Parse a Response into the discriminated ApiResult shape. Non-OK
 *  responses are categorized: 4xx that match the worker's `invalid_*`
 *  surfaces become `validation`; everything else (incl. 5xx) is `http`.
 *  Missing or malformed success receipts return `http` with "invalid_response". */
async function parseJsonResult<T>(resp: Response, writeReceipt = true): Promise<ApiResult<T>> {
  if (resp.type === 'opaqueredirect' || resp.redirected || resp.status === 401
    || (resp.status >= 300 && resp.status < 400)) {
    return { ok: false, reason: 'authentication', status: resp.status, detail: 'sign_in_required' };
  }
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
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (writeReceipt && (body as { ok?: unknown }).ok !== true)) {
    return { ok: false, reason: 'http', status: resp.status, detail: 'invalid_response' };
  }
  return { ok: true, data: body as T };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
