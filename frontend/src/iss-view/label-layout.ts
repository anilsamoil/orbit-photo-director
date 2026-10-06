import type { PlaceKind } from './place-labels';

export type ScreenLabel = {
  kind: PlaceKind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  maxFovDeg?: number;
  rank?: number;
};

export type PlacedLabel = ScreenLabel & {
  offsetX: number;
  offsetY: number;
};

type Rect = { left: number; top: number; right: number; bottom: number };

const GAP = 4;

export function placeScreenLabels(labels: readonly ScreenLabel[], frame: { width: number; height: number }): PlacedLabel[] {
  const cities = labels.filter((label) => label.kind === 'city');
  const areas = labels.filter((label) => label.kind !== 'city');
  const placed: PlacedLabel[] = [];
  const occupied: Rect[] = [];
  const ranked = [...cities].sort(byCity);
  for (const city of ranked) {
    const next = { ...city, offsetX: 0, offsetY: 0 };
    const box = rectOf(next);
    if (!inside(box, frame)) continue;
    if (occupied.some((held) => overlaps(box, held))) continue;
    placed.push(next);
    occupied.push(box);
  }
  const ordered = [...areas].sort((a, b) => score(a, frame) - score(b, frame));
  for (const area of ordered) {
    const slot = openSlot(area, occupied, frame);
    if (!slot) continue;
    const next = { ...area, offsetX: slot.offsetX, offsetY: slot.offsetY };
    placed.push(next);
    occupied.push(rectOf(next));
  }
  return placed;
}

function byCity(a: ScreenLabel, b: ScreenLabel): number {
  const aHand = a.rank === undefined;
  const bHand = b.rank === undefined;
  if (aHand !== bHand) return aHand ? -1 : 1;
  const byRank = (b.rank ?? 0) - (a.rank ?? 0);
  if (byRank !== 0) return byRank;
  const byField = (b.maxFovDeg ?? 0) - (a.maxFovDeg ?? 0);
  if (byField !== 0) return byField;
  return byName(a, b);
}

function byName(a: ScreenLabel, b: ScreenLabel): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function score(label: ScreenLabel, frame: { width: number; height: number }): number {
  return (label.x - frame.width / 2) ** 2 + (label.y - frame.height / 2) ** 2;
}

function rectOf(label: PlacedLabel): Rect {
  const x = label.x + label.offsetX;
  const y = label.y + label.offsetY;
  return {
    left: x - label.width / 2,
    top: y,
    right: x + label.width / 2,
    bottom: y + label.height,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function inside(rect: Rect, frame: { width: number; height: number }): boolean {
  return rect.left >= 0 && rect.top >= 0 && rect.right <= frame.width && rect.bottom <= frame.height;
}

function openSlot(
  area: ScreenLabel,
  occupied: readonly Rect[],
  frame: { width: number; height: number },
): { offsetX: number; offsetY: number } | null {
  const attempts = [{ offsetX: 0, offsetY: 0 }, { offsetX: 0, offsetY: -(area.height + GAP) }];
  for (const box of occupied) {
    attempts.push({ offsetX: 0, offsetY: box.bottom - area.y + GAP });
    attempts.push({ offsetX: box.right - area.x + area.width / 2 + GAP, offsetY: 0 });
    attempts.push({ offsetX: box.left - area.x - area.width / 2 - GAP, offsetY: 0 });
  }
  for (const attempt of attempts) {
    const rect = rectOf({ ...area, offsetX: attempt.offsetX, offsetY: attempt.offsetY });
    if (!inside(rect, frame)) continue;
    if (occupied.some((box) => overlaps(rect, box))) continue;
    return attempt;
  }
  return null;
}
