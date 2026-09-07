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
  return sendCalib(payload, baseUrl, true);
}

async function sendCalib(
  payload: CalibPayload,
  baseUrl: string,
  queueFailures: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = getToken();
  const dedupe = payload.dedupe_key ?? makeDedupeKey(payload);
  const body = { ...payload, dedupe_key: dedupe };
  const keep = () => { if (queueFailures) enqueue(body); };
  try {
    const resp = await fetch(`${baseUrl}/api/log`, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-calib-token': token } : {}),
      },
      body: JSON.stringify(body),
    });
    if (resp.type === 'opaqueredirect' || resp.status >= 300 && resp.status < 400) {
      keep();
      return { ok: false, reason: 'sign_in_required' };
    }
    if (!resp.ok) {
      // Expired Access sessions must not discard a well-formed rating.
      if (resp.status === 401 || resp.status === 403) {
        keep();
        return { ok: false, reason: `server_${resp.status}` };
      }
      if (shouldQueueOnStatus(resp.status)) {
        keep();
      }
      return { ok: false, reason: `server_${resp.status}` };
    }
    // An Access login page can be HTTP200. Only an API receipt confirms a save.
    let receipt: { ok?: boolean } | null = null;
    try { receipt = await resp.json(); } catch { /* keep the queued record */ }
    if (receipt?.ok !== true) {
      keep();
      return { ok: false, reason: 'sign_in_required' };
    }
    return { ok: true };
  } catch {
    keep();
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
let drainPromise: Promise<number> | null = null;
export function drainQueue(baseUrl = ''): Promise<number> {
  if (!drainPromise) drainPromise = drainQueued(baseUrl).finally(() => { drainPromise = null; });
  return drainPromise;
}

async function drainQueued(baseUrl: string): Promise<number> {
  const queued = readQueue();
  if (queued.length === 0) return 0;
  let sent = 0;
  for (const p of queued) {
    const r = await sendCalib(p, baseUrl, false);
    if (r.ok) {
      sent++;
      // Preserve records added while this request was in flight.
      const latest = readQueue();
      const index = latest.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(p));
      if (index >= 0) {
        latest.splice(index, 1);
        writeQueue(latest);
      }
    }
  }
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
