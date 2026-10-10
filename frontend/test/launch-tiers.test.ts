import { describe, expect, it } from 'vitest';

import { parseLaunchArtifact, type LaunchCatalogItem, type ShotEnvelope } from '../src/launch-schema';
import { tiersAt, tierLabel } from '../src/launch-tiers';
import { catalog, catalogItem, iso, NOW, shot } from './launch-fixtures';
import legacyCatalog from './fixtures/launch-catalog-v3-251.json' with { type: 'json' };

function bareShot(over: Partial<ShotEnvelope> = {}): ShotEnvelope {
  const value = shot({ track: [], ...over });
  delete value.evaluated_at;
  delete value.direction;
  return value;
}

function row(
  id: string,
  tier: LaunchCatalogItem['tier'],
  minutes: number,
  score = 30,
  name = id,
): LaunchCatalogItem {
  const net = iso(minutes);
  const end = iso(minutes + 30);
  return catalogItem({
    event_id: id,
    tier,
    name,
    why: id,
    schedule: { net, window_start: net, window_end: end, precision: 'Second', status: 'Go', destination: null },
    direction: { kind: 'none', azimuth_deg: null, source: null, off_plane_deg: null },
    shots: [bareShot({
      liftoff: net,
      start: net,
      best: iso(minutes + 5),
      end,
      score: { low: score, high: score + 5, terms: shot().score.terms },
    })],
  });
}

describe('tier projection', () => {
  it('splits shot, likely, watch, unassessed, and none', () => {
    const tiers = tiersAt(catalog([
      row('shot-1', 'shot', 40, 10),
      row('likely-1', 'likely', 50, 90),
      row('watch-1', 'watch', 60),
      row('open-1', 'unassessed', 70),
      row('none-1', 'none', 80, 100),
    ]), NOW);
    expect(tiers).not.toBeNull();
    if (!tiers) return;
    expect(tiers.groups.shot.map((launch) => launch.eventId)).toEqual(['shot-1']);
    expect(tiers.groups.likely.map((launch) => launch.eventId)).toEqual(['likely-1']);
    expect(tiers.groups.watch.map((launch) => launch.eventId)).toEqual(['watch-1']);
    expect(tiers.pins.map((launch) => launch.eventId)).toEqual(['shot-1', 'likely-1']);
    expect(tiers.upcoming.map((launch) => launch.eventId)).toEqual(['shot-1', 'likely-1']);
    expect(tiers.highlights.map((launch) => launch.eventId)).toEqual(['shot-1', 'likely-1']);
    expect(tiers.all.map((launch) => launch.eventId)).toEqual(['shot-1', 'likely-1', 'watch-1', 'open-1']);
    expect(tiers.all[0]).toBe(tiers.groups.shot[0]);
    expect(tiers.all[2]).toBe(tiers.groups.watch[0]);
    expect(tiers.pins.some((launch) => launch.eventId === 'none-1')).toBe(false);
    expect(tiers.find('none-1')).toBeNull();
    expect(tiers.find('watch-1')?.eventId).toBe('watch-1');
    expect(tiers.upcoming[0]).toBe(tiers.pins[0]);
  });

  it('keeps every in-horizon pin and highlights the first three, Shot before Likely', () => {
    const soonLikely = row('likely-soon', 'likely', 30, 99, 'Soon Likely');
    const pins = [
      row('shot-low-b', 'shot', 24 * 60, 10, 'Shot B'),
      row('shot-low-a', 'shot', 24 * 60, 10, 'Shot A'),
      row('shot-high', 'shot', 2 * 24 * 60, 50, 'Dragon CRS-35'),
      row('shot-late', 'shot', 3 * 24 * 60, 10, 'Shot Late'),
      soonLikely,
    ];
    const tiers = tiersAt(catalog(pins), NOW);
    expect(tiers).not.toBeNull();
    if (!tiers) return;
    expect(tiers.pins.map((launch) => launch.eventId)).toEqual([
      'shot-high', 'shot-low-a', 'shot-low-b', 'shot-late', 'likely-soon',
    ]);
    expect(tiers.highlights).toHaveLength(3);
    expect(tiers.highlights.map((launch) => launch.eventId)).toEqual(['shot-high', 'shot-low-a', 'shot-low-b']);
    expect(tiers.highlights[0]).toBe(tiers.pins[0]);
    expect(tiers.closedLabel).toBe(tierLabel(tiers.highlights[0]!));
    expect(tiers.closedLabel).toBe('CRS-35 · Shot · Sep 9');
    expect(tiers.groups.shot.map((launch) => launch.eventId)).toEqual([
      'shot-high', 'shot-low-a', 'shot-low-b', 'shot-late',
    ]);
    expect(tiers.groups.likely.map((launch) => launch.eventId)).toEqual(['likely-soon']);
    expect(tiers.upcoming.map((launch) => launch.eventId)).toEqual(['shot-low-a', 'shot-low-b', 'likely-soon']);
    expect(tiers.upcoming[0]).toBe(tiers.pins[1]);
    expect(tiers.upcoming[2]).toBe(tiers.pins[4]);
    expect(tiers.pins.map((launch) => launch.eventId)).toContain('shot-late');
    expect(tiers.upcoming.map((launch) => launch.eventId)).not.toContain('shot-late');
    expect(tiers.upcoming.map((launch) => launch.eventId)).not.toContain('shot-high');
    expect(tiers.groups.watch).toEqual([]);
  });

  it('leaves Watch out of pins, upcoming, and highlights', () => {
    const tiers = tiersAt(catalog([
      row('watch-1', 'watch', 15),
      catalogItem({ event_id: 'watch-track', tier: 'watch' }),
    ]), NOW);
    expect(tiers).not.toBeNull();
    if (!tiers) return;
    expect(tiers.pins).toEqual([]);
    expect(tiers.upcoming).toEqual([]);
    expect(tiers.highlights).toEqual([]);
    expect(tiers.groups.watch.map((launch) => launch.eventId).sort()).toEqual(['watch-1', 'watch-track']);
    expect(tiers.closedLabel).toBe('Choose launch');
  });

  it('returns null when either lease is spent or generated_at is still ahead', () => {
    expect(tiersAt(catalog([], { geometry_valid_until: iso(-1) }), NOW)).toBeNull();
    expect(tiersAt(catalog([], { schedule_valid_until: iso(-1) }), NOW)).toBeNull();
    expect(tiersAt(catalog([], { generated_at: iso(1) }), NOW)).toBeNull();
    expect(tiersAt(catalog([]), NOW)).not.toBeNull();
    expect(tiersAt(catalog([]), Date.parse(catalog().generated_at))).not.toBeNull();
    expect(tiersAt(catalog([]), Date.parse(catalog().geometry_valid_until))).toBeNull();
    expect(tiersAt(catalog([]), Date.parse(catalog().schedule_valid_until))).toBeNull();
  });

  it('stays in tier mode when the current catalog has no live rows', () => {
    const dead = row('gone', 'shot', -120);
    dead.schedule.window_end = iso(-60);
    dead.shots[0]!.end = iso(-60);
    dead.shots[0]!.best = iso(-90);
    dead.shots[0]!.start = iso(-120);
    dead.shots[0]!.liftoff = iso(-120);
    const tiers = tiersAt(catalog([dead]), NOW);
    expect(tiers).not.toBeNull();
    expect(tiers?.pins).toEqual([]);
    expect(tiers?.closedLabel).toBe('Choose launch');
  });

  it('keeps a launch whose NET has passed while the window is still open', () => {
    const flying = row('liftoff', 'shot', -30, 40, 'Dragon CRS-35');
    flying.schedule.window_end = iso(20);
    flying.shots[0]!.end = iso(10);
    const tiers = tiersAt(catalog([flying]), NOW);
    expect(tiers?.pins.map((launch) => launch.eventId)).toEqual(['liftoff']);
    expect(tiers?.upcoming.map((launch) => launch.eventId)).toEqual(['liftoff']);
    expect(tiers?.all).toEqual([]);
  });

  it('labels the mission code and an unpadded UTC day', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const likely = row('crs', 'likely', 0, 20, 'Dragon CRS-35');
    likely.schedule.net = '2026-10-13T18:00:00Z';
    likely.schedule.window_start = '2026-10-13T18:00:00Z';
    likely.schedule.window_end = '2026-10-13T19:00:00Z';
    likely.shots[0]!.liftoff = '2026-10-13T18:00:00Z';
    likely.shots[0]!.start = '2026-10-13T18:00:00Z';
    likely.shots[0]!.best = '2026-10-13T18:05:00Z';
    likely.shots[0]!.end = '2026-10-13T18:20:00Z';
    const early = row('day', 'watch', 0, 20, 'Verify Ascent');
    early.schedule.net = '2026-10-07T08:00:00Z';
    early.schedule.window_start = '2026-10-07T08:00:00Z';
    early.schedule.window_end = '2026-10-13T20:00:00Z';
    early.shots[0]!.end = '2026-10-13T18:00:00Z';
    const body = catalog([likely, early], {
      generated_at: '2026-10-13T12:00:00Z',
      schedule_valid_until: '2026-10-13T14:00:00Z',
      geometry_valid_until: '2026-10-13T12:14:00Z',
    });
    const tiers = tiersAt(body, now);
    expect(tierLabel(tiers!.groups.likely[0]!)).toBe('CRS-35 · Likely · Oct 13');
    expect(tiers?.closedLabel).toBe('CRS-35 · Likely · Oct 13');
    expect(tierLabel(tiers!.groups.watch[0]!)).toBe('Verify Ascent · Watch · Oct 7');
  });

  it('has no corridor for a pad-only launch or a one-point ascent track', () => {
    const padOnly = row('pad', 'shot', 20, 40, 'Pad only');
    const short = catalogItem({
      event_id: 'short',
      tier: 'likely',
      shots: [shot({
        subject: 'ascent',
        track: [{ t_offset_s: 0, lat: 28.5, lon: -80.6, alt_km: 0 }],
      })],
    });
    delete short.shots[0]!.evaluated_at;
    delete short.shots[0]!.direction;
    const tiers = tiersAt(catalog([padOnly, short]), NOW);
    expect(tiers?.find('pad')?.corridor).toBeNull();
    expect(tiers?.find('short')?.corridor).toBeNull();
    const shotLine = catalogItem({
      event_id: 'ascent',
      tier: 'shot',
      shots: [shot({
        subject: 'ascent',
        track: [
          { t_offset_s: 0, lat: 28.5, lon: -80.6, alt_km: 0 },
          { t_offset_s: 15, lat: 28.6, lon: -80.5, alt_km: 10 },
        ],
      })],
    });
    const corridor = tiersAt(catalog([shotLine]), NOW)?.find('ascent')?.corridor;
    expect(corridor?.points).toHaveLength(2);
    expect(corridor?.points[0]).toEqual({ lat: 28.5, lon: -80.6, altKm: 0, tOffsetS: 0 });
    expect(corridor?.points[1]).toEqual({ lat: 28.6, lon: -80.5, altKm: 10, tOffsetS: 15 });
  });

  it('does not invent provenance or write the envelope pair back onto the shot', () => {
    const parsed = structuredClone(legacyCatalog);
    const before = JSON.stringify(parsed);
    const catalogBody = parseLaunchArtifact(parsed);
    if (catalogBody.schema_version !== 3) throw new Error('expected schema 3');
    const shotKeys = Object.keys(catalogBody.items[0]!.shots[0]!).sort();
    const tiers = tiersAt(catalogBody, NOW);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(Object.keys(catalogBody.items[0]!.shots[0]!).sort()).toEqual(shotKeys);
    expect(catalogBody.items[0]!.shots[0]).not.toHaveProperty('evaluated_at');
    expect(catalogBody.items[0]!.shots[0]).not.toHaveProperty('direction');
    expect(catalogBody.items[0]!.direction.kind).toBe('iss_plane');
    const launch = tiers?.find('event-1');
    expect(launch?.tier).toBe('watch');
    expect(launch?.top?.provenance).toBeNull();
    expect(launch?.corridor).not.toBeNull();
  });
});
