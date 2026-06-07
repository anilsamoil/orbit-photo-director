/** Tests for ics.ts — the RFC 5545 .ics builder for shot-list reminders.
 *
 *  The correctness here is load-bearing: iOS Calendar silently rejects a
 *  malformed file, so these pin the non-obvious requirements (DTSTAMP, per-
 *  VALARM DESCRIPTION, octet folding, escaping, UTC format, no DTEND, no
 *  METHOD) plus the −5min-in-past and past-pass rules. */
import { describe, expect, it } from 'vitest';

import { buildIcs, escapeText, foldLine, formatUtcStamp } from '../src/ics';
import type { ShotlistEntry } from '../src/shotlist';

const NOW = Date.UTC(2026, 5, 7, 12, 0, 0); // 2026-06-07T12:00:00Z

function entry(o: Partial<ShotlistEntry> & { minutesOut?: number } = {}): ShotlistEntry {
  const closest = o.closest_approach ?? new Date(NOW + (o.minutesOut ?? 30) * 60_000).toISOString();
  const target_id = o.target_id ?? 'tokyo';
  return {
    key: `${target_id}|${closest}`,
    target_id,
    target_name: o.target_name ?? 'Tokyo',
    closest_approach: closest,
    angle_off_nadir_deg: 'angle_off_nadir_deg' in o ? o.angle_off_nadir_deg : 26,
    iss_relative_bearing_deg: 'iss_relative_bearing_deg' in o ? o.iss_relative_bearing_deg : 90,
  };
}

const byteLen = (s: string) => new TextEncoder().encode(s).length;
const veventCount = (ics: string) => ics.split('BEGIN:VEVENT').length - 1;
const valarmCount = (ics: string) => ics.split('BEGIN:VALARM').length - 1;

describe('formatUtcStamp', () => {
  it('formats epoch-ms as YYYYMMDDTHHMMSSZ (no hyphens/colons/millis)', () => {
    expect(formatUtcStamp(Date.UTC(2026, 5, 7, 14, 3, 9))).toBe('20260607T140309Z');
  });
});

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma, newline — but NOT colon', () => {
    expect(escapeText('a,b;c\\d')).toBe('a\\,b\\;c\\\\d');
    expect(escapeText('line1\nline2')).toBe('line1\\nline2');
    expect(escapeText('http://x')).toBe('http://x'); // colon untouched
  });
  it('neutralises raw CRLF so a name cannot inject calendar lines', () => {
    expect(escapeText('evil\r\nBEGIN:VEVENT')).toBe('evil\\nBEGIN:VEVENT');
  });
});

describe('foldLine', () => {
  it('leaves short lines untouched', () => {
    expect(foldLine('SUMMARY:hi')).toBe('SUMMARY:hi');
  });
  it('folds long ASCII lines to <=75 octets with CRLF + space continuation', () => {
    const long = 'DESCRIPTION:' + 'x'.repeat(200);
    const folded = foldLine(long);
    for (const physical of folded.split('\r\n')) {
      expect(byteLen(physical)).toBeLessThanOrEqual(75);
    }
    // Unfolding (strip CRLF + leading space) round-trips to the original.
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });
  it('folds multibyte (emoji / degree) without splitting a code point', () => {
    const long = 'SUMMARY:' + '📸°'.repeat(40); // 4-byte emoji + 2-byte degree
    const folded = foldLine(long);
    for (const physical of folded.split('\r\n')) {
      expect(byteLen(physical)).toBeLessThanOrEqual(75);
    }
    // Round-trips intact — no corrupted/half characters.
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });
});

describe('buildIcs', () => {
  it('returns one VEVENT per future pass with both alarms', () => {
    const ics = buildIcs([entry({ target_id: 'a', minutesOut: 30 }), entry({ target_id: 'b', minutesOut: 60 })], NOW, 0);
    expect(veventCount(ics)).toBe(2);
    expect(valarmCount(ics)).toBe(4); // 2 alarms each
  });

  it('emits required VEVENT props: UID, DTSTAMP, DTSTART, DURATION, SEQUENCE — and NO DTEND/METHOD', () => {
    const ics = buildIcs([entry({ minutesOut: 30 })], NOW, 3);
    expect(ics).toContain('UID:tokyo-');
    expect(ics).toContain('@map.astroanil.dev');
    expect(ics).toContain(`DTSTAMP:${formatUtcStamp(NOW)}`);
    expect(ics).toContain('DTSTART:20260607T123000Z');
    expect(ics).toContain('DURATION:PT2M');
    expect(ics).toContain('SEQUENCE:3');
    expect(ics).not.toContain('DTEND');
    expect(ics).not.toContain('METHOD');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:');
  });

  it('each VALARM carries its own ACTION + DESCRIPTION + TRIGGER', () => {
    const ics = buildIcs([entry({ minutesOut: 30 })], NOW, 0);
    const alarms = ics.split('BEGIN:VALARM').slice(1).map((s) => s.split('END:VALARM')[0]);
    expect(alarms).toHaveLength(2);
    for (const a of alarms) {
      expect(a).toContain('ACTION:DISPLAY');
      expect(a).toContain('DESCRIPTION:');
      expect(a).toContain('TRIGGER:');
    }
    expect(ics).toContain('TRIGGER:-PT5M');
    expect(ics).toContain('TRIGGER:PT0M');
  });

  it('drops the -5min alarm when the pass is under 5 min out', () => {
    const ics = buildIcs([entry({ minutesOut: 3 })], NOW, 0);
    expect(veventCount(ics)).toBe(1);
    expect(valarmCount(ics)).toBe(1); // only the at-time alarm
    expect(ics).toContain('TRIGGER:PT0M');
    expect(ics).not.toContain('TRIGGER:-PT5M');
  });

  it('skips past and unparseable passes', () => {
    expect(buildIcs([entry({ minutesOut: -10 })], NOW, 0)).toBe('');
    expect(buildIcs([entry({ closest_approach: 'not-a-date' })], NOW, 0)).toBe('');
    const mixed = buildIcs([entry({ target_id: 'past', minutesOut: -5 }), entry({ target_id: 'future', minutesOut: 20 })], NOW, 0);
    expect(veventCount(mixed)).toBe(1);
    expect(mixed).toContain('UID:future-');
  });

  it('returns empty string when nothing is exportable', () => {
    expect(buildIcs([], NOW, 0)).toBe('');
  });

  it('builds the SUMMARY from name + direction label, escaped', () => {
    const ics = buildIcs([entry({ target_name: "Ben's house, TX", angle_off_nadir_deg: 26, iss_relative_bearing_deg: 90 })], NOW, 0);
    // Comma in the name is escaped; the direction phrase is reused from the card.
    expect(ics).toContain('SUMMARY:📸 Ben\'s house\\, TX — 26° right of track');
  });

  it('uses CRLF line endings and ends with CRLF', () => {
    const ics = buildIcs([entry({ minutesOut: 30 })], NOW, 0);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/); // every LF is preceded by CR
  });

  it('degrades gracefully when angle/bearing are absent', () => {
    const ics = buildIcs([entry({ angle_off_nadir_deg: undefined, iss_relative_bearing_deg: undefined })], NOW, 0);
    expect(veventCount(ics)).toBe(1);
    expect(ics).toContain('SUMMARY:📸 Tokyo'); // no direction suffix, still valid
  });

  it('never emits "NaN" when the angle is NaN (guards Number.isFinite)', () => {
    const ics = buildIcs([entry({ angle_off_nadir_deg: NaN, iss_relative_bearing_deg: 90 })], NOW, 0);
    expect(veventCount(ics)).toBe(1);
    expect(ics).not.toContain('NaN');
    expect(ics).toContain('SUMMARY:📸 Tokyo');
  });

  it('percent-encodes the target_id in the deep link URL', () => {
    const ics = buildIcs([entry({ target_id: 'personal:anil:a b' })], NOW, 0);
    expect(ics).toContain('?target=personal%3Aanil%3Aa%20b');
  });
});
