/** Slot 9 — CSV parser tests.
 *
 *  Exhaustive coverage of the state-machine parser in src/csv-parse.ts.
 *  Goals:
 *    - happy path (header + body rows)
 *    - quoting edge cases (embedded commas, escaped quotes, embedded newlines)
 *    - per-row validation (lat/lon/name/priority/column-count) with line numbers
 *    - top-level errors (missing or wrong header)
 *    - line-ending tolerance (LF, CRLF)
 *    - blank-line + comment-line skipping
 *    - tab-separated input is REJECTED (we only support commas)
 */

import { describe, expect, it } from 'vitest';

import { parseTargetCsv } from '../src/csv-parse';

describe('parseTargetCsv — happy path', () => {
  it('parses 3 valid rows with header (priority column present)', () => {
    const csv = [
      'name,lat,lon,priority',
      'Boston Aerial,42.3601,-71.0589,8',
      'Mt Etna Volcano,37.7510,14.9934,7',
      'Lago di Como,46.0,9.25,5',
    ].join('\n');
    const r = parseTargetCsv(csv);
    expect(r.topLevelError).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.valid).toHaveLength(3);
    expect(r.valid[0]).toMatchObject({ line: 2, name: 'Boston Aerial', lat: 42.3601, lon: -71.0589, priority: 8 });
    expect(r.valid[1]).toMatchObject({ line: 3, name: 'Mt Etna Volcano', lat: 37.7510, lon: 14.9934, priority: 7 });
    expect(r.valid[2]).toMatchObject({ line: 4, name: 'Lago di Como', lat: 46.0, lon: 9.25, priority: 5 });
  });

  it('parses rows without the priority column (header has 3 cols)', () => {
    const csv = 'name,lat,lon\nLago di Como,46.0,9.25';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]).toMatchObject({ name: 'Lago di Como', priority: 5 });
  });

  it('defaults priority to 5 when omitted on individual rows (header has 4 cols)', () => {
    const csv = 'name,lat,lon,priority\nFoo,0,0\nBar,1,1,9';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(2);
    expect(r.valid[0]!.priority).toBe(5);
    expect(r.valid[1]!.priority).toBe(9);
  });

  it('trims whitespace around lat/lon/priority numeric fields', () => {
    const csv = 'name,lat,lon,priority\nFoo, 12.5 , -34.25 , 7 ';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]).toMatchObject({ lat: 12.5, lon: -34.25, priority: 7 });
  });
});

describe('parseTargetCsv — quoting', () => {
  it('parses a quoted name with embedded comma', () => {
    const csv = 'name,lat,lon\n"Reykjavik, Iceland",64.1466,-21.9426';
    const r = parseTargetCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]!.name).toBe('Reykjavik, Iceland');
  });

  it('parses a quoted name with escaped embedded double-quote ("")', () => {
    const csv = 'name,lat,lon\n"Anil ""the legend"" HQ",37.0,-122.0';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]!.name).toBe('Anil "the legend" HQ');
  });

  it('parses an embedded newline inside a quoted field (line number is row START)', () => {
    const csv = 'name,lat,lon\n"Multi\nLine Name",10,20\nNext,1,2';
    const r = parseTargetCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.valid).toHaveLength(2);
    expect(r.valid[0]!.name).toBe('Multi\nLine Name');
    expect(r.valid[0]!.line).toBe(2);
    // Second row started on line 4 (header=1, multi-line row spans 2+3,
    // so "Next" is line 4).
    expect(r.valid[1]!.line).toBe(4);
  });

  it('treats quote in middle of unquoted field as literal char (does not crash)', () => {
    const csv = 'name,lat,lon\nfoo"bar,0,0';
    const r = parseTargetCsv(csv);
    // Either valid (name="foo\"bar") or rejected — we don't crash.
    expect(r.topLevelError).toBeUndefined();
    expect(r.valid.length + r.errors.length).toBe(1);
  });
});

describe('parseTargetCsv — per-row validation', () => {
  it('flags lat out of range with code lat_out_of_range and the original line number', () => {
    const csv = 'name,lat,lon\nBad,99,0\nGood,0,0';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 2, code: 'lat_out_of_range' });
    expect(r.errors[0]!.raw).toBe('Bad,99,0');
  });

  it('flags lon out of range', () => {
    const csv = 'name,lat,lon\nBad,0,999';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('lon_out_of_range');
  });

  it('flags empty name', () => {
    const csv = 'name,lat,lon\n,12,34';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('name_empty');
  });

  it('flags non-numeric lat', () => {
    const csv = 'name,lat,lon\nBad,not-a-number,0';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('lat_must_be_finite_number');
  });

  it('flags empty lat field', () => {
    const csv = 'name,lat,lon\nBad,,0';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('lat_must_be_finite_number');
  });

  it('flags empty lon field', () => {
    const csv = 'name,lat,lon\nBad,0,';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('lon_must_be_finite_number');
  });

  it('flags priority out of range', () => {
    const csv = 'name,lat,lon,priority\nBad,0,0,99';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('priority_out_of_range');
  });

  it('flags non-integer priority', () => {
    const csv = 'name,lat,lon,priority\nBad,0,0,3.5';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('priority_must_be_integer');
  });

  it('flags row with wrong column count (too few)', () => {
    const csv = 'name,lat,lon\nBad,42';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('wrong_column_count');
  });

  it('flags row with wrong column count (too many)', () => {
    const csv = 'name,lat,lon\nBad,0,0,extra,fields';
    const r = parseTargetCsv(csv);
    expect(r.errors[0]!.code).toBe('wrong_column_count');
  });

  it('returns multiple errors with separate line numbers preserved', () => {
    const csv = [
      'name,lat,lon',
      'Bad1,99,0',       // line 2: lat
      'Good,0,0',        // line 3: valid
      'Bad2,0,999',      // line 4: lon
      ',1,2',            // line 5: empty name
    ].join('\n');
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]!.line).toBe(3);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.map((e) => e.line)).toEqual([2, 4, 5]);
    expect(r.errors.map((e) => e.code)).toEqual([
      'lat_out_of_range',
      'lon_out_of_range',
      'name_empty',
    ]);
  });
});

describe('parseTargetCsv — top-level errors', () => {
  it('rejects when there is no header row (first line is data)', () => {
    const csv = 'Boston,42,-71';
    const r = parseTargetCsv(csv);
    expect(r.topLevelError).toEqual({ code: 'invalid_header' });
    expect(r.valid).toEqual([]);
  });

  it('rejects header with wrong column order', () => {
    const csv = 'lat,lon,name\n42,-71,Boston';
    const r = parseTargetCsv(csv);
    expect(r.topLevelError).toEqual({ code: 'invalid_header' });
  });

  it('rejects header with unknown column', () => {
    const csv = 'name,latitude,longitude\nBoston,42,-71';
    const r = parseTargetCsv(csv);
    expect(r.topLevelError).toEqual({ code: 'invalid_header' });
  });

  it('rejects when first row has too few header columns', () => {
    const csv = 'name,lat\nBoston,42';
    const r = parseTargetCsv(csv);
    expect(r.topLevelError).toEqual({ code: 'invalid_header' });
  });
});

describe('parseTargetCsv — edge cases', () => {
  it('empty input returns empty result with no error', () => {
    const r = parseTargetCsv('');
    expect(r.topLevelError).toBeUndefined();
    expect(r.valid).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('whitespace-only input returns empty result with no error', () => {
    const r = parseTargetCsv('   \n  \n\t\t  \n');
    expect(r.topLevelError).toBeUndefined();
    expect(r.valid).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('skips blank lines between rows', () => {
    const csv = 'name,lat,lon\n\nFoo,1,2\n\n\nBar,3,4\n';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(2);
    expect(r.valid.map((v) => v.name)).toEqual(['Foo', 'Bar']);
  });

  it('skips lines starting with # (comment lines)', () => {
    const csv = '# top comment\nname,lat,lon\n# inline note\nFoo,1,2\n# trailing';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]!.name).toBe('Foo');
  });

  it('tolerates a trailing newline', () => {
    const csv = 'name,lat,lon\nFoo,1,2\n';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(1);
  });

  it('tolerates multiple trailing newlines', () => {
    const csv = 'name,lat,lon\nFoo,1,2\n\n\n';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    const csv = 'name,lat,lon\r\nFoo,1,2\r\nBar,3,4\r\n';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(2);
    expect(r.valid.map((v) => v.name)).toEqual(['Foo', 'Bar']);
  });

  it('handles mixed CRLF + LF line endings in one file', () => {
    const csv = 'name,lat,lon\nFoo,1,2\r\nBar,3,4';
    const r = parseTargetCsv(csv);
    expect(r.valid).toHaveLength(2);
  });

  it('rejects tab-separated input (header parses to one giant column)', () => {
    const csv = 'name\tlat\tlon\nFoo\t1\t2';
    const r = parseTargetCsv(csv);
    expect(r.topLevelError).toEqual({ code: 'invalid_header' });
  });

  it('preserves the raw line content in error rows (for operator triage)', () => {
    const csv = 'name,lat,lon\n  Bad row content  ,abc,def';
    const r = parseTargetCsv(csv);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.raw).toContain('Bad row content');
  });
});
