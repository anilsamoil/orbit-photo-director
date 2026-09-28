import { describe, expect, it } from 'vitest';

import {
  orbitPeriodSeconds,
  parseTracked,
  recordsFromArtifact,
  statusText,
  type TrackedElements,
  type TrackedUnavailable,
} from '../src/tracked';

const UNAVAILABLE: TrackedUnavailable = {
  state: 'unavailable',
  id: 'starship',
  label: 'Starship',
  color: '#ff5c5c',
  reason: 'no_public_orbit',
};

const ELEMENTS: TrackedElements = {
  state: 'elements',
  id: 'starship',
  label: 'Starship',
  color: '#ff5c5c',
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

  it('uses the no-orbit row when the artifact is missing or empty', () => {
    expect(recordsFromArtifact(null)).toEqual([UNAVAILABLE]);
    expect(recordsFromArtifact({ objects: [] })).toEqual([UNAVAILABLE]);
    expect(statusText(recordsFromArtifact(null)[0]!)).toBe('Starship: no public orbit yet');
  });

  it('names each honest state', () => {
    expect(statusText(UNAVAILABLE)).toBe('Starship: no public orbit yet');
    expect(statusText({ ...UNAVAILABLE, reason: 'aged_out' })).toBe('Starship: public orbit expired');
    expect(statusText({ ...UNAVAILABLE, reason: 'lookup_failed' })).toBe('Starship: orbit lookup failed');
    expect(statusText(ELEMENTS)).toBe('Starship: STARSHIP S41');
    expect(statusText({ ...ELEMENTS, from_cache: true })).toBe('Starship: STARSHIP S41 (last good)');
  });

  it('takes one orbit from the element set mean motion', () => {
    const line2 = '2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596';
    expect(orbitPeriodSeconds(line2)).toBeCloseTo(5574.862, 2);
    expect(orbitPeriodSeconds('2 short')).toBeNull();
  });
});
