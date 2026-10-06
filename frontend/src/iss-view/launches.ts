import { RENDER_RADIUS_M } from '../iss-g1/model';
import { operatorLaunchLines } from '../launch-card';
import { greatCircleBearingDeg } from '../pin-drop';
import { hasLaunchTimeConflict, selectLaunches, type LaunchSelection } from '../launch-selectors';
import type { LaunchOpportunity } from '../launch-schema';
import type { LaunchState } from '../launch-store';

export type LaunchSite = {
  eventId: string;
  name: string;
  siteName: string;
  lat: number;
  lon: number;
  corridor: readonly { lat: number; lon: number }[] | null;
};

export type LaunchScreen = { x: number; y: number };

export type LaunchPin = {
  eventId: string;
  name: string;
  siteName: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
};

export type LaunchArrow = {
  eventId: string;
  name: string;
  siteName: string;
  x: number;
  y: number;
  deg: number;
};

export type LaunchVisibility =
  | 'Site in frame'
  | 'Site outside frame'
  | 'Site below horizon'
  | 'View unavailable';

export type LaunchTimeFact = {
  label: 'Launch window' | 'NET, tentative';
  text: string;
};

export type LaunchMark = {
  visibility: LaunchVisibility;
  pin: LaunchPin | null;
  arrow: LaunchArrow | null;
};

const DEG = Math.PI / 180;
const EDGE_PAD_PX = 28;

/** Smallest frame side that can hold a pin or an edge arrow. */
export const LAUNCH_MARK_MIN_PX = 80;

export const ALL_LAUNCHES_HORIZON_MS = 14 * 24 * 3600_000;
const SCHEDULE_PRECISION = new Set(['second', 'minute', 'hour']);

export function selectAllLaunches(state: LaunchState, nowMs: number): LaunchSelection[] {
  const artifact = state.artifact;
  if (!artifact) return [];
  const selected: LaunchSelection[] = [];
  for (const item of artifact.items) {
    if (item.reason_codes.includes('LAUNCH_UNCONFIRMED')) continue;
    const precision = item.launch_window.precision?.toLowerCase() ?? '';
    if (!SCHEDULE_PRECISION.has(precision)) continue;
    const net = Date.parse(item.launch_window.net);
    if (!Number.isFinite(net) || net < nowMs || net > nowMs + ALL_LAUNCHES_HORIZON_MS) continue;
    const end = hasLaunchTimeConflict(item) ? item.launch_window.net : item.launch_window.end ?? item.launch_window.net;
    if (Date.parse(end) <= nowMs) continue;
    selected.push({ item, interval: null, expired: false });
  }
  return selected.sort((a, b) => Date.parse(a.item.launch_window.net) - Date.parse(b.item.launch_window.net)
    || (a.item.event_id < b.item.event_id ? -1 : a.item.event_id > b.item.event_id ? 1 : 0));
}

export function launchSites(state: LaunchState, nowMs: number): LaunchSite[] {
  return selectLaunches(state, nowMs, 'map').map(launchSiteFromSelection);
}

export function launchSiteFromSelection(selection: LaunchSelection): LaunchSite {
  const item = selection.item;
  return {
    eventId: item.event_id,
    name: item.name,
    siteName: item.site.name,
    lat: item.site.lat,
    lon: item.site.lon,
    corridor: sourcedCorridor(item),
  };
}

export function launchTimeFact(selection: LaunchSelection, state: LaunchState, nowMs: number): LaunchTimeFact {
  return {
    label: launchTimeLabel(selection.item),
    text: operatorLaunchLines(selection, state, nowMs).launchWindow,
  };
}

export function launchChoiceLabel(selection: LaunchSelection, state: LaunchState, nowMs: number): string {
  const item = selection.item;
  return `${item.name} · ${item.site.name} · ${launchTimeFact(selection, state, nowMs).text}`;
}

/** Degrees clockwise from screen-up. Ahead of the station, after the 180° roll, points down. */
export function lookArrowDeg(forwardBearingDeg: number, siteBearingDeg: number): number {
  return 180 + signedDelta(siteBearingDeg - forwardBearingDeg);
}

export function lookNudge(forwardBearingDeg: number, siteBearingDeg: number): { right: number; up: number } {
  const rad = lookArrowDeg(forwardBearingDeg, siteBearingDeg) * DEG;
  return { right: Math.sin(rad), up: Math.cos(rad) };
}

export function lookToward(
  forwardBearingDeg: number,
  cameraLat: number,
  cameraLon: number,
  siteLat: number,
  siteLon: number,
): { right: number; up: number; arrowDeg: number } {
  const siteBearing = greatCircleBearingDeg(cameraLat, cameraLon, siteLat, siteLon);
  return {
    ...lookNudge(forwardBearingDeg, siteBearing),
    arrowDeg: lookArrowDeg(forwardBearingDeg, siteBearing),
  };
}

export function siteOnDisk(
  cameraLat: number,
  cameraLon: number,
  altitudeM: number,
  siteLat: number,
  siteLon: number,
): boolean {
  const ratio = RENDER_RADIUS_M / (RENDER_RADIUS_M + Math.max(0, altitudeM));
  if (!(ratio > 0) || ratio >= 1) return false;
  const limb = Math.acos(ratio) / DEG;
  return separationDeg(cameraLat, cameraLon, siteLat, siteLon) <= limb - 0.4;
}

export function launchCorridorLines(sites: readonly LaunchSite[]): [number, number][][] {
  const lines: [number, number][][] = [];
  for (const site of sites) {
    if (!site.corridor || site.corridor.length < 2) continue;
    lines.push(site.corridor.map((point) => [point.lon, point.lat]));
  }
  return lines;
}

export function placeLaunchMarks(
  sites: readonly LaunchSite[],
  project: (lon: number, lat: number) => LaunchScreen | null,
  width: number,
  height: number,
): { pins: LaunchPin[]; arrows: LaunchArrow[] } {
  const pins: LaunchPin[] = [];
  const arrows: LaunchArrow[] = [];
  if (width < LAUNCH_MARK_MIN_PX || height < LAUNCH_MARK_MIN_PX) return { pins, arrows };
  const pad = EDGE_PAD_PX;
  for (const site of sites) {
    const projected = project(site.lon, site.lat);
    if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
    if (
      projected.x >= pad
      && projected.y >= pad
      && projected.x <= width - pad
      && projected.y <= height - pad
    ) {
      pins.push({
        eventId: site.eventId,
        name: site.name,
        siteName: site.siteName,
        lat: site.lat,
        lon: site.lon,
        x: projected.x,
        y: projected.y,
      });
      continue;
    }
    const edge = edgePoint(width, height, projected.x, projected.y, pad);
    if (!edge) continue;
    const dx = projected.x - width / 2;
    const dy = projected.y - height / 2;
    arrows.push({
      eventId: site.eventId,
      name: site.name,
      siteName: site.siteName,
      x: edge.x,
      y: edge.y,
      deg: Math.atan2(dx, -dy) / DEG,
    });
  }
  return { pins, arrows };
}

export function classifyLaunchSite(
  site: LaunchSite,
  onDisk: boolean,
  project: ((lon: number, lat: number) => LaunchScreen | null) | null,
  width: number,
  height: number,
): LaunchMark {
  if (!project) return { visibility: 'View unavailable', pin: null, arrow: null };
  if (!onDisk) return { visibility: 'Site below horizon', pin: null, arrow: null };
  const placed = placeLaunchMarks([site], project, width, height);
  const pin = placed.pins[0] ?? null;
  const arrow = placed.arrows[0] ?? null;
  if (pin) return { visibility: 'Site in frame', pin, arrow: null };
  if (arrow) return { visibility: 'Site outside frame', pin: null, arrow };
  return { visibility: 'View unavailable', pin: null, arrow: null };
}

function launchTimeLabel(item: LaunchOpportunity): LaunchTimeFact['label'] {
  if (hasLaunchTimeConflict(item)) return 'Launch window';
  const precision = item.launch_window.precision?.toLowerCase() ?? '';
  const { start, end } = item.launch_window;
  if (precision === 'day' || precision === 'month' || precision === 'year') return 'NET, tentative';
  if (start && end) return 'Launch window';
  if (precision === 'minute' || precision === 'second') return 'NET, tentative';
  return 'Launch window';
}

function sourcedCorridor(item: LaunchOpportunity): LaunchSite['corridor'] {
  const trajectory = item.trajectory;
  if (trajectory.quality === 'unknown' || !trajectory.source || trajectory.points.length < 2) return null;
  return trajectory.points.map((point) => ({ lat: point.lat, lon: point.lon }));
}

function signedDelta(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function separationDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return (Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) * 2) / DEG;
}

function edgePoint(
  width: number,
  height: number,
  x: number,
  y: number,
  pad: number,
): LaunchScreen | null {
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) return null;
  let scale = Infinity;
  if (dx > 0) scale = Math.min(scale, (width - pad - cx) / dx);
  if (dx < 0) scale = Math.min(scale, (pad - cx) / dx);
  if (dy > 0) scale = Math.min(scale, (height - pad - cy) / dy);
  if (dy < 0) scale = Math.min(scale, (pad - cy) / dy);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return { x: cx + dx * scale, y: cy + dy * scale };
}
