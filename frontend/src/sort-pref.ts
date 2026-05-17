/** Queue / Upcoming sort-order preference.
 *
 *  Operator feedback (anilsamoilenko, 2026-05-16): "the order to shoot
 *  it is interesting — Blue Origin was first up in queue but next was
 *  something 14 minutes away. It wasn't chronological, is that supposed
 *  to be like that? It seems like chronological in queue would be
 *  better." The generator sorts by score (best opportunity first) per
 *  the operator-primary-action-surface design. But a real operator
 *  using the page first-time finds the temporal jumps confusing — they
 *  expect "what's next on the timeline."
 *
 *  Resolution: default to chronological (operator's intuition), keep
 *  score-sort as an opt-in toggle for when scoring is well-tuned and
 *  the operator wants "best opportunities first" behavior. Single
 *  preference applies to both Queue and Upcoming since they share the
 *  same mental model (same scoring formula, same card shape).
 *
 *  Storage: localStorage so the preference persists across visits.
 *  Default 'time' until the operator explicitly picks 'score'. */

const STORAGE_KEY = 'opd_queue_sort_v1';

export type SortOrder = 'time' | 'score';

/** Default sort order: chronological by closest_approach. Operator-
 *  intuition default; matches "what's next on the timeline" mental
 *  model. The Generator's score-descending output is preserved for the
 *  underlying SELECTION (best 5 within 90 min); this preference only
 *  affects DISPLAY order of the already-selected passes. */
export const DEFAULT_SORT_ORDER: SortOrder = 'time';

/** Read the operator's sort preference. Falls back to chronological on
 *  any error (no localStorage, malformed value, etc.) — never blocks
 *  rendering on storage misbehavior. */
export function getSortOrder(): SortOrder {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'score' || v === 'time') return v;
  } catch {
    // localStorage can throw in private-mode Safari or strict-storage
    // environments. Fall through to default.
  }
  return DEFAULT_SORT_ORDER;
}

/** Persist the operator's sort preference. Silent on failure — the
 *  toggle will still render in its new state for this session even if
 *  the write fails. */
export function setSortOrder(order: SortOrder): void {
  try {
    localStorage.setItem(STORAGE_KEY, order);
  } catch {
    // Swallow; toggle effect persists for the session via the in-DOM
    // class state, just won't survive reload.
  }
}

/** Convenience: read the inverse of the current preference. Useful
 *  for the toggle button's onClick handler (flip + persist + re-render
 *  in one shot). */
export function flipSortOrder(): SortOrder {
  return getSortOrder() === 'time' ? 'score' : 'time';
}

/** Apply the operator's sort preference to a passes array. Pure
 *  function — returns a new sorted array, never mutates input.
 *
 *  - 'time' (default): ascending by closest_approach (earliest first)
 *  - 'score': descending by score (best opportunity first; matches the
 *    generator's emitted order)
 *
 *  Defensive on malformed timestamps: rows with unparseable
 *  closest_approach fall back to score-based comparison so they don't
 *  fly to the top/bottom on NaN. Defensive on missing score: treats
 *  undefined as 0. */
export function sortPassesByOrder<T extends { closest_approach: string; score?: number }>(
  passes: T[],
  order: SortOrder,
): T[] {
  const out = passes.slice();
  if (order === 'time') {
    out.sort((a, b) => {
      const aMs = Date.parse(a.closest_approach);
      const bMs = Date.parse(b.closest_approach);
      if (Number.isNaN(aMs) && Number.isNaN(bMs)) {
        return (b.score ?? 0) - (a.score ?? 0);
      }
      if (Number.isNaN(aMs)) return 1;
      if (Number.isNaN(bMs)) return -1;
      return aMs - bMs;
    });
  } else {
    out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  return out;
}
