import { describe, expect, it } from 'vitest';

import { parseLaunchArtifact } from '../src/launch-schema';
import { shotPlan } from '../src/launch-shot-plan';
import { tiersAt } from '../src/launch-tiers';
import tiedRaw from './fixtures/launch-planner-tied-catalog.json' with { type: 'json' };

describe('modeled primary scenario', () => {
  it.each([0, 1])('keeps the corridor empty when the selected envelope has %i track points', (length) => {
    const catalog = parseLaunchArtifact(structuredClone(tiedRaw));
    if (catalog.schema_version !== 3) throw new Error('Expected a launch catalog');
    const item = catalog.items.find((item) => item.event_id === 'fixture-iss-cape');
    const primary = item?.shots[0];
    if (!item || !primary) throw new Error('Expected the tied Cape primary envelope');
    primary.track = primary.track.slice(0, length);
    const accepted = parseLaunchArtifact(catalog);
    if (accepted.schema_version !== 3) throw new Error('Expected a launch catalog');
    const launch = tiersAt(accepted, Date.parse(catalog.generated_at))?.find(item.event_id);
    if (!launch) throw new Error('Expected the projected Cape fixture');

    expect(launch.direction).toMatchObject({ kind: 'modeled', azimuthDeg: 42.7624 });
    expect(launch.shots[0]?.provenance?.direction.azimuthDeg).toBe(42.7624);
    expect(shotPlan(launch).brief.find((fact) => fact.label === 'Best time')?.text).toContain('22:11:25 UTC');
    expect(launch.corridor).toBeNull();
  });

  it('keeps the selected branch in the primary shot, brief and corridor when ascent scores tie', () => {
    const catalog = parseLaunchArtifact(tiedRaw);
    if (catalog.schema_version !== 3) throw new Error('Expected a launch catalog');
    const item = catalog.items.find((item) => item.event_id === 'fixture-iss-cape');
    if (!item) throw new Error('Expected the tied Cape fixture');
    const launch = tiersAt(catalog, Date.parse(catalog.generated_at))?.find(item.event_id);
    if (!launch) throw new Error('Expected the projected Cape fixture');
    const selected = item.shots.find((shot) => shot.subject === 'ascent' && shot.direction?.azimuth_deg === 42.7624);
    const other = item.shots.find((shot) => shot.subject === 'ascent' && shot.direction?.azimuth_deg === 137.2376);
    if (!selected || !other) throw new Error('Expected both modeled ascent branches');

    expect(launch.direction).toMatchObject({ kind: 'modeled', azimuthDeg: 42.7624 });
    expect(launch.ascent?.fans.find((fan) => fan.azimuth_deg === 42.7624)?.branch).toBe('northbound');
    expect(selected.score.low).toBe(60);
    expect(other.score.low).toBe(60);
    expect(selected.best).toBe('2026-11-15T22:11:25Z');
    expect(other.best).toBe('2026-11-15T22:09:30Z');
    expect(launch.shots[0]?.provenance?.direction).toMatchObject({ kind: 'modeled', azimuthDeg: 42.7624 });
    expect(launch.shots[0]?.bestMs).toBe(Date.parse(selected.best));
    expect(launch.top).toBe(launch.shots[0]);

    const plan = shotPlan(launch);
    expect(plan.direction.text).toContain('northbound branch, selected scenario, azimuth 42.8°');
    expect(plan.envelopes[0]?.title).toContain('Modeled azimuth 42.8°');
    expect(plan.brief.find((fact) => fact.label === 'Best time')?.text).toContain('22:11:25 UTC');
    expect(plan.brief.find((fact) => fact.label === 'Stand and look')?.text).toBe(
      'Cupola W1. Look left, 263.3° clockwise from the direction of travel, 67.5° up from straight down. 833 km away.',
    );
    expect(launch.corridor?.points).toEqual(selected.track.map((point) => ({
      lat: point.lat,
      lon: point.lon,
      altKm: point.alt_km,
      tOffsetS: point.t_offset_s,
    })));
    expect(launch.corridor?.points).not.toEqual(other.track.map((point) => ({
      lat: point.lat,
      lon: point.lon,
      altKm: point.alt_km,
      tOffsetS: point.t_offset_s,
    })));
  });
});
