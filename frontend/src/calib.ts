import type { CalibAction, CalibPayload } from './types';

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
 *  401:   special — also clear the token so the user gets the setup banner.
 */
function shouldQueueOnStatus(status: number): boolean {
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
      if (resp.status === 401) {
        // Token rejected; clear it so the next page load surfaces the setup banner.
        clearToken();
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
  return {
    target_id: targetId,
    pass_time: passTimeIso,
    action,
    score_at_time: scoreAtTime,
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
