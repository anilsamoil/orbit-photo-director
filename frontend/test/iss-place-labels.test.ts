import { describe, expect, it } from 'vitest';

import { CUPOLA_WINDOWS, cupolaPreset } from '../src/iss-view/cupola';
import { TOWN_LABEL_FOV_DEG } from '../src/iss-view/fov';
import { LABEL_CATALOG } from '../src/iss-view/label-catalog';
import { LABEL_TOWNS } from '../src/iss-view/label-catalog-towns';
import { readCatalog } from '../src/iss-view/catalog-read';
import { namesAt, placesOnDisk } from '../src/iss-view/place-labels';

const catalog = [...LABEL_CATALOG, ...LABEL_TOWNS];

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

  it('adds cities, the state, the gulf, then towns as the field narrows over Florida', () => {
    const florida = (fovDeg: number) => placesOnDisk(28.5, -81.4, 420_000, 0, 0, fovDeg, catalog);
    const wide = florida(80);
    expect(wide.some((place) => place.kind === 'country' && place.name === 'United States')).toBe(true);
    expect(wide.some((place) => place.name === 'Miami')).toBe(false);
    expect(wide.some((place) => place.kind === 'region' && place.name === 'Florida')).toBe(false);
    const mid = florida(40);
    expect(mid.some((place) => place.kind === 'city' && place.name === 'Miami')).toBe(true);
    expect(mid.some((place) => place.kind === 'region' && place.name === 'Florida')).toBe(true);
    expect(mid.some((place) => place.kind === 'water' && place.name === 'Gulf of Mexico')).toBe(true);
    expect(mid.some((place) => place.name === 'Orlando')).toBe(false);
    expect(mid.some((place) => place.name === 'Kissimmee')).toBe(false);
    const close = florida(20);
    expect(close.some((place) => place.kind === 'city' && place.name === 'Orlando')).toBe(true);
    expect(close.some((place) => place.kind === 'city' && place.name === 'Tampa')).toBe(true);
    expect(close.some((place) => place.kind === 'water' && place.name === 'Lake Okeechobee')).toBe(true);
    expect(close.some((place) => place.name === 'Kissimmee')).toBe(false);
    const deep = florida(8);
    expect(deep.some((place) => place.kind === 'town' && place.name === 'Kissimmee')).toBe(true);
    expect(deep.length).toBeGreaterThan(mid.length);
    expect(mid.length).toBeGreaterThan(wide.length);
  });

  it('adds Denver and Colorado before the closer Front Range towns', () => {
    const colorado = (fovDeg: number) => placesOnDisk(39, -105.5, 420_000, 0, 0, fovDeg, catalog);
    expect(colorado(80).some((place) => place.name === 'Denver')).toBe(false);
    const mid = colorado(30);
    expect(mid.some((place) => place.kind === 'city' && place.name === 'Denver')).toBe(true);
    expect(mid.some((place) => place.kind === 'region' && place.name === 'Colorado')).toBe(true);
    expect(mid.some((place) => place.name === 'Boulder')).toBe(false);
    const deep = colorado(10);
    expect(deep.some((place) => place.kind === 'city' && place.name === 'Colorado Springs')).toBe(true);
    expect(deep.some((place) => place.kind === 'town' && place.name === 'Boulder')).toBe(true);
  });

  it('keeps the Mississippi off a wide field and on a close field', () => {
    const wide = placesOnDisk(36.54, -89.56, 420_000, 0, 0, 40, catalog);
    const close = placesOnDisk(36.54, -89.56, 420_000, 0, 0, 10, catalog);
    expect(wide.some((place) => place.kind === 'water' && place.name === 'Mississippi')).toBe(false);
    expect(close.some((place) => place.kind === 'water' && place.name === 'Mississippi')).toBe(true);
  });

  it('drops a catalog row whose kind is not a place', () => {
    expect(readCatalog([
      ['city', 'Miami', -80.23, 25.79, 57],
      ['country', 'France', 2, 46, 40],
      ['town', '', -80, 25, 10],
    ])).toEqual([
      { kind: 'city', name: 'Miami', lon: -80.23, lat: 25.79, maxFovDeg: 57 },
    ]);
  });

  it('keeps every town inside the field that loads the town chunk', () => {
    expect(LABEL_TOWNS.every((point) => point.kind === 'town' && point.maxFovDeg <= TOWN_LABEL_FOV_DEG)).toBe(true);
    expect(LABEL_CATALOG.some((point) => point.kind === 'town')).toBe(false);
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
