import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { liveIssNow } from '../src/iss';
import { issPositionWithAltSGP4 } from '../src/iss-sgp4';
import {
  frameFromFixes,
  groundLightFromElevation,
  lightingDelayed,
  renderAltitudeM,
  sceneCard,
  sceneFit,
  sceneFrame,
  sensorField,
  type SceneSnapshot,
} from '../src/iss-view/model';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const startMs = Date.parse(fixture.start);
const ALT_KM = 424.1;
const RENDER_RADIUS_M = 6_371_008.8;
const SGP4_RADIUS_KM = 6378.137;

function track(overrides: Partial<Track> = {}): Track {
  return {
    iss_polynomial: fixture.iss_polynomial,
    tle: fixture.tle,
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 17,
    tle_freshness_factor: 1,
    ...overrides,
  };
}

function snapshot(version: string, overrides: Partial<Track> = {}): SceneSnapshot {
  return { manifestVersion: version, generatedAtMs: startMs, track: track(overrides) };
}

function separationDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const av = [
    Math.cos(aLat * toRad) * Math.cos(aLon * toRad),
    Math.cos(aLat * toRad) * Math.sin(aLon * toRad),
    Math.sin(aLat * toRad),
  ];
  const bv = [
    Math.cos(bLat * toRad) * Math.cos(bLon * toRad),
    Math.cos(bLat * toRad) * Math.sin(bLon * toRad),
    Math.sin(bLat * toRad),
  ];
  const dot = av[0]! * bv[0]! + av[1]! * bv[1]! + av[2]! * bv[2]!;
  return Math.acos(Math.min(1, Math.max(-1, dot))) / toRad;
}

function eastDelta(subLon: number, targetLon: number): number {
  let delta = targetLon - subLon;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

describe('ISS scene pose', () => {
  it('converts radial distance onto the render sphere and keeps the model altitude', () => {
    const radialM = (ALT_KM + SGP4_RADIUS_KM) * 1000;
    const cameraM = radialM - RENDER_RADIUS_M;
    const alpha = Math.acos(RENDER_RADIUS_M / radialM) * 180 / Math.PI;
    expect(renderAltitudeM(ALT_KM)).toBeCloseTo(cameraM, 4);
    const horizon = frameFromFixes(
      { latDeg: 43.46, lonDeg: -13.92, altKm: ALT_KM },
      { latDeg: 43.7, lonDeg: -13.92, altKm: ALT_KM },
      { latDeg: 43.22, lonDeg: -13.92, altKm: ALT_KM },
      'horizon',
      0,
    );
    const nadir = frameFromFixes(
      { latDeg: 43.46, lonDeg: -13.92, altKm: ALT_KM },
      { latDeg: 43.7, lonDeg: -13.92, altKm: ALT_KM },
      { latDeg: 43.22, lonDeg: -13.92, altKm: ALT_KM },
      'nadir',
      0,
    );
    expect(horizon.ok).toBe(true);
    expect(nadir.ok).toBe(true);
    if (!horizon.ok || !nadir.ok) return;
    expect(horizon.pose.altitudeM).toBeCloseTo(cameraM, 3);
    expect(horizon.pose.camera.radiusM).toBeCloseTo(radialM, 3);
    expect(horizon.modelAltKm).toBe(ALT_KM);
    expect(horizon.pose.horizonDepressionDeg).toBeCloseTo(alpha, 4);
    expect(horizon.pose.analyticPitchDeg).toBeCloseTo(90, 3);
    expect(separationDeg(43.46, -13.92, horizon.pose.targetLatDeg, horizon.pose.targetLonDeg)).toBeCloseTo(alpha, 3);
    expect(horizon.pose.targetLatDeg).toBeLessThan(43.46);
    expect(nadir.pose.targetLatDeg).toBeCloseTo(43.46, 5);
    expect(nadir.pose.targetLonDeg).toBeCloseTo(-13.92, 5);
    expect(nadir.pose.analyticPitchDeg).toBe(0);
    expect(separationDeg(43.46, -13.92, nadir.pose.targetLatDeg, nadir.pose.targetLonDeg)).toBeCloseTo(0, 5);
  });

  it('keeps ground-track forward across the antimeridian', () => {
    const frame = frameFromFixes(
      { latDeg: 0, lonDeg: 179.9, altKm: 420 },
      { latDeg: 0, lonDeg: 179.4, altKm: 420 },
      { latDeg: 0, lonDeg: -179.6, altKm: 420 },
      'horizon',
      0,
    );
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(eastDelta(179.9, frame.pose.targetLonDeg)).toBeGreaterThan(10);
    expect(Number.isFinite(frame.pose.bearingDeg)).toBe(true);
  });

  it('rejects a near-zero forward vector and a camera inside the render sphere', () => {
    const stuck = frameFromFixes(
      { latDeg: 10, lonDeg: 20, altKm: 420 },
      { latDeg: 10, lonDeg: 20, altKm: 420 },
      { latDeg: 10, lonDeg: 20, altKm: 420 },
      'horizon',
      0,
    );
    const buried = frameFromFixes(
      { latDeg: 10, lonDeg: 20, altKm: -8 },
      { latDeg: 10, lonDeg: 19, altKm: -8 },
      { latDeg: 10, lonDeg: 21, altKm: -8 },
      'nadir',
      0,
    );
    expect(stuck).toEqual({ ok: false, reason: 'degenerate-forward' });
    expect(buried).toEqual({ ok: false, reason: 'nonphysical-radius' });
  });

  it('fits the 14 mm 3:2 frame and stays finite near a pole', () => {
    expect(sensorField().horizontal).toBeCloseTo(104.25003, 5);
    expect(sensorField().vertical).toBeCloseTo(81.20259, 5);
    expect(sceneFit(390, 844)).toEqual({ widthPx: 390, heightPx: 260, verticalFovDeg: sensorField().vertical });
    const pole = frameFromFixes(
      { latDeg: 89, lonDeg: 0, altKm: 420 },
      { latDeg: 89, lonDeg: -0.2, altKm: 420 },
      { latDeg: 89, lonDeg: 0.2, altKm: 420 },
      'horizon',
      0,
    );
    expect(pole.ok).toBe(true);
    if (!pole.ok) return;
    expect(Number.isFinite(pole.pose.targetLatDeg)).toBe(true);
    expect(Number.isFinite(pole.pose.bearingDeg)).toBe(true);
  });

  it('propagates a real element set and refuses a missing one', () => {
    const when = startMs + 60_000;
    const frame = sceneFrame(track(), when, 'horizon', 0);
    const published = issPositionWithAltSGP4(track(), when);
    const live = liveIssNow(track(), when);
    expect(frame.ok).toBe(true);
    expect(published).not.toBeNull();
    expect(live).toEqual(published && { lat: published.lat, lon: published.lon });
    if (!frame.ok || !published) return;
    expect(frame.pose.camera.latDeg).toBeCloseTo(published.lat, 6);
    expect(frame.pose.camera.lonDeg).toBeCloseTo(published.lon, 6);
    expect(frame.modelAltKm).toBeCloseTo(published.alt_km, 6);
    expect(sceneFrame(track({ tle: undefined }), when, 'nadir')).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('ISS scene card', () => {
  it('labels a fresh horizon pose and an old element set', () => {
    const fresh = sceneFrame(track(), startMs + 3_600_000, 'horizon', 0);
    const card = sceneCard({
      snapshot: snapshot('2024-10-17'),
      whenMs: startMs + 3_600_000,
      frame: fresh,
      light: 'day',
      imagery: { kind: 'ready' },
      lightingUtcMs: startMs + 3_600_000,
    });
    expect(card.title).toBe('ISS perspective');
    expect(card.lens).toBe('14 mm · full frame');
    expect(card.lock).toBe('Horizon locked · ground-track forward');
    expect(card.lighting).toBe('Modeled live day/night · Day below ISS');
    expect(card.imagery).toBe('Cloud-free · Blue Marble + Black Marble 2016');
    expect(card.detail).toContain('manifest 2024-10-17');
    expect(card.detail).toContain('spherical Earth model');
    if (!fresh.ok) return;
    expect(card.position).toContain(`${fresh.modelAltKm.toFixed(1)} km`);
    expect(card.position).not.toContain(`${(fresh.pose.altitudeM / 1000).toFixed(1)} km`);

    const old = sceneCard({
      snapshot: snapshot('old'),
      whenMs: Date.parse('2024-10-16T18:58:11.999Z') + 49 * 3_600_000,
      frame: fresh,
      light: 'night',
      imagery: { kind: 'offline' },
      lightingUtcMs: startMs,
    });
    expect(old.title).toBe('Estimated view · orbit data old');
    expect(old.imagery).toBe('Imagery unavailable offline');
    expect(old.lighting).toContain('Night below ISS');
  });

  it('names civil twilight, lighting delay, and an unavailable orbit', () => {
    expect(groundLightFromElevation(0)).toBe('day');
    expect(groundLightFromElevation(-3)).toBe('civil-twilight');
    expect(groundLightFromElevation(-6)).toBe('night');
    expect(lightingDelayed(0, 61_000, true)).toBe(true);
    expect(lightingDelayed(0, 30_000, true)).toBe(false);
    const missing = sceneCard({
      snapshot: snapshot('none', { tle: undefined }),
      whenMs: Date.UTC(2025, 11, 31, 23, 59, 59),
      frame: { ok: false, reason: 'missing' },
      light: null,
      imagery: { kind: 'degraded', missing: 'night' },
      lightingUtcMs: Date.UTC(2025, 11, 31, 23, 59, 0),
    });
    expect(missing.position).toBe('Orbit unavailable · no element set');
    expect(missing.position).not.toMatch(/\d+\.\d+°/);
    expect(missing.imagery).toBe('Cloud-free · Black Marble unavailable');
    expect(missing.detail).toContain('2025-12-31');
  });
});

describe('public nav stays at five tabs', () => {
  it('does not add an ISS tab or a main import', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
    expect(html.match(/id="tab-/g)).toHaveLength(5);
    expect(html).not.toContain('tab-iss');
    expect(main).not.toContain('iss-view');
    expect(main).not.toContain('precacheIssStaticTiles');
  });
});
