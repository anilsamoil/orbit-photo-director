export type LngLat = [lng: number, lat: number];

export type Point = { x: number; y: number };

export type BBox = { west: number; south: number; east: number; north: number };

export function boundsOf(points: readonly LngLat[]): BBox {
  const [first, ...rest] = points;
  if (!first) throw new Error('boundsOf needs at least one point');
  const box: BBox = { west: first[0], south: first[1], east: first[0], north: first[1] };
  for (const [lng, lat] of rest) {
    box.west = Math.min(box.west, lng);
    box.east = Math.max(box.east, lng);
    box.south = Math.min(box.south, lat);
    box.north = Math.max(box.north, lat);
  }
  return box;
}
