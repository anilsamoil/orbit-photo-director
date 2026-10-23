export type GestureReading = {
  hidden: boolean;
  pending: boolean;
  dragRotate: boolean;
  dragPan: boolean;
  touchZoomRotate: boolean;
  touchPitch: boolean;
  keyboard: boolean;
  rotating: boolean;
  moving: boolean;
  userDriven: boolean;
};

/** A follow write waits while MapLibre reports a user gesture.
 *  A hidden document is not one, and a camera ease counts only when the
 *  user started it. Handler activity is MapLibre's own isActive. */
export function gestureBlocksFollow(reading: GestureReading): boolean {
  if (reading.hidden) return false;
  if (reading.pending || reading.dragRotate || reading.dragPan || reading.touchZoomRotate || reading.touchPitch || reading.keyboard) return true;
  return (reading.rotating || reading.moving) && reading.userDriven;
}
