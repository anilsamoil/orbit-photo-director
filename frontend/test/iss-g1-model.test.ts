import { describe, expect, it } from 'vitest';

import {
  altitudeAboveRenderSphereM,
  angularSeparationDeg,
  cornerAngleDeg,
  fittedFrame,
  groundTrackForward,
  poseAt,
  reconstructCamera,
  sensorFovDeg,
  verticalAngleDeg,
  type SphericalFix,
} from '../src/iss-g1/model';

const NOW: SphericalFix = { latDeg: 0, lonDeg: 0, altKm: 420 };
const BEFORE: SphericalFix = { latDeg: 0, lonDeg: -0.1, altKm: 420 };
const AFTER: SphericalFix = { latDeg: 0, lonDeg: 0.1, altKm: 420 };

function ecef(latDeg: number, lonDeg: number, radiusM: number): [number, number, number] {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  return [
    radiusM * Math.cos(lat) * Math.cos(lon),
    radiusM * Math.cos(lat) * Math.sin(lon),
    radiusM * Math.sin(lat),
  ];
}

describe('ISS camera geometry', () => {
  it('converts SGP4 altitude onto the render sphere without keeping the old radius', () => {
    expect(altitudeAboveRenderSphereM(420)).toBeCloseTo(427_128.2, 1);
  });

  it('uses the 14 mm full-frame field and fits the whole 3:2 frame', () => {
    expect(sensorFovDeg().horizontal).toBeCloseTo(104.25003, 5);
    expect(sensorFovDeg().vertical).toBeCloseTo(81.20259, 5);
    const phone = fittedFrame(390, 844);
    expect(phone.widthPx).toBe(390);
    expect(phone.heightPx).toBe(260);
    expect(phone.verticalFovDeg).toBeCloseTo(81.20259, 5);
    expect(fittedFrame(1024, 768).widthPx).toBeCloseTo(1024, 5);
    expect(fittedFrame(1024, 768).heightPx).toBeCloseTo(1024 / 1.5, 5);
  });

  it('places a horizon camera on the tangent and a nadir camera on the sub-point', () => {
    const horizon = poseAt(NOW, BEFORE, AFTER, 'horizon', 0);
    const nadir = poseAt(NOW, BEFORE, AFTER, 'nadir', 0);
    expect(horizon.ok).toBe(true);
    expect(nadir.ok).toBe(true);
    if (!horizon.ok || !nadir.ok) return;
    expect(horizon.pose.camera.radiusM).toBeCloseTo(6_798_137, 0);
    expect(horizon.pose.altitudeM).toBeCloseTo(427_128.2, 1);
    expect(horizon.pose.analyticPitchDeg).toBeCloseTo(90, 4);
    expect(horizon.pose.bearingDeg).toBeCloseTo(90, 3);
    expect(horizon.pose.targetLatDeg).toBeCloseTo(0, 4);
    expect(horizon.pose.targetLonDeg).toBeCloseTo(20.41843, 4);
    expect(horizon.pose.horizonDepressionDeg).toBeCloseTo(20.41843, 4);
    expect(horizon.pose.limbFromNadirDeg).toBeCloseTo(69.58157, 4);
    expect(nadir.pose.analyticPitchDeg).toBe(0);
    expect(nadir.pose.targetLonDeg).toBeCloseTo(0, 6);
    expect(nadir.pose.targetLatDeg).toBeCloseTo(0, 6);
    expect(nadir.pose.bearingDeg).toBeCloseTo(90, 3);
    expect(horizon.pose.limbFromNadirDeg - cornerAngleDeg()).toBeGreaterThan(12);
  });

  it('pulls an inward horizon target inside the 1 degree gate and under 90 degrees of pitch', () => {
    const pose = poseAt(NOW, BEFORE, AFTER, 'horizon', 0.25);
    expect(pose.ok).toBe(true);
    if (!pose.ok) return;
    expect(pose.pose.analyticPitchDeg).toBeCloseTo(89.74852, 3);
    expect(pose.pose.analyticPitchDeg).toBeLessThan(90);
    expect(pose.pose.inwardDeg).toBe(0.25);
    expect(angularSeparationDeg(0, 0, pose.pose.targetLatDeg, pose.pose.targetLonDeg)).toBeCloseTo(20.16843, 3);
  });

  it('keeps ground-track forward continuous across the antimeridian', () => {
    const radiusM = (420 + 6378.137) * 1000;
    const wrapped = groundTrackForward(
      { latDeg: 0, lonDeg: 179.5, altKm: 420 },
      { latDeg: 0, lonDeg: -179.5, altKm: 420 },
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    const start = ecef(0, 179.5, radiusM);
    const end = ecef(0, -179.5, radiusM);
    const chord: [number, number, number] = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const mid: [number, number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
    const midLength = Math.hypot(mid[0], mid[1], mid[2]);
    const radial = (chord[0] * mid[0] + chord[1] * mid[1] + chord[2] * mid[2]) / (midLength * midLength);
    const tangential: [number, number, number] = [chord[0] - mid[0] * radial, chord[1] - mid[1] * radial, chord[2] - mid[2] * radial];
    const tangentialLength = Math.hypot(tangential[0], tangential[1], tangential[2]);
    const expected = [
      tangential[1] / tangentialLength,
      tangential[2] / tangentialLength,
      tangential[0] / tangentialLength,
    ];
    expect(wrapped.forward[0]).toBeCloseTo(expected[0] ?? 0, 6);
    expect(wrapped.forward[1]).toBeCloseTo(expected[1] ?? 0, 6);
    expect(wrapped.forward[2]).toBeCloseTo(expected[2] ?? 0, 6);
    expect(Math.hypot(chord[0], chord[1], chord[2])).toBeLessThan(radiusM * 0.02);

    const samples = [];
    for (let lon = 170; lon <= 190; lon += 2) {
      const shifted = lon > 180 ? lon - 360 : lon;
      const step = groundTrackForward(
        { latDeg: 20, lonDeg: shifted - 0.2, altKm: 420 },
        { latDeg: 20, lonDeg: shifted + 0.2 > 180 ? shifted + 0.2 - 360 : shifted + 0.2, altKm: 420 },
      );
      expect(step.ok).toBe(true);
      if (step.ok) samples.push(step.forward);
    }
    for (let i = 1; i < samples.length; i += 1) {
      const prev = samples[i - 1];
      const next = samples[i];
      if (!prev || !next) continue;
      const similarity = prev[0] * next[0] + prev[1] * next[1] + prev[2] * next[2];
      expect(similarity).toBeGreaterThan(Math.cos(5 * Math.PI / 180));
    }
  });

  it('rejects a vanished ground track and a camera inside the render sphere', () => {
    expect(groundTrackForward(NOW, NOW).ok).toBe(false);
    const sunk = poseAt({ latDeg: 0, lonDeg: 0, altKm: -8000 }, BEFORE, AFTER, 'horizon', 0);
    expect(sunk).toEqual({ ok: false, reason: 'nonphysical-radius' });
  });

  it('reconstructs the geocentric camera from the public pitch, bearing, and zoom', () => {
    const camera = reconstructCamera({
      targetLatDeg: 0,
      targetLonDeg: 20.41843034047394,
      pitchDeg: 90,
      bearingDeg: 90,
      zoom: 3.528313610855326,
      verticalFovDeg: 81.20258929000894,
      viewportHeightPx: 600,
    });
    expect(camera.latDeg).toBeCloseTo(0, 3);
    expect(camera.lonDeg).toBeCloseTo(0, 3);
    expect(camera.radiusM).toBeCloseTo(6_798_137, 0);
  });

  it('reads a limb row as an angle in the vertical field', () => {
    const height = 600;
    const fov = 81.20258929000894;
    expect(verticalAngleDeg((height - 1) / 2, height, fov)).toBeCloseTo(0, 6);
    const oneDegree = verticalAngleDeg(0, height, fov);
    expect(oneDegree).toBeCloseTo(fov / 2, 1);
  });
});
