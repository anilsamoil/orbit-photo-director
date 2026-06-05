import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetOpenBreakdownsForTest, _resetOpenThumbnailsForTest, formatForecastHorizon, formatObsAge, renderCard, renderCards } from '../src/card';
import type { PassEntry } from '../src/types';

const samplePass = (overrides: Partial<PassEntry> = {}): PassEntry => ({
  target_id: 'tokyo-night',
  target_name: 'Tokyo at night',
  target_regime: 'night',
  target_priority: 5,
  target_lat: 35.68,
  target_lon: 139.69,
  closest_approach: '2024-10-17T12:23:00Z',
  nadir_distance_km: 100,
  pass_regime: 'night',
  obstruction_class: 'clear',
  p_unobstructed: 87,
  cloud_fraction: 13,
  cloud_source: 'mock',
  score: 64,
  score_components: {
    p_unobstructed: 87,
    regime_fit: 100,
    nadir_proximity: 80,
    priority_weight: 100,
    tle_freshness: 1,
  },
  iss_at_closest: { lat: 35, lon: 140, alt_km: 410 },
  ...overrides,
});

const NOW = Date.parse('2024-10-17T12:00:00Z');

beforeEach(() => {
  document.body.innerHTML = '<div id="cards"></div>';
});

describe('renderCard', () => {
  it('renders the target name', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    expect(el.querySelector('.card-name')!.textContent).toBe('Tokyo at night');
  });

  it('shows a UTC label in the countdown title attribute', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    const title = el.querySelector('.card-countdown')!.getAttribute('title');
    expect(title).toContain('UTC');
  });

  it('renders the score as a 5-star block in the headline (v1.2.5.0)', () => {
    // Score 64.7 → 4★ tier (50 ≤ score < 75).
    const el = renderCard(samplePass({ score: 64.7 }), NOW, false, () => undefined);
    const stars = el.querySelector('.score-stars')!;
    expect(stars.textContent).toBe('★★★★☆');
    expect(stars.getAttribute('aria-label')).toBe('4 of 5 stars');
    // Raw score doesn't appear in the headline — it lives in the
    // breakdown panel (visible on expand) and in the artifact.
    expect(el.querySelector('.score-value')).toBeNull();
  });

  it('exposes the raw score and word anchor in the breakdown panel header', () => {
    // Tap to open the panel, then verify the header content.
    const el = renderCard(samplePass({ score: 64.7 }), NOW, false, () => undefined);
    const trigger = el.querySelector<HTMLButtonElement>('.card-score')!;
    trigger.click();  // expand
    const header = el.querySelector('.score-breakdown-header')!;
    expect(header.querySelector('.score-stars')!.textContent).toBe('★★★★☆');
    // Header text combines word anchor + raw score for diagnosis.
    expect(header.querySelector('.score-breakdown-header-text')!.textContent).toBe(' solid · score 65');
  });

  it('disables the Shoot button when stale', () => {
    const el = renderCard(samplePass(), NOW, true, () => undefined);
    const shoot = el.querySelector<HTMLButtonElement>('.btn-shoot')!;
    expect(shoot.disabled).toBe(true);
  });

  it('applies the stale class when stale', () => {
    const el = renderCard(samplePass(), NOW, true, () => undefined);
    expect(el.classList.contains('stale')).toBe(true);
  });

  it('emits shoot action on click', () => {
    const onAction = vi.fn();
    const el = renderCard(samplePass(), NOW, false, onAction);
    el.querySelector<HTMLButtonElement>('.btn-shoot')!.click();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.calls[0]![0]).toBe('shoot');
  });

  it('emits skip action on click', () => {
    const onAction = vi.fn();
    const el = renderCard(samplePass(), NOW, false, onAction);
    el.querySelector<HTMLButtonElement>('.btn-skip')!.click();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.calls[0]![0]).toBe('skip');
  });

  it('tags pass regime correctly', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    expect(el.querySelector('.tag.regime-night')).toBeTruthy();
  });

  it('tags obstruction class correctly', () => {
    const el = renderCard(samplePass({ obstruction_class: 'cloudy' }), NOW, false, () => undefined);
    expect(el.querySelector('.tag.obs-cloudy')).toBeTruthy();
  });

  it('shows WORF badge when angle is below 30°', () => {
    const el = renderCard(
      samplePass({ angle_off_nadir_deg: 18 }),
      NOW, false, () => undefined,
    );
    const tag = el.querySelector('.tag.window-worf');
    expect(tag).toBeTruthy();
    expect(tag?.textContent).toContain('WORF');
    expect(tag?.textContent).toContain('18');
    expect(el.querySelector('.tag.window-cupola')).toBeNull();
  });

  it('shows Cupola badge when angle is at or above 30°', () => {
    const el = renderCard(
      samplePass({ angle_off_nadir_deg: 45 }),
      NOW, false, () => undefined,
    );
    const tag = el.querySelector('.tag.window-cupola');
    expect(tag).toBeTruthy();
    expect(tag?.textContent).toContain('Cupola');
    expect(el.querySelector('.tag.window-worf')).toBeNull();
  });

  it('omits the WORF/Cupola badge when angle is missing', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    expect(el.querySelector('.tag.window-worf, .tag.window-cupola')).toBeNull();
  });

  it('shows "no cloud obs" tag when source is combined-no-coverage', () => {
    const el = renderCard(
      samplePass({ cloud_source: 'combined-no-coverage' }),
      NOW, false, () => undefined,
    );
    expect(el.querySelector('.tag.obs-noobs')).toBeTruthy();
  });

  it('omits the "no cloud obs" tag for real cloud sources', () => {
    const el = renderCard(
      samplePass({ cloud_source: 'gibs' }),
      NOW, false, () => undefined,
    );
    expect(el.querySelector('.tag.obs-noobs')).toBeNull();
  });

  it('forecast variant: applies forecast class, omits Shoot/Skip, shows tag', () => {
    const el = renderCard(
      samplePass({ cloud_source: 'gfs-forecast' }),
      NOW, false, () => undefined,
      'forecast',
    );
    expect(el.classList.contains('forecast')).toBe(true);
    expect(el.querySelector('.btn-shoot')).toBeNull();
    expect(el.querySelector('.btn-skip')).toBeNull();
    expect(el.querySelector('.tag.forecast-tag')?.textContent).toContain('forecast');
  });

  it('observed variant: shows Shoot/Skip and no forecast tag for non-forecast source', () => {
    const el = renderCard(
      samplePass({ cloud_source: 'gibs' }),
      NOW, false, () => undefined,
      'observed',
    );
    expect(el.classList.contains('forecast')).toBe(false);
    expect(el.querySelector('.btn-shoot')).toBeTruthy();
    expect(el.querySelector('.btn-skip')).toBeTruthy();
    expect(el.querySelector('.tag.forecast-tag')).toBeNull();
  });

  it('marks gfs-forecast cloud source with forecast tag even in observed variant', () => {
    // If a stale or boundary case ships gfs-forecast in the immediate queue,
    // still tag it so the user knows the source.
    const el = renderCard(
      samplePass({ cloud_source: 'gfs-forecast' }),
      NOW, false, () => undefined,
      'observed',
    );
    expect(el.querySelector('.tag.forecast-tag')).toBeTruthy();
  });

  it('token-aware buttons: hint text + tooltip when no token is set', () => {
    const el = renderCard(
      samplePass(),
      NOW, false, () => undefined,
      { tokenSet: false },
    );
    const shoot = el.querySelector<HTMLButtonElement>('.btn-shoot');
    const skip = el.querySelector<HTMLButtonElement>('.btn-skip');
    expect(shoot?.textContent).toContain('set token');
    expect(skip?.textContent).toContain('set token');
    expect(shoot?.title).toContain('queues offline');
    expect(skip?.title).toContain('queues offline');
  });

  it('token-aware buttons: plain "Shoot"/"Skip" when token is set', () => {
    const el = renderCard(
      samplePass(),
      NOW, false, () => undefined,
      { tokenSet: true },
    );
    const shoot = el.querySelector<HTMLButtonElement>('.btn-shoot');
    const skip = el.querySelector<HTMLButtonElement>('.btn-skip');
    expect(shoot?.textContent).toBe('Shoot');
    expect(skip?.textContent).toBe('Skip');
    expect(shoot?.title).toBe('');
    expect(skip?.title).toBe('');
  });

  it('renderCards still accepts the old positional variant string', () => {
    const c = document.getElementById('cards')!;
    renderCards(c, [samplePass()], NOW, false, () => undefined, 'forecast');
    expect(c.querySelector('.card.forecast')).toBeTruthy();
  });
});

describe('renderCard score breakdown (V4-P2 explainer)', () => {
  beforeEach(() => {
    _resetOpenBreakdownsForTest();
  });

  it('renders the score line as a button (clickable)', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    const score = el.querySelector('.card-score');
    expect(score?.tagName).toBe('BUTTON');
    expect(score?.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides the breakdown panel by default', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    const panel = el.querySelector('.score-breakdown') as HTMLElement;
    expect(panel.hidden).toBe(true);
  });

  it('opens the breakdown panel on click + sets aria-expanded', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    const score = el.querySelector('.card-score') as HTMLButtonElement;
    const panel = el.querySelector('.score-breakdown') as HTMLElement;
    score.click();
    expect(panel.hidden).toBe(false);
    expect(score.getAttribute('aria-expanded')).toBe('true');
    expect(score.classList.contains('open')).toBe(true);
  });

  it('toggles closed on second click', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    const score = el.querySelector('.card-score') as HTMLButtonElement;
    const panel = el.querySelector('.score-breakdown') as HTMLElement;
    score.click();
    score.click();
    expect(panel.hidden).toBe(true);
    expect(score.getAttribute('aria-expanded')).toBe('false');
  });

  it('breakdown table lists all 5 score components + composite footer', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    const rows = el.querySelectorAll('.score-breakdown-table tr');
    expect(rows.length).toBe(6); // 5 components + composite footer
    const names = Array.from(el.querySelectorAll('.sb-name')).map((n) => n.textContent);
    expect(names).toEqual([
      'p(unobstructed)',
      'regime fit',
      'nadir proximity',
      'priority weight',
      'TLE freshness',
      'Composite',
    ]);
  });

  it('breakdown contextualizes nadir distance using the actual km value', () => {
    const el = renderCard(samplePass({ nadir_distance_km: 234 }), NOW, false, () => undefined);
    const noteCells = Array.from(el.querySelectorAll('.sb-note')).map((c) => c.textContent);
    expect(noteCells.some((t) => t?.includes('234 km off target'))).toBe(true);
  });

  it("breakdown explains regime='any' targets without a mismatch reading", () => {
    const el = renderCard(
      samplePass({ target_regime: 'any', pass_regime: 'day' }),
      NOW, false, () => undefined,
    );
    const noteCells = Array.from(el.querySelectorAll('.sb-note')).map((c) => c.textContent);
    expect(noteCells.some((t) => t?.includes('any lighting'))).toBe(true);
  });

  it('open state survives a re-render of the same card (1Hz tick guard)', () => {
    // The rerenderCountdowns tick blows away the card DOM every second.
    // Without a persistence layer, every panel the user opened would close
    // on the next tick. We track open state in a module-level Set keyed by
    // (target_id, closest_approach) and re-apply on render.
    const p = samplePass({ target_id: 'persistent-1' });
    const el1 = renderCard(p, NOW, false, () => undefined);
    (el1.querySelector('.card-score') as HTMLButtonElement).click();
    expect((el1.querySelector('.score-breakdown') as HTMLElement).hidden).toBe(false);

    // Simulate the 1Hz tick: render the same PassEntry again, get a new DOM node.
    const el2 = renderCard(p, NOW + 1000, false, () => undefined);
    const score2 = el2.querySelector('.card-score') as HTMLButtonElement;
    const panel2 = el2.querySelector('.score-breakdown') as HTMLElement;
    expect(panel2.hidden).toBe(false);
    expect(score2.getAttribute('aria-expanded')).toBe('true');
    expect(score2.classList.contains('open')).toBe(true);
  });

  it('closing a panel removes the persistent open state', () => {
    const p = samplePass({ target_id: 'closeable-1' });
    const el1 = renderCard(p, NOW, false, () => undefined);
    const score1 = el1.querySelector('.card-score') as HTMLButtonElement;
    score1.click();  // open
    score1.click();  // close

    // Re-render: panel should be closed.
    const el2 = renderCard(p, NOW + 1000, false, () => undefined);
    expect((el2.querySelector('.score-breakdown') as HTMLElement).hidden).toBe(true);
  });

  it('open state is per-card (different target_id keeps its own panel state)', () => {
    const a = samplePass({ target_id: 'card-a', closest_approach: '2024-10-17T12:00:00Z' });
    const b = samplePass({ target_id: 'card-b', closest_approach: '2024-10-17T13:00:00Z' });
    const elA = renderCard(a, NOW, false, () => undefined);
    (elA.querySelector('.card-score') as HTMLButtonElement).click();  // open A only

    // Re-render both — A should remember open, B should remember closed.
    const elA2 = renderCard(a, NOW + 1000, false, () => undefined);
    const elB2 = renderCard(b, NOW + 1000, false, () => undefined);
    expect((elA2.querySelector('.score-breakdown') as HTMLElement).hidden).toBe(false);
    expect((elB2.querySelector('.score-breakdown') as HTMLElement).hidden).toBe(true);
  });
});

describe('renderCards', () => {
  it('clears the container when empty', () => {
    const c = document.getElementById('cards')!;
    c.innerHTML = '<p>old</p>';
    renderCards(c, [], NOW, false, () => undefined);
    expect(c.children.length).toBe(0);
  });

  it('renders one card per pass', () => {
    const c = document.getElementById('cards')!;
    renderCards(c, [samplePass(), samplePass({ target_id: 'baikal' })], NOW, false, () => undefined);
    expect(c.querySelectorAll('.card')).toHaveLength(2);
  });

  it('replaces existing cards on each render', () => {
    const c = document.getElementById('cards')!;
    renderCards(c, [samplePass()], NOW, false, () => undefined);
    renderCards(c, [], NOW, false, () => undefined);
    expect(c.children.length).toBe(0);
  });
});

describe('formatObsAge', () => {
  const now = Date.parse('2024-10-17T12:00:00Z');

  it('returns "<1m ago" for sub-minute ages', () => {
    expect(formatObsAge('2024-10-17T11:59:30Z', now)).toBe('<1m ago');
  });

  it('returns minutes for ages under 1h', () => {
    expect(formatObsAge('2024-10-17T11:48:00Z', now)).toBe('12m ago');
  });

  it('returns hours (1 decimal) for ages under 10h', () => {
    expect(formatObsAge('2024-10-17T08:30:00Z', now)).toBe('3.5h ago');
  });

  it('returns hours (whole) for ages 10h–24h', () => {
    expect(formatObsAge('2024-10-17T00:00:00Z', now)).toBe('12h ago');
  });

  it('formats just under and just over the 10h boundary correctly', () => {
    // 9.0h → '9.0h ago' (1 decimal), 9.9h → '9.9h ago', 10h → '10h ago' (whole).
    // Off-by-one at the toFixed switch point would break the visual rhythm
    // of the obs-age tag.
    expect(formatObsAge('2024-10-17T03:00:00Z', now)).toBe('9.0h ago');
    expect(formatObsAge('2024-10-17T02:06:00Z', now)).toBe('9.9h ago');
    expect(formatObsAge('2024-10-17T02:00:00Z', now)).toBe('10h ago');
  });

  it('returns days past 24h', () => {
    expect(formatObsAge('2024-10-15T12:00:00Z', now)).toBe('2d ago');
  });

  it('returns empty string for malformed timestamps', () => {
    expect(formatObsAge('not a date', now)).toBe('');
  });

  it('returns empty string for future-dated samples (clock skew)', () => {
    expect(formatObsAge('2024-10-17T12:30:00Z', now)).toBe('');
  });
});

describe('formatForecastHorizon', () => {
  const now = Date.parse('2024-10-17T12:00:00Z');

  it('returns empty string for past-dated samples (caller uses formatObsAge)', () => {
    expect(formatForecastHorizon('2024-10-17T11:00:00Z', now)).toBe('');
  });

  it('returns empty string for the exact-now boundary', () => {
    // 0 minutes ahead is not a forecast — fall back to obs path.
    expect(formatForecastHorizon('2024-10-17T12:00:00Z', now)).toBe('');
  });

  it('returns minutes for sub-hour horizons', () => {
    expect(formatForecastHorizon('2024-10-17T12:42:00Z', now)).toBe('+42m');
  });

  it('returns hours (1 decimal) for horizons under 10h', () => {
    expect(formatForecastHorizon('2024-10-17T18:00:00Z', now)).toBe('+6.0h');
  });

  it('returns hours (whole) for horizons 10h–24h', () => {
    expect(formatForecastHorizon('2024-10-18T05:00:00Z', now)).toBe('+17h');
  });

  it('returns days for multi-day forecasts', () => {
    expect(formatForecastHorizon('2024-10-20T12:00:00Z', now)).toBe('+3d');
  });

  it('returns empty string for malformed timestamps', () => {
    expect(formatForecastHorizon('not a date', now)).toBe('');
  });
});

describe('renderCard obs-age tag', () => {
  const now = Date.parse('2024-10-17T12:00:00Z');

  it('renders the obs-age tag when sample_time is present', () => {
    const card = renderCard(
      samplePass({ cloud_source: 'gibs', sample_time: '2024-10-17T11:48:00Z' }),
      now, false, () => undefined,
    );
    const tag = card.querySelector('.tag.obs-age');
    expect(tag?.textContent).toBe('obs 12m ago');
  });

  it('omits obs-age when cloud_source is a no-observation placeholder', () => {
    const card = renderCard(
      samplePass({ cloud_source: 'mock', sample_time: '2024-10-17T11:48:00Z' }),
      now, false, () => undefined,
    );
    expect(card.querySelector('.tag.obs-age')).toBeNull();
    // Still gets the no-cloud-obs tag instead.
    expect(card.querySelector('.tag.obs-noobs')).not.toBeNull();
  });

  it('omits obs-age silently when sample_time is missing (older manifests)', () => {
    const card = renderCard(
      samplePass({ cloud_source: 'gibs' }),  // no sample_time
      now, false, () => undefined,
    );
    expect(card.querySelector('.tag.obs-age')).toBeNull();
  });
});

// formatRelativeBearing was removed in v1.7.7.0 — the card/map/thumbnail now
// share track-offset.ts:formatTrackOffset ("x° right/left of track"), tested in
// track-offset.test.ts. The card-render assertions below cover the integration.

describe('renderCard launch.kind tag (V3-P2 ASCENT)', () => {
  const launchOverhead = samplePass({
    launch: {
      name: 'Falcon 9 | Starlink 11-X',
      rocket_type: 'Falcon 9 Block 5',
      geometry: 'overhead',
      kind: 'overhead',
      site_name: 'LC-39A',
      net_window_seconds: 0,
      t0: '2024-10-17T12:23:00Z',
    },
  });
  const launchAscent = samplePass({
    launch: {
      name: 'Falcon 9 | Starlink 11-X',
      rocket_type: 'Falcon 9 Block 5',
      geometry: 'ascent',
      kind: 'ascent',
      site_name: 'LC-39A',
      net_window_seconds: 0,
      t0: '2024-10-17T12:23:00Z',
    },
  });
  const launchOlderManifest = samplePass({
    launch: {
      name: 'Falcon 9 | Starlink 11-X',
      rocket_type: 'Falcon 9 Block 5',
      geometry: 'overhead',
      // no `kind` — manifest predates V3-P2
      site_name: 'LC-39A',
      net_window_seconds: 0,
      t0: '2024-10-17T12:23:00Z',
    },
  });

  it('renders "OVERHEAD pass" for kind=overhead', () => {
    const card = renderCard(launchOverhead, NOW, false, () => undefined);
    const tag = card.querySelector('.tag.launch-overhead');
    expect(tag?.textContent).toBe('🚀 OVERHEAD pass');
  });

  it('renders "ASCENT plume" for kind=ascent + uses launch-ascent class', () => {
    const card = renderCard(launchAscent, NOW, false, () => undefined);
    expect(card.querySelector('.tag.launch-ascent')?.textContent).toBe('🚀 ASCENT plume');
    // Must NOT also have the launch-overhead tag.
    expect(card.querySelector('.tag.launch-overhead')).toBeNull();
  });

  it('falls back to geometry when kind missing (older manifest)', () => {
    const card = renderCard(launchOlderManifest, NOW, false, () => undefined);
    const tag = card.querySelector('.tag.launch-overhead');
    expect(tag?.textContent).toBe('🚀 OVERHEAD pass');
  });
});

describe('renderCard direction-of-look tag', () => {
  it('renders "x° right of track · window" when bearing is on the starboard half', () => {
    const card = renderCard(
      samplePass({ angle_off_nadir_deg: 35, iss_relative_bearing_deg: 90 }),
      NOW, false, () => undefined,
    );
    const tag = card.querySelector('.tag.window-cupola');
    expect(tag?.textContent).toBe('35° right of track · Cupola');  // off-nadir = degrees off track
  });

  it('renders "x° left of track" when bearing is on the port half', () => {
    const card = renderCard(
      samplePass({ angle_off_nadir_deg: 35, iss_relative_bearing_deg: 270 }),
      NOW, false, () => undefined,
    );
    const tag = card.querySelector('.tag.window-cupola');
    expect(tag?.textContent).toBe('35° left of track · Cupola');
  });

  it('omits direction silently when iss_relative_bearing_deg missing', () => {
    const card = renderCard(
      samplePass({ angle_off_nadir_deg: 35 }),
      NOW, false, () => undefined,
    );
    const tag = card.querySelector('.tag.window-cupola');
    expect(tag?.textContent).toBe('35° · Cupola');
  });
});

// v2 — 🌍 CEO zoom imagery toggle (Jack feedback 2026-05-27). v3.2 — the
// thumbnail toggle now renders on EVERY card (curated AND personal) when
// the caller injects a `renderThumbnail` factory. pass-thumbnail.ts is
// coord-driven via target_lat/lon, so curated cards work without any
// upstream changes.
describe('renderCard — 🌍 thumbnail toggle (v2 / v3.2)', () => {
  beforeEach(() => { _resetOpenThumbnailsForTest(); });

  const personalPass = (overrides: Partial<PassEntry> = {}): PassEntry => ({
    ...samplePass(),
    target_id: 'personal:anil:abc123',
    target_name: 'My personal target',
    ...overrides,
  });

  // v3.2 regression — the 🌍 button now appears on curated cards too
  // (was gated to `personal:` ids in v2). Coord-driven pass-thumbnail
  // means no upstream change was needed.
  it('adds the 🌍 button on a CURATED target card too (v3.2)', () => {
    const renderStub = vi.fn(() => document.createElement('div'));
    const el = renderCard(
      samplePass({ target_id: 'tokyo-night' }),
      NOW, false, () => undefined,
      { renderThumbnail: renderStub },
    );
    expect(el.querySelector('.btn-thumbnail')).not.toBeNull();
    // Render is still deferred until the operator clicks.
    expect(renderStub).not.toHaveBeenCalled();
  });

  it('does NOT add the 🌍 button when no renderThumbnail factory is passed', () => {
    const el = renderCard(personalPass(), NOW, false, () => undefined);
    expect(el.querySelector('.btn-thumbnail')).toBeNull();
  });

  it('adds the 🌍 button on a personal-target card when renderThumbnail is provided', () => {
    const renderStub = vi.fn(() => {
      const d = document.createElement('div');
      d.className = 'stub-thumbnail';
      return d;
    });
    const el = renderCard(
      personalPass(), NOW, false, () => undefined,
      { renderThumbnail: renderStub },
    );
    const btn = el.querySelector<HTMLButtonElement>('.btn-thumbnail');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('🌍');
    expect(btn!.getAttribute('aria-expanded')).toBe('false');
  });

  it('defers thumbnail render until the operator clicks the 🌍 button', () => {
    const renderStub = vi.fn(() => {
      const d = document.createElement('div');
      d.className = 'stub-thumbnail';
      return d;
    });
    const el = renderCard(
      personalPass(), NOW, false, () => undefined,
      { renderThumbnail: renderStub },
    );
    expect(renderStub).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('.btn-thumbnail')!.click();
    expect(renderStub).toHaveBeenCalledOnce();
    expect(el.querySelector('.stub-thumbnail')).not.toBeNull();
  });

  it('toggles hidden state on click', () => {
    const el = renderCard(
      personalPass(), NOW, false, () => undefined,
      { renderThumbnail: () => document.createElement('div') },
    );
    const btn = el.querySelector<HTMLButtonElement>('.btn-thumbnail')!;
    const container = el.querySelector<HTMLElement>('.pass-thumbnail-container')!;
    expect(container.hidden).toBe(true);
    btn.click();
    expect(container.hidden).toBe(false);
    expect(btn.classList.contains('open')).toBe(true);
    btn.click();
    expect(container.hidden).toBe(true);
    expect(btn.classList.contains('open')).toBe(false);
  });

  it('preserves open state across re-renders via the OPEN_THUMBNAILS registry', () => {
    const pass = personalPass();
    const renderStub = vi.fn(() => document.createElement('div'));
    // First render + open.
    const el1 = renderCard(pass, NOW, false, () => undefined, { renderThumbnail: renderStub });
    el1.querySelector<HTMLButtonElement>('.btn-thumbnail')!.click();
    // Second render of the SAME pass — open state should persist.
    const el2 = renderCard(pass, NOW, false, () => undefined, { renderThumbnail: renderStub });
    expect(el2.querySelector<HTMLButtonElement>('.btn-thumbnail')!
      .getAttribute('aria-expanded')).toBe('true');
    const container = el2.querySelector<HTMLElement>('.pass-thumbnail-container')!;
    expect(container.hidden).toBe(false);
  });

  it('offers the thumbnail on forecast variant cards too (no Shoot/Skip row)', () => {
    const el = renderCard(
      personalPass(), NOW, false, () => undefined,
      { variant: 'forecast', renderThumbnail: () => document.createElement('div') },
    );
    expect(el.querySelector('.btn-thumbnail')).not.toBeNull();
    // Forecast cards have no shoot button.
    expect(el.querySelector('.btn-shoot')).toBeNull();
  });
});

// v3 — Hide button (Anil 2026-05-26). v3.2 — Hide now renders on EVERY
// card (curated AND personal). card.ts is profile-agnostic and just
// emits 'hide'; main.ts:handleHideAction branches on the `personal:`
// prefix at click time to pick the right delete semantics.
describe('renderCard — Hide button (v3 / v3.2)', () => {
  const personalPass = (overrides: Partial<PassEntry> = {}): PassEntry => ({
    ...samplePass(),
    target_id: 'personal:anil:abc123',
    target_name: 'My personal target',
    ...overrides,
  });

  it('renders the Hide button on a curated-target card', () => {
    const el = renderCard(samplePass(), NOW, false, () => undefined);
    const hide = el.querySelector<HTMLButtonElement>('.btn-hide');
    expect(hide).not.toBeNull();
    expect(hide!.textContent).toBe('Hide');
  });

  // v3.2 regression — Hide now renders on personal-target cards (was
  // skipped in v3). Click semantics differ (handled in main.ts), but
  // card.ts always emits the same 'hide' action.
  it('ALSO renders the Hide button on a personal-target card (v3.2)', () => {
    const el = renderCard(personalPass(), NOW, false, () => undefined);
    const hide = el.querySelector<HTMLButtonElement>('.btn-hide');
    expect(hide).not.toBeNull();
    expect(hide!.textContent).toBe('Hide');
  });

  it('uses a personal-flavored title hint on personal-target cards (v3.2)', () => {
    const el = renderCard(personalPass(), NOW, false, () => undefined);
    const hide = el.querySelector<HTMLButtonElement>('.btn-hide')!;
    expect(hide.title).toContain('Remove this personal target');
  });

  it('emits the hide action on click (curated card)', () => {
    const onAction = vi.fn();
    const el = renderCard(samplePass(), NOW, false, onAction);
    el.querySelector<HTMLButtonElement>('.btn-hide')!.click();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.calls[0]![0]).toBe('hide');
    expect((onAction.mock.calls[0]![1] as PassEntry).target_id).toBe('tokyo-night');
  });

  it('emits the hide action on click (personal card) (v3.2)', () => {
    const onAction = vi.fn();
    const el = renderCard(personalPass(), NOW, false, onAction);
    el.querySelector<HTMLButtonElement>('.btn-hide')!.click();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.calls[0]![0]).toBe('hide');
    expect((onAction.mock.calls[0]![1] as PassEntry).target_id).toBe('personal:anil:abc123');
  });

  it('renders Hide on forecast-variant curated cards too (no Shoot/Skip row)', () => {
    const el = renderCard(
      samplePass(), NOW, false, () => undefined, 'forecast',
    );
    expect(el.querySelector('.btn-hide')).not.toBeNull();
    expect(el.querySelector('.btn-shoot')).toBeNull();
    expect(el.querySelector('.btn-skip')).toBeNull();
  });

  it('renders Hide on forecast-variant personal cards too (v3.2)', () => {
    const el = renderCard(
      personalPass(), NOW, false, () => undefined, 'forecast',
    );
    expect(el.querySelector('.btn-hide')).not.toBeNull();
    expect(el.querySelector('.btn-shoot')).toBeNull();
    expect(el.querySelector('.btn-skip')).toBeNull();
  });

  it('exposes a useful aria-label naming the target', () => {
    const el = renderCard(samplePass({ target_name: 'Etna' }), NOW, false, () => undefined);
    const hide = el.querySelector<HTMLButtonElement>('.btn-hide')!;
    expect(hide.getAttribute('aria-label')).toContain('Etna');
  });
});
