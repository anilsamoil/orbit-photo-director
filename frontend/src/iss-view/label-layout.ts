import type { PlaceKind } from './place-labels';

export type ScreenLabel = {
  kind: PlaceKind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PlacedLabel = ScreenLabel & {
  offsetX: number;
  offsetY: number;
};

export function placeScreenLabels(labels: readonly ScreenLabel[], frame: { width: number; height: number }): PlacedLabel[] {
  return labels
    .filter((label) => label.x >= 0 && label.y >= 0 && label.x <= frame.width && label.y <= frame.height)
    .map((label) => ({ ...label, offsetX: 0, offsetY: 0 }));
}
