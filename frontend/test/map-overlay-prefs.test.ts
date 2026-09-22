import { afterEach, describe, expect, it } from 'vitest';

import { readCloudsVisible, readIrVisible } from '../src/map/features/basemap';
import { readLabelsVisible } from '../src/map/features/labels';
import { readNightLightsVisible } from '../src/map/features/night-lights';
import { readTerminatorVisible } from '../src/map/features/terminator';
import {
  readBearingMode,
  readMultiOrbitVisible,
} from '../src/map';

// Every map overlay toggle persists to its own localStorage key, and the
// default-when-missing is not uniform. Clouds, labels, and the terminator are
// on unless the operator turned them off. IR, night lights, and multi-orbit
// are off unless the operator turned them on, because each one costs tiles or
// clutter. Bearing defaults to iss-up, which is Chris's WORF mental model.
//
// An earlier revision duplicated these readers in the test file, so a change
// to a default in map.ts could not fail anything.

const KEYS = [
  'opd-map-clouds-visible',
  'opd-map-labels-visible',
  'opd-map-terminator-visible',
  'opd-map-ir-visible',
  'opd-map-night-lights-visible',
  'opd-map-multi-orbit-visible',
  'opd-map-bearing-mode',
] as const;

afterEach(() => {
  for (const key of KEYS) localStorage.removeItem(key);
});

type BooleanReader = { key: string; read: () => boolean };

const DEFAULT_ON: BooleanReader[] = [
  { key: 'opd-map-clouds-visible', read: readCloudsVisible },
  { key: 'opd-map-labels-visible', read: readLabelsVisible },
  { key: 'opd-map-terminator-visible', read: readTerminatorVisible },
];

const DEFAULT_OFF: BooleanReader[] = [
  { key: 'opd-map-ir-visible', read: readIrVisible },
  { key: 'opd-map-night-lights-visible', read: readNightLightsVisible },
  { key: 'opd-map-multi-orbit-visible', read: readMultiOrbitVisible },
];

describe('overlay preferences that default on', () => {
  for (const { key, read } of DEFAULT_ON) {
    it(`${key} reads true when nothing is stored`, () => {
      localStorage.removeItem(key);
      expect(read()).toBe(true);
    });

    it(`${key} reads true when stored as "1"`, () => {
      localStorage.setItem(key, '1');
      expect(read()).toBe(true);
    });

    it(`${key} reads false when stored as "0"`, () => {
      localStorage.setItem(key, '0');
      expect(read()).toBe(false);
    });

    it(`${key} reads false for any other stored string`, () => {
      localStorage.setItem(key, 'yes');
      expect(read()).toBe(false);
    });
  }
});

describe('overlay preferences that default off', () => {
  for (const { key, read } of DEFAULT_OFF) {
    it(`${key} reads false when nothing is stored`, () => {
      localStorage.removeItem(key);
      expect(read()).toBe(false);
    });

    it(`${key} reads true only when stored as "1"`, () => {
      localStorage.setItem(key, '1');
      expect(read()).toBe(true);
    });

    it(`${key} reads false when stored as "0"`, () => {
      localStorage.setItem(key, '0');
      expect(read()).toBe(false);
    });
  }
});

describe('bearing mode preference', () => {
  it('defaults to iss-up when nothing is stored', () => {
    localStorage.removeItem('opd-map-bearing-mode');
    expect(readBearingMode()).toBe('iss-up');
  });

  it('reads north only when north is stored exactly', () => {
    localStorage.setItem('opd-map-bearing-mode', 'north');
    expect(readBearingMode()).toBe('north');
  });

  it('reads iss-up when iss-up is stored', () => {
    localStorage.setItem('opd-map-bearing-mode', 'iss-up');
    expect(readBearingMode()).toBe('iss-up');
  });

  it('reads iss-up for an unrecognised stored value', () => {
    localStorage.setItem('opd-map-bearing-mode', 'up');
    expect(readBearingMode()).toBe('iss-up');
  });
});

describe('overlay preference keys', () => {
  it('gives every toggle its own key, so one toggle cannot clobber another', () => {
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  it('writing one preference leaves the others at their defaults', () => {
    localStorage.setItem('opd-map-clouds-visible', '0');
    expect(readCloudsVisible()).toBe(false);
    expect(readLabelsVisible()).toBe(true);
    expect(readTerminatorVisible()).toBe(true);
    expect(readIrVisible()).toBe(false);
    expect(readNightLightsVisible()).toBe(false);
    expect(readMultiOrbitVisible()).toBe(false);
    expect(readBearingMode()).toBe('iss-up');
  });
});
