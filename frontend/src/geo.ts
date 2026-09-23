/** Shared geographic primitives. Pure, no imports, no I/O — safe for any
 *  module to depend on without pulling a bundle behind it. */

/** Wrap longitude to [-180, 180]. */
export function wrapLon(lon: number): number {
  let v = lon;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}
