/** Countdown formatting. All inputs and outputs are UTC-anchored. */

/** Parse an ISO 8601 string ending in Z; return Date or throw. */
export function parseUtcIso(s: string): Date {
  if (!s.endsWith('Z')) {
    throw new Error(`expected UTC ISO 8601 with Z suffix, got ${s}`);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid timestamp ${s}`);
  }
  return d;
}

/** Render a target time as an absolute UTC label like `14:23 UTC`. */
export function formatUtcLabel(s: string): string {
  const d = parseUtcIso(s);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/** Render a relative countdown.
 *
 *  > 60 min   → `In 1h 12m`
 *  > 1 min    → `In 23 min`
 *  > 0        → `In 47s`
 *  > -window  → `Now (Xm remaining)` until pass window expires
 *  past       → `Past`
 */
export function formatCountdown(targetIso: string, nowMs: number, passWindowMinutes = 6): string {
  const target = parseUtcIso(targetIso).getTime();
  const deltaMs = target - nowMs;

  if (deltaMs >= 60 * 60 * 1000) {
    const hours = Math.floor(deltaMs / (60 * 60 * 1000));
    const mins = Math.round((deltaMs % (60 * 60 * 1000)) / (60 * 1000));
    return `In ${hours}h ${mins}m`;
  }
  if (deltaMs >= 60 * 1000) {
    return `In ${Math.round(deltaMs / 60000)} min`;
  }
  if (deltaMs >= 0) {
    return `In ${Math.round(deltaMs / 1000)}s`;
  }
  // Negative — within the active pass window?
  const elapsedMin = -deltaMs / 60000;
  if (elapsedMin <= passWindowMinutes) {
    const remaining = Math.max(0, Math.round(passWindowMinutes - elapsedMin));
    return `Now (${remaining}m remaining)`;
  }
  return 'Past';
}

/** Score formatted as a 0-100 integer. Always returns the literal score, no `%`. */
export function formatScore(s: number): string {
  return String(Math.round(s));
}
