import { describe, expect, it } from 'vitest';

import { placeScreenLabels, type PlacedLabel } from '../src/iss-view/label-layout';

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
});
