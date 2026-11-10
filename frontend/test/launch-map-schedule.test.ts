import { afterEach, describe, expect, it, vi } from 'vitest';

import { launchCatalog } from '../src/launch-catalog';
import { renderMapLaunchBrief } from '../src/launch-map-brief';
import { parseLaunchArtifact } from '../src/launch-schema';
import { tiersAt } from '../src/launch-tiers';
import { buildTierMapFeatures } from '../src/map/features/launch-corridor/geometry';
import { catalog, catalogItem, iso, NOW, state } from './launch-fixtures';
import capturedCatalog from './fixtures/starship-catalog-2026-11-10.json' with { type: 'json' };

const CAPTURED_NOW = Date.parse('2026-11-10T08:39:00Z');
const STARSHIP_ID = '0f867f0c-5422-4d44-93b8-d7faaae7019b';

afterEach(() => { vi.restoreAllMocks(); });

function fact(root: ParentNode, label: string): string {
  const row = [...root.querySelectorAll('.launch-fact')]
    .find((element) => element.querySelector('.launch-fact-label')?.textContent === label);
  return row?.lastElementChild?.textContent ?? '';
}

describe('map launch schedules', () => {
  it('renders the real-shaped November feed as Watch pads without promoting a photography chance', () => {
    const parsed = parseLaunchArtifact(capturedCatalog);
    if (parsed.schema_version !== 3) throw new Error('expected a catalog');
    const tiers = tiersAt(parsed, CAPTURED_NOW);
    if (!tiers) throw new Error('expected a current catalog');
    const drawn = buildTierMapFeatures(tiers, CAPTURED_NOW);
    expect(drawn.pads.map((feature) => feature.properties?.event_id)).toEqual([
      '6aa7b90b-e5ed-45d8-a52e-04fbf399d178', STARSHIP_ID,
    ]);
    expect(drawn.pads.map((feature) => feature.properties?.label)).toEqual(['LAUNCH / WATCH', 'LAUNCH / WATCH']);
    expect(drawn.pads[1]?.geometry).toEqual({ type: 'Point', coordinates: [-97.15799, 25.99677] });
    expect(drawn.lines).toEqual([]);
    expect(tiers.pins).toEqual([]);
    expect(tiers.highlights).toEqual([]);
    expect(tiers.upcoming).toEqual([]);
    vi.spyOn(launchCatalog, 'read').mockReturnValue(tiers);
    const box = document.createElement('div');
    const show = vi.fn();
    renderMapLaunchBrief(box, state(), CAPTURED_NOW, show);
    expect(box.querySelector('.map-launch-primary > summary')?.textContent).toBe('Next launch · Watch');
    const starship = box.querySelector(`[data-event-id="${STARSHIP_ID}"]`);
    if (!starship) throw new Error('missing Starship card');
    expect(starship.querySelector('.launch-name')?.textContent).toBe('Starship | Starlink Group 31-2 (Starship Flight 15)');
    expect(fact(starship, 'Vehicle')).toBe('Starship V3');
    expect(fact(starship, 'Site')).toBe('SpaceX Starbase, TX, USA');
    expect(fact(starship, 'Pad')).toBe('Orbital Launch Pad 2');
    expect(fact(starship, 'Status')).toBe('TBC · Tentative');
    expect(fact(starship, 'Time precision')).toBe('Minute');
    expect(fact(starship, 'NET')).toBe('13 Nov 2026, 22:45:00 UTC · 13 Nov 2026, 16:45:00 CST');
    expect(fact(starship, 'Launch window')).toContain('14 Nov 2026, 00:00:00 UTC');
    starship.querySelector<HTMLButtonElement>('.launch-brief-actions button')?.click();
    expect(show).toHaveBeenCalledWith(STARSHIP_ID);
  });

  it('admits schedule-only No shot and Unassessed rows while retaining schedule gates', () => {
    const scheduled = (event_id: string, over: Partial<ReturnType<typeof catalogItem>> = {}) => catalogItem({
      event_id, tier: 'none', shots: [],
      schedule: { net: iso(10), window_start: iso(10), window_end: iso(20), precision: 'Minute', status: 'Go', destination: null },
      ...over,
    });
    const base = scheduled('base');
    const rows = [
      scheduled('no-shot'),
      scheduled('unassessed', { tier: 'unassessed' }),
      scheduled('tentative', { schedule: { ...base.schedule, status: 'TBC' } }),
      scheduled('cancelled', { schedule: { ...base.schedule, status: 'Cancelled' } }),
      scheduled('no-go', { schedule: { ...base.schedule, status: 'No Go' } }),
      scheduled('day', { schedule: { ...base.schedule, precision: 'Day' } }),
      scheduled('unconfirmed', { reasons: ['LAUNCH_UNCONFIRMED'] }),
      scheduled('far', { schedule: { ...base.schedule, net: iso(7 * 24 * 60 + 1), window_end: iso(7 * 24 * 60 + 2) } }),
      scheduled('past', { schedule: { ...base.schedule, net: iso(-20), window_end: iso(-10) } }),
    ];
    const tiers = tiersAt(catalog(rows), NOW);
    if (!tiers) throw new Error('expected a current catalog');
    const drawn = buildTierMapFeatures(tiers, NOW);
    expect(drawn.pads.map((feature) => feature.properties?.event_id)).toEqual(['no-shot', 'tentative', 'unassessed']);
    expect(drawn.pads[0]?.properties?.label).toBe('LAUNCH / NO SHOT');
    expect(tiers.pins).toEqual([]);
    expect(tiers.upcoming).toEqual([]);
    expect(tiersAt(catalog(rows, { geometry_valid_until: iso(0) }), NOW)).toBeNull();
    expect(tiersAt(catalog(rows, { schedule_valid_until: iso(0) }), NOW)).toBeNull();
  });

  it('keeps tentative Starship through its open launch window after NET and removes it at window end', () => {
    const parsed = parseLaunchArtifact(capturedCatalog);
    if (parsed.schema_version !== 3) throw new Error('expected a catalog');
    const refreshAt = (stamp: string) => {
      const now = Date.parse(stamp);
      const tiers = tiersAt({
        ...parsed,
        generated_at: new Date(now - 60_000).toISOString(),
        schedule_valid_until: new Date(now + 60 * 60_000).toISOString(),
        geometry_valid_until: new Date(now + 10 * 60_000).toISOString(),
        coverage: { ...parsed.coverage, schedule_fetched_at: new Date(now - 60_000).toISOString() },
      }, now);
      if (!tiers) throw new Error('expected a current catalog');
      expect(tiers.highlights).toEqual([]);
      expect(tiers.upcoming).toEqual([]);
      expect(tiers.all).toEqual([]);
      return buildTierMapFeatures(tiers, now).pads.map((feature) => feature.properties?.event_id);
    };
    expect(refreshAt('2026-11-13T22:46:00Z')).toEqual([STARSHIP_ID]);
    expect(refreshAt('2026-11-13T23:59:59Z')).toEqual([STARSHIP_ID]);
    expect(refreshAt('2026-11-14T00:00:00Z')).toEqual([]);
  });

  it('still draws the schedule when the catalog says coverage is incomplete', () => {
    const parsed = parseLaunchArtifact({
      ...capturedCatalog,
      coverage: { ...capturedCatalog.coverage, complete: false, reasons: ['FEED_PAGINATED'] },
    });
    if (parsed.schema_version !== 3) throw new Error('expected a catalog');
    const tiers = tiersAt(parsed, CAPTURED_NOW);
    if (!tiers) throw new Error('expected a current catalog');
    const ids = buildTierMapFeatures(tiers, CAPTURED_NOW).pads.map((feature) => feature.properties?.event_id);
    expect(ids).toContain(STARSHIP_ID);
    expect(tiers.pins).toEqual([]);
    expect(tiers.upcoming).toEqual([]);
  });
});
