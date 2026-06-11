/**
 * Tests for frontend/src/aurora.ts — Kp topbar widget.
 *
 * Coverage:
 * - fetchKpData: happy path, 5xx, malformed JSON, network error → all null
 * - kpToColorClass: every Kp threshold boundary
 * - renderKpWidget: null state hides; valid state renders + applies class +
 *   tooltip; tooltip age format switches at 60min boundary
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

  it('sanity: the daylit threshold is below the horizon (twilight-aware)', () => {
    expect(AURORA_DAYLIT_SUN_ELEV_DEG).toBeLessThan(0);
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

describe('refreshAuroraVisibility (rate-limit gate)', () => {
  beforeEach(() => {
    _resetAuroraStateForTest();
  });

  it('fetches at most once per 10 minutes; re-assesses against the live position', async () => {
    let fetches = 0;
    const spot = { lat: 65, lon: 0 };
    const grid = gridWith([[70, 0, 80]]);
    const counting = (async () => {
      fetches += 1;
      return new Response(JSON.stringify(grid));
    }) as typeof fetch;
    const widget = document.createElement('div');
    const t0 = Date.parse('2026-06-11T05:00:00Z'); // subpoint dark at 0°E? assessment not asserted here
    await refreshAuroraVisibility(spot, widget, counting, t0);
    await refreshAuroraVisibility(spot, widget, counting, t0 + 60_000);
    expect(fetches).toBe(1); // second call inside the 10-min window
    await refreshAuroraVisibility(spot, widget, counting, t0 + 11 * 60_000);
    expect(fetches).toBe(2);
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
