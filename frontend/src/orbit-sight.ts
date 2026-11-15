import { formatUtcHm } from './countdown';
import { propagateIssDetailed } from './iss-sgp4';
import type { Track } from './types';

const EARTH_RADIUS_KM = 6378.137;
const STEP_MS = 30_000;
export const SIGHT_HORIZON_HOURS = 24;

/** One stretch during which the straight line from the ISS to another
 *  object clears the Earth. Geometry only: it says nothing about sunlight. */
export type SightWindow = {
  readonly startMs: number;
  readonly endMs: number;
  readonly closestMs: number;
  readonly closestKm: number;
};

type Vec = readonly [number, number, number];

function positionKm(track: Track, atMs: number): Vec | null {
  const fix = propagateIssDetailed(track, atMs);
  if (!fix.ok) return null;
  const r = EARTH_RADIUS_KM + fix.alt_km;
  const lat = (fix.lat * Math.PI) / 180;
  const lon = (fix.lon * Math.PI) / 180;
  return [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
}

/** Range in km when the segment between the two points stays above the
 *  Earth's surface, else null. */
export function clearRangeKm(a: Vec, b: Vec): number | null {
  const d: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (dd === 0) return 0;
  const t = Math.min(1, Math.max(0, -(a[0] * d[0] + a[1] * d[1] + a[2] * d[2]) / dd));
  const nearest = Math.hypot(a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]);
  return nearest >= EARTH_RADIUS_KM ? Math.sqrt(dd) : null;
}

/** Line-of-sight windows from the ISS to `other`, sampled every 30 s from
 *  `fromMs`. A window still open at the horizon ends at the horizon. */
export function issSightWindows(
  iss: Track,
  other: Track,
  fromMs: number,
  hours: number = SIGHT_HORIZON_HOURS,
): SightWindow[] {
  const windows: SightWindow[] = [];
  const untilMs = fromMs + hours * 3_600_000;
  let open: { startMs: number; lastMs: number; closestMs: number; closestKm: number } | null = null;
  const close = (): void => {
    if (!open) return;
    windows.push({ startMs: open.startMs, endMs: open.lastMs, closestMs: open.closestMs, closestKm: open.closestKm });
    open = null;
  };
  for (let atMs = fromMs; atMs <= untilMs; atMs += STEP_MS) {
    const a = positionKm(iss, atMs);
    const b = a ? positionKm(other, atMs) : null;
    const range = a && b ? clearRangeKm(a, b) : null;
    if (range === null) {
      close();
      continue;
    }
    if (!open) open = { startMs: atMs, lastMs: atMs, closestMs: atMs, closestKm: range };
    open.lastMs = atMs;
    if (range < open.closestKm) {
      open.closestKm = range;
      open.closestMs = atMs;
    }
  }
  close();
  return windows;
}

function km(value: number): string {
  return `${Math.round(value).toLocaleString('en-US')} km`;
}

/** One line for the picker row: the open window, else the next one. A
 *  window still open at the 24 h horizon has no end time to give. */
export function sightText(windows: readonly SightWindow[], nowMs: number): string {
  const next = windows.find((window) => window.endMs >= nowMs);
  if (!next) return `No ISS line of sight in the next ${SIGHT_HORIZON_HOURS} h`;
  const closest = `closest ${km(next.closestKm)} at ${formatUtcHm(next.closestMs)}`;
  const open = next.startMs <= nowMs;
  if (next.endMs >= nowMs + SIGHT_HORIZON_HOURS * 3_600_000) {
    const span = `for the next ${SIGHT_HORIZON_HOURS} h or longer`;
    return open
      ? `In ISS line of sight now and ${span}, ${closest}`
      : `ISS line of sight from ${formatUtcHm(next.startMs)} ${span}, ${closest}`;
  }
  if (open) return `In ISS line of sight now until ${formatUtcHm(next.endMs)}, ${closest}`;
  return `ISS line of sight ${formatUtcHm(next.startMs)} to ${formatUtcHm(next.endMs)}, ${closest}`;
}
