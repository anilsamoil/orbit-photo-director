import { describe, expect, it } from 'vitest';

import { CUPOLA_WINDOWS, cupolaPreset } from '../src/iss-view/cupola';
import { namesAt, placesOnDisk } from '../src/iss-view/place-labels';

describe('ISS place labels', () => {
  it('names the country or the water under the station', () => {
    expect(namesAt(36.2, 138.4)).toEqual({ country: 'Japan', water: '' });
    expect(namesAt(35.69, 139.75)).toEqual({ country: 'Japan', water: '' });
    expect(namesAt(39, -97)).toEqual({ country: 'United States', water: '' });
    expect(namesAt(40.75, -73.98)).toEqual({ country: 'United States', water: '' });
    expect(namesAt(41.3, -44.4)).toEqual({ country: '', water: 'North Atlantic Ocean' });
    expect(namesAt(40, -40).water).toBe('North Atlantic Ocean');
  });

  it('keeps the nadir disk on the ground under the station', () => {
    const places = placesOnDisk(41.3, -44.4, 420_000, 90, 0);
    expect(places.some((place) => place.kind === 'water' && place.name === 'North Atlantic Ocean')).toBe(true);
    expect(places.some((place) => place.name === 'Chile' || place.name === 'Japan')).toBe(false);
    const tokyo = placesOnDisk(35.69, 139.75, 420_000, 40, 0);
    expect(tokyo.some((place) => place.kind === 'country' && place.name === 'Japan')).toBe(true);
    expect(tokyo.some((place) => place.kind === 'city' && place.name === 'Tokyo')).toBe(true);
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
