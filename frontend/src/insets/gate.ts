/** Portrait phones are narrower than this. iPad Pro 11 portrait is 834. */
export const INSET_MIN_WIDTH_PX = 800;

/** Safari on iPad landscape is about 710 tall, and a 1280×800 laptop window is about 700. Phone landscape stays under 440. */
export const INSET_MIN_HEIGHT_PX = 600;

export function insetViewportFits(widthPx: number, heightPx: number): boolean {
  return widthPx >= INSET_MIN_WIDTH_PX && heightPx >= INSET_MIN_HEIGHT_PX;
}
