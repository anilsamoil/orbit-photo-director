import type { PassEntry } from './types';

/** Fallback distance threshold (km) used when no profile is present or
 *  the profile is corrupted. Matches the ISS_HORIZON_KM used by the
 *  generator's scoring loop, so the v1 default behavior is unchanged for
 *  first-launchers. */
export const DEFAULT_DISTANCE_THRESHOLD_KM = 1500;

/** Apply the distance threshold to a passes array. Takes the threshold as
 *  an argument so the queue, the upcoming list and the map pins can share
 *  one predicate while each reads the threshold from wherever it already
 *  has it. A non-finite or non-positive threshold disables the filter.
 *
 *  A missing or non-finite nadir_distance_km means the generator could not
 *  compute it. Those passes stay in, and the card renders the
 *  missing-distance state, rather than the pass vanishing with no trace. */
export function filterPassesByDistance(
  passes: PassEntry[],
  thresholdKm: number,
): PassEntry[] {
  if (!Number.isFinite(thresholdKm) || thresholdKm <= 0) return passes;
  return passes.filter((p) => {
    const d = p.nadir_distance_km;
    if (typeof d !== 'number' || !Number.isFinite(d)) return true;
    return d <= thresholdKm;
  });
}
