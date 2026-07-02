/** Tiny in-memory shot-count store shared between the Profile-pane CRUD list
 *  and the map target popup. The Profile pane fetches /api/log once per session
 *  and aggregates `shoot` events by target_id; it publishes the result here so
 *  the map popup can answer Jack's "have I shot it yet?" WITHOUT a log fetch on
 *  every tap (review R12). Kept dependency-free so neither the map chunk nor the
 *  profile chunk pulls the other's heavy module graph.
 *
 *  Keyed flat by target_id (curated AND personal targets are both shootable, and
 *  the active operator is single at a time), replaced wholesale when the active
 *  profile's counts load — switching profiles re-publishes on the new Profile
 *  pane mount. Absence means "no data" (quiet), never "never shot". */
let counts = new Map<string, number>();
const mapFetched = new Set<string>();

/** Publish the active profile's `target_id → shoot count` map (replaces prior). */
export function publishShotCounts(next: Map<string, number>): void {
  counts = next;
}

/** Shoot count for a target, or 0 when unknown. */
export function getShotCount(targetId: string): number {
  return counts.get(targetId) ?? 0;
}

/** Aggregate `/api/log` entries into a `target_id → shoot count` map. Pure, so
 *  both the Profile pane and the Map (main.ts, on first Map-tab open) build the
 *  counts the same way without importing each other. Only `shoot` events count. */
export function aggregateShootCounts(
  entries: ReadonlyArray<{ action: string; target_id: string }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.action !== 'shoot') continue;
    out.set(e.target_id, (out.get(e.target_id) ?? 0) + 1);
  }
  return out;
}

/** Claim the Map's once-per-session shot-count fetch for a profile. Returns true
 *  the first time (caller should fetch + publish), false after. Independent from
 *  the Profile pane's own guard — at most one extra /api/log fetch per session
 *  so the map popup can answer "have I shot it yet" before Profile is opened. */
export function claimMapShotFetch(profile: string): boolean {
  if (mapFetched.has(profile)) return false;
  mapFetched.add(profile);
  return true;
}

/** Test-only reset. */
export function _resetShotCountsForTest(): void {
  counts = new Map();
  mapFetched.clear();
}
