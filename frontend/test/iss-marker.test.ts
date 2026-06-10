import { beforeEach, describe, expect, it } from 'vitest';

import {
  createIssMarkerElement,
  markerPositionAt,
  refreshMapForManifest,
  _resetMapStateForTest,
} from '../src/map';
import { liveIssNow, liveIssPosition } from '../src/iss';
import { _resetSatrecCacheForTests } from '../src/iss-sgp4';
import type { Manifest, Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

interface Fixture {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
}
const fixture = fixtureRaw as Fixture;
const startMs = Date.parse(fixture.start);

function buildTrack(overrides: Partial<Track> = {}): Track {
  return {
    iss_polynomial: fixture.iss_polynomial,
    tle: fixture.tle,
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 17,
    tle_freshness_factor: 1,
    ...overrides,
  };
}

describe('createIssMarkerElement', () => {
  it('returns a div with the iss-marker class', () => {
    const el = createIssMarkerElement();
    expect(el.tagName).toBe('DIV');
    expect(el.classList.contains('iss-marker')).toBe(true);
  });

  it('contains a pulse element for the animated halo', () => {
    const el = createIssMarkerElement();
    expect(el.querySelector('.iss-pulse')).toBeTruthy();
  });

  it('contains an SVG with the correct viewBox', () => {
    const el = createIssMarkerElement();
    const svg = el.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('viewBox')).toBe('-20 -8 40 16');
  });

  it('renders both solar arrays (left + right) and a central truss', () => {
    const el = createIssMarkerElement();
    const rects = el.querySelectorAll('rect');
    // 2 solar arrays + 1 truss = 3 rects
    expect(rects.length).toBe(3);
    const xs = Array.from(rects).map((r) => Number(r.getAttribute('x')));
    expect(xs).toContain(-18); // port array
    expect(xs).toContain(4);   // starboard array
    expect(xs).toContain(-3);  // truss
  });

  it('exposes role + aria-label so screen readers announce the marker', () => {
    const el = createIssMarkerElement();
    const svg = el.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toContain('ISS');
  });

  it('uses a high-contrast white truss on a cyan panel ground', () => {
    const el = createIssMarkerElement();
    const trussRect = Array.from(el.querySelectorAll('rect')).find(
      (r) => r.getAttribute('x') === '-3',
    );
    expect(trussRect?.getAttribute('fill')).toBe('#ffffff');
  });
});

// BUG 3 (Chris 2026-06-09): "ISS marker doesn't line up with the track when
// you zoom in." Root cause — the marker used the polynomial fit
// (liveIssPosition) while the ground-track polyline uses raw SGP4
// (track_points). These regression tests pin the marker to the SGP4 source
// (liveIssNow), matching the track polyline.
describe('markerPositionAt — marker rides the same SGP4 curve as the track', () => {
  beforeEach(() => _resetSatrecCacheForTests());

  it('returns the SGP4 position (liveIssNow), NOT the polynomial, at lookahead 0', () => {
    const track = buildTrack();
    const now = startMs + 60 * 60_000; // 60 min into the 120-min window
    const got = markerPositionAt(track, 0, now);
    const sgp4 = liveIssNow(track, now);
    const poly = liveIssPosition(track, now);
    expect(got).not.toBeNull();
    expect(got).toEqual(sgp4);
    // The bug was returning `poly`. Prove the marker is no longer on it
    // (the order-11 polynomial is measurably off SGP4 truth in-window).
    expect(got).not.toEqual(poly);
  });

  it('uses SGP4 for a future lookahead too (no 120-min polynomial ceiling)', () => {
    const track = buildTrack();
    const now = startMs;
    const got = markerPositionAt(track, 45, now);
    expect(got).toEqual(liveIssNow(track, now + 45 * 60_000));
  });

  it('falls back to the polynomial only when the manifest carries no TLE', () => {
    const noTle = buildTrack({ tle: undefined });
    const now = startMs + 30 * 60_000;
    expect(markerPositionAt(noTle, 0, now)).toEqual(liveIssPosition(noTle, now));
  });
});

// BUG 1 (Chris 2026-06-09): "orbit tracks don't update — it shows ISS but the
// track from whenever you opened it." Root cause — doRefresh() never
// re-rendered the map. refreshMapForManifest is the hook it now calls; it must
// no-op safely before the map has been created (Map tab never opened).
describe('refreshMapForManifest — safe no-op before the map exists', () => {
  it('resolves without creating a map when none has been rendered', async () => {
    _resetMapStateForTest();
    await expect(refreshMapForManifest({} as Manifest)).resolves.toBeUndefined();
  });
});
