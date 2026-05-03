import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderCard, renderCards } from '../src/card';
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

  it('displays the score as an integer with no percent sign', () => {
    const el = renderCard(samplePass({ score: 64.7 }), NOW, false, () => undefined);
    const value = el.querySelector('.score-value')!.textContent;
    expect(value).toBe('65');
    expect(value!.includes('%')).toBe(false);
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
