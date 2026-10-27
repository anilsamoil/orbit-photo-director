export function passRowReachable(
  part: {
    rect: { width: number; height: number };
    rawWidth: number;
    rawHeight: number;
  } | null | undefined,
  content: { width: number; height: number } | null | undefined,
): boolean;
