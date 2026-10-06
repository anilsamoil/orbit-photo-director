/** Imagery above the GIBS level-8 tile is overzoom. */
export const MIN_OPTICAL_FOV_DEG = 2;

/** Town names are in a separate chunk. Load it once the field is this narrow. */
export const TOWN_LABEL_FOV_DEG = 18;

export function clampOpticalFov(value: number, lensFovDeg: number, fallback: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(lensFovDeg)) return fallback;
  const floor = Math.min(MIN_OPTICAL_FOV_DEG, lensFovDeg);
  return Math.min(lensFovDeg, Math.max(floor, value));
}
