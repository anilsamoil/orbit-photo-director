import type { Manifest, PassEntry, Status, Track } from './types';

export const SNAPSHOT_KEY = 'opd-snapshot';

/** Everything the app needs to boot a usable UI without the network.
 *  Persisted as one localStorage key so reads are O(1) and writes are atomic
 *  (the whole bundle goes in or none of it does — no torn writes between
 *  manifest and the artifacts it points at). */
export interface Snapshot {
  manifest: Manifest;
  top5: PassEntry[];
  top_24h: PassEntry[];
  track: Track;
  status: Status | null;
  /** Wall-clock ms when this snapshot was written. Drives the offline-age
   *  banner escalation (yellow >1h, orange >3h, red >12h). Never used to
   *  invalidate the snapshot — staleness is a UX signal, not a discard rule. */
  savedAt: number;
}

/** Persist the snapshot. Returns true on success, false on quota / write error.
 *  Callers should NOT block UI on the result — a failed snapshot is recoverable
 *  next tick; a thrown exception isn't. */
export function saveSnapshot(snapshot: Snapshot): boolean {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    // QuotaExceededError, SecurityError (private browsing), JSON.stringify
    // throwing on cycles. None should crash the live UI.
    return false;
  }
}

/** Read the snapshot. Returns null on missing, corrupted, or schema-shape failure.
 *  Never throws — a corrupted snapshot is treated identically to no snapshot.
 *  Validates the load-bearing fields (manifest, track, top5, top_24h, savedAt)
 *  so downstream consumers like renderOfflineBanner can deref snap.track.X
 *  without needing their own null guards. */
export function readSnapshot(): Snapshot | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SNAPSHOT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Snapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.manifest || typeof parsed.manifest !== 'object') return null;
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return null;
    if (!parsed.track || typeof parsed.track !== 'object') return null;
    if (!Array.isArray(parsed.top5) || !Array.isArray(parsed.top_24h)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Minutes since the snapshot was written. Returns Infinity if nothing saved
 *  (so callers can treat "no snapshot" as "infinitely old" in age comparisons). */
export function snapshotAgeMinutes(nowMs: number = Date.now()): number {
  const snap = readSnapshot();
  if (!snap) return Infinity;
  return (nowMs - snap.savedAt) / 60_000;
}

/** Test-only: clear the snapshot. Production code should never need this —
 *  the never-discard rule says we always have something to show. */
export function _clearSnapshotForTests(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // ignore
  }
}
