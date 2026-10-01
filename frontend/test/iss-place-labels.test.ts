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
  it('aims each side window around nadir and keeps window 7 straight down', () => {
    expect(cupolaPreset(7)).toEqual({ mode: 'nadir', azimuthDeg: 0 });
    expect(cupolaPreset(1)).toEqual({ mode: 'horizon', azimuthDeg: -90 });
    expect(cupolaPreset(2)).toEqual({ mode: 'horizon', azimuthDeg: -30 });
    expect(cupolaPreset(3)).toEqual({ mode: 'horizon', azimuthDeg: 30 });
    expect(cupolaPreset(4)).toEqual({ mode: 'horizon', azimuthDeg: 90 });
    expect(cupolaPreset(5)).toEqual({ mode: 'horizon', azimuthDeg: 150 });
    expect(cupolaPreset(6)).toEqual({ mode: 'horizon', azimuthDeg: 210 });
    expect(cupolaPreset(8)).toBeNull();
    const port = cupolaPreset(2);
    const starboard = cupolaPreset(3);
    expect(port && starboard && port.azimuthDeg + starboard.azimuthDeg).toBe(0);
    expect(port && starboard && starboard.azimuthDeg - port.azimuthDeg).toBe(60);
  });

  it('names the plate from port through nadir', () => {
    expect(CUPOLA_WINDOWS.map((entry) => entry.label)).toEqual([
      'Window 1 · Port',
      'Window 2 · Forward port',
      'Window 3 · Forward starboard',
      'Window 4 · Starboard',
      'Window 5 · Aft starboard',
      'Window 6 · Aft port',
      'Window 7 · Nadir',
    ]);
  });
});
