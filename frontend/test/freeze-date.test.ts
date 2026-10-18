import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import exifr from 'exifr';
import { describe, expect, it } from 'vitest';

import { extractExifTimestamp } from '../src/photo-lookup';
import { installFrozenDate } from './freeze-date';

const FIXED = Date.parse('2026-06-10T12:00:00.000Z');
const FIXTURE = resolve(__dirname, 'fixtures/exif-datetime.jpg');

const argCases: { label: string; args: readonly unknown[] }[] = [
  { label: '1 timestamp', args: [1_700_000_000_000] },
  { label: '1 date string', args: ['2020-01-02T03:04:05.000Z'] },
  { label: '2 args', args: [2026, 5] },
  { label: '3 args', args: [2026, 5, 10] },
  { label: '4 args', args: [2026, 5, 10, 4] },
  { label: '5 args', args: [2026, 5, 10, 4, 5] },
  { label: '6 args', args: [2026, 5, 10, 4, 5, 6] },
  { label: '7 args', args: [2026, 5, 10, 4, 5, 6, 7] },
];

const undefinedCases: { label: string; args: readonly unknown[] }[] = [
  { label: 'month undefined', args: [2026, undefined] },
  { label: 'day undefined', args: [2026, 5, undefined] },
  { label: 'hours undefined', args: [2026, 5, 10, undefined] },
  { label: 'trailing undefined through ms', args: [2026, 5, 10, undefined, undefined, undefined, undefined] },
];

function callNew(ctor: DateConstructor, args: readonly unknown[]): Date {
  return new ctor(...(args as unknown as ConstructorParameters<DateConstructor>));
}

function frozen<T>(body: (native: DateConstructor) => T): T {
  const native = globalThis.Date;
  installFrozenDate(FIXED);
  try {
    return body(native);
  } finally {
    globalThis.Date = native;
  }
}

async function frozenAsync<T>(body: (native: DateConstructor) => Promise<T>): Promise<T> {
  const native = globalThis.Date;
  installFrozenDate(FIXED);
  try {
    return await body(native);
  } finally {
    globalThis.Date = native;
  }
}

describe('installFrozenDate', () => {
  it.each(argCases)('new Date with $label matches the original Date', ({ args }) => {
    frozen((native) => {
      const actual = callNew(Date, args);
      const expected = callNew(native, args);
      expect(actual).toBeInstanceOf(Date);
      expect(Object.is(actual.getTime(), expected.getTime())).toBe(true);
    });
  });

  it.each(undefinedCases)('new Date with $label matches the original Date', ({ args }) => {
    frozen((native) => {
      const actual = callNew(Date, args);
      const expected = callNew(native, args);
      expect(actual).toBeInstanceOf(Date);
      expect(Object.is(actual.getTime(), expected.getTime())).toBe(true);
    });
  });

  it('Date() without new returns the frozen time string', () => {
    frozen((native) => {
      const frozenText = new native(FIXED).toString();
      const callDate = Date as unknown as (...args: unknown[]) => string;
      expect(callDate()).toBe(frozenText);
      expect(callDate(2026, 5, 10)).toBe(frozenText);
    });
  });

  it('zero-arg new Date() and Date.now() return the frozen instant', () => {
    frozen(() => {
      expect(new Date().getTime()).toBe(FIXED);
      expect(Date.now()).toBe(FIXED);
    });
  });

  it('instances stay dates', () => {
    frozen((native) => {
      const created = new Date(2026, 5, 10);
      expect(created instanceof Date).toBe(true);
      expect(created instanceof native).toBe(true);
      expect(Date.prototype).toBe(native.prototype);
    });
  });

  it('Date.UTC and Date.parse stay on the original Date', () => {
    frozen((native) => {
      expect(Date.UTC(2026, 5, 10, 1, 2, 3, 4)).toBe(native.UTC(2026, 5, 10, 1, 2, 3, 4));
      expect(Date.parse('2020-01-02T03:04:05.000Z')).toBe(native.parse('2020-01-02T03:04:05.000Z'));
    });
  });

  it('exifr converts an EXIF date to a valid Date while frozen', async () => {
    const bytes = readFileSync(FIXTURE);
    await frozenAsync(async (native) => {
      const parsed = await exifr.parse(bytes, { reviveValues: true });
      const original = parsed.DateTimeOriginal as Date;
      const expected = callNew(native, [2020, 0, 2, 3, 4, 5]);
      expect(original).toBeInstanceOf(Date);
      expect(Number.isFinite(original.getTime())).toBe(true);
      expect(Object.is(original.getTime(), expected.getTime())).toBe(true);

      const file = new File([bytes], 'exif-datetime.jpg', { type: 'image/jpeg' });
      const extracted = await extractExifTimestamp(file);
      expect(extracted.reason).toBe('ok');
      expect(extracted.date).toBeInstanceOf(Date);
      expect(Object.is(extracted.date?.getTime(), expected.getTime())).toBe(true);
    });
  });
});
