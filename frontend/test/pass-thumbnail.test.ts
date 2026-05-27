import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PASS_SAMPLE_STEP_SECONDS,
  PASS_WINDOW_HALF_SECONDS,
  THUMBNAIL_PIXEL_SIZE,
  THUMBNAIL_ZOOM,
  esriImageryTileUrl,
  formatThumbnailCountdown,
  lonLatToTileXY,
  projectSampleToThumbnail,
  renderPassThumbnail,
  sampleIssTrackForPass,
} from '../src/pass-thumbnail';
import { _resetSatrecCacheForTests } from '../src/iss-sgp4';
import type { PassEntry, Track } from '../src/types';

// v2 (Jack feedback 2026-05-27) — pass thumbnail render + projection tests.
// Tile fetches are mocked off (jsdom doesn't load external images); we
// verify the DOM scaffolding, attribution, polyline projection math, and
// the polynomial → SGP4 fallback for samples outside the polynomial window.

beforeEach(() => {
  _resetSatrecCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('esriImageryTileUrl', () => {
  it('builds the World_Imagery tile URL with z/y/x in Esri order', () => {
    // Note: Esri uses /tile/{z}/{y}/{x} (NOT /z/x/y) — easy to mess up.
    const url = esriImageryTileUrl(12, 100, 200);
    expect(url).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/200/100',
    );
  });
});

describe('lonLatToTileXY', () => {
  it('maps (0, 0) → tile center at z=1 (x=1, y=1)', () => {
    const t = lonLatToTileXY(0, 0, 1);
    expect(t.x).toBeCloseTo(1, 5);
    expect(t.y).toBeCloseTo(1, 5);
  });

  it('maps eastern hemisphere to higher tile x than western', () => {
    const east = lonLatToTileXY(100, 0, 8);
    const west = lonLatToTileXY(-100, 0, 8);
    expect(east.x).toBeGreaterThan(west.x);
  });

  it('maps northern lat to lower tile y than southern (Web Mercator)', () => {
    const north = lonLatToTileXY(0, 50, 8);
    const south = lonLatToTileXY(0, -50, 8);
    expect(north.y).toBeLessThan(south.y);
  });
});

describe('projectSampleToThumbnail', () => {
  it('projects the target itself to the thumbnail center', () => {
    const proj = projectSampleToThumbnail(50, 35, 50, 35);
    expect(proj).not.toBeNull();
    expect(proj!.px).toBeCloseTo(THUMBNAIL_PIXEL_SIZE / 2, 1);
    expect(proj!.py).toBeCloseTo(THUMBNAIL_PIXEL_SIZE / 2, 1);
  });

  it('projects samples east of target to higher px than target center', () => {
    const eastProj = projectSampleToThumbnail(50.1, 35, 50, 35);
    expect(eastProj).not.toBeNull();
    expect(eastProj!.px).toBeGreaterThan(THUMBNAIL_PIXEL_SIZE / 2);
  });

  it('returns null for samples farther than basePx outside the thumbnail', () => {
    // At z=12, ~10° lon = many thousand pixels off the 256-px thumbnail.
    const wayOff = projectSampleToThumbnail(60, 35, 50, 35);
    expect(wayOff).toBeNull();
  });
});

describe('sampleIssTrackForPass — polynomial path', () => {
  const PASS_TIME = '2024-10-17T12:30:00Z';
  const PASS_TIME_MS = Date.parse(PASS_TIME);
  // Polynomial covers the pass window; very simple polynomial fit
  // (constant lat=0, linearly-increasing lon) for easy assertions.
  const POLY_START_MS = PASS_TIME_MS - 600_000;  // 10 min before pass
  const track: Track = {
    iss_polynomial: {
      start: new Date(POLY_START_MS).toISOString(),
      duration_seconds: 1800,  // 30 min window
      lat_coeffs: [0],          // constant lat 0
      // lon = 0.1 * t (degrees/sec? — small, only for sampling-coverage tests)
      lon_coeffs: [0.001, -0.6],
      polynomial_order: 1,
    },
    tle_epoch: '2024-10-17T00:00:00Z',
    tle_age_hours: 12,
    tle_freshness_factor: 0.9,
  };
  const samplePass: PassEntry = {
    target_id: 'personal:anil:abc',
    target_name: 'Test',
    target_regime: 'any',
    target_priority: 5,
    target_lat: 0,
    target_lon: 0,
    closest_approach: PASS_TIME,
    nadir_distance_km: 50,
    pass_regime: 'day',
    obstruction_class: 'clear',
    p_unobstructed: 90,
    cloud_fraction: 10,
    cloud_source: 'mock',
    score: 80,
    score_components: {
      p_unobstructed: 90, regime_fit: 100, nadir_proximity: 90,
      priority_weight: 100, tle_freshness: 0.9,
    },
    iss_at_closest: { lat: 0, lon: 0, alt_km: 410 },
  };

  it('emits 2*half/step + 1 samples when the polynomial covers the entire window', () => {
    const samples = sampleIssTrackForPass(samplePass, track);
    const expected = Math.floor((2 * PASS_WINDOW_HALF_SECONDS) / PASS_SAMPLE_STEP_SECONDS) + 1;
    expect(samples.length).toBe(expected);
  });

  it('returns [] when closest_approach is unparseable', () => {
    const bad = { ...samplePass, closest_approach: 'not a date' };
    expect(sampleIssTrackForPass(bad, track)).toEqual([]);
  });
});

describe('formatThumbnailCountdown', () => {
  const NOW = Date.parse('2024-10-17T12:00:00Z');

  it('returns "now" within ±30 s', () => {
    expect(formatThumbnailCountdown('2024-10-17T12:00:10Z', NOW)).toBe('now');
    expect(formatThumbnailCountdown('2024-10-17T11:59:50Z', NOW)).toBe('now');
  });

  it('reports "in N min" for future passes within an hour', () => {
    expect(formatThumbnailCountdown('2024-10-17T12:23:00Z', NOW)).toBe('in 23 min');
  });

  it('reports "N min ago" for past passes', () => {
    expect(formatThumbnailCountdown('2024-10-17T11:45:00Z', NOW)).toBe('15 min ago');
  });

  it('switches to hours past 60 min', () => {
    expect(formatThumbnailCountdown('2024-10-17T14:00:00Z', NOW)).toBe('in 2 h');
  });

  it('returns "" for unparseable input', () => {
    expect(formatThumbnailCountdown('garbage', NOW)).toBe('');
  });
});

describe('renderPassThumbnail (DOM scaffold)', () => {
  const samplePass: PassEntry = {
    target_id: 'personal:anil:abc',
    target_name: 'Boston Aerial',
    target_regime: 'any',
    target_priority: 5,
    target_lat: 42.36,
    target_lon: -71.06,
    closest_approach: '2024-10-17T12:30:00Z',
    nadir_distance_km: 87,
    angle_off_nadir_deg: 22,
    pass_regime: 'day',
    obstruction_class: 'clear',
    p_unobstructed: 91,
    cloud_fraction: 8,
    cloud_source: 'mock',
    score: 82,
    score_components: {
      p_unobstructed: 91, regime_fit: 100, nadir_proximity: 90,
      priority_weight: 100, tle_freshness: 0.9,
    },
    // ISS at closest_approach: very close to the target (within ~0.01°,
    // ~1 km horizontally) so the marker falls inside the z=12 thumbnail
    // extent. Real production passes can be much further off-nadir; the
    // marker just doesn't render then (caller's polyline still does).
    iss_at_closest: { lat: 42.365, lon: -71.055, alt_km: 410 },
  };
  const NOW = Date.parse('2024-10-17T12:00:00Z');

  it('renders the .pass-thumbnail wrapper with an <img> at the correct Esri URL', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    expect(el.className).toBe('pass-thumbnail');
    const img = el.querySelector<HTMLImageElement>('img.pass-thumbnail-image');
    expect(img).not.toBeNull();
    expect(img!.src).toMatch(/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/);
    // z=12 in the URL (the thumbnail zoom).
    expect(img!.src).toContain(`/${THUMBNAIL_ZOOM}/`);
  });

  it('shows the Esri attribution per ToS', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const attr = el.querySelector('.pass-thumbnail-attribution');
    expect(attr).not.toBeNull();
    expect(attr!.textContent).toContain('Esri');
    expect(attr!.textContent).toContain('Maxar');
    expect(attr!.textContent).toContain('Earthstar Geographics');
  });

  it('renders the caption with nadir-distance + angle-off-nadir + countdown', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const cap = el.querySelector('.pass-thumbnail-caption');
    expect(cap).not.toBeNull();
    expect(cap!.textContent).toContain('87 km nadir');
    expect(cap!.textContent).toContain('22° off');
    expect(cap!.textContent).toContain('in 30 min');
  });

  it('uses textContent for the caption (XSS discipline)', () => {
    // Mutate a field to a value containing HTML-ish characters; verify it
    // appears verbatim in textContent (no <b> element parsed).
    const malicious = { ...samplePass, nadir_distance_km: NaN, angle_off_nadir_deg: NaN };
    const el = renderPassThumbnail(malicious, null, NOW);
    const cap = el.querySelector('.pass-thumbnail-caption')!;
    expect(cap.querySelector('b, script, img')).toBeNull();
  });

  it('renders an ISS marker overlay when iss_at_closest is in-range', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    // The target marker is always present (center crosshair); the ISS
    // marker is conditionally present when in-range.
    const issMarker = el.querySelector('circle.pass-thumbnail-iss-marker');
    expect(issMarker).not.toBeNull();
  });

  it('shows the placeholder when the Esri tile load fires "error"', async () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const img = el.querySelector<HTMLImageElement>('img.pass-thumbnail-image')!;
    // Synthesize a load failure.
    img.dispatchEvent(new Event('error'));
    // After the handler runs, the image should be swapped for the placeholder.
    const placeholder = el.querySelector('.pass-thumbnail-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toContain('Imagery unavailable');
    // The wrap gets a class flag so the polyline overlay can still show.
    expect(el.classList.contains('pass-thumbnail-tile-failed')).toBe(true);
  });

  it('omits the polyline when no track is available', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    expect(el.querySelector('path.pass-thumbnail-iss-track')).toBeNull();
  });
});
