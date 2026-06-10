import { beforeEach, describe, expect, it } from 'vitest';

import { _resetMapStateForTest, ensureImageryDateBadge, setLookahead } from '../src/map';
import type { Manifest } from '../src/types';

const baseManifest: Manifest = {
  version: '20260504T120000Z',
  generated_at: '2026-05-04T12:00:00Z',
  tle_epoch: '2026-05-04T00:00:00Z',
  cloud_composite_hour: '2026-05-04T11:00:00Z',
  target_data_version: 'v1',
  build_version: '2.0.0.0',
  freshness: { tle_hours: 12, cloud_hours: 1, ok: true },
  artifacts: {},
};

describe('ensureImageryDateBadge', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.replaceChildren(container);
    _resetMapStateForTest();
  });

  it('creates the badge with the cloud_composite_hour date', () => {
    ensureImageryDateBadge(container, baseManifest);
    const badge = container.querySelector<HTMLElement>('.map-imagery-date');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('Imagery: 2026-05-04');
    expect(badge!.hidden).toBe(false);
  });

  it('updates the existing badge instead of stacking duplicates', () => {
    ensureImageryDateBadge(container, baseManifest);
    ensureImageryDateBadge(container, { ...baseManifest, cloud_composite_hour: '2026-05-05T00:00:00Z' });
    const badges = container.querySelectorAll('.map-imagery-date');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe('Imagery: 2026-05-05');
  });

  it('hides the badge when cloud_composite_hour is malformed', () => {
    ensureImageryDateBadge(container, { ...baseManifest, cloud_composite_hour: 'not a date' });
    const badge = container.querySelector<HTMLElement>('.map-imagery-date');
    expect(badge!.hidden).toBe(true);
  });

  // T5 (eng-review 2026-06-10): scrub honesty — until V4-P2 ships forecast
  // frames, the raster under a scrubbed view is still OBSERVED imagery
  // while the pins show forecast. The badge must say the mismatch.
  describe('scrub honesty wording', () => {
    it('states observed-not-forecast while the view is scrubbed', () => {
      setLookahead(360, /*recenter=*/false);
      ensureImageryDateBadge(container, baseManifest);
      const badge = container.querySelector<HTMLElement>('.map-imagery-date');
      expect(badge!.textContent).toBe('Clouds: observed 2026-05-04 — not forecast');
    });

    it('re-renders automatically when the scrub state changes (no renderMap needed)', () => {
      ensureImageryDateBadge(container, baseManifest); // live → caches args
      const badge = container.querySelector<HTMLElement>('.map-imagery-date');
      expect(badge!.textContent).toBe('Imagery: 2026-05-04');
      setLookahead(360, false); // setLookahead refreshes the badge itself
      expect(badge!.textContent).toBe('Clouds: observed 2026-05-04 — not forecast');
      setLookahead(0, false);
      expect(badge!.textContent).toBe('Imagery: 2026-05-04');
    });
  });
});
