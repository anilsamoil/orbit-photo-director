/** Empty-Queue disambiguator (V4-P3 from TODOS.md line 160).
 *
 *  An empty Queue can mean two very different things to the operator:
 *    1. Orbital geometry — there genuinely are no qualifying passes in
 *       the next 90 minutes. Wait it out or check Upcoming for what's
 *       further ahead.
 *    2. Generator lag — the manifest is so old that every pick it
 *       contained has aged past its 90-min Queue window. Picks ARE
 *       coming, the generator just hasn't ticked recently.
 *
 *  Today the UI shows "No passes in the next 90 minutes." in both
 *  cases. This module returns a more specific hint when staleness is
 *  the unambiguous cause — manifests at 90+ min have by definition
 *  outlived every pick they could possibly serve to the Queue.
 *
 *  Pairs with the existing isStaleManifest banner (60 min threshold).
 *  90 min is intentionally a higher bar than the banner: the banner
 *  warns about "data may be slightly stale"; this hint says "Queue
 *  emptiness is BECAUSE of staleness, not geometry."
 */

import type { Manifest } from './types';

/** Generator cron cadence in minutes. Matches the hourly tick documented
 *  in scripts/deploy.sh and generator/daemon.py. Defines how we project
 *  the next-expected-update time off `generated_at`. */
const GENERATOR_TICK_INTERVAL_MIN = 60;

/** Threshold past which empty Queue = stale-manifest-induced. A pick is
 *  good for at most 90 minutes in the Queue tab (closest_approach >
 *  now within 90 min), so a manifest older than this has by definition
 *  had every pick age out of the Queue's window. */
export const EMPTY_HINT_THRESHOLD_MIN = 90;

/** Returns a hint string to override the default "No passes in the next
 *  90 minutes." copy when the Queue's emptiness is caused by manifest
 *  staleness rather than orbital geometry. Returns null in the normal
 *  fresh-manifest case so the default copy fires.
 *
 *  Pure function. Time-independent (takes `nowMs` rather than reading
 *  Date.now()) so tests can pin time. NaN-tolerant on `generated_at`. */
export function emptyQueueHint(manifest: Manifest, nowMs: number): string | null {
  const generated = Date.parse(manifest.generated_at);
  if (Number.isNaN(generated)) return null;
  const ageMin = Math.floor((nowMs - generated) / 60000);
  if (ageMin < EMPTY_HINT_THRESHOLD_MIN) return null;
  // Next tick projection: hourly cadence from generated_at. If we're
  // already past the expected next tick (ageMin > 60), the modulo wraps
  // to the next expected boundary — i.e. how long until the GENERATOR's
  // next cron fire-up should land a fresh manifest.
  const minsToNext = GENERATOR_TICK_INTERVAL_MIN - (ageMin % GENERATOR_TICK_INTERVAL_MIN);
  return `Manifest is ${formatAge(ageMin)} stale — generator has been slow. Next update due in ${minsToNext}m.`;
}

/** Format minutes as "Nm" or "Nh Mm" / "Nh". Drops the minutes word when
 *  exactly on the hour ("2h" not "2h 0m"). Used in the hint string. */
function formatAge(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
