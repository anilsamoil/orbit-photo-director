/**
 * Tests for the V3.0 launch tag rendering on PassEntry cards.
 * Covers: 🚀 LAUNCH tag presence, rocket name + window confidence chips,
 * formatLaunchWindow text, backward compat for v1.0/v1.1 PassEntries
 * without a launch field.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { formatLaunchWindow, renderCard } from '../src/card';
import type { PassEntry } from '../src/types';

const baseLaunchPass = (overrides: Partial<PassEntry> = {}): PassEntry => ({
  target_id: 'launch:f9-starlink-2026-05-test-1',
  target_name: '🚀 Falcon 9 Block 5 | Starlink Group 6-99',
  target_regime: 'any',
  target_priority: 5,
  target_lat: 28.6082,
  target_lon: -80.6041,
  closest_approach: '2026-05-12T03:42:00Z',
  nadir_distance_km: 50,
  pass_regime: 'night',
  obstruction_class: 'clear',
  p_unobstructed: 95,
  cloud_fraction: 5,
  cloud_source: 'gibs',
  score: 88,
  score_components: {
    p_unobstructed: 95,
    regime_fit: 100,
    nadir_proximity: 95,
    priority_weight: 100,
    tle_freshness: 1,
  },
  iss_at_closest: { lat: 28.6, lon: -80.6, alt_km: 410 },
  launch: {
    name: 'Falcon 9 Block 5 | Starlink Group 6-99',
    rocket_type: 'Falcon 9 Block 5',
    geometry: 'overhead',
    site_name: 'Kennedy Space Center, FL, USA',
    net_window_seconds: 0,
    t0: '2026-05-12T03:42:00Z',
  },
  ...overrides,
});

const groundPass = (overrides: Partial<PassEntry> = {}): PassEntry => ({
  target_id: 'tokyo-night',
  target_name: 'Tokyo at night',
  target_regime: 'night',
  target_priority: 5,
  target_lat: 35.68,
  target_lon: 139.69,
  closest_approach: '2026-05-12T03:42:00Z',
  nadir_distance_km: 200,
  pass_regime: 'night',
  obstruction_class: 'clear',
  p_unobstructed: 85,
  cloud_fraction: 15,
  cloud_source: 'gibs',
  score: 78,
  score_components: {
    p_unobstructed: 85,
    regime_fit: 100,
    nadir_proximity: 75,
    priority_weight: 100,
    tle_freshness: 1,
  },
  iss_at_closest: { lat: 35, lon: 140, alt_km: 410 },
  ...overrides,
});

const NOW = Date.parse('2026-05-12T03:00:00Z');

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('formatLaunchWindow', () => {
  it('renders 0s as "T-0 exact"', () => {
    expect(formatLaunchWindow(0)).toBe('T-0 exact');
  });

  it('renders sub-minute windows in seconds', () => {
    expect(formatLaunchWindow(15)).toBe('Window: ±15s');
    expect(formatLaunchWindow(45)).toBe('Window: ±45s');
  });

  it('renders sub-hour windows in minutes', () => {
    expect(formatLaunchWindow(60)).toBe('Window: ±1 min');
    expect(formatLaunchWindow(900)).toBe('Window: ±15 min');
    expect(formatLaunchWindow(1800)).toBe('Window: ±30 min');
  });

  it('renders multi-hour windows with one decimal up to 10h', () => {
    expect(formatLaunchWindow(3600)).toBe('Window: ±1.0h');
    expect(formatLaunchWindow(5400)).toBe('Window: ±1.5h');
  });

  it('renders very wide windows as integer hours past 10h', () => {
    expect(formatLaunchWindow(36000)).toBe('Window: ±10h');
    expect(formatLaunchWindow(43200)).toBe('Window: ±12h');
  });
});

describe('renderCard with launch field', () => {
  it('renders the launch tag (OVERHEAD pass for geometry=overhead)', () => {
    // V3-P2: the tag is now kind-aware. Old PassEntries with geometry='overhead'
    // (no `kind` field yet) fall back to geometry, rendering "🚀 OVERHEAD pass".
    const card = renderCard(baseLaunchPass(), NOW, false, () => {});
    const tags = Array.from(card.querySelectorAll('.tag'));
    const launchTag = tags.find((t) => t.textContent?.startsWith('🚀'));
    expect(launchTag).toBeTruthy();
    expect(launchTag?.textContent).toBe('🚀 OVERHEAD pass');
    expect(launchTag?.classList.contains('launch-overhead')).toBe(true);
  });

  it('renders the rocket name as a tag adjacent to 🚀 LAUNCH', () => {
    const card = renderCard(baseLaunchPass(), NOW, false, () => {});
    const rocketTag = card.querySelector('.tag.launch-rocket');
    expect(rocketTag?.textContent).toBe('Falcon 9 Block 5');
  });

  it('renders the window confidence chip from net_window_seconds', () => {
    const card = renderCard(
      baseLaunchPass({
        launch: {
          name: 'X',
          rocket_type: 'X',
          geometry: 'overhead',
          site_name: 'X',
          net_window_seconds: 900,
          t0: '2026-05-12T03:42:00Z',
        },
      }),
      NOW, false, () => {},
    );
    const windowTag = card.querySelector('.tag.launch-window');
    expect(windowTag?.textContent).toBe('Window: ±15 min');
  });

  it('renders T-0 exact when net_window_seconds is 0', () => {
    const card = renderCard(baseLaunchPass(), NOW, false, () => {});
    const windowTag = card.querySelector('.tag.launch-window');
    expect(windowTag?.textContent).toBe('T-0 exact');
  });

  it('places launch tags BEFORE regime + obstruction tags (left-to-right scan)', () => {
    const card = renderCard(baseLaunchPass(), NOW, false, () => {});
    const tagTexts = Array.from(card.querySelectorAll('.tag')).map((t) => t.textContent);
    const launchIdx = tagTexts.findIndex((t) => t?.startsWith('🚀'));
    const regimeIdx = tagTexts.findIndex((t) => t === 'night' || t === 'day' || t === 'terminator');
    expect(launchIdx).toBeLessThan(regimeIdx);
  });
});

describe('renderCard backward compat (no launch field)', () => {
  it('omits all launch tags when launch field is absent (older PassEntry)', () => {
    const card = renderCard(groundPass(), NOW, false, () => {});
    expect(card.querySelector('.tag.launch-overhead')).toBeNull();
    expect(card.querySelector('.tag.launch-rocket')).toBeNull();
    expect(card.querySelector('.tag.launch-window')).toBeNull();
  });

  it('renders ground passes identically to v1.1.x (no regression)', () => {
    const card = renderCard(groundPass(), NOW, false, () => {});
    // Smoke check: the existing card structure (name + countdown + meta + score) intact.
    expect(card.querySelector('.card-name')?.textContent).toBe('Tokyo at night');
    expect(card.querySelector('.card-meta .tag.regime-night')?.textContent).toBe('night');
    expect(card.querySelector('.card-score')).toBeTruthy();
  });
});
