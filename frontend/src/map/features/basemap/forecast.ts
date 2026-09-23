const FCST_HOURLY_BAND_H = 6;
const FCST_TOL_HOURLY_MIN = 30;
const FCST_TOL_COARSE_MIN = 90;
const FCST_MAX_FRAME_AGE_MIN = 45;

/** "2026-06-10T06:00:00Z" becomes "20260610T060000Z", the generator's
 *  compact_key. No colons in object paths. */
export function compactFrameKey(iso: string): string {
  return iso.replace(/[-:]/g, '');
}

/** The forecast frame nearest the view instant. A frame more than 45
 *  minutes in the past is never a candidate. Null when nothing sits inside
 *  the tolerance: ±30 min within 6h of now, ±90 min beyond. */
export function nearestForecastFrame(
  validTimes: string[],
  viewMs: number,
  nowMs: number,
): { iso: string; validMs: number } | null {
  const lookaheadH = (viewMs - nowMs) / 3_600_000;
  const tolMs = (lookaheadH <= FCST_HOURLY_BAND_H ? FCST_TOL_HOURLY_MIN : FCST_TOL_COARSE_MIN) * 60_000;
  const minValidMs = nowMs - FCST_MAX_FRAME_AGE_MIN * 60_000;
  let best: { iso: string; validMs: number } | null = null;
  for (const iso of validTimes) {
    const validMs = Date.parse(iso);
    if (Number.isNaN(validMs) || validMs < minValidMs) continue;
    if (best === null || Math.abs(validMs - viewMs) < Math.abs(best.validMs - viewMs)) {
      best = { iso, validMs };
    }
  }
  if (best === null || Math.abs(best.validMs - viewMs) > tolMs) return null;
  return best;
}
