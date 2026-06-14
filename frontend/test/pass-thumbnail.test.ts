import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PASS_SAMPLE_STEP_SECONDS,
  PASS_WINDOW_HALF_SECONDS,
  THUMBNAIL_PIXEL_SIZE,
  THUMBNAIL_ZOOM,
  esriImageryTileUrl,
  esriReferenceTileUrl,
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

describe('esriReferenceTileUrl', () => {
  it('builds the reference labels tile URL with z/y/x in Esri order', () => {
    const url = esriReferenceTileUrl(10, 100, 200);
    expect(url).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/10/200/100',
    );
  });
});

describe('THUMBNAIL_ZOOM', () => {
  it('is widened to z=11 now that the tile layer is target-centered', () => {
    // appendCenteredTileLayer puts the target at the canvas center, so the
    // marker is accurate and we can widen the zoom for ocean/remote context.
    expect(THUMBNAIL_ZOOM).toBe(11);
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

  it('reports compact "in Nm" for future passes within an hour', () => {
    expect(formatThumbnailCountdown('2024-10-17T12:23:00Z', NOW)).toBe('in 23m');
  });

  it('reports compact "Nm ago" for past passes', () => {
    expect(formatThumbnailCountdown('2024-10-17T11:45:00Z', NOW)).toBe('15m ago');
  });

  it('switches to compact hours past 60 min', () => {
    expect(formatThumbnailCountdown('2024-10-17T14:00:00Z', NOW)).toBe('in 2h');
  });

  it('returns "" for unparseable input', () => {
    expect(formatThumbnailCountdown('garbage', NOW)).toBe('');
  });
});

// formatLookDirection (the off-forward "tilt · aim" formatter) was removed in
// v1.7.7.0. The thumbnail's CLOSEST row now uses track-offset.ts:formatTrackOffset
// ("x° right/left of track"), tested in track-offset.test.ts; the INITIAL row is
// a lead-time "rising ahead" heads-up. Render integration is covered below.

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
    // With photo conditions present (samplePass has nadir geometry) the
    // root is the panel; the 256px thumbnail box is its first child.
    expect(el.className).toBe('pass-thumbnail-panel');
    expect(el.firstElementChild!.className).toBe('pass-thumbnail');
    const img = el.querySelector<HTMLImageElement>('img.pass-thumbnail-image');
    expect(img).not.toBeNull();
    expect(img!.src).toMatch(/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/);
    // z=12 in the URL (the thumbnail zoom).
    expect(img!.src).toContain(`/${THUMBNAIL_ZOOM}/`);
  });

  it('composites a reference-labels tile over the imagery so the site is identifiable', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const labels = el.querySelector<HTMLImageElement>('img.pass-thumbnail-labels');
    expect(labels).not.toBeNull();
    expect(labels!.src).toMatch(
      /server\.arcgisonline\.com\/ArcGIS\/rest\/services\/Reference\/World_Boundaries_and_Places/,
    );
    expect(labels!.src).toContain(`/${THUMBNAIL_ZOOM}/`);
  });

  it('renders the photo-conditions camera row below the image (Unit 1)', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const block = el.querySelector('.photo-conditions');
    expect(block).not.toBeNull();
    expect(block!.querySelector('.photo-conditions-divider')!.textContent)
      .toBe('photo conditions');
    const row = block!.querySelector<HTMLButtonElement>('.photo-condition-row');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.photo-condition-label')!.textContent)
      .toBe('📷 tracked floors · hand-track');
    // 87km nadir / 410km alt → slant ≈ 419km: same rounded numbers as nadir.
    expect(row!.querySelector('.photo-condition-value')!.textContent)
      .toBe('400mm ≈38km ≥1/640 · 800mm ≈19km ≥1/1250 · 1200mm ≈13km ≥1/2000');
    // The block must be a SIBLING of the 256px box, never inside it —
    // .pass-thumbnail is overflow:hidden and silently clips in-box content
    // (visual QA 2026-06-11). And never in the caption overlay (D4).
    expect(el.querySelector('.pass-thumbnail .photo-conditions')).toBeNull();
    expect(el.querySelector('.pass-thumbnail-caption .photo-conditions')).toBeNull();
  });

  it('mounts the ⚡ sprite-watch row when the pass carries a dark-sky sprite field (Unit 7)', () => {
    // The full feed→thumbnail→conditions wiring for a sprite pass: a night
    // pass whose closest_approach sits ~6 h before the June-2026 new moon
    // (dark sky), so the moon gate does NOT suppress. Same geometry as the
    // in-browser proof, exercised here through the real render function.
    const spritePass: PassEntry = {
      ...samplePass,
      pass_regime: 'night',
      closest_approach: '2026-06-15T03:00:00Z',
      iss_at_closest: { lat: 15, lon: -85, alt_km: 420 },
      sprite: { distance_km: 1480, bearing_deg: 158, flash_count: 320 },
    };
    const el = renderPassThumbnail(spritePass, null, Date.parse('2026-06-15T03:00:00Z'));
    const sprite = [...el.querySelectorAll<HTMLButtonElement>('.photo-condition-row')].find(
      (r) => /sprite watch/.test(r.querySelector('.photo-condition-label')?.textContent ?? ''),
    );
    expect(sprite).toBeTruthy();
    expect(sprite!.tagName).toBe('BUTTON');  // every row deep-links to the almanac
    expect(sprite!.querySelector('.photo-condition-label')!.textContent).toBe('⚡ sprite watch');
    const v = sprite!.querySelector('.photo-condition-value')!.textContent!;
    expect(v).toContain('possible sprites');   // honest hedge, never a detection claim
    expect(v).toContain('1480km SSE');         // distance + 16-pt bearing (158° → SSE)
    expect(v).toContain('try the dark limb');  // does NOT command "limb only" — Pettit shoots nadir too
  });

  it('suppresses the sprite row under a bright Moon despite a sprite field (Unit 7 moon gate)', () => {
    // Full moon with the ISS at the lunar sub-point → moonlit → faint red
    // sprites wash out, so the row stays silent. The block still renders its
    // other rows (camera floors) — the gate drops one row, not the panel.
    const moonlitSprite: PassEntry = {
      ...samplePass,
      pass_regime: 'night',
      closest_approach: '2026-06-29T23:57:00Z',
      iss_at_closest: { lat: -27, lon: 2, alt_km: 420 },
      sprite: { distance_km: 1480, bearing_deg: 158, flash_count: 320 },
    };
    const el = renderPassThumbnail(moonlitSprite, null, Date.parse('2026-06-29T23:57:00Z'));
    const labels = [...el.querySelectorAll('.photo-condition-label')].map((l) => l.textContent);
    expect(labels.some((t) => /sprite/.test(t ?? ''))).toBe(false);
    expect(el.querySelector('.photo-conditions')).not.toBeNull();
  });

  it('omits the conditions block entirely when the pass has no nadir geometry', () => {
    const broken = { ...samplePass, nadir_distance_km: NaN };
    const el = renderPassThumbnail(broken, null, NOW);
    // Degenerate passes keep the ORIGINAL root — zero structural change.
    expect(el.className).toBe('pass-thumbnail');
    expect(el.querySelector('.photo-conditions')).toBeNull();
    expect(el.querySelector('.photo-conditions-divider')).toBeNull();
  });

  it('removes failed label tiles, leaving the imagery intact', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const labelTiles = [...el.querySelectorAll<HTMLImageElement>('img.pass-thumbnail-labels')];
    expect(labelTiles.length).toBeGreaterThan(0);
    // Each label tile self-removes on failure (gap beats a broken icon).
    labelTiles.forEach((t) => t.dispatchEvent(new Event('error')));
    expect(el.querySelector('img.pass-thumbnail-labels')).toBeNull();
    // The imagery tiles must survive a labels failure.
    expect(el.querySelector('img.pass-thumbnail-image')).not.toBeNull();
  });

  it('shows the Esri attribution per ToS', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const attr = el.querySelector('.pass-thumbnail-attribution');
    expect(attr).not.toBeNull();
    expect(attr!.textContent).toContain('Esri');
    expect(attr!.textContent).toContain('Maxar');
    expect(attr!.textContent).toContain('Earthstar Geographics');
  });

  it('renders a CLOSEST row and NO duplicated nadir/window context line', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const cap = el.querySelector('.pass-thumbnail-caption');
    expect(cap).not.toBeNull();
    // CLOSEST row: countdown + off-nadir tilt.
    expect(cap!.textContent).toContain('CLOSEST');
    expect(cap!.textContent).toContain('in 30m');
    expect(cap!.textContent).toContain('22°');
    // The nadir/window line is gone — the card directly above already shows
    // "nadir N km" and the WORF/Cupola tag; repeating them here was duplication.
    expect(el.querySelector('.pass-thumbnail-caption-context')).toBeNull();
    expect(cap!.textContent).not.toContain('km nadir');
    expect(cap!.textContent).not.toContain('WORF');
  });

  it('renders an INITIAL "rising ahead" lead-time row when encounter present', () => {
    const withEnc: PassEntry = {
      ...samplePass,
      encounter: {
        time: '2024-10-17T12:27:00Z',  // 3 min before closest → "in 27m" @ NOW
        off_nadir_deg: 41,
        rel_bearing_deg: 90,
      },
    };
    const el = renderPassThumbnail(withEnc, null, NOW);
    const rows = [...el.querySelectorAll('.pass-thumbnail-caption-row')];
    const labels = rows.map((r) => r.querySelector('.pass-thumbnail-caption-label')!.textContent);
    expect(labels).toContain('INITIAL');
    expect(labels).toContain('CLOSEST');
    const initRow = rows.find(
      (r) => r.querySelector('.pass-thumbnail-caption-label')!.textContent === 'INITIAL',
    )!;
    const v = initRow.querySelector('.pass-thumbnail-caption-value')!.textContent!;
    expect(v).toBe('in 27m · rising ahead');  // lead time + heads-up; direction is on CLOSEST
  });

  it('renders CLOSEST as "x° right/left of track" when off-nadir + bearing present', () => {
    // off-nadir 22° + bearing 90 (starboard) → "22° right of track" (CEO convention).
    const right: PassEntry = { ...samplePass, iss_relative_bearing_deg: 90 };
    const closestVal = (p: PassEntry): string | null => {
      const el = renderPassThumbnail(p, null, NOW);
      return [...el.querySelectorAll('.pass-thumbnail-caption-row')]
        .find((r) => r.querySelector('.pass-thumbnail-caption-label')!.textContent === 'CLOSEST')!
        .querySelector('.pass-thumbnail-caption-value')!.textContent;
    };
    expect(closestVal(right)).toBe('in 30m · 22° right of track');
    // port half (bearing 270) → "left of track" at the DOM integration layer too.
    const left: PassEntry = { ...samplePass, iss_relative_bearing_deg: 270 };
    expect(closestVal(left)).toBe('in 30m · 22° left of track');
  });

  it('omits the INITIAL row when encounter is absent (grazing pass / old manifest)', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);  // no encounter field
    const labels = [...el.querySelectorAll('.pass-thumbnail-caption-label')]
      .map((l) => l.textContent);
    expect(labels).not.toContain('INITIAL');
    expect(labels).toContain('CLOSEST');  // closest-only render, no error
  });

  it('shows a bare off-nadir on CLOSEST when rel_bearing is absent (no track side)', () => {
    // samplePass has angle_off_nadir_deg=22 but no iss_relative_bearing_deg —
    // older manifest shape. Degrades to a bare angle, no "of track".
    const el = renderPassThumbnail(samplePass, null, NOW);
    const closestRow = [...el.querySelectorAll('.pass-thumbnail-caption-row')]
      .find((r) => r.querySelector('.pass-thumbnail-caption-label')!.textContent === 'CLOSEST')!;
    const val = closestRow.querySelector('.pass-thumbnail-caption-value')!.textContent!;
    expect(val).toBe('in 30m · 22°');
    expect(val).not.toContain('of track');
  });

  it('drops the direction when off-nadir is absent (no angle → no track offset)', () => {
    const noAngle: PassEntry = {
      ...samplePass, angle_off_nadir_deg: NaN, iss_relative_bearing_deg: 71,
    };
    const el = renderPassThumbnail(noAngle, null, NOW);
    const closestRow = [...el.querySelectorAll('.pass-thumbnail-caption-row')]
      .find((r) => r.querySelector('.pass-thumbnail-caption-label')!.textContent === 'CLOSEST')!;
    expect(closestRow.querySelector('.pass-thumbnail-caption-value')!.textContent).toBe('in 30m');
  });

  it('renders the track offset with no leading countdown when the time is unparseable', () => {
    const noTime: PassEntry = {
      ...samplePass, closest_approach: 'garbage', iss_relative_bearing_deg: 90,
    };
    const el = renderPassThumbnail(noTime, null, NOW);
    const closestRow = [...el.querySelectorAll('.pass-thumbnail-caption-row')]
      .find((r) => r.querySelector('.pass-thumbnail-caption-label')!.textContent === 'CLOSEST')!;
    expect(closestRow.querySelector('.pass-thumbnail-caption-value')!.textContent)
      .toBe('22° right of track');  // no leading separator, no countdown
  });

  it('omits the INITIAL row when encounter.time is unparseable (defensive)', () => {
    const badEnc: PassEntry = {
      ...samplePass,
      encounter: { time: 'not-a-date', off_nadir_deg: 40, rel_bearing_deg: 90 },
    };
    const el = renderPassThumbnail(badEnc, null, NOW);
    const labels = [...el.querySelectorAll('.pass-thumbnail-caption-label')]
      .map((l) => l.textContent);
    expect(labels).not.toContain('INITIAL');  // unparseable time → skipped, no crash
    expect(labels).toContain('CLOSEST');
  });

  it('drops a row whose value is fully empty (unparseable closest + no angle)', () => {
    // closest_approach unparseable → countdown ''; angle NaN → no angle part →
    // rowValue '' → addRow skips it. No CLOSEST row, no context line, no crash.
    const empty: PassEntry = {
      ...samplePass,
      closest_approach: 'garbage',
      angle_off_nadir_deg: NaN,
      nadir_distance_km: NaN,
    };
    const el = renderPassThumbnail(empty, null, NOW);
    expect(el.querySelector('.pass-thumbnail-caption-row')).toBeNull();
    expect(el.querySelector('.pass-thumbnail-caption-context')).toBeNull();
    // The thumbnail itself still renders (caption just has no rows).
    expect(el.className).toBe('pass-thumbnail');
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
    // Only the center (target-containing) tile carries the placeholder handler;
    // fire 'error' on every imagery tile so the center one reacts regardless
    // of its position in the layout order.
    [...el.querySelectorAll<HTMLImageElement>('img.pass-thumbnail-image')]
      .forEach((t) => t.dispatchEvent(new Event('error')));
    // After the handler runs, the center image is swapped for the placeholder.
    const placeholder = el.querySelector('.pass-thumbnail-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toContain('Imagery unavailable');
    // The wrap (the 256px box — root may be the conditions panel) gets a
    // class flag so the polyline overlay can still show.
    const box = el.classList.contains('pass-thumbnail')
      ? el
      : el.querySelector('.pass-thumbnail')!;
    expect(box.classList.contains('pass-thumbnail-tile-failed')).toBe(true);
  });

  it('omits the polyline when no track is available', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    expect(el.querySelector('path.pass-thumbnail-iss-track')).toBeNull();
  });

  it('lays out 1-4 absolutely-positioned tiles with the target at canvas center', () => {
    const el = renderPassThumbnail(samplePass, null, NOW);
    const tiles = [...el.querySelectorAll<HTMLImageElement>('img.pass-thumbnail-image')];
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(4);
    expect(tiles.every((t) => t.style.position === 'absolute')).toBe(true);

    // The center tile (containing the target) must be positioned so the
    // target's exact fractional position maps to the canvas center (128,128).
    const t = lonLatToTileXY(samplePass.target_lon, samplePass.target_lat, THUMBNAIL_ZOOM);
    const cx = Math.floor(t.x);
    const cy = Math.floor(t.y);
    const expectedLeft = Math.round(cx * 256 - (t.x * 256 - 128));
    const expectedTop = Math.round(cy * 256 - (t.y * 256 - 128));
    const centerTile = tiles.find(
      (im) => Math.round(parseFloat(im.style.left)) === expectedLeft
        && Math.round(parseFloat(im.style.top)) === expectedTop,
    );
    expect(centerTile).toBeTruthy();
    const targetX = parseFloat(centerTile!.style.left) + (t.x - cx) * 256;
    const targetY = parseFloat(centerTile!.style.top) + (t.y - cy) * 256;
    expect(targetX).toBeCloseTo(128, 0);
    expect(targetY).toBeCloseTo(128, 0);
  });
});
