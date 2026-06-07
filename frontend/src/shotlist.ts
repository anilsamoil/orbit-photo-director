/** Shot-list: the passes the operator has picked to be reminded about.
 *
 *  Stored in localStorage as self-contained records (not just keys) so the .ics
 *  can be built even after a pass scrolls out of the loaded Queue/Upcoming
 *  lists — the selection is the source of truth, independent of what's currently
 *  rendered. Mirrors the defensive localStorage pattern in sort-pref.ts: every
 *  read/write is try/caught so private-mode Safari or strict-storage never
 *  blocks rendering.
 *
 *  A pass is identified by (target_id, closest_approach) — a target can have
 *  several passes a day, each its own reminder.
 */
import type { PassEntry } from './types';

const STORAGE_KEY = 'opd_shotlist_v1';
const SEQ_KEY = 'opd_shotlist_seq_v1';

/** The minimal pass data the .ics builder needs. Kept small — this is what we
 *  persist per selected pass. */
export interface ShotlistEntry {
  key: string; // `${target_id}|${closest_approach}`
  target_id: string;
  target_name: string;
  closest_approach: string; // ISO 8601 Z
  angle_off_nadir_deg?: number;
  iss_relative_bearing_deg?: number;
}

/** Stable per-pass key. */
export function passKey(p: { target_id: string; closest_approach: string }): string {
  return `${p.target_id}|${p.closest_approach}`;
}

function readRaw(): ShotlistEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: keep only well-formed records (a hand-edited or partially
    // written store shouldn't crash the export).
    return parsed.filter(
      (e): e is ShotlistEntry =>
        !!e &&
        typeof (e as ShotlistEntry).key === 'string' &&
        typeof (e as ShotlistEntry).target_id === 'string' &&
        typeof (e as ShotlistEntry).target_name === 'string' &&
        typeof (e as ShotlistEntry).closest_approach === 'string',
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: ShotlistEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Swallow — the in-memory/DOM state still reflects the toggle for this
    // session, it just won't survive reload.
  }
}

function toEntry(p: PassEntry): ShotlistEntry {
  return {
    key: passKey(p),
    target_id: p.target_id,
    target_name: p.target_name,
    closest_approach: p.closest_approach,
    angle_off_nadir_deg: p.angle_off_nadir_deg,
    iss_relative_bearing_deg: p.iss_relative_bearing_deg,
  };
}

/** Is this pass in the shot-list? */
export function isInShotlist(p: { target_id: string; closest_approach: string }): boolean {
  const k = passKey(p);
  return readRaw().some((e) => e.key === k);
}

/** Toggle a pass in/out of the shot-list. Returns the NEW membership state
 *  (true = now selected). */
export function toggleShotlist(p: PassEntry): boolean {
  const k = passKey(p);
  const cur = readRaw();
  const idx = cur.findIndex((e) => e.key === k);
  if (idx >= 0) {
    cur.splice(idx, 1);
    writeRaw(cur);
    return false;
  }
  cur.push(toEntry(p));
  writeRaw(cur);
  return true;
}

/** All selected entries (raw, unpruned). */
export function getShotlist(): ShotlistEntry[] {
  return readRaw();
}

/** Count of selected passes (after pruning past ones). */
export function shotlistCount(nowMs: number): number {
  return pruneExpired(nowMs).length;
}

export function clearShotlist(): void {
  writeRaw([]);
}

/** Drop passes whose at-time reminder has already passed and persist the
 *  pruned list. Returns the surviving entries. A pass exactly at `nowMs` is
 *  dropped (its reminders are moot). */
export function pruneExpired(nowMs: number): ShotlistEntry[] {
  const cur = readRaw();
  const kept = cur.filter((e) => {
    const ms = Date.parse(e.closest_approach);
    return !Number.isNaN(ms) && ms > nowMs;
  });
  if (kept.length !== cur.length) writeRaw(kept);
  return kept;
}

/** Monotonic export counter for VEVENT SEQUENCE — incremented and persisted on
 *  each export so a re-imported .ics UPDATES same-UID events rather than
 *  duplicating them. */
export function nextSequence(): number {
  let n = 0;
  try {
    const raw = localStorage.getItem(SEQ_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    if (Number.isFinite(parsed) && parsed >= 0) n = parsed;
  } catch {
    /* default 0 */
  }
  const next = n + 1;
  try {
    localStorage.setItem(SEQ_KEY, String(next));
  } catch {
    /* best-effort */
  }
  return next;
}
