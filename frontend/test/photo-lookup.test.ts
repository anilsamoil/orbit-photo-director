import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseTimestamp,
  resolveTimestampToIssPosition,
} from '../src/photo-lookup';
import { _resetSatrecCacheForTests } from '../src/iss-sgp4';
import type { Track } from '../src/types';

const SAMPLE_TLE = {
  line1: '1 25544U 98067A   24290.79041667  .00031560  00000-0  56270-3 0  9990',
  line2: '2 25544  51.6383 254.0066 0009172  76.0729  21.3008 15.49814196479596',
};
const SAMPLE_TRACK: Track = {
  iss_polynomial: {
    start: '2024-10-16T19:00:00.000Z',
    duration_seconds: 7200,
    lat_coeffs: [],
    lon_coeffs: [],
    polynomial_order: 11,
  },
  tle: SAMPLE_TLE,
  tle_epoch: '2024-10-16T18:58:11.999Z',
  tle_age_hours: 1.0,
  tle_freshness_factor: 1.0,
};

beforeEach(() => {
  _resetSatrecCacheForTests();
});

describe('parseTimestamp', () => {
  it('parses standard ISO 8601 with Z', () => {
    const d = parseTimestamp('2024-10-17T12:23:00Z');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2024-10-17T12:23:00.000Z');
  });

  it('parses ISO with fractional seconds', () => {
    const d = parseTimestamp('2024-10-17T12:23:00.123Z');
    expect(d?.toISOString()).toBe('2024-10-17T12:23:00.123Z');
  });

  it('parses ISO 8601 without timezone (assumes UTC)', () => {
    const d = parseTimestamp('2024-10-17T12:23:00');
    expect(d?.toISOString()).toBe('2024-10-17T12:23:00.000Z');
  });

  it('parses space-separated date and time', () => {
    const d = parseTimestamp('2024-10-17 12:23:00');
    expect(d?.toISOString()).toBe('2024-10-17T12:23:00.000Z');
  });

  it('honors explicit timezone offset', () => {
    const d = parseTimestamp('2024-10-17T12:23:00+04:00');
    expect(d?.toISOString()).toBe('2024-10-17T08:23:00.000Z');
  });

  it('returns null for garbage input', () => {
    expect(parseTimestamp('not a date')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('   ')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const d = parseTimestamp('  2024-10-17T12:23:00Z  ');
    expect(d?.toISOString()).toBe('2024-10-17T12:23:00.000Z');
  });
});

describe('resolveTimestampToIssPosition', () => {
  it('returns null when track is null', () => {
    const r = resolveTimestampToIssPosition(new Date('2024-10-17T12:00:00Z'), null, 'paste');
    expect(r).toBeNull();
  });

  it('returns null when track has no tle', () => {
    const noTle: Track = { ...SAMPLE_TRACK, tle: undefined };
    const r = resolveTimestampToIssPosition(new Date('2024-10-17T12:00:00Z'), noTle, 'paste');
    expect(r).toBeNull();
  });

  it('returns high confidence for timestamps within 24h of epoch', () => {
    // Epoch is 2024-10-16T18:58:11Z; +12h is well within 24h.
    const ts = new Date('2024-10-17T06:58:11Z');
    const r = resolveTimestampToIssPosition(ts, SAMPLE_TRACK, 'paste');
    expect(r).not.toBeNull();
    expect(r?.confidence).toBe('high');
    expect(r?.tle_age_at_lookup_hours).toBeCloseTo(12, 0);
  });

  it('returns medium confidence for timestamps 24-72h from epoch', () => {
    // Epoch + 48h
    const ts = new Date('2024-10-18T18:58:11Z');
    const r = resolveTimestampToIssPosition(ts, SAMPLE_TRACK, 'paste');
    expect(r?.confidence).toBe('medium');
  });

  it('returns low confidence for timestamps >72h from epoch', () => {
    // Epoch + 96h
    const ts = new Date('2024-10-20T18:58:11Z');
    const r = resolveTimestampToIssPosition(ts, SAMPLE_TRACK, 'paste');
    expect(r?.confidence).toBe('low');
  });

  it('returns valid lat/lon/alt for typical ISS lookup', () => {
    const ts = new Date('2024-10-17T06:58:11Z');
    const r = resolveTimestampToIssPosition(ts, SAMPLE_TRACK, 'paste');
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.lat).toBeGreaterThan(-52);
    expect(r.lat).toBeLessThan(52);
    expect(r.lon).toBeGreaterThanOrEqual(-180);
    expect(r.lon).toBeLessThanOrEqual(180);
    expect(r.alt_km).toBeGreaterThan(380);
    expect(r.alt_km).toBeLessThan(450);
  });

  it('preserves the input timestamp on the result', () => {
    const ts = new Date('2024-10-17T06:58:11Z');
    const r = resolveTimestampToIssPosition(ts, SAMPLE_TRACK, 'paste');
    expect(r?.timestamp_utc.toISOString()).toBe('2024-10-17T06:58:11.000Z');
  });

  it('passes through the source field', () => {
    const ts = new Date('2024-10-17T06:58:11Z');
    const fromPaste = resolveTimestampToIssPosition(ts, SAMPLE_TRACK, 'paste');
    const fromExif = resolveTimestampToIssPosition(ts, SAMPLE_TRACK, 'exif');
    expect(fromPaste?.source).toBe('paste');
    expect(fromExif?.source).toBe('exif');
  });

  it('returns null when tle_epoch is missing or unparseable', () => {
    const noEpoch: Track = { ...SAMPLE_TRACK, tle_epoch: 'garbage' };
    const r = resolveTimestampToIssPosition(new Date(), noEpoch, 'paste');
    expect(r).toBeNull();
  });
});
