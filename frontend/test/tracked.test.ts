import { describe, expect, it } from 'vitest';

import noDataArtifact from './fixtures/tracked-lookup-failed.json' with { type: 'json' };

import {
  UNPUBLISHED_TRACKED,
  orbitPeriodSeconds,
  parseTracked,
  recordsFromArtifact,
  type TrackedElements,
  type TrackedUnavailable,
} from '../src/tracked';

const LOOKUP = {
  names: ['STARSHIP', 'SHIP'],
  patterns: ['^STARSHIP(?:[\\s-]|$)', '^SHIP[\\s-]+\\d+\\b'],
  max_age_hours: 12,
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

  it('reads a missing or empty artifact as a failed lookup, never as no orbit', () => {
    const failed = { ...UNAVAILABLE, reason: 'lookup_failed' };
    expect(recordsFromArtifact(null)).toEqual([failed]);
    expect(recordsFromArtifact({ objects: [] })).toEqual([failed]);
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
    const row = { ...UNAVAILABLE, id: 'ship-40', label: 'Ship 40', lookup: { names: [], patterns: [], max_age_hours: 48, catnr: 67002, intldes: '2026-211A' } };
    expect(parseTracked({ objects: [row] })).toEqual([row]);
  });

  it('takes one orbit from the element set mean motion', () => {
    const line2 = '2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596';
    expect(orbitPeriodSeconds(line2)).toBeCloseTo(5574.862, 2);
    expect(orbitPeriodSeconds('2 short')).toBeNull();
  });
});
