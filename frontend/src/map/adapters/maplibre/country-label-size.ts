/** Mercator size of lettering that can be a country name.
 *  The shortest audited name is 0.000763 tall (Japan, Nigeria, and Kenya on the dark tile at level 6).
 *  The faint CANADA scrap on the dark level-8 tile is about 36 by 8 screen pixels at view zoom 6.5, which is 0.00017 tall.
 */
export const COUNTRY_LABEL_MIN_MERCATOR = 0.0004;

export function countryLabelCounts(extent: { width: number; height: number }): boolean {
  return extent.width >= COUNTRY_LABEL_MIN_MERCATOR && extent.height >= COUNTRY_LABEL_MIN_MERCATOR;
}

export function countryLabelCountsScreen(box: readonly number[], zoom: number): boolean {
  const world = 512 * (2 ** zoom);
  return countryLabelCounts({
    width: Math.abs(box[2]! - box[0]!) / world,
    height: Math.abs(box[3]! - box[1]!) / world,
  });
}
