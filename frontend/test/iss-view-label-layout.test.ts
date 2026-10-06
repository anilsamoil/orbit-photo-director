import { describe, expect, it } from 'vitest';

import { placeScreenLabels, type PlacedLabel } from '../src/iss-view/label-layout';
import { sceneFrame } from '../src/iss-view/model';
import { placesOnDisk } from '../src/iss-view/place-labels';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

function rect(label: PlacedLabel): { left: number; top: number; right: number; bottom: number } {
  const x = label.x + label.offsetX;
  const y = label.y + label.offsetY;
  return {
    left: x - label.width / 2,
    top: y,
    right: x + label.width / 2,
    bottom: y + label.height,
  };
}

function overlaps(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const frame = { width: 800, height: 500 };

describe('ISS place label collision', () => {
  it('keeps city anchors and moves country labels off Tokyo, Paris, and New York', () => {
    const placed = placeScreenLabels(
      [
        { kind: 'country', name: 'Japan', x: 160, y: 240, width: 72, height: 16 },
        { kind: 'city', name: 'Tokyo', x: 160, y: 240, width: 48, height: 14 },
        { kind: 'country', name: 'France', x: 400, y: 240, width: 78, height: 16 },
        { kind: 'city', name: 'Paris', x: 400, y: 240, width: 46, height: 14 },
        { kind: 'country', name: 'United States', x: 640, y: 240, width: 148, height: 16 },
        { kind: 'city', name: 'New York', x: 640, y: 240, width: 84, height: 14 },
      ],
      frame,
    );
    for (const name of ['Tokyo', 'Paris', 'New York']) {
      const city = placed.find((label) => label.name === name);
      expect(city?.offsetX).toBe(0);
      expect(city?.offsetY).toBe(0);
    }
    for (const [country, city] of [
      ['Japan', 'Tokyo'],
      ['France', 'Paris'],
      ['United States', 'New York'],
    ] as const) {
      const area = placed.find((label) => label.name === country);
      const town = placed.find((label) => label.name === city);
      expect(area).toBeTruthy();
      expect(town).toBeTruthy();
      if (!area || !town) continue;
      expect(overlaps(rect(area), rect(town))).toBe(false);
    }
  });

  it('leaves a country label on its anchor when the boxes are apart', () => {
    const placed = placeScreenLabels(
      [
        { kind: 'country', name: 'Japan', x: 120, y: 80, width: 72, height: 16 },
        { kind: 'city', name: 'Tokyo', x: 520, y: 360, width: 48, height: 14 },
      ],
      frame,
    );
    const japan = placed.find((label) => label.name === 'Japan');
    expect(japan?.offsetX).toBe(0);
    expect(japan?.offsetY).toBe(0);
  });

  it('drops a country label when no shift fits in the frame', () => {
    const placed = placeScreenLabels(
      [
        { kind: 'city', name: 'Tokyo', x: 45, y: 8, width: 70, height: 14 },
        { kind: 'country', name: 'Japan', x: 45, y: 8, width: 80, height: 16 },
      ],
      { width: 90, height: 30 },
    );
    expect(placed.map((label) => label.name)).toEqual(['Tokyo']);
  });

  it('keeps New York when Bridgeport overlaps it', () => {
    const placed = placeScreenLabels(
      [
        { kind: 'city', name: 'Bridgeport', x: 300, y: 200, width: 80, height: 14, rank: 144000, maxFovDeg: 22 },
        { kind: 'city', name: 'New York', x: 300, y: 200, width: 84, height: 14 },
      ],
      frame,
    );
    expect(placed.map((label) => label.name)).toEqual(['New York']);
    expect(placed[0]?.offsetX).toBe(0);
    expect(placed[0]?.offsetY).toBe(0);
  });

  it('moves a town off a city and keeps the city anchor', () => {
    const placed = placeScreenLabels(
      [
        { kind: 'town', name: 'Kissimmee', x: 240, y: 180, width: 78, height: 14 },
        { kind: 'city', name: 'Orlando', x: 240, y: 180, width: 58, height: 14 },
      ],
      frame,
    );
    const city = placed.find((label) => label.name === 'Orlando');
    const town = placed.find((label) => label.name === 'Kissimmee');
    expect(city?.offsetX).toBe(0);
    expect(city?.offsetY).toBe(0);
    expect(town).toBeTruthy();
    if (!city || !town) return;
    expect(overlaps(rect(city), rect(town))).toBe(false);
  });

  it('moves a water label off a city and keeps the city anchor', () => {
    const placed = placeScreenLabels(
      [
        { kind: 'water', name: 'North Atlantic Ocean', x: 300, y: 200, width: 180, height: 14 },
        { kind: 'city', name: 'New York', x: 300, y: 200, width: 84, height: 14 },
      ],
      frame,
    );
    const city = placed.find((label) => label.name === 'New York');
    const water = placed.find((label) => label.name === 'North Atlantic Ocean');
    expect(city?.offsetX).toBe(0);
    expect(city?.offsetY).toBe(0);
    expect(water).toBeTruthy();
    if (!city || !water) return;
    expect(overlaps(rect(city), rect(water))).toBe(false);
  });

  it('keeps the earlier city name and drops the overlapping city', () => {
    const pairs = [
      [
        { kind: 'city' as const, name: 'São Paulo', x: 219.9497726553395, y: 107.2729192765149, width: 61.765625, height: 12 },
        { kind: 'city' as const, name: 'Rio de Janeiro', x: 199.02209900195777, y: 111.0458603502833, width: 89.515625, height: 12 },
        'Rio de Janeiro',
        'São Paulo',
      ],
      [
        { kind: 'city' as const, name: 'Paris', x: 199.97328942638316, y: 110.73189586087013, width: 31.765625, height: 12 },
        { kind: 'city' as const, name: 'London', x: 223.6025405934202, y: 108.60941076090614, width: 46.328125, height: 12 },
        'London',
        'Paris',
      ],
      [
        { kind: 'city' as const, name: 'Washington D.C.', x: 316.1459086666145, y: 86.36259218180246, width: 103.828125, height: 12 },
        { kind: 'city' as const, name: 'New York', x: 279.8154752448632, y: 97.36383015526505, width: 59.125, height: 12 },
        'New York',
        'Washington D.C.',
      ],
    ] as const;
    for (const [first, second, kept, dropped] of pairs) {
      const placed = placeScreenLabels([first, second], { width: 340, height: 226 });
      const winner = placed.find((label) => label.name === kept);
      expect(placed.map((label) => label.name)).toEqual([kept]);
      expect(winner?.offsetX).toBe(0);
      expect(winner?.offsetY).toBe(0);
      expect(placed.some((label) => label.name === dropped)).toBe(false);
    }
  });

  it('drops a long city name that leaves the frame and keeps the city that fits', () => {
    const placed = placeScreenLabels(
      [
        { kind: 'city', name: 'Washington D.C.', x: 80, y: 16, width: 104, height: 12 },
        { kind: 'city', name: 'Boston', x: 40, y: 40, width: 48, height: 12 },
      ],
      { width: 120, height: 80 },
    );
    expect(placed.map((label) => label.name)).toEqual(['Boston']);
    expect(placed[0]?.offsetX).toBe(0);
    expect(placed[0]?.offsetY).toBe(0);
  });

  it('moves a country off the admitted city after the other city is dropped', () => {
    const placed = placeScreenLabels(
      [
        { kind: 'country', name: 'Brazil', x: 210, y: 108, width: 70, height: 16 },
        { kind: 'city', name: 'São Paulo', x: 219.9497726553395, y: 107.2729192765149, width: 61.765625, height: 12 },
        { kind: 'city', name: 'Rio de Janeiro', x: 199.02209900195777, y: 111.0458603502833, width: 89.515625, height: 12 },
      ],
      { width: 340, height: 226 },
    );
    const rio = placed.find((label) => label.name === 'Rio de Janeiro');
    const brazil = placed.find((label) => label.name === 'Brazil');
    expect(rio?.offsetX).toBe(0);
    expect(rio?.offsetY).toBe(0);
    expect(placed.some((label) => label.name === 'São Paulo')).toBe(false);
    expect(brazil).toBeTruthy();
    if (!rio || !brazil) return;
    expect(overlaps(rect(rio), rect(brazil))).toBe(false);
  });
});

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  iss_polynomial: Track['iss_polynomial'];
};

describe('ISS city collision on a horizon orbit', () => {
  it('separates city pairs from the 2024-10-17 horizon passes', () => {
    const track: Track = {
      iss_polynomial: fixture.iss_polynomial,
      tle: fixture.tle,
      tle_epoch: '2024-10-16T18:58:11.999Z',
      tle_age_hours: 17,
      tle_freshness_factor: 1,
    };
    const passes = [
      {
        utc: '2024-10-17T16:00:00.000Z',
        lat: -37.26028841192257,
        lon: -54.034093970133,
        kept: 'Rio de Janeiro',
        dropped: 'São Paulo',
        a: { kind: 'city' as const, name: 'Rio de Janeiro', x: 199.02209900195777, y: 111.0458603502833, width: 89.515625, height: 12 },
        b: { kind: 'city' as const, name: 'São Paulo', x: 219.9497726553395, y: 107.2729192765149, width: 61.765625, height: 12 },
      },
      {
        utc: '2024-10-17T17:58:30.000Z',
        lat: 36.22146266241252,
        lon: -11.634905516130965,
        kept: 'London',
        dropped: 'Paris',
        a: { kind: 'city' as const, name: 'London', x: 223.6025405934202, y: 108.60941076090614, width: 46.328125, height: 12 },
        b: { kind: 'city' as const, name: 'Paris', x: 199.97328942638316, y: 110.73189586087013, width: 31.765625, height: 12 },
      },
      {
        utc: '2024-10-17T20:59:30.000Z',
        lat: 23.561272825097774,
        lon: -72.88689070429011,
        kept: 'New York',
        dropped: 'Washington D.C.',
        a: { kind: 'city' as const, name: 'New York', x: 279.8154752448632, y: 97.36383015526505, width: 59.125, height: 12 },
        b: { kind: 'city' as const, name: 'Washington D.C.', x: 316.1459086666145, y: 86.36259218180246, width: 103.828125, height: 12 },
      },
    ];
    for (const pass of passes) {
      const posed = sceneFrame(track, Date.parse(pass.utc), 'horizon', 0);
      expect(posed.ok).toBe(true);
      if (!posed.ok) continue;
      expect(posed.pose.camera.latDeg).toBeCloseTo(pass.lat, 4);
      expect(posed.pose.camera.lonDeg).toBeCloseTo(pass.lon, 4);
      const visible = placesOnDisk(
        posed.pose.camera.latDeg,
        posed.pose.camera.lonDeg,
        posed.pose.altitudeM,
        posed.pose.bearingDeg,
        posed.pose.analyticPitchDeg,
      );
      expect(visible.some((place) => place.name === pass.kept)).toBe(true);
      expect(visible.some((place) => place.name === pass.dropped)).toBe(true);
      const placed = placeScreenLabels([pass.a, pass.b], { width: 340, height: 226 });
      expect(placed.map((label) => label.name)).toEqual([pass.kept]);
      const boxes = placed.map(rect);
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const left = boxes[i];
          const right = boxes[j];
          if (!left || !right) continue;
          expect(overlaps(left, right)).toBe(false);
        }
      }
    }
  });
});
