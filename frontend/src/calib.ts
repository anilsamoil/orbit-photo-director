import type { CalibAction, CalibPayload } from './types';
// Slot 8 (design rev 2): include the active profile name in every calib
// payload so the Worker can scope reads/writes per astronaut. Imported via
// the function to avoid an eager-binding circular dep — main.ts also imports
// from this file, but the ES-module cycle is benign as long as we resolve
// `getCurrentProfile` lazily (call-site, not module-load).
import { getCurrentProfile } from './main';
import { DEFAULT_PROFILE_NAME } from './profile';

const TOKEN_KEY = 'opd-calib-token';
const QUEUE_KEY = 'opd-calib-queue';
const QUEUE_MAX_ENTRIES = 200; // hard cap so localStorage never balloons

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore storage errors */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Should this server status trigger a queued retry, or should we drop?
 *
 *  Queue: network errors, 429, 5xx — recoverable.
 *  Drop:  4xx (except 429) — not recoverable; retrying floods the queue with junk.
 *
 *  Note (v2 token-bug fix 2026-05-27): 401 is intentionally NOT included here.
 *  This helper stays "drop on 401" so other endpoints (profile-api, etc.) keep
 *  their existing fail-fast-on-auth behavior. The calib path has its own
 *  per-call 401 handling inside `postCalib` (queue + distinct toast) — that
 *  scoping is deliberate. Don't add 401 here without also auditing every
 *  caller of `shouldQueueOnStatus`. */
export function shouldQueueOnStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  return false; // 4xx (other than 429) — drop
}

/** POST a calibration record. On retryable failure, queue locally for next visit. */
export async function postCalib(
  payload: CalibPayload,
  baseUrl = ''
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = getToken();
  if (!token) {
    enqueue(payload);
    return { ok: false, reason: 'token_missing' };
  }
  const dedupe = payload.dedupe_key ?? makeDedupeKey(payload);
  const body = { ...payload, dedupe_key: dedupe };
  try {
    const resp = await fetch(`${baseUrl}/api/log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-calib-token': token,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      // v2 token-bug fix (Chris feedback 2026-05-27): on 401, KEEP the token
      // (so the operator can see what's in their field and re-paste/edit) AND
      // queue the payload (well-formed; will succeed once token is corrected).
      // Surfaced as `server_401` so the UI shows a distinct "Token rejected"
      // toast instead of the generic "Server rejected …" message. Per-call
      // scoping: we do NOT add 401 to `shouldQueueOnStatus` — other endpoints
      // (profile-api etc.) should still fail-fast on auth errors.
      if (resp.status === 401) {
        enqueue(body);
        return { ok: false, reason: 'server_401' };
      }
      if (shouldQueueOnStatus(resp.status)) {
        enqueue(body);
      }
      return { ok: false, reason: `server_${resp.status}` };
    }
    return { ok: true };
  } catch {
    enqueue(body);
    return { ok: false, reason: 'network' };
  }
}

/** Read the queued-calibration count without parsing the full payload list.
 *  Drives the topbar "N pending sync" badge. Cheap enough to call every
 *  refresh — readQueue() is one localStorage read + one JSON.parse, and
 *  the queue is bounded at QUEUE_MAX_ENTRIES.
 */
export function queuedCalibCount(): number {
  return readQueue().length;
}

/** Drain queued calibrations on page load. Returns how many were sent successfully. */
export async function drainQueue(baseUrl = ''): Promise<number> {
  const queued = readQueue();
  if (queued.length === 0) return 0;
  let sent = 0;
  const failed: CalibPayload[] = [];
  for (const p of queued) {
    const r = await postCalib(p, baseUrl);
    if (r.ok) {
      sent++;
    } else {
      failed.push(p);
    }
  }
  writeQueue(failed);
  return sent;
}

export function makeDedupeKey(p: CalibPayload): string {
  return `${p.target_id}|${p.pass_time}|${p.action}|${p.rating ?? ''}`;
}

export function buildPayload(
  action: CalibAction,
  targetId: string,
  passTimeIso: string,
  scoreAtTime: number
): CalibPayload {
  // Stamp the active profile so the Worker can route reads per astronaut.
  // Null profile (boot not yet complete, or main.ts has not set it) falls
  // back to DEFAULT_PROFILE_NAME ("anil") — matches the Worker's legacy
  // default so a pre-v1.6.3.0 read of these payloads still surfaces them
  // in the unfiltered list.
  const profile = getCurrentProfile()?.name ?? DEFAULT_PROFILE_NAME;
  return {
    target_id: targetId,
    pass_time: passTimeIso,
    action,
    score_at_time: scoreAtTime,
    profile,
  };
}

// ----- queue helpers (exported for tests) -----

export function enqueue(p: CalibPayload): void {
  const q = readQueue();
  q.push(p);
  // Drop oldest entries when over the cap so localStorage stays bounded.
  // Calibration data is best-effort — the alternative (failing the write) is worse.
  if (q.length > QUEUE_MAX_ENTRIES) {
    q.splice(0, q.length - QUEUE_MAX_ENTRIES);
  }
  writeQueue(q);
}

export function readQueue(): CalibPayload[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as CalibPayload[];
  } catch {
    return [];
  }
}

export function writeQueue(q: CalibPayload[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
}

export function clearQueue(): void {
  try {
    localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* ignore */
  }
}
