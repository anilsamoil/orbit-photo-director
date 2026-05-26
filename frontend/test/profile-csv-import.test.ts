/** Slot 9 — CSV import UI integration tests.
 *
 *  Covers the bulk-import flow end-to-end:
 *    - buildCsvImportSection renders the file picker + paste textarea + buttons
 *    - Preview button parses + shows "N valid, M errors"
 *    - Import button is disabled when no rows are valid
 *    - On Import: optimistic local save + parallel POSTs
 *    - Per-row failure: failed rows roll back, successful rows persist
 *    - Operator-controlled raw error strings escape via textContent
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultProfile,
  loadProfile,
  saveProfile,
  addPersonalTargetsBatch,
  type PersonalTarget,
} from '../src/profile';
import {
  _test,
  buildCrudSection,
  buildCsvImportSection,
} from '../src/profile-crud';

const PROFILE = 'jack';
const TOKEN_KEY = 'opd-calib-token';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'test-token');
  document.body.innerHTML = `
    <div id="toast" hidden></div>
    <main>
      <section id="profile-pane">
        <div id="profile-body"></div>
      </section>
    </main>
  `;
  saveProfile(createDefaultProfile(PROFILE));
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function mountCrud(name: string): HTMLElement {
  const body = document.getElementById('profile-body')!;
  body.replaceChildren();
  const section = buildCrudSection(name);
  body.appendChild(section);
  return section;
}

// ---------------------------------------------------------------------------
// addPersonalTargetsBatch (pure helper)
// ---------------------------------------------------------------------------

describe('addPersonalTargetsBatch', () => {
  it('appends multiple targets and returns a new profile', () => {
    const before = createDefaultProfile(PROFILE);
    const ts: PersonalTarget[] = [
      { id: 'personal:jack:a', name: 'A', lat: 0, lon: 0, priority: 5, createdAt: '2026-05-26T12:00:00Z' },
      { id: 'personal:jack:b', name: 'B', lat: 1, lon: 1, priority: 5, createdAt: '2026-05-26T12:00:00Z' },
    ];
    const after = addPersonalTargetsBatch(before, ts);
    expect(after).not.toBe(before);
    expect(after.additions).toHaveLength(2);
  });

  it('rejects duplicate id within the batch', () => {
    const before = createDefaultProfile(PROFILE);
    const dup: PersonalTarget[] = [
      { id: 'personal:jack:a', name: 'A', lat: 0, lon: 0, priority: 5, createdAt: '2026-05-26T12:00:00Z' },
      { id: 'personal:jack:a', name: 'B', lat: 1, lon: 1, priority: 5, createdAt: '2026-05-26T12:00:00Z' },
    ];
    expect(() => addPersonalTargetsBatch(before, dup)).toThrow(/duplicate/);
  });

  it('rejects duplicate id against existing additions', () => {
    let before = createDefaultProfile(PROFILE);
    before = addPersonalTargetsBatch(before, [
      { id: 'personal:jack:a', name: 'A', lat: 0, lon: 0, priority: 5, createdAt: '2026-05-26T12:00:00Z' },
    ]);
    expect(() => addPersonalTargetsBatch(before, [
      { id: 'personal:jack:a', name: 'dup', lat: 1, lon: 1, priority: 5, createdAt: '2026-05-26T12:00:00Z' },
    ])).toThrow(/duplicate/);
  });

  it('returns the same reference (no-op) for an empty batch', () => {
    const before = createDefaultProfile(PROFILE);
    const after = addPersonalTargetsBatch(before, []);
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// DOM rendering — the section + preview
// ---------------------------------------------------------------------------

describe('buildCsvImportSection DOM', () => {
  it('renders file input + paste textarea + Preview / Import / Cancel buttons', () => {
    const section = buildCsvImportSection(PROFILE);
    document.body.appendChild(section);
    expect(section.querySelector('#profile-csv-file')).not.toBeNull();
    expect(section.querySelector('#profile-csv-paste')).not.toBeNull();
    expect(section.querySelector('#profile-csv-preview-btn')).not.toBeNull();
    const importBtn = section.querySelector('#profile-csv-import-btn') as HTMLButtonElement;
    const cancelBtn = section.querySelector('#profile-csv-cancel-btn') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);
  });

  it('Preview parses textarea and shows "N valid, M errors"', () => {
    const section = mountCrud(PROFILE);
    const ta = section.querySelector('#profile-csv-paste') as HTMLTextAreaElement;
    ta.value = [
      'name,lat,lon,priority',
      'Boston,42.36,-71.06,8',
      'Bad,999,0,5',
      'Etna,37.75,14.99,7',
    ].join('\n');
    (section.querySelector('#profile-csv-preview-btn') as HTMLButtonElement).click();
    const summary = section.querySelector('.profile-csv-summary');
    expect(summary?.textContent).toBe('2 valid, 1 errors');
    const importBtn = section.querySelector('#profile-csv-import-btn') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(false);
    expect(importBtn.textContent).toBe('Import 2 valid');
  });

  it('Preview shows top-level error when header is missing', () => {
    const section = mountCrud(PROFILE);
    const ta = section.querySelector('#profile-csv-paste') as HTMLTextAreaElement;
    ta.value = 'Boston,42,-71';
    (section.querySelector('#profile-csv-preview-btn') as HTMLButtonElement).click();
    const err = section.querySelector('.profile-csv-preview .profile-error');
    expect(err?.textContent).toMatch(/header row/i);
    const importBtn = section.querySelector('#profile-csv-import-btn') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
  });

  it('Import button stays disabled when no rows are valid', () => {
    const section = mountCrud(PROFILE);
    const ta = section.querySelector('#profile-csv-paste') as HTMLTextAreaElement;
    ta.value = 'name,lat,lon\nBad,999,999';
    (section.querySelector('#profile-csv-preview-btn') as HTMLButtonElement).click();
    const importBtn = section.querySelector('#profile-csv-import-btn') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    const hint = section.querySelector('.profile-csv-preview .profile-error');
    expect(hint?.textContent).toMatch(/re-paste/i);
  });

  it('error rows render with line number, code message, and raw content', () => {
    const section = mountCrud(PROFILE);
    const ta = section.querySelector('#profile-csv-paste') as HTMLTextAreaElement;
    ta.value = 'name,lat,lon\nBad,999,0';
    (section.querySelector('#profile-csv-preview-btn') as HTMLButtonElement).click();
    const errRow = section.querySelector('.profile-csv-error-row');
    expect(errRow).not.toBeNull();
    expect(errRow!.textContent).toContain('Line 2');
    expect(errRow!.textContent).toContain('Latitude must be between -90 and 90');
    expect(errRow!.querySelector('.profile-csv-error-raw')?.textContent).toBe('Bad,999,0');
  });

  it('escapes operator-controlled raw row content via textContent (no innerHTML)', () => {
    const section = mountCrud(PROFILE);
    const ta = section.querySelector('#profile-csv-paste') as HTMLTextAreaElement;
    ta.value = 'name,lat,lon\n<script>alert(1)</script>,999,0';
    (section.querySelector('#profile-csv-preview-btn') as HTMLButtonElement).click();
    const raw = section.querySelector('.profile-csv-error-raw') as HTMLElement;
    expect(raw.textContent).toContain('<script>alert(1)</script>');
    // No script element actually injected
    expect(section.querySelector('.profile-csv-preview script')).toBeNull();
  });

  it('Cancel resets the preview and re-disables Import', () => {
    const section = mountCrud(PROFILE);
    const ta = section.querySelector('#profile-csv-paste') as HTMLTextAreaElement;
    ta.value = 'name,lat,lon\nFoo,1,2';
    (section.querySelector('#profile-csv-preview-btn') as HTMLButtonElement).click();
    expect((section.querySelector('#profile-csv-import-btn') as HTMLButtonElement).disabled).toBe(false);
    (section.querySelector('#profile-csv-cancel-btn') as HTMLButtonElement).click();
    expect((section.querySelector('#profile-csv-import-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(section.querySelector('.profile-csv-summary')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleCsvImport — bulk POST + per-row rollback
// ---------------------------------------------------------------------------

describe('handleCsvImport (bulk POST)', () => {
  it('fires one POST per valid row and persists all on success', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const valid = [
      { line: 2, name: 'Boston', lat: 42.36, lon: -71.06, priority: 8 },
      { line: 3, name: 'Etna', lat: 37.75, lon: 14.99, priority: 7 },
      { line: 4, name: 'Como', lat: 46.0, lon: 9.25, priority: 5 },
    ];
    await _test.handleCsvImport(PROFILE, valid);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(3);
    expect(after.additions.map((t) => t.name)).toEqual(['Boston', 'Etna', 'Como']);
  });

  it('rolls back ONLY the failed rows when one of N posts fails', async () => {
    // Mock: first call → 200, second call → 503, third call → 200.
    let callIndex = 0;
    const fetchMock = vi.fn(async () => {
      const idx = callIndex++;
      if (idx === 1) {
        return new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const valid = [
      { line: 2, name: 'GoodOne', lat: 1, lon: 1, priority: 5 },
      { line: 3, name: 'BadOne', lat: 2, lon: 2, priority: 5 },
      { line: 4, name: 'GoodTwo', lat: 3, lon: 3, priority: 5 },
    ];
    await _test.handleCsvImport(PROFILE, valid);

    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(2);
    const names = after.additions.map((t) => t.name);
    expect(names).toContain('GoodOne');
    expect(names).toContain('GoodTwo');
    expect(names).not.toContain('BadOne');
  });

  it('rolls back all rows when every POST fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 }),
    ));
    const valid = [
      { line: 2, name: 'A', lat: 1, lon: 1, priority: 5 },
      { line: 3, name: 'B', lat: 2, lon: 2, priority: 5 },
    ];
    await _test.handleCsvImport(PROFILE, valid);
    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(0);
  });

  it('persists locally BEFORE the API calls settle (optimistic)', async () => {
    let resolveFirstFetch: (r: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => { resolveFirstFetch = resolve; });
    // First call blocks; subsequent calls succeed immediately.
    let callIndex = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      const idx = callIndex++;
      if (idx === 0) return pending;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 }));
    }));

    const valid = [
      { line: 2, name: 'A', lat: 1, lon: 1, priority: 5 },
      { line: 3, name: 'B', lat: 2, lon: 2, priority: 5 },
    ];
    const promise = _test.handleCsvImport(PROFILE, valid);
    // Microtask flush so the synchronous saveProfile + rerender ran.
    await Promise.resolve();
    const mid = loadProfile(PROFILE)!;
    expect(mid.additions).toHaveLength(2);

    resolveFirstFetch(new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 }));
    await promise;
    expect(loadProfile(PROFILE)!.additions).toHaveLength(2);
  });

  it('records partial success on mixed network + ok responses', async () => {
    let callIndex = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const idx = callIndex++;
      if (idx === 0) throw new TypeError('offline');
      return new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 });
    }));

    const valid = [
      { line: 2, name: 'Doomed', lat: 1, lon: 1, priority: 5 },
      { line: 3, name: 'Saved', lat: 2, lon: 2, priority: 5 },
    ];
    await _test.handleCsvImport(PROFILE, valid);
    const after = loadProfile(PROFILE)!;
    expect(after.additions.map((t) => t.name)).toEqual(['Saved']);
  });

  it('handles a single-row import (no batching edge cases)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 }),
    ));
    await _test.handleCsvImport(PROFILE, [
      { line: 2, name: 'Solo', lat: 1, lon: 1, priority: 5 },
    ]);
    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(1);
    expect(after.additions[0]!.name).toBe('Solo');
  });
});
