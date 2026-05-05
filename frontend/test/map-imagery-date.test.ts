import { beforeEach, describe, expect, it } from 'vitest';

import { ensureImageryDateBadge } from '../src/map';
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
});
