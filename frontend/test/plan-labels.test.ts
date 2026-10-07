import { describe, expect, it } from 'vitest';

import { planNameSystem, planPlaces } from '../src/insets/plan-labels';

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

describe('plan map label tiers', () => {
  it('uses vector country names below the raster place-name zoom and no vector names after it', () => {
    expect(planNameSystem(2.9)).toBe('vector');
    expect(planNameSystem(3)).toBe('raster');
    expect(planNameSystem(3.1)).toBe('raster');
    expect(planNameSystem(8)).toBe('raster');
    expect(names(1)).toEqual(COUNTRIES);
    expect(names(3.1)).toEqual([]);
    expect(names(8)).toEqual([]);
    expect(names(3.1)).not.toContain('Washington D.C.');
    expect(names(3.1)).not.toContain('New York');
    expect(names(8)).not.toContain('Washington D.C.');
  });
});
