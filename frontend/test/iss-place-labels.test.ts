import { describe, expect, it } from 'vitest';

import { CUPOLA_WINDOWS, cupolaPreset } from '../src/iss-view/cupola';
import { PLACE_LABELS, placeLabelCollection } from '../src/iss-view/place-labels';

describe('ISS place labels', () => {
  it('names a major country, a major city, and an ocean', () => {
    const collection = placeLabelCollection();
    const japan = collection.features.find((feature) => feature.properties?.name === 'Japan');
    const tokyo = collection.features.find((feature) => feature.properties?.name === 'Tokyo');
    const pacific = collection.features.find((feature) => feature.properties?.name === 'North Pacific Ocean');
    expect(japan?.properties?.kind).toBe('country');
    expect(japan?.geometry).toEqual({ type: 'Point', coordinates: [138.44, 36.14] });
    expect(tokyo?.properties?.kind).toBe('city');
    expect(tokyo?.geometry).toEqual({ type: 'Point', coordinates: [139.75, 35.69] });
    expect(pacific?.properties?.kind).toBe('water');
    expect(pacific?.geometry).toMatchObject({ type: 'Point' });
    expect(PLACE_LABELS.every((place) => place.name.length > 0 && Number.isFinite(place.lon) && Number.isFinite(place.lat))).toBe(true);
  });
});

describe('Cupola windows', () => {
  it('points window 7 straight down and leaves the side windows unset', () => {
    expect(cupolaPreset(7)).toBe('nadir');
    expect([1, 2, 3, 4, 5, 6].map((id) => cupolaPreset(id))).toEqual([null, null, null, null, null, null]);
    expect(cupolaPreset(8)).toBeNull();
  });

  it('names the plate from port through nadir', () => {
    expect(CUPOLA_WINDOWS.map((entry) => entry.label)).toEqual([
      'Window 1 · Port · Coming soon',
      'Window 2 · Forward port · Coming soon',
      'Window 3 · Forward starboard · Coming soon',
      'Window 4 · Starboard · Coming soon',
      'Window 5 · Aft starboard · Coming soon',
      'Window 6 · Aft port · Coming soon',
      'Window 7 · Nadir',
    ]);
  });
});