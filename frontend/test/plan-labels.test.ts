import { describe, expect, it } from 'vitest';

import { planPlaces } from '../src/insets/plan-labels';
import { PLACE_CITIES } from '../src/iss-view/place-labels';

function names(zoom: number): string[] {
  return planPlaces(zoom).map((place) => place.name);
}

const COUNTRIES = [
  'Canada',
  'Mexico',
  'Brazil',
  'Argentina',
  'France',
  'Egypt',
  'Nigeria',
  'Kenya',
  'China',
  'India',
  'Japan',
  'Australia',
];

const TOWNS = ['Salem', 'Houston', 'Dubai', 'Lisbon', 'Oslo', 'Honolulu'];

describe('plan map label tiers', () => {
  it('shows countries, then the cupola cities, then towns as zoom rises', () => {
    expect(names(1)).toEqual(COUNTRIES);
    for (const city of PLACE_CITIES) {
      expect(names(1)).not.toContain(city.name);
      expect(names(3)).toContain(city.name);
    }
    expect(names(3).slice(0, COUNTRIES.length)).toEqual(COUNTRIES);
    expect(names(4).filter((name) => !names(3).includes(name))).toEqual([]);
    expect(names(5).filter((name) => !names(3).includes(name))).toEqual(TOWNS);
    expect(names(8)).toEqual(names(5));
  });
});
