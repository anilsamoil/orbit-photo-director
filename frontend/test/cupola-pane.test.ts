import { afterEach, describe, expect, it, vi } from 'vitest';

import { decorateCupolaTags, setupCupolaPane } from '../src/cupola-pane';
import { fetchCupolaWindows } from '../src/manifest';
import type { Manifest, PassEntry } from '../src/types';

// A generator-shaped Cupola window (PassEntry-compatible — full enough to
// render through renderCards without NaN/undefined).
const cupolaWindow = (over: Partial<PassEntry> = {}): PassEntry => ({
  target_id: 'cupola:2026-06-15T14:32Z',
  target_name: 'Memorabilia shot — South Pacific',
  target_regime: 'day',
  target_priority: 5,
  target_lat: -20.1,
  target_lon: -120.4,
  closest_approach: '2026-06-15T14:32:00Z',
  pass_regime: 'day',
  obstruction_class: 'clear',
  p_unobstructed: 0.95,
  cloud_fraction: 5,
  cloud_source: 'gfs-forecast',
  sample_time: '2026-06-15T14:32:00Z',
  nadir_distance_km: 0,
  score: 95,
  score_components: {
    p_unobstructed: 95, regime_fit: 100, nadir_proximity: 100,
    priority_weight: 100, tle_freshness: 1,
  },
  iss_at_closest: { lat: -20.1, lon: -120.4, alt_km: 420 },
  golden_hour: true,
  water_pct: 60,
  ...over,
} as PassEntry);

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('fetchCupolaWindows', () => {
  it('returns [] when the manifest has no cupola_windows artifact (no fetch)', async () => {
    const manifest = { artifacts: {} } as unknown as Manifest;
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchCupolaWindows(manifest)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();  // absent key short-circuits
  });
});

describe('decorateCupolaTags', () => {
  it('appends golden-hour and water tags onto the matching card meta', () => {
    const container = document.createElement('div');
    const card = document.createElement('div');
    card.dataset.targetId = 'cupola:2026-06-15T14:32Z';
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    card.appendChild(meta);
    container.appendChild(card);

    decorateCupolaTags(container, [cupolaWindow({ golden_hour: true, water_pct: 60 })]);
    expect(meta.querySelector('.golden-hour')?.textContent).toBe('🌇 golden hour');
    expect(meta.querySelector('.water-pct')?.textContent).toBe('🌊 water 60%');
  });

  it('omits the golden tag when golden_hour is false', () => {
    const container = document.createElement('div');
    const card = document.createElement('div');
    card.dataset.targetId = 'cupola:x';
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    card.appendChild(meta);
    container.appendChild(card);
    decorateCupolaTags(container, [cupolaWindow({ target_id: 'cupola:x', golden_hour: false, water_pct: 40 })]);
    expect(meta.querySelector('.golden-hour')).toBeNull();
    expect(meta.querySelector('.water-pct')?.textContent).toBe('🌊 water 40%');
  });
});

describe('setupCupolaPane', () => {
  const build = () => {
    const button = document.createElement('button');
    const pane = document.createElement('div');
    pane.hidden = true;
    const cardsContainer = document.createElement('div');
    cardsContainer.id = 'cupola-cards';
    document.body.append(button, pane, cardsContainer);
    return { button, pane, cardsContainer };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('reveals the pane and renders window cards on open', async () => {
    const { button, pane, cardsContainer } = build();
    setupCupolaPane({
      button, pane, cardsContainer,
      onCardAction: () => {},
      loadWindows: async () => [cupolaWindow()],
    });
    button.click();
    await flush();
    expect(pane.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // The visible on-state (operator feedback 2026-06-15): the .active class
    // drives the filled-pill + caret-▾ styling so the toggle reads clearly.
    expect(button.classList.contains('active')).toBe(true);
    const card = cardsContainer.querySelector('[data-target-id="cupola:2026-06-15T14:32Z"]');
    expect(card).not.toBeNull();
    // No NaN in the rendered card (full PassEntry-compatible shape).
    expect(cardsContainer.textContent).not.toMatch(/NaN/);
    // Decorator tags landed.
    expect(cardsContainer.querySelector('.golden-hour')).not.toBeNull();
  });

  it('shows an empty-state message when no windows come back', async () => {
    const { button, pane, cardsContainer } = build();
    setupCupolaPane({
      button, pane, cardsContainer,
      onCardAction: () => {},
      loadWindows: async () => [],
    });
    button.click();
    await flush();
    expect(cardsContainer.querySelector('.cupola-empty')?.textContent).toMatch(/No memorabilia windows/);
  });

  it('shows a reconnect message when the fetch throws', async () => {
    const { button, pane, cardsContainer } = build();
    setupCupolaPane({
      button, pane, cardsContainer,
      onCardAction: () => {},
      loadWindows: async () => { throw new Error('offline'); },
    });
    button.click();
    await flush();
    expect(cardsContainer.querySelector('.cupola-empty')?.textContent).toMatch(/when online/);
  });

  it('hides the pane on a second click (toggle)', async () => {
    const { button, pane, cardsContainer } = build();
    setupCupolaPane({
      button, pane, cardsContainer,
      onCardAction: () => {},
      loadWindows: async () => [cupolaWindow()],
    });
    button.click();
    await flush();
    button.click();
    expect(pane.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.classList.contains('active')).toBe(false);  // visible off-state
  });
});
