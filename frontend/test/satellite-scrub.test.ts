/** Tests for satellite scrub-consistency (eng-review 4A, 2026-06-10).
 *
 *  The one-clock rule: when the operator scrubs the map to a future
 *  instant, satellite TRACK WINDOWS render at that instant — the same
 *  clock as the ISS track and marker. This is the v1.7.12.0
 *  marker-on-wrong-track bug class, applied forward to satellites
 *  (Codex finding, verified at map.ts buildSatelliteTrackFeatures).
 *
 *  Marker pinning + the 1Hz tick gate + follow-ISS gating need a live
 *  MapLibre map and are browser-QA items (see the eng-review test plan);
 *  the view-time propagation seam tested here is the heart of all three. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetMapStateForTest,
  buildSatelliteTrackFeatures,
  setLookahead,
} from '../src/map';
import { _resetSatrecCacheForTests } from '../src/iss-sgp4';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

// Reuse the ISS SGP4 fixture TLE as a stand-in satellite — the code path
// is satellite-agnostic (trackFromTLE wraps any TLE).
const TLE = {
  line1: fixtureRaw.tle.line1,
  line2: fixtureRaw.tle.line2,
  name: 'TESTSAT (fixture)',
};

/** First rendered coordinate of the track polyline ([lon, lat]). */
function firstCoord(features: GeoJSON.Feature[]): [number, number] {
  expect(features.length).toBeGreaterThan(0);
  const geom = features[0]!.geometry as GeoJSON.LineString;
  return geom.coordinates[0] as [number, number];
}

describe('buildSatelliteTrackFeatures — view-time window (4A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Near the fixture TLE epoch so SGP4 propagation is well-conditioned.
    vi.setSystemTime(new Date('2024-10-17T12:00:00Z'));
    _resetMapStateForTest();
    _resetSatrecCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is deterministic for a given view instant (no hidden Date.now())', () => {
    const viewMs = Date.now();
    const a = firstCoord(buildSatelliteTrackFeatures(TLE, viewMs));
    const b = firstCoord(buildSatelliteTrackFeatures(TLE, viewMs));
    expect(a).toEqual(b);
  });

  it('the window follows the view instant — +6h starts somewhere else', () => {
    const nowMs = Date.now();
    const live = firstCoord(buildSatelliteTrackFeatures(TLE, nowMs));
    const future = firstCoord(buildSatelliteTrackFeatures(TLE, nowMs + 360 * 60_000));
    // ~4 orbits later the sub-point is far from the live one.
    expect(future).not.toEqual(live);
  });

  it('default view time follows the SCRUB: scrubbed tracks render at the pinned instant', () => {
    const nowMs = Date.now();
    setLookahead(360, /*recenter=*/false); // pin the map at +6h
    const viaScrub = firstCoord(buildSatelliteTrackFeatures(TLE));
    const explicit = firstCoord(buildSatelliteTrackFeatures(TLE, nowMs + 360 * 60_000));
    const liveNow = firstCoord(buildSatelliteTrackFeatures(TLE, nowMs));
    expect(viaScrub).toEqual(explicit); // rides the map's one clock…
    expect(viaScrub).not.toEqual(liveNow); // …NOT the wall clock
  });

  it('default view time is live-now when not scrubbed', () => {
    const viaDefault = firstCoord(buildSatelliteTrackFeatures(TLE));
    const explicit = firstCoord(buildSatelliteTrackFeatures(TLE, Date.now()));
    expect(viaDefault).toEqual(explicit);
  });

  it('returning to Now returns the window to the live clock', () => {
    setLookahead(360, false);
    setLookahead(0, false);
    const viaDefault = firstCoord(buildSatelliteTrackFeatures(TLE));
    const explicit = firstCoord(buildSatelliteTrackFeatures(TLE, Date.now()));
    expect(viaDefault).toEqual(explicit);
  });
});
