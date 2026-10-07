import { describe, expect, it } from 'vitest';
import { launchCoverageLabel, launchScheduleFresh, queueSlots, selectLaunches } from '../src/launch-selectors';
import { applyTargetFilter } from '../src/target-filter-pref';
import { filterPassesByDistance } from '../src/pass-filter';
import type { PassEntry } from '../src/types';
import { artifact, assessment, catalog, interval, iso, launch, NOW, state, supported } from './launch-fixtures';
import { parseLaunchArtifact } from '../src/launch-schema';
import type { LaunchState } from '../src/launch-store';

describe('shared launch selection', () => {
  it('separates recent tentative schedules from expired camera evidence without extending Queue', () => {
    const s = state();
    const later = NOW + 120 * 60_000;
    expect(launchScheduleFresh(s, later)).toBe(true);
    expect(launchCoverageLabel(s, later)).toContain('SCHEDULE CURRENT (MAP ONLY)');
    expect(launchCoverageLabel(s, later)).toContain('Schedule checked 2026-09-07 11:55:00 UTC');
    expect(selectLaunches(s, later, 'queue')).toEqual([]);
    expect(launchScheduleFresh(s, NOW + 175 * 60_000)).toBe(false);
    expect(launchCoverageLabel(s, NOW + 175 * 60_000)).toContain('STALE / EXPIRED');
    s.availability = 'offline';
    expect(launchCoverageLabel(s, later)).toContain('OFFLINE');
    s.artifact!.coverage.reasons.push('SOURCE_AGE_MTIME_ONLY');
    expect(launchScheduleFresh(s, later)).toBe(false);
  });
  it('a new wrapper cannot renew the tentative schedule timestamp or unsupported instruction', () => {
    const s = state();
    for (const fetched of [null, iso(-180), iso(1)]) {
      s.artifact!.coverage.fetched_at = fetched;
      expect(launchScheduleFresh(s, NOW)).toBe(false);
    }
    s.artifact!.coverage.fetched_at = iso(-5);
    s.artifact!.items = [supported()];
    expect(launchCoverageLabel(s, NOW + 20 * 60_000)).toContain('STALE / EXPIRED');
    expect(selectLaunches(s, NOW + 20 * 60_000, 'queue')).toEqual([]);
  });
  it('uses tentative NET instead of a conflicting old end for map-only events', () => {
    const s = state([launch({ reason_codes: ['TIME_CONFLICT'], launch_window: { net: iso(10), start: iso(20), end: iso(-40), precision: null } })]);
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    expect(selectLaunches(s, NOW, 'upcoming')).toEqual([]);
    expect(selectLaunches(s, NOW, 'map')).toEqual([]);
  });
  it('Map covers seven days while Upcoming remains 36 hours, both bounded by coverage', () => {
    const at = (event_id: string, minutes: number) => launch({
      event_id,
      launch_window: { net: iso(minutes), start: iso(minutes), end: iso(minutes + 1), precision: 'Minute' },
      assessment: assessment({ net: { ...assessment().net, at: iso(minutes) } }),
    });
    const s = state([at('36h', 2160), at('day3', 3 * 24 * 60), at('day7', 7 * 24 * 60), at('outside', 7 * 24 * 60 + 1)]);
    expect(selectLaunches(s, NOW, 'upcoming').map((x) => x.item.event_id)).toEqual(['36h']);
    expect(selectLaunches(s, NOW, 'map').map((x) => x.item.event_id)).toEqual(['36h', 'day3', 'day7']);
    s.artifact!.coverage.until = iso(4 * 24 * 60);
    expect(selectLaunches(s, NOW, 'map').map((x) => x.item.event_id)).toEqual(['36h', 'day3']);
    expect(launchCoverageLabel(s, NOW, 'map')).toContain('2026-09-11 12:00:00 UTC');
    expect(launchCoverageLabel(s, NOW, 'map')).toContain('Coverage incomplete');
  });
  it('rejects partial, offline and reason-blocked capture instructions; fresh clean last-good stays labeled', () => {
    const s = state([supported()]);
    s.artifact!.coverage.complete = false;
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    s.artifact!.coverage.complete = true; s.availability = 'offline';
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    s.availability = 'last-good';
    expect(selectLaunches(s, NOW, 'queue')).toHaveLength(1);
    expect(launchCoverageLabel(s, NOW)).toContain('LAST GOOD');
    s.artifact!.items[0]!.reason_codes.push('VALIDATION_PENDING');
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    s.artifact!.items[0]!.reason_codes = []; s.artifact!.coverage.reasons.push('SOURCE_STALE');
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
  });
  it('does not refresh stale or unknown source evidence by wrapping it in a newer artifact', () => {
    const s = state([supported()]);
    for (const fetched of [null, iso(-120), iso(10)]) {
      s.artifact!.coverage.fetched_at = fetched;
      expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    }
    s.artifact!.coverage.fetched_at = iso(-5);
    s.artifact!.items[0]!.sources[0]!.fetched_at = iso(-120);
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    expect(selectLaunches(s, NOW, 'map')).toEqual([]);
  });
  it('leaves generic map-only profiles out of Queue, Upcoming, and Map', () => {
    const s = state();
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    expect(selectLaunches(s, NOW, 'upcoming')).toEqual([]);
    expect(selectLaunches(s, NOW, 'map')).toEqual([]);
  });
  it('reserves max two of five slots, stable time/id ordering, and three ground positions', () => {
    const s = state(['c', 'b', 'a'].map((event_id) => supported({ event_id })));
    const ground = Array.from({ length: 5 }, (_, i) => ({ target_id: `ground-${i}` }) as PassEntry);
    const slots = queueSlots(ground, selectLaunches(s, NOW, 'queue'));
    expect(slots.launches.map((x) => x.item.event_id)).toEqual(['a', 'b']);
    expect(slots.ground).toEqual(ground.slice(0, 3));
    expect(queueSlots(ground, []).ground).toHaveLength(5);
    expect(selectLaunches(s, NOW, 'upcoming')).toHaveLength(3);
  });
  it('bypasses ground mine/distance filters and shares exact facts across views', () => {
    const s = state([supported()]);
    const ground = [{ target_id: 'shared', nadir_distance_km: 2000 }] as PassEntry[];
    const filtered = applyTargetFilter(filterPassesByDistance(ground, 10), 'mine');
    const queue = queueSlots(filtered, selectLaunches(s, NOW, 'queue'));
    expect(queue.ground).toEqual([]);
    expect(queue.launches).toHaveLength(1);
    expect(queue.launches[0]?.item).toBe(selectLaunches(s, NOW, 'map')[0]?.item);
    expect(queue.launches[0]?.interval).toBe(selectLaunches(s, NOW, 'upcoming')[0]?.interval);
  });
  it('enforces 90min and 36h boundaries and actual coverage', () => {
    const s = state([supported({ event_id: 'soon', capture_intervals: [interval(90, 91)] }),
      supported({ event_id: 'later', capture_intervals: [interval(91, 92)] }),
      launch({ event_id: 'far', launch_window: { net: iso(2161), start: null, end: null, precision: null } })]);
    expect(selectLaunches(s, NOW, 'queue').map((x) => x.item.event_id)).toEqual(['soon']);
    expect(selectLaunches(s, NOW, 'upcoming').map((x) => x.item.event_id)).toEqual(['soon', 'later']);
    s.artifact!.coverage.until = iso(90);
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    expect(launchCoverageLabel(s, NOW)).toContain('Coverage incomplete');
    expect(launchCoverageLabel(s, NOW)).toContain('2026-09-07 13:30:00 UTC');
  });
  it('removes an expired capture from Queue, Map, and Upcoming', () => {
    const s = state([supported()]); const end = Date.parse(iso(15));
    expect(selectLaunches(s, end, 'queue')).toEqual([]);
    expect(selectLaunches(s, end, 'map')).toEqual([]);
    expect(selectLaunches(s, end, 'upcoming')).toEqual([]);
    expect(selectLaunches(s, end + 30 * 60_000, 'upcoming')).toEqual([]);
  });
  it('drops an open window that is not a possible shot', () => {
    const s = state([launch({ launch_window: { net: iso(-10), start: iso(-15), end: iso(15), precision: null } })]);
    expect(selectLaunches(s, NOW, 'map')).toEqual([]);
    expect(selectLaunches(s, NOW, 'upcoming')).toEqual([]);
  });
  it('expires cached capture instructions even with a future interval', () => {
    const s = state([supported()], { artifact: artifact([supported()], { valid_until: iso(0) }), availability: 'offline' });
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    expect(selectLaunches(s, NOW, 'map')).toEqual([]);
    expect(launchCoverageLabel(s, NOW)).toContain('STALE / EXPIRED');
  });
  it('shows only a possible shot on the map and in Upcoming', () => {
    const noise = ['unknown', 'too_far', 'timing', 'far', 'stale', 'coarse'].map((event_id) => {
      const item = launch({ event_id, launch_window: { net: iso(20), start: iso(20), end: iso(21), precision: 'Minute' } });
      if (event_id === 'too_far') {
        item.assessment = assessment({ net: { ...assessment().net, verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR', look: null } });
      }
      if (event_id === 'timing') item.reason_codes = ['TIME_CONFLICT'];
      if (event_id === 'coarse') item.launch_window.precision = 'Day';
      return item;
    });
    const possible = launch({
      event_id: 'go',
      launch_window: { net: iso(10), start: iso(10), end: iso(97), precision: 'Minute' },
      assessment: assessment(),
    });
    const s = state([...noise, possible]);
    expect(selectLaunches(s, NOW, 'map').map((row) => row.item.event_id)).toEqual(['go']);
    expect(selectLaunches(s, NOW, 'upcoming').map((row) => row.item.event_id)).toEqual(['go']);
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
    expect(selectLaunches(state(noise), NOW, 'map')).toEqual([]);
  });
  it('accepts a schema 3 catalog and does not select it as a v2 chance', () => {
    const parsed = parseLaunchArtifact(catalog());
    expect(parsed.schema_version).toBe(3);
    if (parsed.schema_version !== 3) throw new Error('expected schema 3');
    expect(parsed.items[0]?.tier).toBe('watch');
    expect(parsed.items[0]?.shots[0]?.lens).toBe('telephoto');
    expect(parsed.items[0]?.shots[0]?.lens_reason).toBe('Distant plume');
    expect(parsed.items[0]?.shots[0]?.window).toBe('W6');
    const loaded: LaunchState = { artifact: parsed, pointer: null, availability: 'ready' };
    expect(selectLaunches(loaded, NOW, 'queue')).toEqual([]);
    expect(selectLaunches(loaded, NOW, 'upcoming')).toEqual([]);
    expect(selectLaunches(loaded, NOW, 'map')).toEqual([]);
    expect(launchScheduleFresh(loaded, NOW)).toBe(false);
    expect(launchCoverageLabel(loaded, NOW)).toBe('LAUNCH: Schedule checked 2026-09-07 11:55:00 UTC | Coverage complete: 2026-09-07 11:00:00 UTC to 2026-09-09 00:00:00 UTC');
    loaded.availability = 'last-good';
    expect(launchCoverageLabel(loaded, NOW)).toContain('LAST GOOD; refresh unavailable');
    const v2 = state();
    expect(v2.artifact?.schema_version).toBe(2);
    expect(launchCoverageLabel(v2, NOW)).toContain('SCHEDULE CURRENT (MAP ONLY)');
    expect(selectLaunches(v2, NOW, 'map')).toEqual([]);
  });
});
