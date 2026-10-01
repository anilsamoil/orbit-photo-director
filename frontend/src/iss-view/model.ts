import { isTleStale, TLE_STALE_AFTER_HOURS } from '../banner';
import {
  altitudeAboveRenderSphereM,
  angularSeparationDeg,
  fittedFrame,
  poseAt,
  sensorFovDeg,
  SGP4_RADIUS_KM,
  RENDER_RADIUS_M,
  type CameraPreset,
  type PoseAim,
  type ScenePose,
  type SphericalFix,
} from '../iss-g1/model';
import { groundSunElevationDeg } from '../iss-g1/lighting';
import { sampleIssViewOrbit, tleEpochMs, type IssViewFix } from '../iss-sgp4';
import { subsolarPoint } from '../terminator';
import type { Track } from '../types';

export type CameraMode = CameraPreset;

/** Cupola floor look. 180° about the boresight puts ground-track forward at the bottom of the frame. */
export const EARTH_VIEW_ROLL_DEG = 180;

/** Screen sides of the station body. Roll 0 keeps port on the left. Roll 180 moves port to the right. */
export function earthFrameSides(rollDeg: number): { left: 'port' | 'starboard'; right: 'port' | 'starboard' } {
  const wrapped = ((rollDeg % 360) + 360) % 360;
  if (wrapped === 180) return { left: 'starboard', right: 'port' };
  return { left: 'port', right: 'starboard' };
}

export type SceneSnapshot = {
  manifestVersion: string;
  generatedAtMs: number;
  track: Track;
};

export type SceneFailure = 'missing' | 'malformed' | 'stale' | 'degenerate-forward' | 'nonphysical-radius';

export type SceneFrame =
  | { ok: true; pose: ScenePose; mode: CameraMode; radialKm: number; modelAltKm: number }
  | { ok: false; reason: SceneFailure };

export type GroundLight = 'day' | 'civil-twilight' | 'night';

export type ImageryState =
  | { kind: 'ready' }
  | { kind: 'offline' }
  | { kind: 'degraded'; missing: 'day' | 'night' }
  | { kind: 'delayed' };

export type SceneCard = {
  title: string;
  lens: string;
  position: string;
  lock: string;
  lighting: string;
  imagery: string;
  detail: string;
};

export function renderAltitudeM(altKm: number): number {
  return altitudeAboveRenderSphereM(altKm);
}

export function radialKmFromAltitude(altKm: number): number {
  return altKm + SGP4_RADIUS_KM;
}

export function sceneFit(paneWidthPx: number, paneHeightPx: number): { widthPx: number; heightPx: number; verticalFovDeg: number } {
  return fittedFrame(paneWidthPx, paneHeightPx);
}

export function sensorField(): { horizontal: number; vertical: number } {
  return sensorFovDeg();
}

export function frameFromFixes(
  now: SphericalFix,
  before: SphericalFix,
  after: SphericalFix,
  mode: CameraMode,
  inwardDeg = 0,
  aim: PoseAim = {},
): SceneFrame {
  const posed = poseAt(now, before, after, mode, inwardDeg, aim);
  if (!posed.ok) return posed;
  return {
    ok: true,
    pose: posed.pose,
    mode,
    radialKm: radialKmFromAltitude(now.altKm),
    modelAltKm: now.altKm,
  };
}

export function sceneFrame(track: Track, whenMs: number, mode: CameraMode, inwardDeg = 0, aim: PoseAim = {}): SceneFrame {
  const sample = sampleIssViewOrbit(track, whenMs);
  if (!sample.ok) return sample;
  return frameFromFixes(toFix(sample.now), toFix(sample.before), toFix(sample.after), mode, inwardDeg, aim);
}

export function separationFromSubpointDeg(frame: SceneFrame): number | null {
  if (!frame.ok) return null;
  return angularSeparationDeg(frame.pose.camera.latDeg, frame.pose.camera.lonDeg, frame.pose.targetLatDeg, frame.pose.targetLonDeg);
}

export function groundLightFromElevation(elevationDeg: number): GroundLight {
  if (elevationDeg >= 0) return 'day';
  if (elevationDeg > -6) return 'civil-twilight';
  return 'night';
}

export function groundLightAt(whenMs: number, latDeg: number, lonDeg: number): GroundLight {
  const sun = subsolarPoint(new Date(whenMs));
  return groundLightFromElevation(groundSunElevationDeg(latDeg, lonDeg, sun.lat, sun.lon));
}

export function tleAgeHoursAt(track: Track, nowMs: number): number | null {
  const epoch = tleEpochMs(track.tle);
  if (epoch === null) return null;
  return (nowMs - epoch) / 3_600_000;
}

export function orbitDataOld(track: Track, nowMs: number): boolean {
  return isTleStale(tleAgeHoursAt(track, nowMs) ?? undefined);
}

export function lightingDelayed(lightingUtcMs: number, nowMs: number, failed: boolean): boolean {
  return failed && nowMs - lightingUtcMs > 60_000;
}

export function sceneCard(input: {
  snapshot: SceneSnapshot;
  whenMs: number;
  frame: SceneFrame;
  light: GroundLight | null;
  imagery: ImageryState;
  lightingUtcMs: number;
  windowLabel?: string | null;
}): SceneCard {
  const estimated = input.frame.ok && orbitDataOld(input.snapshot.track, input.whenMs);
  const title = estimated ? 'Estimated view · orbit data old' : 'ISS perspective';
  const lens = '14 mm · full frame';
  if (!input.frame.ok) {
    return {
      title: 'ISS perspective',
      lens,
      position: unavailable(input.frame.reason),
      lock: '',
      lighting: '',
      imagery: imageryLine(input.imagery),
      detail: detailLine(input),
    };
  }
  const pose = input.frame.pose;
  const light = input.light ?? groundLightAt(input.whenMs, pose.camera.latDeg, pose.camera.lonDeg);
  const delayed = lightingDelayed(input.lightingUtcMs, input.whenMs, input.imagery.kind === 'delayed');
  return {
    title,
    lens,
    position: `${formatUtc(input.whenMs)} · ${formatLat(pose.camera.latDeg)} ${formatLon(pose.camera.lonDeg)} · ${input.frame.modelAltKm.toFixed(1)} km`,
    lock: input.windowLabel
      ? input.windowLabel
      : input.frame.mode === 'horizon'
        ? 'Horizon locked · ground-track forward'
        : 'Nadir locked · ground-track forward',
    lighting: `Modeled live day/night · ${lightLabel(light)}${delayed ? ' · Lighting delayed' : ''}`,
    imagery: imageryLine(input.imagery),
    detail: detailLine(input),
  };
}

export function staleThresholdHours(): number {
  return TLE_STALE_AFTER_HOURS;
}

function toFix(fix: IssViewFix): SphericalFix {
  return { latDeg: fix.lat, lonDeg: fix.lon, altKm: fix.alt_km };
}

function unavailable(reason: SceneFailure): string {
  if (reason === 'missing') return 'Orbit unavailable · no element set';
  if (reason === 'malformed') return 'Orbit unavailable · element set does not match';
  if (reason === 'stale') return 'Orbit unavailable · propagation failed';
  if (reason === 'degenerate-forward') return 'Orbit unavailable · orientation unavailable';
  return 'Orbit unavailable · nonphysical camera radius';
}

function lightLabel(light: GroundLight): string {
  if (light === 'day') return 'Day below ISS';
  if (light === 'civil-twilight') return 'Civil twilight below ISS';
  return 'Night below ISS';
}

function imageryLine(imagery: ImageryState): string {
  if (imagery.kind === 'offline') return 'Imagery unavailable offline';
  if (imagery.kind === 'degraded' && imagery.missing === 'day') return 'Cloud-free · Blue Marble unavailable';
  if (imagery.kind === 'degraded' && imagery.missing === 'night') return 'Cloud-free · Black Marble unavailable';
  if (imagery.kind === 'delayed') return 'Cloud-free · Blue Marble + Black Marble 2016';
  return 'Cloud-free · Blue Marble + Black Marble 2016';
}

function detailLine(input: { snapshot: SceneSnapshot; whenMs: number; lightingUtcMs: number }): string {
  const epoch = tleEpochMs(input.snapshot.track.tle);
  const age = tleAgeHoursAt(input.snapshot.track, input.whenMs);
  const epochText = epoch === null ? 'TLE epoch unavailable' : `TLE epoch ${new Date(epoch).toISOString()}`;
  const ageText = age === null ? 'age unavailable' : `age ${age.toFixed(1)} h`;
  return [
    `manifest ${input.snapshot.manifestVersion}`,
    epochText,
    ageText,
    `lighting ${new Date(input.lightingUtcMs).toISOString()}`,
    'spherical Earth model',
    `render radius ${RENDER_RADIUS_M} m`,
  ].join(' · ');
}

function formatUtc(whenMs: number): string {
  const date = new Date(whenMs);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s} UTC`;
}

function formatLat(latDeg: number): string {
  const hemisphere = latDeg >= 0 ? 'N' : 'S';
  return `${Math.abs(latDeg).toFixed(2)}°${hemisphere}`;
}

function formatLon(lonDeg: number): string {
  const hemisphere = lonDeg >= 0 ? 'E' : 'W';
  return `${Math.abs(lonDeg).toFixed(2)}°${hemisphere}`;
}
