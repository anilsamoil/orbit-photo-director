export type Box = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
