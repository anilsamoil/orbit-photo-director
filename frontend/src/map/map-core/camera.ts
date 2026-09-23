import type { InitialCamera } from './vendor-map';

/** Width the operator tuned the initial framing against (iPad-class viewport). */
const MAP_REFERENCE_WIDTH_PX = 1024;
/** Zoom that felt right at MAP_REFERENCE_WIDTH_PX — see the 2026-05-17 note. */
const MAP_REFERENCE_ZOOM = 2;

/** Initial zoom that shows the same slice of Earth regardless of screen width.
 *
 *  Web-mercator zoom is independent of viewport size: at z=2 the world is
 *  512*2^2 = 2048px across, so a 1024px iPad sees half the globe while a 390px
 *  iPhone sees 19% of it. Same zoom number, wildly different framing — which is
 *  why the map read as over-zoomed on iPhone (operator report 2026-08-24) while
 *  looking correct on iPad. Scaling by log2(width/reference) holds the visible
 *  fraction constant instead of the zoom number.
 *
 *  Clamped at MAP_REFERENCE_ZOOM on the upper end so iPad and desktop keep
 *  exactly the framing they have today; only narrower screens widen out.
 */
export function initialZoomForViewport(widthPx: number): number {
  const w = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : MAP_REFERENCE_WIDTH_PX;
  const scaled = MAP_REFERENCE_ZOOM + Math.log2(w / MAP_REFERENCE_WIDTH_PX);
  return Math.min(MAP_REFERENCE_ZOOM, Math.max(0, scaled));
}

/** center [0,0] is deliberate: the first recenter comes from main.ts's 1Hz
 *  applyFollowISS tick, not from construction.
 *
 *  z=1.5 fit the whole world but made panning feel like a no-op (you were
 *  already at the edge of the visible tile space). z=2 leaves room to drag
 *  without losing the "see the orbit at a glance" affordance. Operator
 *  reported 2026-05-17 pan felt locked at z=1.5.
 */
export function initialCamera(viewportWidthPx: number): InitialCamera {
  return { center: [0, 0], zoom: initialZoomForViewport(viewportWidthPx) };
}
