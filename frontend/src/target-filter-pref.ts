/** "All targets" vs "Mine only" display filter.
 *
 *  Astronauts add personal targets but the Queue / Upcoming / Map pool them
 *  with the shared curated set, so a personal target can sit below the
 *  top-N cutoff and feel "missing" (Jack feedback 2026-06-01). This filter
 *  lets the operator collapse the view to just their own targets.
 *
 *  Storage: localStorage so the choice persists across visits. Mirrors
 *  sort-pref.ts — same defensive try/catch (private-mode Safari throws on
 *  localStorage access) and the same "never block render on a bad value"
 *  contract.
 */

export type TargetFilter = 'all' | 'mine';

const STORAGE_KEY = 'opd_target_filter_v1';

/** Read the saved filter. Defaults to 'all' on first visit or any error. */
export function getTargetFilter(): TargetFilter {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'mine' ? 'mine' : 'all';
  } catch {
    return 'all';
  }
}

/** Persist the filter. Best-effort — a storage failure is swallowed so the
 *  in-session toggle still works even when persistence can't. */
export function setTargetFilter(filter: TargetFilter): void {
  try {
    localStorage.setItem(STORAGE_KEY, filter);
  } catch {
    /* private-mode Safari / strict-storage — ignore, session-only */
  }
}

/** A pass belongs to the active astronaut's own list when its target_id
 *  carries the personal-target prefix `personal:<profile>:<token>`. Curated
 *  / auto-loaded targets use bare kebab-case ids, so the prefix is an exact
 *  discriminator. */
export function isPersonalPass(pass: { target_id?: string }): boolean {
  return typeof pass.target_id === 'string' && pass.target_id.startsWith('personal:');
}

/** Filter a pass list to the operator's own targets when 'mine' is active;
 *  pass everything through for 'all'. Generic so it works on PassEntry and
 *  any structurally-compatible shape (map features, etc.). */
export function applyTargetFilter<T extends { target_id?: string }>(
  passes: T[],
  filter: TargetFilter,
): T[] {
  if (filter !== 'mine') return passes;
  return passes.filter(isPersonalPass);
}
