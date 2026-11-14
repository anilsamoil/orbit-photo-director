import { describe, expect, it } from 'vitest';

import noDataArtifact from './fixtures/tracked-lookup-failed.json' with { type: 'json' };

import {
  UNPUBLISHED_TRACKED,
  orbitPeriodSeconds,
  parseTracked,
  recordsFromArtifact,
  reentered,
  type TrackedElements,
  type TrackedObject,
  type TrackedUnavailable,
} from '../src/tracked';

const LOOKUP = {
  names: ['STARSHIP', 'SHIP'],
  patterns: ['^STARSHIP(?:[\\s-]|$)(?!.*\\bDEB\\b)', '^SHIP[\\s-]+\\d+\\b(?!.*\\bDEB\\b)'],
  max_age_hours: 12,
  grace_hours: 72,
};

const UNAVAILABLE: TrackedUnavailable = {
  state: 'unavailable',
  id: 'starship',
  label: 'Starship',
  color: '#ff5c5c',
  lookup: LOOKUP,
  reason: 'no_public_orbit',
};

const ELEMENTS: TrackedElements = {
  state: 'elements',
  id: 'starship',
  label: 'Starship',
  color: '#ff5c5c',
  lookup: LOOKUP,
  source: 'supgp',
  name: 'STARSHIP S41',
  norad: 1,
  intldes: '26159A',
  line1: '1 00001U 26159A   26271.50000000  .00000000  00000-0  00000-0 0  9991',
  line2: '2 00001  51.6000  10.0000 0001000  90.0000 270.0000 15.50000000    12',
  epoch: '2026-09-28T12:00:00Z',
  age_hours: 1.25,
};

describe('tracked artifact', () => {
  it('reads an elements row and an unavailable row', () => {
    expect(parseTracked({ objects: [ELEMENTS, { ...UNAVAILABLE, id: 'other', label: 'Other' }] })).toEqual([
      ELEMENTS,
      { ...UNAVAILABLE, id: 'other', label: 'Other' },
    ]);
  });

  it('drops a row that is not an element set and not a status', () => {
    expect(parseTracked({
      objects: [{ ...ELEMENTS, line1: 'not a tle' }],
    })).toBeNull();
  });

  it('reads a missing or empty artifact as unread by this browser, never as no orbit or a publisher failure', () => {
    const unread = { ...UNAVAILABLE, reason: 'unread' };
    expect(recordsFromArtifact(null)).toEqual([unread]);
    expect(recordsFromArtifact({ objects: [] })).toEqual([unread]);
    expect(parseTracked({ objects: [unread] })).toBeNull();
  });

  it('assumes exactly what the generator publishes when it has no data', () => {
    expect(parseTracked(noDataArtifact)).toEqual(UNPUBLISHED_TRACKED);
  });

  it('keeps the built-in Starship lookup for a row from a publisher that sends none', () => {
    const { lookup: _lookup, ...bare } = UNAVAILABLE;
    expect(parseTracked({ objects: [bare] })).toEqual([UNAVAILABLE]);
    expect(parseTracked({ objects: [{ ...bare, lookup: { names: 'STARSHIP' } }] })).toEqual([UNAVAILABLE]);
  });

  it('reads the lookup of an object the operator added', () => {
    const lookup = { names: [], patterns: [], max_age_hours: 48, grace_hours: 48, catnr: 67002, intldes: '2026-211A' };
    const row = { ...UNAVAILABLE, id: 'ship-40', label: 'Ship 40', lookup };
    expect(parseTracked({ objects: [row] })).toEqual([row]);
  });

  it('gives a row from a publisher that predates the grace the built-in grace for its id, never one under its age limit', () => {
    const { grace_hours: _grace, ...old } = LOOKUP;
    expect(parseTracked({ objects: [{ ...UNAVAILABLE, lookup: old }] })).toEqual([UNAVAILABLE]);
    expect(parseTracked({ objects: [{ ...UNAVAILABLE, lookup: { ...LOOKUP, grace_hours: 6 } }] })).toEqual([UNAVAILABLE]);
    const added = { ...UNAVAILABLE, id: 'ship-40', label: 'Ship 40' };
    expect(parseTracked({ objects: [{ ...added, lookup: { ...old, max_age_hours: 48 } }] }))
      .toEqual([{ ...added, lookup: { ...LOOKUP, max_age_hours: 48, grace_hours: 48 } }]);
  });

  it('reads the other live objects of a row, skipping one that is not an element set', () => {
    const { state: _s, id: _i, label: _l, color: _c, lookup: _k, ...primary } = ELEMENTS;
    const body: TrackedObject = { ...primary, name: 'STARSHIP S41 R/B', norad: 2, from_cache: true };
    const row = { ...ELEMENTS, also: [body] };

    expect(parseTracked({ objects: [row] })).toEqual([row]);
    expect(parseTracked({ objects: [{ ...ELEMENTS, also: [body, { ...body, line2: 'not a tle' }, 'junk'] }] })).toEqual([row]);
    expect(parseTracked({ objects: [{ ...ELEMENTS, also: [] }] })).toEqual([ELEMENTS]);
    expect(parseTracked({ objects: [{ ...ELEMENTS, also: 'junk' }] })).toEqual([ELEMENTS]);
  });

  it('reads a reentered status row', () => {
    const row = { ...UNAVAILABLE, reason: 'reentered' };
    expect(parseTracked({ objects: [row] })).toEqual([row]);
  });

  it('calls a set reentered once a perigee under 80 km has had one revolution to come round', () => {
    const low = '2 90010  26.5000 270.0000 0200000  90.0000 270.0000 16.40000000    17';
    const periodMs = (86_400_000 / 16.4);

    expect(reentered(low, 0, periodMs - 1_000)).toBe(false);
    expect(reentered(low, 0, periodMs + 1_000)).toBe(true);
    expect(reentered(ELEMENTS.line2, 0, 12 * 3_600_000)).toBe(false);
    expect(reentered(low.replace('0200000', '02x0000'), 0, periodMs + 1_000)).toBe(false);
    expect(reentered('2 short', 0, periodMs + 1_000)).toBe(false);
  });

  it('takes one orbit from the element set mean motion', () => {
    const line2 = '2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596';
    expect(orbitPeriodSeconds(line2)).toBeCloseTo(5574.862, 2);
    expect(orbitPeriodSeconds('2 short')).toBeNull();
  });
});
