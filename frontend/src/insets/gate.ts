/** Both axes. Width alone lets an iPhone 17 Pro landscape through and drops iPad portrait. */
export const INSET_MIN_PX = 800;

export function insetViewportFits(widthPx: number, heightPx: number): boolean {
  return widthPx >= INSET_MIN_PX && heightPx >= INSET_MIN_PX;
}
