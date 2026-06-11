/** Tests for the V4-P2 forecast-frame frontend half (map.ts).
 *
 *  Covers the locked frontend test plan: nearest-frame pick with the tiered
 *  tolerance (±30min ≤6h lookahead, ±90min beyond — 2C revision), the
 *  anti-stale guard, the at-Now observed-path regression (CRITICAL), the
 *  manifest-missing fallback, the badge wording truth table, and the
 *  compact key contract with the generator. The MapLibre layer swap and
 *  tile-error fallback are browser-QA (happy-dom has no map runtime).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetMapStateForTest,
  compactFrameKey,
  ensureImageryDateBadge,
  nearestForecastFrame,
  setLookahead,
} from '../src/map';
import type { Manifest } from '../src/types';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const H = 3_600_000;

function isoAt(offsetH: number): string {
  return new Date(NOW + offsetH * H).toISOString().replace('.000Z', 'Z');
}

// Generator-shaped index: run-anchored hourly 0..6h + 3-hourly to +48h,
// anchored here at NOW for arithmetic clarity.
const VALID_TIMES = [
  ...[0, 1, 2, 3, 4, 5, 6].map(isoAt),
  ...[9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48].map(isoAt),
];

const FC_MANIFEST: Manifest = {
  version: '20260610T120000Z',
  generated_at: '2026-06-10T12:00:00Z',
  tle_epoch: '2026-06-10T00:00:00Z',
  cloud_composite_hour: '2026-06-09T11:00:00Z',
  target_data_version: 'v1',
  build_version: '1.9.0.0',
  freshness: { tle_hours: 12, cloud_hours: 1, ok: true },
  artifacts: {},
  forecast_clouds: {
    gfs_run: '2026-06-10T12:00:00Z',
    prefix: 'clouds-fcst/20260610T120000Z',
    valid_times: VALID_TIMES,
    max_zoom: 3,
  },
};

describe('compactFrameKey', () => {
  it('matches the generator compact_key contract (no colons in paths)', () => {
    expect(compactFrameKey('2026-06-10T06:00:00Z')).toBe('20260610T060000Z');
  });
});

describe('nearestForecastFrame (locked A4 + 2C tiered tolerance)', () => {
  it('picks the nearest frame within ±30min in the hourly band', () => {
    const view = NOW + 2 * H + 10 * 60_000; // +2h10m → nearest +2h
    expect(nearestForecastFrame(VALID_TIMES, view, NOW)?.iso).toBe(isoAt(2));
  });

  it('uses the ±90min tolerance in the 3-hourly band', () => {
    const view = NOW + 13.4 * H; // +13h24m → nearest +12h (84min away)
    expect(nearestForecastFrame(VALID_TIMES, view, NOW)?.iso).toBe(isoAt(12));
  });

  it('returns null when nothing sits within tolerance', () => {
    // Sparse index: only +0h and +24h. View +5h → nearest is 5h away.
    const sparse = [isoAt(0), isoAt(24)];
    expect(nearestForecastFrame(sparse, NOW + 5 * H, NOW)).toBeNull();
  });

  it('returns null past the last frame (the forecast-ends clamp case)', () => {
    const view = NOW + 50 * H; // beyond +48h tail by 2h > 90min tolerance
    expect(nearestForecastFrame(VALID_TIMES, view, NOW)).toBeNull();
  });

  it('never picks a frame more than 45min in the past (anti-stale guard)', () => {
    // All frames at least 1h old relative to "now": nothing qualifies even
    // though they are numerically nearest to a +0h view.
    const past = [isoAt(-3), isoAt(-2), isoAt(-1)];
    expect(nearestForecastFrame(past, NOW + 0.5 * H, NOW)).toBeNull();
    // A frame 30min old is still honest for a near-now view.
    const fresh = [isoAt(-0.5)];
    expect(nearestForecastFrame(fresh, NOW, NOW)?.iso).toBe(isoAt(-0.5));
  });

  it('ignores malformed valid_times instead of throwing', () => {
    expect(nearestForecastFrame(['garbage', isoAt(1)], NOW + H, NOW)?.iso).toBe(isoAt(1));
  });
});

describe('imagery badge wording follows the layer truth (V4-P2)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    container = document.createElement('div');
    document.body.replaceChildren(container);
    _resetMapStateForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  const badge = () => container.querySelector<HTMLElement>('.map-imagery-date')!;

  it('CRITICAL regression: at Now the observed wording renders, never forecast', () => {
    ensureImageryDateBadge(container, FC_MANIFEST);
    expect(badge().textContent).toBe('Imagery: 2026-06-09');
  });

  it('scrubbed with a frame available → GFS forecast wording with horizon + run', () => {
    setLookahead(360, /*recenter=*/false); // +6h → frame at +6h
    ensureImageryDateBadge(container, FC_MANIFEST);
    expect(badge().textContent).toBe('Clouds: GFS forecast +6h (12z run)');
  });

  it('scrubbed past the last frame → observed + forecast-ends wording', () => {
    const shortIndex: Manifest = {
      ...FC_MANIFEST,
      forecast_clouds: { ...FC_MANIFEST.forecast_clouds!, valid_times: [isoAt(0), isoAt(3), isoAt(6)] },
    };
    setLookahead(720, false); // +12h, frames end at +6h
    ensureImageryDateBadge(container, shortIndex);
    expect(badge().textContent).toBe('Clouds: observed 2026-06-09 — forecast ends +6h');
  });

  it('scrubbed with no index → the T5 observed-not-forecast wording', () => {
    const noIndex: Manifest = { ...FC_MANIFEST, forecast_clouds: undefined };
    setLookahead(360, false);
    ensureImageryDateBadge(container, noIndex);
    expect(badge().textContent).toBe('Clouds: observed 2026-06-09 — not forecast');
  });

  it('returning to Now restores the plain imagery wording', () => {
    setLookahead(360, false);
    ensureImageryDateBadge(container, FC_MANIFEST);
    setLookahead(0, false); // badge auto-refreshes via setLookahead
    expect(badge().textContent).toBe('Imagery: 2026-06-09');
  });
});
