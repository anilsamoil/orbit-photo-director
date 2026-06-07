/** iCalendar (.ics) builder for shot-list reminders.
 *
 *  The operator picks passes they want to photograph; this turns the selection
 *  into an RFC 5545 VCALENDAR the phone's Calendar imports. Each pass becomes a
 *  VEVENT with TWO alarms — 5 minutes before and at closest approach — that the
 *  OS fires natively even with the app closed and the phone locked. We export a
 *  calendar file (not Web Push) precisely so the reminder does NOT depend on our
 *  daemon/Worker being alive at fire time.
 *
 *  RFC 5545 correctness is load-bearing: iOS Calendar SILENTLY rejects a
 *  malformed file. The non-obvious requirements (verified against the spec +
 *  Codex review 2026-06-07):
 *    - Every VEVENT needs UID *and* DTSTAMP.
 *    - Every VALARM needs its own ACTION + DESCRIPTION (event-level DESCRIPTION
 *      does NOT satisfy the alarm).
 *    - Lines fold at 75 OCTETS (not JS chars) — the 📸 emoji and ° are multibyte,
 *      so naive char folding corrupts them.
 *    - TEXT values escape \\ , ; and newline (NOT colon); raw CR/LF stripped.
 *    - Times are UTC basic format YYYYMMDDTHHMMSSZ (no hyphens/colons/millis).
 *    - DURATION xor DTEND (we use DURATION); METHOD omitted (cleaner for import).
 *    - SEQUENCE bumps per export so a re-import UPDATES same-UID events instead
 *      of duplicating.
 */
import { formatTrackOffset } from './track-offset';
import type { ShotlistEntry } from './shotlist';

const PRODID = '-//orbit-photo-director//shot-list reminders//EN';
const APP_URL = 'https://map.astroanil.dev/';
/** −5 min reminder, in ms. A pass closer than this exports with only the
 *  at-time alarm (a −5min trigger already in the past is dropped/ignored by
 *  calendars and would mislead the operator). */
export const LEAD_MS = 5 * 60 * 1000;
const WORF_MAX_OFF_NADIR_DEG = 30;

/** Format an epoch-ms instant as RFC 5545 UTC basic format YYYYMMDDTHHMMSSZ. */
export function formatUtcStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** Escape a TEXT value per RFC 5545 §3.3.11: backslash, semicolon, comma, and
 *  newline get escaped; colon is NOT escaped. Raw CR/LF are normalised to the
 *  literal `\n` escape so a hostile target name can't inject calendar lines. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const enc = new TextEncoder();
const byteLen = (s: string): number => enc.encode(s).length;

/** Fold one content line to ≤75 octets per RFC 5545 §3.1. Continuation lines
 *  begin with CRLF + a single space (the space counts toward the 75). Folds on
 *  code-point boundaries so multibyte chars (emoji, °) are never split. */
export function foldLine(line: string): string {
  if (byteLen(line) <= 75) return line;
  const segments: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const chBytes = byteLen(ch);
    // First physical line gets 75; continuation lines reserve 1 octet for the
    // leading space, so 74 of content.
    const limit = segments.length === 0 ? 75 : 74;
    if (curBytes + chBytes > limit) {
      segments.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  segments.push(cur);
  return segments.join('\r\n ');
}

/** WORF (Destiny nadir window) below 30° off-nadir, Cupola at/above. */
function windowLabel(offNadirDeg: number): string {
  return offNadirDeg < WORF_MAX_OFF_NADIR_DEG ? 'WORF' : 'Cupola';
}

/** Direction phrase reused from the card ("26° right of track"), or '' when the
 *  manifest lacks the angle/bearing. */
function direction(e: ShotlistEntry): string {
  if (typeof e.angle_off_nadir_deg !== 'number') return '';
  if (typeof e.iss_relative_bearing_deg !== 'number') {
    return `${Math.round(e.angle_off_nadir_deg)}° off nadir`;
  }
  return formatTrackOffset(e.angle_off_nadir_deg, e.iss_relative_bearing_deg);
}

function buildVevent(e: ShotlistEntry, closestMs: number, nowMs: number, sequence: number): string[] {
  const dir = direction(e);
  const win =
    typeof e.angle_off_nadir_deg === 'number' ? windowLabel(e.angle_off_nadir_deg) : '';
  const summary = `📸 ${e.target_name}${dir ? ` — ${dir}` : ''}`;
  const descParts = [dir, win ? `${win} window` : '', `Open: ${APP_URL}?target=${e.target_id}`]
    .filter(Boolean)
    .join('. ');

  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${e.target_id}-${e.closest_approach}@map.astroanil.dev`,
    `DTSTAMP:${formatUtcStamp(nowMs)}`,
    `DTSTART:${formatUtcStamp(closestMs)}`,
    'DURATION:PT2M',
    `SEQUENCE:${sequence}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(descParts)}`,
    `URL:${APP_URL}?target=${e.target_id}`,
  ];

  // At-closest alarm always fires. The −5min alarm only when the pass is far
  // enough out that −5min is still in the future — otherwise drop it (a past
  // trigger is ignored/immediate and would mislead).
  if (closestMs - nowMs >= LEAD_MS) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(`5 min to ${e.target_name}`)}`,
      'TRIGGER:-PT5M',
      'END:VALARM',
    );
  }
  lines.push(
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(`Shoot now: ${e.target_name}`)}`,
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
  );
  return lines;
}

/** Build a VCALENDAR string from the shot-list. Entries whose closest approach
 *  is already in the past are skipped (a reminder for a pass that already
 *  happened is noise). `sequence` should increase on each export so re-imports
 *  update rather than duplicate. Returns '' when nothing is exportable. */
export function buildIcs(entries: ShotlistEntry[], nowMs: number, sequence = 0): string {
  const events: string[] = [];
  for (const e of entries) {
    const closestMs = Date.parse(e.closest_approach);
    if (Number.isNaN(closestMs) || closestMs <= nowMs) continue; // skip past / unparseable
    events.push(...buildVevent(e, closestMs, nowMs, sequence));
  }
  if (events.length === 0) return '';

  const all = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
  ];
  return all.map(foldLine).join('\r\n') + '\r\n';
}
