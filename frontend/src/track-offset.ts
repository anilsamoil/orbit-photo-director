/** Operator direction cue in the CEO-target-sheet convention:
 *  "{x}° right/left of track" where x = the off-nadir angle.
 *
 *  In LVLH at closest approach the target is abeam (cross-track), so the
 *  off-nadir angle IS the number of degrees right/left of the ground track —
 *  one number carries both how-oblique and how-far-off-track. (Operator/Chris
 *  feedback 2026-06-04: "at closest it's always directly right or left, and the
 *  CEO sheets say 'x degrees Right/Left of track' where x = off-nadir".)
 *
 *  The SIDE comes from which half of the track the target is on: bearing in
 *  [0, 180) → right (starboard), [180, 360) → left (port). The side is robust
 *  to the 30s sampling jitter that makes the bearing MAGNITUDE unreliable at the
 *  closest sample (a sample fore or aft of true-closest is still on the same
 *  side of the track), so we take only the side from the bearing and the
 *  magnitude from off-nadir. The exact fore/aft axis (0/180) falls to a side by
 *  the `< 180` split, but at closest the target is abeam so it never lands there.
 *
 *  Rounds-to-0 off-nadir → "nadir" (the target is directly below; left/right is
 *  meaningless). bearing convention: 0=fore, 90=starboard, 180=aft, 270=port.
 */
export function formatTrackOffset(offNadirDeg: number, relBearingDeg: number): string {
  const deg = Math.round(offNadirDeg);
  if (deg <= 0) return 'nadir';
  const b = ((relBearingDeg % 360) + 360) % 360;
  const side = b < 180 ? 'right' : 'left';
  return `${deg}° ${side} of track`;
}
