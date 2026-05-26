/** CSV → personal-target parser — Slot 9 of design rev 2 (2026-05-26).
 *
 *  Operators paste a spreadsheet's worth of targets at once instead of
 *  clicking "Add" 30 times in the Profile tab. The parser is pure (no DOM,
 *  no localStorage, no async) so it can be unit-tested at the byte level
 *  and reused as a library by future bulk-import flows.
 *
 *  ---------------------------------------------------------------------------
 *  CSV format spec (the parser is the source of truth — keep this in sync)
 *  ---------------------------------------------------------------------------
 *
 *  Header row REQUIRED. First non-blank, non-comment row must be one of:
 *      name,lat,lon
 *      name,lat,lon,priority
 *  Column order is fixed (no header reshuffle support — operators can
 *  re-export from Excel if their columns are out of order).
 *
 *  Body rows:
 *      Boston Aerial,42.3601,-71.0589,8
 *      Mt Etna Volcano,37.7510,14.9934,7
 *      Lago di Como,46.0,9.25
 *
 *  - Priority column is OPTIONAL on a per-row basis. Omit it (or leave it
 *    empty) and the parser defaults to 5 — matches the slot 6 add form's
 *    default. If the header omits priority, every row defaults to 5.
 *  - Names containing commas MUST be double-quoted:
 *      "Reykjavik, Iceland",64.1466,-21.9426
 *  - Embedded double quote inside a quoted name escapes as "" (CSV-RFC4180):
 *      "Anil ""the legend"" Samoilenko HQ",37.0,-122.0
 *  - Embedded newlines inside quoted fields ARE supported. The line-number
 *    reported on error is the line where the row STARTED (most useful for
 *    operator triage).
 *  - Blank lines are skipped silently (use them as separators).
 *  - Lines starting with `#` are treated as comments and skipped.
 *  - Trailing newline is tolerated (one or many).
 *  - Line endings: LF and CRLF both work; CR-only is treated as a single
 *    line ending too (defensive — Excel for Mac is known to emit it).
 *  - Tab-separated values are NOT supported. Comma only.
 *  - id and createdAt columns are NOT accepted — those are minted by the
 *    importer via makePersonalTargetId + new Date().toISOString(). An
 *    operator's CSV from Excel won't have them.
 *  ---------------------------------------------------------------------------
 */

import { validatePersonalTargetInput } from './profile';

/** A row that parsed AND passed validatePersonalTargetInput. Carries the
 *  raw operator input so the caller can mint id + createdAt themselves
 *  (we don't bake those into the parser — keeps it pure-ish + lets the
 *  caller batch makePersonalTargetId with one stamp of new Date()). */
export interface ParsedValidRow {
  /** Original 1-based line number in the input (header is line 1). Used
   *  by the preview UI so the operator can hunt the row in their CSV. */
  line: number;
  name: string;
  lat: number;
  lon: number;
  priority: number;
}

/** A row that failed parsing OR validation. `code` matches the worker /
 *  slot 6 validation surface where possible (lat_out_of_range,
 *  lon_out_of_range, name_empty, ...) so the UI can show the same
 *  message strings it already shows for the add form. */
export interface ParsedErrorRow {
  line: number;
  /** Original line content (UNESCAPED — operator sees what they pasted). */
  raw: string;
  /** Machine-readable error code. UI maps to a human message. */
  code: string;
}

/** Top-level errors (header missing, header wrong) — distinct from per-row
 *  errors because they invalidate the whole input, not just one row. */
export interface ParsedTopLevelError {
  code: string;
}

export interface ParseTargetCsvResult {
  /** Per-row outcomes for rows that parsed AND validated successfully. */
  valid: ParsedValidRow[];
  /** Per-row outcomes for rows that parsed but failed validation, or that
   *  had structural problems (wrong column count, malformed quoting). */
  errors: ParsedErrorRow[];
  /** Whole-input error. When present, `valid` and `errors` are empty —
   *  the operator needs to fix the header before any row can be parsed. */
  topLevelError?: ParsedTopLevelError;
}

/** Tokenize one CSV row from a position into the source. Returns the
 *  parsed fields + the new cursor position (just past the row terminator,
 *  or at EOF). Handles double-quoted fields with embedded commas, escaped
 *  double-quotes ("") and embedded newlines.
 *
 *  The tokenizer doesn't own a line counter — the caller maps byte
 *  positions to lines via `lineNumberAt` so embedded newlines inside
 *  quoted fields stay correct. */
function tokenizeRow(src: string, start: number): { fields: string[]; next: number } {
  const fields: string[] = [];
  let field = '';
  let i = start;
  let inQuotes = false;

  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        // Lookahead for "" escape
        if (i + 1 < src.length && src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    // Not in quotes
    if (ch === '"') {
      // Quote at start of field begins a quoted field. Mid-field quote
      // is treated as a literal char (lenient — operators paste weird
      // stuff; surface as a per-row validation error rather than throw).
      if (field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      fields.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      // Row terminator. Consume \r\n as a single terminator.
      const consumed = (ch === '\r' && src[i + 1] === '\n') ? 2 : 1;
      fields.push(field);
      return { fields, next: i + consumed };
    }
    field += ch;
    i += 1;
  }
  // EOF terminates the row.
  fields.push(field);
  return { fields, next: i };
}

/** Count the line breaks in `src[0..pos]`. CRLF and LF both count as one. */
function lineNumberAt(src: string, pos: number): number {
  let line = 1;
  let i = 0;
  while (i < pos && i < src.length) {
    const ch = src[i]!;
    if (ch === '\r') {
      line += 1;
      if (src[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return line;
}

/** Skip blank lines + comment lines starting at `pos`. Returns the new
 *  cursor position. Used between row reads so the operator's blank
 *  separators + `#` headers don't generate empty error rows. */
function skipBlankAndComment(src: string, pos: number): number {
  let i = pos;
  while (i < src.length) {
    // Peek at the start of the line.
    const start = i;
    // Walk to next LF / CR / EOF without consuming
    let j = i;
    while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j += 1;
    const line = src.slice(start, j);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      // Consume the terminator (CRLF or LF or CR)
      if (j >= src.length) return j;
      if (src[j] === '\r' && src[j + 1] === '\n') i = j + 2;
      else i = j + 1;
      continue;
    }
    return start;
  }
  return i;
}

/** Parse the CSV body. Header row determines the priority column slot;
 *  body rows are mapped to PersonalTargetInput-shaped objects and run
 *  through validatePersonalTargetInput row-by-row.
 *
 *  Returns a result with `valid`, `errors`, and optionally `topLevelError`
 *  when the header is missing or malformed. */
export function parseTargetCsv(text: string): ParseTargetCsvResult {
  const result: ParseTargetCsvResult = { valid: [], errors: [] };
  // Empty input is a no-op (not an error — the UI shows "fix and re-paste"
  // anyway, and an empty paste is a common harmless event).
  if (!text || text.trim() === '') return result;

  let pos = skipBlankAndComment(text, 0);
  if (pos >= text.length) return result;

  // Read header row
  const headerToken = tokenizeRow(text, pos);
  pos = headerToken.next;
  const headerFields = headerToken.fields.map((s) => s.trim().toLowerCase());

  // Validate header shape. Accept exactly:
  //   ["name","lat","lon"]    → priority defaults
  //   ["name","lat","lon","priority"]
  let hasPriorityCol = false;
  if (headerFields.length === 3
      && headerFields[0] === 'name'
      && headerFields[1] === 'lat'
      && headerFields[2] === 'lon') {
    hasPriorityCol = false;
  } else if (headerFields.length === 4
      && headerFields[0] === 'name'
      && headerFields[1] === 'lat'
      && headerFields[2] === 'lon'
      && headerFields[3] === 'priority') {
    hasPriorityCol = true;
  } else {
    return {
      valid: [],
      errors: [],
      topLevelError: { code: 'invalid_header' },
    };
  }

  // Walk body rows
  while (pos < text.length) {
    pos = skipBlankAndComment(text, pos);
    if (pos >= text.length) break;
    const rowStartByte = pos;
    const rowLine = lineNumberAt(text, rowStartByte);
    const token = tokenizeRow(text, pos);
    pos = token.next;
    const rowFields = token.fields;

    // Reconstruct the operator's raw line for the error preview. The
    // tokenizer's `next` cursor sits just past the row terminator (1 or
    // 2 bytes). Slice the raw range and strip trailing CR/LF.
    const raw = text.slice(rowStartByte, token.next).replace(/[\r\n]+$/, '');

    // Column count check
    if (hasPriorityCol) {
      // 3 or 4 fields allowed (priority optional even when header has it)
      if (rowFields.length !== 3 && rowFields.length !== 4) {
        result.errors.push({ line: rowLine, raw, code: 'wrong_column_count' });
        continue;
      }
    } else {
      if (rowFields.length !== 3) {
        result.errors.push({ line: rowLine, raw, code: 'wrong_column_count' });
        continue;
      }
    }

    const nameRaw = rowFields[0] ?? '';
    const latRaw = (rowFields[1] ?? '').trim();
    const lonRaw = (rowFields[2] ?? '').trim();
    const prioRaw = hasPriorityCol ? ((rowFields[3] ?? '').trim()) : '';

    // Numeric coercion BEFORE validate so the "must be a number" errors
    // map to the worker's `*_must_be_finite_number` codes.
    if (latRaw === '') {
      result.errors.push({ line: rowLine, raw, code: 'lat_must_be_finite_number' });
      continue;
    }
    if (lonRaw === '') {
      result.errors.push({ line: rowLine, raw, code: 'lon_must_be_finite_number' });
      continue;
    }
    const lat = Number(latRaw);
    const lon = Number(lonRaw);

    let priority: number | undefined = undefined;
    if (hasPriorityCol && prioRaw !== '') {
      priority = Number(prioRaw);
      if (!Number.isFinite(priority)) {
        result.errors.push({ line: rowLine, raw, code: 'priority_must_be_integer' });
        continue;
      }
    }

    // Use the slot 6 validator — single source of truth. We pass a
    // throwaway profile name 'csv-import' because the parser doesn't know
    // the operator's active profile; the caller re-validates with the
    // real profile name before POST. (We don't trust this name; we just
    // need a valid-looking one so the profile-name check passes.)
    const validated = validatePersonalTargetInput({
      profileName: 'csv-import',
      name: nameRaw,
      lat,
      lon,
      priority,
    });
    if (!validated.ok) {
      result.errors.push({ line: rowLine, raw, code: validated.error });
      continue;
    }

    result.valid.push({
      line: rowLine,
      name: validated.target.name,
      lat: validated.target.lat,
      lon: validated.target.lon,
      priority: validated.target.priority,
    });
  }

  return result;
}
