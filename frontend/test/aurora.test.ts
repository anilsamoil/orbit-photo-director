/**
 * Tests for frontend/src/aurora.ts — Kp topbar widget.
 *
 * Coverage:
 * - fetchKpData: happy path, 5xx, malformed JSON, network error → all null
 * - kpToColorClass: every Kp threshold boundary
 * - renderKpWidget: null state hides; valid state renders + applies class +
 *   tooltip; tooltip age format switches at 60min boundary; the Kp value
 *   lives in a .kp-value child span so re-renders preserve the aurora note
 * - initKpWidget: click and keyboard activation open SWPC dashboard
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SWPC_DASHBOARD_URL,
  fetchKpData,
  initKpWidget,
  kpToColorClass,
  renderKpWidget,
} from '../src/aurora';

describe('fetchKpData', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
  });

  it('returns parsed KpData on a successful response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ kp: 4.2, timestamp: '2026-05-13T11:55:00Z', age_min: 5 })),
    );
    const result = await fetchKpData(fetchSpy as unknown as typeof fetch);
    expect(result).toEqual({ kp: 4.2, timestamp: '2026-05-13T11:55:00Z', age_min: 5 });
  });

  it('returns null on 5xx response', async () => {
    fetchSpy.mockResolvedValue(new Response('error', { status: 502 }));
    expect(await fetchKpData(fetchSpy as unknown as typeof fetch)).toBeNull();
  });

  it('returns null on malformed JSON (missing fields)', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ kp: 4.2 })));
    expect(await fetchKpData(fetchSpy as unknown as typeof fetch)).toBeNull();
  });

  it('returns null on wrong field types (schema drift defense)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ kp: 'four', timestamp: '...', age_min: 5 })),
    );
    expect(await fetchKpData(fetchSpy as unknown as typeof fetch)).toBeNull();
  });

  it('returns null on network error (fetch throws)', async () => {
    fetchSpy.mockRejectedValue(new Error('net down'));
    expect(await fetchKpData(fetchSpy as unknown as typeof fetch)).toBeNull();
  });
});

describe('kpToColorClass', () => {
  it('classifies quiet range (Kp < 3) as kp-quiet', () => {
    expect(kpToColorClass(0)).toBe('kp-quiet');
    expect(kpToColorClass(2.9)).toBe('kp-quiet');
  });

  it('classifies active range (3 ≤ Kp < 5) as kp-active', () => {
    expect(kpToColorClass(3)).toBe('kp-active');
    expect(kpToColorClass(4.9)).toBe('kp-active');
  });

  it('classifies storm range (5 ≤ Kp < 7) as kp-storm', () => {
    expect(kpToColorClass(5)).toBe('kp-storm');
    expect(kpToColorClass(6.9)).toBe('kp-storm');
  });

  it('classifies severe range (Kp ≥ 7) as kp-severe', () => {
    expect(kpToColorClass(7)).toBe('kp-severe');
    expect(kpToColorClass(9)).toBe('kp-severe');
  });

  it('falls back to quiet for invalid input', () => {
    expect(kpToColorClass(NaN)).toBe('kp-quiet');
    expect(kpToColorClass(-1)).toBe('kp-quiet');
  });
});

describe('renderKpWidget', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'kp-widget';
  });

  it('hides the widget when state is null', () => {
    container.hidden = false;
    container.textContent = 'stale';
    renderKpWidget(null, container);
    expect(container.hidden).toBe(true);
    expect(container.textContent).toBe('');
  });

  it('renders Kp with the right color class', () => {
    renderKpWidget({ kp: 4.2, timestamp: '2026-05-13T11:55:00Z', age_min: 5 }, container);
    expect(container.hidden).toBe(false);
    expect(container.textContent).toBe('Kp 4.2');
    expect(container.className).toContain('kp-active');
  });

  it('applies kp-severe class for Kp ≥ 7', () => {
    renderKpWidget({ kp: 7.7, timestamp: 'x', age_min: 10 }, container);
    expect(container.className).toContain('kp-severe');
  });

  it('formats tooltip with minutes-only when age < 60', () => {
    renderKpWidget({ kp: 3.0, timestamp: 'x', age_min: 47 }, container);
    expect(container.title).toContain('47m ago');
  });

  it('formats tooltip with hours-and-minutes when age ≥ 60', () => {
    renderKpWidget({ kp: 3.0, timestamp: 'x', age_min: 102 }, container);
    expect(container.title).toContain('1h 42m ago');
  });

  it('is idempotent across re-renders (1Hz tick pattern)', () => {
    renderKpWidget({ kp: 4.2, timestamp: 'x', age_min: 5 }, container);
    renderKpWidget({ kp: 4.2, timestamp: 'x', age_min: 5 }, container);
    renderKpWidget({ kp: 4.2, timestamp: 'x', age_min: 5 }, container);
    expect(container.textContent).toBe('Kp 4.2');
  });

  it('updates from a previously rendered state to null state cleanly', () => {
    renderKpWidget({ kp: 4.2, timestamp: 'x', age_min: 5 }, container);
    renderKpWidget(null, container);
    expect(container.hidden).toBe(true);
    expect(container.title).toBe('');
  });
});

describe('initKpWidget', () => {
  let container: HTMLDivElement;
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.unstubAllGlobals();
  });

  it('opens SWPC dashboard on click', () => {
    initKpWidget(container);
    container.click();
    expect(openSpy).toHaveBeenCalledWith(SWPC_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
  });

  it('opens SWPC dashboard on Enter key', () => {
    initKpWidget(container);
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    container.dispatchEvent(evt);
    expect(openSpy).toHaveBeenCalled();
  });

  it('opens SWPC dashboard on Space key', () => {
    initKpWidget(container);
    const evt = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
    container.dispatchEvent(evt);
    expect(openSpy).toHaveBeenCalled();
  });

  it('sets role=button and tabindex for a11y', () => {
    initKpWidget(container);
    expect(container.getAttribute('role')).toBe('button');
    expect(container.getAttribute('tabindex')).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// Aurora v1.1 — visibility from the ISS (grid fetch, cap scan, sun gate,
// trust-calibrated rendering, refresh rate-limit)
// ---------------------------------------------------------------------------

import {
  AURORA_DAYLIT_SUN_ELEV_DEG,
  AURORA_PROB_FAINT,
  AURORA_PROB_IN_VIEW,
  _resetAuroraStateForTest,
  assessAuroraVisibility,
  fetchAuroraGrid,
  maxAuroraNearIss,
  refreshAuroraVisibility,
  renderAuroraVisibility,
  sunElevationDeg,
  type AuroraGrid,
} from '../src/aurora';
import { subsolarPoint } from '../src/terminator';

/** 36×72 zero grid with named hot cells set by (lat, lon, prob). */
function gridWith(hot: Array<[lat: number, lon: number, prob: number]>): AuroraGrid {
  const probs = Array.from({ length: 36 }, () => new Array<number>(72).fill(0));
  for (const [lat, lon, p] of hot) {
    const row = probs[Math.floor((lat + 90) / 5)];
    if (row) row[Math.floor(((lon + 360) % 360) / 5)] = p;
  }
  return {
    observation_time: '2026-06-11T04:16:00Z',
    forecast_time: '2026-06-11T05:22:00Z',
    age_min: 12,
    grid_step: 5,
    probs,
  };
}

describe('fetchAuroraGrid', () => {
  it('reconstructs fields explicitly: defaults for grid_step/degraded drift', async () => {
    const base = gridWith([]);
    const sparse = {
      observation_time: base.observation_time,
      age_min: 12,
      probs: base.probs,
      // no grid_step, no degraded, no forecast_time
    };
    const okFetch = (async () => new Response(JSON.stringify(sparse))) as typeof fetch;
    const grid = await fetchAuroraGrid(okFetch);
    expect(grid).not.toBeNull();
    expect(grid!.grid_step).toBe(5);
    expect(grid!.degraded).toBe(false);
  });

  it('parses a valid response and rejects malformed ones', async () => {
    const good = gridWith([]);
    const okFetch = (async () => new Response(JSON.stringify(good))) as typeof fetch;
    expect(await fetchAuroraGrid(okFetch)).not.toBeNull();
    const badFetch = (async () => new Response(JSON.stringify({ nope: 1 }))) as typeof fetch;
    expect(await fetchAuroraGrid(badFetch)).toBeNull();
    const errFetch = (async () => new Response('x', { status: 502 })) as typeof fetch;
    expect(await fetchAuroraGrid(errFetch)).toBeNull();
  });
});

describe('maxAuroraNearIss (look-angle cap, not naive subpoint)', () => {
  it('sees a bright cell well away from the subpoint but inside the cap', () => {
    // ISS over 60°N 0°E; aurora cell at 75°N 0°E ≈ 1,670km away — visible.
    const grid = gridWith([[75, 0, 80]]);
    expect(maxAuroraNearIss(grid, 60, 0)).toBe(80);
  });

  it('ignores aurora beyond the ~3,600km cap', () => {
    // ISS over the equator; cell at 75°N ≈ 8,300km away — not in view.
    const grid = gridWith([[75, 0, 80]]);
    expect(maxAuroraNearIss(grid, 0, 0)).toBe(0);
  });

  it('handles the antimeridian (grid lons 0..360 vs ISS lon −180..180)', () => {
    // ISS at 65°N 179°W; hot cell at 67°N 175°E — neighbors across the seam.
    const grid = gridWith([[67, 175, 50]]);
    expect(maxAuroraNearIss(grid, 65, -179)).toBe(50);
  });
});

describe('sunElevationDeg', () => {
  it('is ~90° at the subsolar point and ~−90° at its antipode', () => {
    const when = new Date('2026-06-11T12:00:00Z');
    const sub = subsolarPoint(when);
    expect(sunElevationDeg(sub.lat, sub.lon, when)).toBeGreaterThan(89);
    const antipodeLon = sub.lon > 0 ? sub.lon - 180 : sub.lon + 180;
    expect(sunElevationDeg(-sub.lat, antipodeLon, when)).toBeLessThan(-89);
  });
});

describe('assessAuroraVisibility', () => {
  const whenNoon = new Date('2026-06-11T12:00:00Z');

  function nightSpot(when: Date): { lat: number; lon: number } {
    // High-lat point on the night side: antipode of the subsolar point,
    // nudged north into plausible aurora latitudes.
    const sub = subsolarPoint(when);
    const lon = sub.lon > 0 ? sub.lon - 180 : sub.lon + 180;
    return { lat: Math.min(65, -sub.lat + 40), lon };
  }

  it('daylit gate wins regardless of the oval', () => {
    const sub = subsolarPoint(whenNoon);
    const grid = gridWith([[sub.lat + 5, sub.lon, 99]]);
    const vis = assessAuroraVisibility(grid, sub.lat, sub.lon, whenNoon);
    expect(vis.state).toBe('daylit');
  });

  it('confident copy only at the high threshold; hedged in between', () => {
    const spot = nightSpot(whenNoon);
    const strong = gridWith([[spot.lat + 5, spot.lon, AURORA_PROB_IN_VIEW]]);
    expect(assessAuroraVisibility(strong, spot.lat, spot.lon, whenNoon).state).toBe('in-view');
    const faint = gridWith([[spot.lat + 5, spot.lon, AURORA_PROB_FAINT]]);
    expect(assessAuroraVisibility(faint, spot.lat, spot.lon, whenNoon).state).toBe('faint');
    const dark = gridWith([[spot.lat + 5, spot.lon, AURORA_PROB_FAINT - 1]]);
    expect(assessAuroraVisibility(dark, spot.lat, spot.lon, whenNoon).state).toBe('none');
  });

  it('daylit threshold stays inside nautical twilight (recalibration guard)', () => {
    // The comment justifies −8° as "inside nautical twilight, biased toward
    // suppression" — pin the band so a future recalibration outside
    // civil (−6) … nautical (−12) has to update the rationale too.
    expect(AURORA_DAYLIT_SUN_ELEV_DEG).toBeLessThan(-6);
    expect(AURORA_DAYLIT_SUN_ELEV_DEG).toBeGreaterThan(-12);
  });

  it('per-cell sun gate: a daylit hot cell on the cap rim cannot fire past a dark nadir', () => {
    // Geometry built relative to the real subsolar point so the scenario
    // is exact: ISS on the equator 105° of longitude from the sun (nadir
    // dark, ≈ −14°); one hot cell sunward at +77.5° (daylit, ≈ +12°), one
    // anti-sunward at +132.5° (dark, ≈ −40°). Both cells sit ~27.5° from
    // the ISS — inside the 3,600km cap with margin for cell-center snap.
    const when = new Date('2026-06-11T12:00:00Z');
    const sub = subsolarPoint(when);
    const signed = (x: number): number => ((x + 540) % 360) - 180;
    const issLon = signed(sub.lon + 105);
    const daylitCellLon = signed(sub.lon + 77.5);
    const darkCellLon = signed(sub.lon + 132.5);
    // Preconditions, asserted so drift fails loudly:
    expect(sunElevationDeg(0, issLon, when)).toBeLessThan(AURORA_DAYLIT_SUN_ELEV_DEG);
    expect(sunElevationDeg(0, daylitCellLon, when)).toBeGreaterThan(AURORA_DAYLIT_SUN_ELEV_DEG);
    expect(sunElevationDeg(0, darkCellLon, when)).toBeLessThan(AURORA_DAYLIT_SUN_ELEV_DEG);

    const daylitGrid = gridWith([[0, daylitCellLon, 90]]);
    // Pure geometry (no `when`): the cell IS inside the cap…
    expect(maxAuroraNearIss(daylitGrid, 0, issLon)).toBe(90);
    // …but with the sun gate it cannot contribute,
    expect(maxAuroraNearIss(daylitGrid, 0, issLon, when)).toBe(0);
    // and end-to-end the operator never sees a confident false positive.
    expect(assessAuroraVisibility(daylitGrid, 0, issLon, when).state).toBe('none');

    const darkGrid = gridWith([[0, darkCellLon, 90]]);
    expect(maxAuroraNearIss(darkGrid, 0, issLon, when)).toBe(90);
    expect(assessAuroraVisibility(darkGrid, 0, issLon, when).state).toBe('in-view');
  });
});

describe('renderAuroraVisibility (trust-calibrated copy)', () => {
  let widget: HTMLElement;
  beforeEach(() => {
    widget = document.createElement('div');
    widget.textContent = 'Kp 5.0';
  });

  it('appends the note for in-view/faint and names prob + source age in the title', () => {
    renderAuroraVisibility({ state: 'in-view', maxProb: 62, ageMin: 12, degraded: false }, widget);
    const note = widget.querySelector<HTMLElement>('.kp-aurora-note')!;
    expect(note.textContent).toBe(' · aurora in view');
    expect(note.title).toContain('62%');
    expect(note.title).toContain('12m old');
    renderAuroraVisibility({ state: 'faint', maxProb: 20, ageMin: 12, degraded: false }, widget);
    expect(widget.querySelector('.kp-aurora-note')!.textContent).toBe(' · aurora nearby');
  });

  it('flags degraded source in the tooltip', () => {
    renderAuroraVisibility({ state: 'in-view', maxProb: 50, ageMin: 90, degraded: true }, widget);
    expect(widget.querySelector<HTMLElement>('.kp-aurora-note')!.title).toContain('degraded');
  });

  it('removes the note for none/daylit/null', () => {
    renderAuroraVisibility({ state: 'in-view', maxProb: 50, ageMin: 5, degraded: false }, widget);
    renderAuroraVisibility({ state: 'none', maxProb: 0, ageMin: 5, degraded: false }, widget);
    expect(widget.querySelector('.kp-aurora-note')).toBeNull();
    renderAuroraVisibility({ state: 'in-view', maxProb: 50, ageMin: 5, degraded: false }, widget);
    renderAuroraVisibility(null, widget);
    expect(widget.querySelector('.kp-aurora-note')).toBeNull();
  });
});

/** High-lat point on the night side at `when`: antipode of the subsolar
 *  point, nudged north into plausible aurora latitudes (same construction
 *  as assessAuroraVisibility's nightSpot). */
function nightSpotAt(when: Date): { lat: number; lon: number } {
  const sub = subsolarPoint(when);
  const lon = sub.lon > 0 ? sub.lon - 180 : sub.lon + 180;
  return { lat: Math.min(65, -sub.lat + 40), lon };
}

describe('refreshAuroraVisibility (rate-limit gate + staleness honesty)', () => {
  beforeEach(() => {
    _resetAuroraStateForTest();
  });

  it('fetches at most once per 10 minutes after a success', async () => {
    let fetches = 0;
    const spot = { lat: 65, lon: 0 };
    const grid = gridWith([[70, 0, 80]]);
    const counting = (async () => {
      fetches += 1;
      return new Response(JSON.stringify(grid));
    }) as typeof fetch;
    const widget = document.createElement('div');
    const t0 = Date.parse('2026-06-11T05:00:00Z');
    await refreshAuroraVisibility(spot, widget, counting, t0);
    await refreshAuroraVisibility(spot, widget, counting, t0 + 60_000);
    expect(fetches).toBe(1); // second call inside the 10-min window
    await refreshAuroraVisibility(spot, widget, counting, t0 + 11 * 60_000);
    expect(fetches).toBe(2);
  });

  it('a failed fetch does not consume the 10-min window (60s retry)', async () => {
    let fetches = 0;
    let healthy = false;
    const t0 = Date.parse('2026-06-11T12:00:00Z');
    const spot = nightSpotAt(new Date(t0));
    const grid = gridWith([[spot.lat + 5, spot.lon, 80]]);
    const flaky = (async () => {
      fetches += 1;
      if (!healthy) throw new Error('LOS');
      return new Response(JSON.stringify(grid));
    }) as typeof fetch;
    const widget = document.createElement('div');
    await refreshAuroraVisibility(spot, widget, flaky, t0);
    expect(fetches).toBe(1);
    expect(widget.querySelector('.kp-aurora-note')).toBeNull();
    healthy = true;
    // 61s after the FAILURE the gate reopens (not 10 minutes later)…
    await refreshAuroraVisibility(spot, widget, flaky, t0 + 61_000);
    expect(fetches).toBe(2);
    expect(widget.querySelector('.kp-aurora-note')).not.toBeNull();
    // …and after a success the full 10-min gate applies again.
    await refreshAuroraVisibility(spot, widget, flaky, t0 + 121_000);
    expect(fetches).toBe(2);
  });

  it('re-assesses the cached grid against the live position between fetches', async () => {
    let fetches = 0;
    const t0 = Date.parse('2026-06-11T12:00:00Z');
    const when0 = new Date(t0);
    const near = nightSpotAt(when0);
    const grid = gridWith([[near.lat + 5, near.lon, 80]]);
    const counting = (async () => {
      fetches += 1;
      return new Response(JSON.stringify(grid));
    }) as typeof fetch;
    const widget = document.createElement('div');
    await refreshAuroraVisibility(near, widget, counting, t0);
    expect(widget.querySelector('.kp-aurora-note')).not.toBeNull();
    // 5 min later (inside the window — no fetch) the ISS has moved to the
    // dark southern ocean far from the oval: the note must flip OFF from
    // the CACHED grid. Catches "cached the assessment instead of the grid".
    const far = { lat: -40, lon: near.lon };
    expect(sunElevationDeg(far.lat, far.lon, new Date(t0 + 5 * 60_000)))
      .toBeLessThan(AURORA_DAYLIT_SUN_ELEV_DEG);
    await refreshAuroraVisibility(far, widget, counting, t0 + 5 * 60_000);
    expect(fetches).toBe(1);
    expect(widget.querySelector('.kp-aurora-note')).toBeNull();
  });

  it('recomputes the displayed age while holding a grid, and drops it past 24h', async () => {
    let healthy = true;
    const t0 = Date.parse('2026-06-11T12:00:00Z');
    const spot = nightSpotAt(new Date(t0));
    const grid = gridWith([[spot.lat + 5, spot.lon, 80]]); // age_min: 12
    const flaky = (async () => {
      if (!healthy) throw new Error('SWPC outage');
      return new Response(JSON.stringify(grid));
    }) as typeof fetch;
    const widget = document.createElement('div');
    await refreshAuroraVisibility(spot, widget, flaky, t0);
    expect(widget.querySelector<HTMLElement>('.kp-aurora-note')!.title).toContain('12m old');
    // Outage begins. Two hours in: note survives on the last-good grid but
    // the tooltip ages honestly (12m at fetch + 120m held = 2h 12m).
    healthy = false;
    const spot2h = nightSpotAt(new Date(t0 + 2 * 3_600_000));
    await refreshAuroraVisibility(spot2h, widget, flaky, t0 + 2 * 3_600_000);
    expect(widget.querySelector<HTMLElement>('.kp-aurora-note')!.title).toContain('2h 12m old');
    // 25 hours in: effective source age passed 24h — the grid dies and the
    // note disappears, mirroring the worker's own last-good cap. Without
    // this a long-lived tab strands "aurora in view" on dead data.
    const spot25h = nightSpotAt(new Date(t0 + 25 * 3_600_000));
    await refreshAuroraVisibility(spot25h, widget, flaky, t0 + 25 * 3_600_000);
    expect(widget.querySelector('.kp-aurora-note')).toBeNull();
    // Recovery: the next successful fetch restores the note with fresh age.
    healthy = true;
    await refreshAuroraVisibility(spot25h, widget, flaky, t0 + 25 * 3_600_000 + 61_000);
    expect(widget.querySelector<HTMLElement>('.kp-aurora-note')!.title).toContain('12m old');
  });

  it('the aurora note survives Kp badge re-renders (value-span contract)', async () => {
    const t0 = Date.parse('2026-06-11T12:00:00Z');
    const spot = nightSpotAt(new Date(t0));
    const grid = gridWith([[spot.lat + 5, spot.lon, 80]]);
    const okFetch = (async () => new Response(JSON.stringify(grid))) as typeof fetch;
    const widget = document.createElement('div');
    renderKpWidget({ kp: 5.0, timestamp: 'x', age_min: 3 }, widget);
    await refreshAuroraVisibility(spot, widget, okFetch, t0);
    expect(widget.querySelector('.kp-aurora-note')).not.toBeNull();
    // The 60s poll re-renders the badge; before the value-span fix this
    // wiped the note until the next aurora refresh re-appended it.
    renderKpWidget({ kp: 5.3, timestamp: 'x', age_min: 1 }, widget);
    renderKpWidget({ kp: 5.3, timestamp: 'x', age_min: 1 }, widget);
    renderKpWidget({ kp: 6.1, timestamp: 'x', age_min: 0 }, widget);
    expect(widget.querySelectorAll('.kp-aurora-note').length).toBe(1);
    expect(widget.querySelector<HTMLElement>('.kp-value')!.textContent).toBe('Kp 6.1');
    expect(widget.textContent).toContain('· aurora in view');
    // Null state still wipes everything: a hidden widget carries no claims.
    renderKpWidget(null, widget);
    expect(widget.querySelector('.kp-aurora-note')).toBeNull();
  });

  it('clears the note when no position is available', async () => {
    const widget = document.createElement('div');
    const note = document.createElement('span');
    note.className = 'kp-aurora-note';
    widget.appendChild(note);
    await refreshAuroraVisibility(null, widget);
    expect(widget.querySelector('.kp-aurora-note')).toBeNull();
  });
});

describe('moon modulation of the aurora note (Unit 3 — copy-only)', () => {
  let widget: HTMLElement;
  beforeEach(() => { widget = document.createElement('div'); });

  const moonlit: import('../src/moon').MoonState = { phaseName: 'full', glyph: '🌕', illum: 0.98, waning: false, altitudeDeg: 80, skyState: 'moonlit' };
  const upFaint: import('../src/moon').MoonState = { phaseName: 'waxing-crescent', glyph: '🌒', illum: 0.1, waning: false, altitudeDeg: 40, skyState: 'up-faint' };

  it('back-compat: the 3-arg call is unchanged (no moon param)', () => {
    renderAuroraVisibility({ state: 'in-view', maxProb: 62, ageMin: 12, degraded: false }, widget);
    expect(widget.querySelector('.kp-aurora-note')!.textContent).toBe(' · aurora in view');
  });

  it('moonlit appends the hedge to text AND the tooltip', () => {
    renderAuroraVisibility({ state: 'in-view', maxProb: 62, ageMin: 12, degraded: false }, widget, moonlit);
    const note = widget.querySelector<HTMLElement>('.kp-aurora-note')!;
    expect(note.textContent).toBe(' · aurora in view (moonlit — faint)');
    expect(note.title).toContain('moon 98% up — skyglow');
    expect(note.title).toContain('OVATION max 62%'); // base tooltip preserved
  });

  it('faint state hedges the same way for "nearby"', () => {
    renderAuroraVisibility({ state: 'faint', maxProb: 20, ageMin: 5, degraded: false }, widget, moonlit);
    expect(widget.querySelector('.kp-aurora-note')!.textContent).toBe(' · aurora nearby (moonlit — faint)');
  });

  it('up-faint and null moon do NOT modulate', () => {
    renderAuroraVisibility({ state: 'in-view', maxProb: 50, ageMin: 5, degraded: false }, widget, upFaint);
    expect(widget.querySelector('.kp-aurora-note')!.textContent).toBe(' · aurora in view');
    renderAuroraVisibility({ state: 'in-view', maxProb: 50, ageMin: 5, degraded: false }, widget, null);
    expect(widget.querySelector('.kp-aurora-note')!.textContent).toBe(' · aurora in view');
  });
});
