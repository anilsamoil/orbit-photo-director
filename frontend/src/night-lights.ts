import { gibsBlackMarbleUrl } from './tile-precache';

export const NIGHT_LIGHTS_MINUTE_MS = 60_000;

/** Stable within a minute; scrubbing backward and forward uses the same mask instant. */
export function nightLightsMinute(atMs: number): number {
  return Math.floor(atMs / NIGHT_LIGHTS_MINUTE_MS) * NIGHT_LIGHTS_MINUTE_MS;
}

/** The source stays the static 2016 composite; only the local solar mask changes. */
export function viirsAlphaUrl(yearIso: string, atMs: number): string {
  return `viirs-alpha://${gibsBlackMarbleUrl(yearIso)}?night=${nightLightsMinute(atMs)}`;
}

/** No city-light emission in daylight; full intensity three degrees into night. */
export function nightLightsFade(elevationDegrees: number): number {
  const t = Math.min(1, Math.max(0, -elevationDegrees / 3));
  return t * t * (3 - 2 * t);
}
