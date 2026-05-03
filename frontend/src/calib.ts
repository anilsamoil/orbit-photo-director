import type { CalibAction, CalibPayload } from './types';

const TOKEN_KEY = 'opd-calib-token';
const QUEUE_KEY = 'opd-calib-queue';

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

/** POST a calibration record. On network failure, queue locally for retry on next page load. */
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
      enqueue(body);
      return { ok: false, reason: `server_${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    enqueue(body);
    return { ok: false, reason: 'network' };
  }
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
