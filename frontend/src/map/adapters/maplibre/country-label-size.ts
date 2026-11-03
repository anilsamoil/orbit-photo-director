/** Mercator size of lettering that can be a country name.
 *  The shortest audited name is 0.000763 tall (Japan, Nigeria, and Kenya on the dark tile at level 6).
 *  The faint CANADA scrap on the dark level-8 tile is about 36 by 8 screen pixels at view zoom 6.5, which is 0.00017 tall.
 */
export const COUNTRY_LABEL_MIN_MERCATOR = 0.0004;

export function countryLabelCounts(extent: { width: number; height: number }): boolean {
  return extent.width >= COUNTRY_LABEL_MIN_MERCATOR && extent.height >= COUNTRY_LABEL_MIN_MERCATOR;
}

/** A one-pixel touch is not occlusion. The map and the verifier share this rule. */
export function letteringOccluded(
  box: { left: number; top: number; right: number; bottom: number } | readonly number[],
  occlusions: readonly ({ left: number; top: number; right: number; bottom: number } | readonly number[])[],
): boolean {
  const edges = (value: { left: number; top: number; right: number; bottom: number } | readonly number[]) => {
    if ('left' in value) return value;
    return { left: Number(value[0]), top: Number(value[1]), right: Number(value[2]), bottom: Number(value[3]) };
  };
  const ink = edges(box);
  return occlusions.some((entry) => {
    const cover = edges(entry);
    const width = Math.min(ink.right, cover.right) - Math.max(ink.left, cover.left);
    const height = Math.min(ink.bottom, cover.bottom) - Math.max(ink.top, cover.top);
    return width > 1 && height > 1;
  });
}

export function countryLabelCountsScreen(box: readonly number[], zoom: number): boolean {
  const world = 512 * (2 ** zoom);
  return countryLabelCounts({
    width: Math.abs(box[2]! - box[0]!) / world,
    height: Math.abs(box[3]! - box[1]!) / world,
  });
}
