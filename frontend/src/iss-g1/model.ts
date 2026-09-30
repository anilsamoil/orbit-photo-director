/** Spherical ISS camera for the G1 probe.
 *
 *  Orbital altitude arrives on the SGP4 sphere. MapLibre's vertical-perspective
 *  camera is altitude above a smaller sphere. The radial distance is what
 *  stays constant. Pitch here is the target-local angle the public from-to
 *  solver returns, not a depression to feed `setPitch`. */

export const SGP4_RADIUS_KM = 6378.137;
export const RENDER_RADIUS_M = 6_371_008.8;
export const FOCAL_MM = 14;
export const SENSOR_WIDTH_MM = 36;
export const SENSOR_HEIGHT_MM = 24;
export const SENSOR_ASPECT = SENSOR_WIDTH_MM / SENSOR_HEIGHT_MM;
export const TILE_SIZE_PX = 512;
export const WEB_MERCATOR_MAX_LAT_DEG = 85.0511287798;

/** Target-local pitch of an exact tangent aim. The ISS renderer must allow it.
 *  The existing Map keeps MapLibre's default maximum. */
export const TANGENT_PITCH_DEG = 90;

const DEGENERATE_METERS = 1;

export type Vec3 = readonly [number, number, number];

export type CameraPreset = 'nadir' | 'horizon';

export type SphericalFix = {
  latDeg: number;
  lonDeg: number;
  altKm: number;
};

export type Geocentric = {
  latDeg: number;
  lonDeg: number;
  radiusM: number;
};

export type ScenePose = {
  preset: CameraPreset;
  camera: Geocentric;
  targetLatDeg: number;
  targetLonDeg: number;
  altitudeM: number;
  analyticPitchDeg: number;
  bearingDeg: number;
  horizonDepressionDeg: number;
  limbFromNadirDeg: number;
  inwardDeg: number;
};

export type PoseResult =
  | { ok: true; pose: ScenePose }
  | { ok: false; reason: 'degenerate-forward' | 'nonphysical-radius' };

export type SolverView = {
  targetLatDeg: number;
  targetLonDeg: number;
  pitchDeg: number;
  bearingDeg: number;
  zoom: number;
  verticalFovDeg: number;
  viewportHeightPx: number;
};

const RAD = Math.PI / 180;

function finiteFix(fix: SphericalFix): boolean {
  return Number.isFinite(fix.latDeg) && Number.isFinite(fix.lonDeg) && Number.isFinite(fix.altKm);
}

export function altitudeAboveRenderSphereM(altKm: number): number {
  return (altKm + SGP4_RADIUS_KM) * 1000 - RENDER_RADIUS_M;
}

export function sensorFovDeg(): { horizontal: number; vertical: number } {
  return {
    horizontal: 2 * Math.atan(SENSOR_WIDTH_MM / (2 * FOCAL_MM)) / RAD,
    vertical: 2 * Math.atan(SENSOR_HEIGHT_MM / (2 * FOCAL_MM)) / RAD,
  };
}

/** Fit the whole 3:2 frame inside the pane. The vertical field of view stays
 *  the sensor's, because the frame is the full virtual sensor. */
export function fittedFrame(paneWidthPx: number, paneHeightPx: number): { widthPx: number; heightPx: number; verticalFovDeg: number } {
  const widthLimited = paneWidthPx / SENSOR_ASPECT <= paneHeightPx;
  const widthPx = widthLimited ? paneWidthPx : paneHeightPx * SENSOR_ASPECT;
  const heightPx = widthLimited ? paneWidthPx / SENSOR_ASPECT : paneHeightPx;
  return { widthPx, heightPx, verticalFovDeg: sensorFovDeg().vertical };
}

function surface(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const cosLat = Math.cos(lat);
  return [Math.sin(lon) * cosLat, Math.sin(lat), Math.cos(lon) * cosLat];
}

function geographic(vector: Vec3): { latDeg: number; lonDeg: number } {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  const x = vector[0] / length;
  const y = vector[1] / length;
  const z = vector[2] / length;
  const latDeg = Math.asin(Math.min(1, Math.max(-1, y))) / RAD;
  const horizontal = Math.hypot(x, z);
  if (horizontal <= 1e-12) return { latDeg, lonDeg: 0 };
  const lonDeg = (x > 0 ? Math.acos(Math.min(1, Math.max(-1, z / horizontal))) : -Math.acos(Math.min(1, Math.max(-1, z / horizontal)))) / RAD;
  return { latDeg, lonDeg };
}

function scale(vector: Vec3, factor: number): Vec3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(vector: Vec3): Vec3 | null {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-12) return null;
  return scale(vector, 1 / length);
}

function rotY(vector: Vec3, rad: number): Vec3 {
  const [x, y, z] = vector;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [z * s + x * c, y, z * c - x * s];
}

function rotX(vector: Vec3, rad: number): Vec3 {
  const [x, y, z] = vector;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [x, y * c - z * s, y * s + z * c];
}

function localEast(_latDeg: number, lonDeg: number): Vec3 {
  const lon = lonDeg * RAD;
  return [Math.cos(lon), 0, -Math.sin(lon)];
}

function localNorth(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  return [-Math.sin(lat) * Math.sin(lon), Math.cos(lat), -Math.sin(lat) * Math.cos(lon)];
}

function bearingOf(look: Vec3, latDeg: number, lonDeg: number): number {
  const east = dot(look, localEast(latDeg, lonDeg));
  const north = dot(look, localNorth(latDeg, lonDeg));
  let degrees = Math.atan2(east, north) / RAD;
  if (degrees < 0) degrees += 360;
  return degrees;
}

export function groundTrackForward(before: SphericalFix, after: SphericalFix): { ok: true; forward: Vec3 } | { ok: false; reason: 'degenerate-forward' } {
  if (!finiteFix(before) || !finiteFix(after)) return { ok: false, reason: 'degenerate-forward' };
  const beforeRadius = (before.altKm + SGP4_RADIUS_KM) * 1000;
  const afterRadius = (after.altKm + SGP4_RADIUS_KM) * 1000;
  const start = scale(surface(before.latDeg, before.lonDeg), beforeRadius);
  const end = scale(surface(after.latDeg, after.lonDeg), afterRadius);
  const chord = sub(end, start);
  const up = normalize(add(start, end));
  if (!up) return { ok: false, reason: 'degenerate-forward' };
  const tangential = sub(chord, scale(up, dot(chord, up)));
  if (Math.hypot(tangential[0], tangential[1], tangential[2]) < DEGENERATE_METERS) {
    return { ok: false, reason: 'degenerate-forward' };
  }
  const forward = normalize(tangential);
  if (!forward) return { ok: false, reason: 'degenerate-forward' };
  return { ok: true, forward };
}

function solverPitchDeg(camera: Vec3, target: Vec3): number {
  const toCamera = sub(camera, target);
  const distance = Math.hypot(toCamera[0], toCamera[1], toCamera[2]);
  const where = geographic(target);
  const local = rotX(rotY(toCamera, -where.lonDeg * RAD), where.latDeg * RAD);
  return Math.acos(Math.min(1, Math.max(-1, local[2] / distance))) / RAD;
}

export function poseAt(
  now: SphericalFix,
  before: SphericalFix,
  after: SphericalFix,
  preset: CameraPreset,
  inwardDeg: number,
): PoseResult {
  if (!finiteFix(now) || inwardDeg < 0 || !Number.isFinite(inwardDeg)) return { ok: false, reason: 'degenerate-forward' };
  const altitudeM = altitudeAboveRenderSphereM(now.altKm);
  const radiusM = RENDER_RADIUS_M + altitudeM;
  if (!(radiusM > RENDER_RADIUS_M)) return { ok: false, reason: 'nonphysical-radius' };
  const track = groundTrackForward(before, after);
  if (!track.ok) return track;
  const up = surface(now.latDeg, now.lonDeg);
  const radial = dot(track.forward, up);
  const forward = normalize(sub(track.forward, scale(up, radial)));
  if (!forward) return { ok: false, reason: 'degenerate-forward' };
  const ratio = Math.min(1, RENDER_RADIUS_M / radiusM);
  const depressionRad = Math.acos(ratio);
  const limbRad = Math.asin(ratio);
  const camera = scale(up, radiusM / RENDER_RADIUS_M);
  const central = preset === 'horizon' ? depressionRad - inwardDeg * RAD : 0;
  if (central <= 0 && preset === 'horizon') return { ok: false, reason: 'nonphysical-radius' };
  const target = preset === 'nadir'
    ? up
    : add(scale(up, Math.cos(central)), scale(forward, Math.sin(central)));
  const where = geographic(target);
  const look = sub(target, camera);
  const bearingDeg = preset === 'nadir'
    ? bearingOf(forward, now.latDeg, now.lonDeg)
    : bearingOf(look, where.latDeg, where.lonDeg);
  return {
    ok: true,
    pose: {
      preset,
      camera: { latDeg: now.latDeg, lonDeg: now.lonDeg, radiusM },
      targetLatDeg: where.latDeg,
      targetLonDeg: where.lonDeg,
      altitudeM,
      analyticPitchDeg: preset === 'nadir' ? 0 : solverPitchDeg(camera, target),
      bearingDeg,
      horizonDepressionDeg: depressionRad / RAD,
      limbFromNadirDeg: limbRad / RAD,
      inwardDeg: preset === 'horizon' ? inwardDeg : 0,
    },
  };
}

function cameraToCenterPx(verticalFovDeg: number, viewportHeightPx: number): number {
  return 0.5 / Math.tan((verticalFovDeg * RAD) / 2) * viewportHeightPx;
}

function globeRadiusPx(latitudeDeg: number): number {
  return TILE_SIZE_PX / (2 * Math.PI) / Math.cos(latitudeDeg * RAD);
}

/** Invert the public from-to placement. Zoom, pitch, and bearing are the
 *  values the map reports after `jumpTo`, so a clamped pitch moves this
 *  point off the intended radius. */
export function reconstructCamera(view: SolverView): Geocentric {
  const distance = cameraToCenterPx(view.verticalFovDeg, view.viewportHeightPx)
    / (2 ** view.zoom * globeRadiusPx(view.targetLatDeg));
  const pitch = view.pitchDeg * RAD;
  const bearing = view.bearingDeg * RAD;
  const local: Vec3 = [
    -Math.sin(bearing) * Math.sin(pitch) * distance,
    -Math.cos(bearing) * Math.sin(pitch) * distance,
    Math.cos(pitch) * distance,
  ];
  const target = surface(view.targetLatDeg, view.targetLonDeg);
  const world = add(target, rotY(rotX(local, -view.targetLatDeg * RAD), view.targetLonDeg * RAD));
  const radiusUnit = Math.hypot(world[0], world[1], world[2]);
  const where = geographic(world);
  return { latDeg: where.latDeg, lonDeg: where.lonDeg, radiusM: radiusUnit * RENDER_RADIUS_M };
}

export function angularSeparationDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const av = surface(aLat, aLon);
  const bv = surface(bLat, bLon);
  return Math.acos(Math.min(1, Math.max(-1, dot(av, bv)))) / RAD;
}

export function verticalAngleDeg(row: number, heightPx: number, verticalFovDeg: number): number {
  const focal = (heightPx / 2) / Math.tan((verticalFovDeg * RAD) / 2);
  const center = (heightPx - 1) / 2;
  return Math.atan((center - row) / focal) / RAD;
}

export function cornerAngleDeg(): number {
  const { horizontal, vertical } = sensorFovDeg();
  const halfWide = Math.tan((horizontal * RAD) / 2);
  const halfTall = Math.tan((vertical * RAD) / 2);
  return Math.atan(Math.hypot(halfWide, halfTall)) / RAD;
}
