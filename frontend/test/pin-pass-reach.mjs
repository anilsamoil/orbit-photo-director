export function passRowReachable(part, content) {
  if (!part?.rect || !content) return false;
  const heightOk = part.rect.height >= Math.min(part.rawHeight, content.height) - 1;
  const widthOk = part.rect.width >= Math.min(part.rawWidth, content.width) - 1;
  return heightOk && widthOk;
}
