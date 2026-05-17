/** Score → 5-star conversion for Queue + Upcoming card display.
 *
 *  Operator feedback (anilsamoilenko, in-flight iPhone 2026-05-16):
 *  "It might be better to convert the score to a five-star rating so it
 *  corresponds to the set token rating we give it." The 0-100 raw score
 *  is ambiguous ("is 26 good?"), mismatched with the 1-5 calibration
 *  rating scale the operator uses after shooting, and forces the operator
 *  to learn what each number means.
 *
 *  This module converts the underlying 0-100 score (from
 *  generator/score.py) to a 1-5 star tier for display only. The raw
 *  score stays in the artifact (top5.json, top_24h.json) and in the
 *  calibration log (`score_at_time`), so the prediction-vs-rating
 *  comparison v1.2.5.1+ can compare aligned 1-5 scales.
 *
 *  Thresholds (locked via /plan-eng-review 2026-05-17, D1):
 *    score ≥ 75    → 5★  excellent (clear cloud, prime regime, close
 *                       nadir, high priority — all components firing)
 *    50 ≤ score   → 4★  solid (one component middling)
 *    30 ≤ score   → 3★  worth knowing (multiple components middling)
 *    15 ≤ score   → 2★  marginal
 *    score < 15   → 1★  poor
 *
 *  Inclusive on the lower bound, exclusive on the upper — Codex's plan
 *  review flagged the original spec as ambiguous. Tunable as we learn
 *  from calibration data accumulating in the CALIB R2 bucket.
 */

/** Stars tier thresholds (lower-bound-inclusive). Named constants so
 *  retuning is a one-line edit rather than scattered magic numbers. */
export const STAR_THRESHOLDS = {
  five: 75,
  four: 50,
  three: 30,
  two: 15,
} as const;

/** Convert a 0-100 generator score to a 1-5 star tier.
 *
 *  Defensive on invalid input: NaN, undefined, negative, and missing
 *  values all collapse to 1★ rather than throwing or returning NaN —
 *  card rendering should never break on a malformed score field. Values
 *  >100 clamp to 5★ (shouldn't happen post-clamping in the generator
 *  but defensive in case of future schema changes).
 */
export function scoreToStars(score: number | undefined | null): number {
  if (score == null || !Number.isFinite(score)) return 1;
  if (score < 0) return 1;
  if (score >= STAR_THRESHOLDS.five) return 5;
  if (score >= STAR_THRESHOLDS.four) return 4;
  if (score >= STAR_THRESHOLDS.three) return 3;
  if (score >= STAR_THRESHOLDS.two) return 2;
  return 1;
}

/** Render a star block as an accessible HTMLSpanElement. Filled stars
 *  for the count, hollow stars for the remainder. Includes aria-label
 *  so screen readers say "3 of 5 stars" rather than reading the unicode
 *  glyphs literally (Codex review caught this gap).
 *
 *  Uses the same star glyphs (★ / ☆) as the rate modal's star-btn UI
 *  in calib.ts so the predicted-stars and rated-stars feel like the
 *  same scale to the operator.
 */
export function renderStarBlock(stars: number, maxStars = 5): HTMLSpanElement {
  const clamped = Math.max(1, Math.min(maxStars, Math.round(stars)));
  const span = document.createElement('span');
  span.className = 'score-stars';
  span.setAttribute('aria-label', `${clamped} of ${maxStars} stars`);
  span.setAttribute('role', 'img');
  span.textContent = '★'.repeat(clamped) + '☆'.repeat(maxStars - clamped);
  return span;
}

/** Word anchor for a star tier — addresses Codex's "3 stars alone lacks
 *  anchor" concern by attaching a short adjective in places where space
 *  permits (currently the breakdown panel header). The headline stays
 *  star-only to keep the card compact. */
export function starsToLabel(stars: number): string {
  switch (stars) {
    case 5: return 'excellent';
    case 4: return 'solid';
    case 3: return 'worth knowing';
    case 2: return 'marginal';
    default: return 'poor';
  }
}
