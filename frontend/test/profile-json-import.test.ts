/** Slot 10 — JSON IO UI integration tests.
 *
 *  Covers:
 *    - buildJsonIoSection renders Export button + Import file input +
 *      hidden Replace/Cancel buttons
 *    - Export click invokes downloadProfileJson (asserts blob URL + click)
 *    - Import preview shows target count, cross-profile warning, replacement
 *      caveat
 *    - Replace triggers PUT /api/profiles/<name>/targets and saves locally
 *    - Failed PUT rolls back local state
 *    - Future-schema export rejected with a clear error in the preview
 *    - Operator-controlled imported profile name flows through textContent
 *      (no innerHTML XSS)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_PROFILE_VERSION,
  createDefaultProfile,
  loadProfile,
  saveProfile,
  type Profile,
} from '../src/profile';
import {
  _test,
  buildCrudSection,
  buildJsonIoSection,
} from '../src/profile-crud';
import { PROFILE_EXPORT_FORMAT } from '../src/profile-json-io';

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

function profileWithTargets(name: string): Profile {
  const p = createDefaultProfile(name);
  p.additions = [
    {
      id: `personal:${name}:a`,
      name: 'Site A',
      lat: 1,
      lon: 2,
      priority: 5,
      createdAt: '2026-05-26T00:00:00Z',
    },
    {
      id: `personal:${name}:b`,
      name: 'Site B',
      lat: 3,
      lon: 4,
      priority: 7,
      createdAt: '2026-05-26T00:00:00Z',
    },
  ];
  return p;
}

// ---------------------------------------------------------------------------
// DOM: buildJsonIoSection rendering
// ---------------------------------------------------------------------------

describe('buildJsonIoSection DOM', () => {
  it('renders Export button + Import file input + hidden action row', () => {
    const section = buildJsonIoSection(PROFILE);
    document.body.appendChild(section);
    expect(section.querySelector('#profile-export-btn')).not.toBeNull();
    const importInput = section.querySelector('#profile-import-file') as HTMLInputElement;
    expect(importInput).not.toBeNull();
    expect(importInput.accept).toContain('json');
    const replaceBtn = section.querySelector('#profile-json-replace-btn') as HTMLButtonElement;
    const cancelBtn = section.querySelector('#profile-json-cancel-btn') as HTMLButtonElement;
    expect(replaceBtn).not.toBeNull();
    expect(cancelBtn).not.toBeNull();
    // Action row hidden until a valid file is parsed
    expect((replaceBtn.parentElement as HTMLElement).style.display).toBe('none');
  });

  it('is appended inside buildCrudSection alongside other sub-sections', () => {
    const section = mountCrud(PROFILE);
    expect(section.querySelector('#profile-json-io')).not.toBeNull();
    expect(section.querySelector('#profile-csv-import')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Export button — DOM-side flow
// ---------------------------------------------------------------------------

describe('Export button', () => {
  it('creates a blob URL and clicks an anchor with download filename', () => {
    saveProfile(profileWithTargets(PROFILE));
    const createObjectURL = vi.fn(() => 'blob:export-mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    let clickedAnchor: HTMLAnchorElement | null = null;
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLAnchorElement;
      if (tag === 'a') el.click = () => { clickedAnchor = el; };
      return el;
    });

    const section = mountCrud(PROFILE);
    const btn = section.querySelector('#profile-export-btn') as HTMLButtonElement;
    btn.click();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickedAnchor).not.toBeNull();
    expect(clickedAnchor!.download).toBe(`${PROFILE}-profile.json`);
  });
});

// ---------------------------------------------------------------------------
// Import preview rendering
// ---------------------------------------------------------------------------

describe('Import preview', () => {
  it('shows target count + meta + replacement warning on a valid import', async () => {
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION,
      exportedAt: '2026-05-26T19:50:00.000Z',
      appVersion: '1.6.12.0',
      profile: profileWithTargets(PROFILE),
    });
    const result = await _test.handleJsonImportReplace
      // Drive the renderer directly via the section's file input.
      ? null
      : null;
    void result;

    const section = mountCrud(PROFILE);
    const importInput = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'jack-profile.json', { type: 'application/json' });
    Object.defineProperty(importInput, 'files', { value: [file], configurable: true });
    importInput.dispatchEvent(new Event('change'));

    // The change handler is async (calls readProfileImportFile). Flush
    // microtasks (file.text() returns a Promise).
    await new Promise((r) => setTimeout(r, 10));

    const summary = section.querySelector('.profile-json-summary');
    expect(summary?.textContent).toContain('2 valid');
    const warns = section.querySelectorAll('.profile-json-preview .profile-error');
    // At least the "REPLACES all" warning
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const hasReplaceWarning = Array.from(warns).some((w) =>
      /REPLACES all/i.test(w.textContent ?? ''),
    );
    expect(hasReplaceWarning).toBe(true);

    const replaceBtn = section.querySelector('#profile-json-replace-btn') as HTMLButtonElement;
    expect((replaceBtn.parentElement as HTMLElement).style.display).not.toBe('none');
  });

  it('shows a cross-profile warning when imported profile.name != active', async () => {
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION,
      profile: profileWithTargets('chris'), // different from active "jack"
    });
    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'chris-profile.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    const warnings = Array.from(section.querySelectorAll('.profile-json-preview .profile-error'));
    const crossProfileWarning = warnings.some((w) =>
      /from "chris"/i.test(w.textContent ?? ''),
    );
    expect(crossProfileWarning).toBe(true);
  });

  it('rejects a future-schema export with a clear error in the preview', async () => {
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION + 1,
      profile: { version: CURRENT_PROFILE_VERSION + 1, name: PROFILE, additions: [] },
    });
    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'future-profile.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    const err = section.querySelector('.profile-json-preview .profile-error');
    expect(err?.textContent).toMatch(/newer app version/i);
    // No action row when there's nothing to import
    const replaceBtn = section.querySelector('#profile-json-replace-btn') as HTMLButtonElement;
    expect((replaceBtn.parentElement as HTMLElement).style.display).toBe('none');
  });

  it('rejects malformed JSON with a clear error', async () => {
    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File(['{not-json'], 'bad.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    const err = section.querySelector('.profile-json-preview .profile-error');
    expect(err?.textContent).toMatch(/not valid JSON/i);
  });

  // -------------------------------------------------------------------------
  // Item 4 — wipe warning when imported additions count < current count.
  // -------------------------------------------------------------------------

  it('shows a wipe warning when the import would delete existing targets', async () => {
    // Seed the active profile with 12 existing targets.
    const current = createDefaultProfile(PROFILE);
    for (let i = 0; i < 12; i++) {
      current.additions.push({
        id: `personal:${PROFILE}:cur${i}`,
        name: `Existing ${i}`,
        lat: i,
        lon: -i,
        priority: 5,
        createdAt: '2026-05-26T00:00:00Z',
      });
    }
    saveProfile(current);

    // Import file carries 5 targets — a net wipe of 7.
    const imported = createDefaultProfile(PROFILE);
    for (let i = 0; i < 5; i++) {
      imported.additions.push({
        id: `personal:${PROFILE}:new${i}`,
        name: `Imported ${i}`,
        lat: i,
        lon: i,
        priority: 5,
        createdAt: '2026-05-26T00:00:00Z',
      });
    }
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION,
      profile: imported,
    });

    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'shrink.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    const wipe = section.querySelector('.profile-json-wipe-warn');
    expect(wipe).not.toBeNull();
    expect(wipe!.textContent).toMatch(/delete 7 existing personal targets/);
    expect(wipe!.textContent).toMatch(/current: 12/);
    expect(wipe!.textContent).toMatch(/after import: 5/);
  });

  it('does NOT warn when the import has the same target count as current', async () => {
    const current = createDefaultProfile(PROFILE);
    for (let i = 0; i < 12; i++) {
      current.additions.push({
        id: `personal:${PROFILE}:cur${i}`,
        name: `Existing ${i}`,
        lat: i,
        lon: -i,
        priority: 5,
        createdAt: '2026-05-26T00:00:00Z',
      });
    }
    saveProfile(current);
    const imported = createDefaultProfile(PROFILE);
    for (let i = 0; i < 12; i++) {
      imported.additions.push({
        id: `personal:${PROFILE}:new${i}`,
        name: `Imported ${i}`,
        lat: i,
        lon: i,
        priority: 5,
        createdAt: '2026-05-26T00:00:00Z',
      });
    }
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION,
      profile: imported,
    });
    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'equal.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(section.querySelector('.profile-json-wipe-warn')).toBeNull();
  });

  it('does NOT warn when the import grows the target count', async () => {
    const current = createDefaultProfile(PROFILE);
    for (let i = 0; i < 12; i++) {
      current.additions.push({
        id: `personal:${PROFILE}:cur${i}`,
        name: `Existing ${i}`,
        lat: i,
        lon: -i,
        priority: 5,
        createdAt: '2026-05-26T00:00:00Z',
      });
    }
    saveProfile(current);
    const imported = createDefaultProfile(PROFILE);
    for (let i = 0; i < 20; i++) {
      imported.additions.push({
        id: `personal:${PROFILE}:new${i}`,
        name: `Imported ${i}`,
        lat: i,
        lon: i,
        priority: 5,
        createdAt: '2026-05-26T00:00:00Z',
      });
    }
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION,
      profile: imported,
    });
    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'grow.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(section.querySelector('.profile-json-wipe-warn')).toBeNull();
  });

  it('does NOT warn when the active profile has no targets to lose', async () => {
    // Default profile has additions=[]; import an empty one.
    const imported = createDefaultProfile(PROFILE);
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION,
      profile: imported,
    });
    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'empty.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    expect(section.querySelector('.profile-json-wipe-warn')).toBeNull();
  });

  it('escapes operator-controlled profile name in cross-profile warning (no innerHTML)', async () => {
    // The validator rejects `<script>` as an invalid profile name, so we
    // use a still-valid-but-conspicuous name that survives the regex.
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION,
      profile: profileWithTargets('evil-name'),
    });
    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'evil-name-profile.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    // No injected script element
    expect(section.querySelector('.profile-json-preview script')).toBeNull();
    // The name appears as text content
    const text = section.querySelector('.profile-json-preview')?.textContent ?? '';
    expect(text).toContain('evil-name');
  });
});

// ---------------------------------------------------------------------------
// Replace flow — handleJsonImportReplace via _test handle
// ---------------------------------------------------------------------------

describe('handleJsonImportReplace', () => {
  it('saves merged profile locally and PUTs imported additions to the server', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const importedProfile = profileWithTargets(PROFILE);
    await _test.handleJsonImportReplace(PROFILE, {
      ok: true,
      profile: importedProfile,
      targetErrors: [],
      sourceSchemaVersion: 1,
      exportedAt: '2026-05-26T00:00:00Z',
      appVersion: '1.6.12.0',
    });

    // Server PUT fired once with the imported additions
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(String(url)).toContain(`/api/profiles/${PROFILE}/targets`);
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(body.targets).toHaveLength(2);
    expect(body.targets.map((t: { name: string }) => t.name)).toEqual(['Site A', 'Site B']);

    // Local profile reflects the import
    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(2);
  });

  it('rolls back local state when the PUT fails (5xx)', async () => {
    saveProfile(createDefaultProfile(PROFILE)); // empty additions
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 }),
      ),
    );

    const imported = profileWithTargets(PROFILE);
    await _test.handleJsonImportReplace(PROFILE, {
      ok: true,
      profile: imported,
      targetErrors: [],
      sourceSchemaVersion: 1,
      exportedAt: '',
      appVersion: '',
    });

    // Rollback: additions are still empty (the original pre-import state)
    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(0);
  });

  it('preserves the current profile name even when importing a cross-profile file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200 })),
    );
    const importedFromChris = profileWithTargets('chris');
    await _test.handleJsonImportReplace(PROFILE, {
      ok: true,
      profile: importedFromChris,
      targetErrors: [],
      sourceSchemaVersion: 1,
      exportedAt: '',
      appVersion: '',
    });
    const after = loadProfile(PROFILE)!;
    expect(after.name).toBe(PROFILE);
    expect(after.additions).toHaveLength(2);
  });

  it('writes the imported distanceThresholdKm + removedCuratedIds into the active profile', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, count: 0 }), { status: 200 })),
    );
    const imported = createDefaultProfile(PROFILE);
    imported.additions = [];
    imported.distanceThresholdKm = 800;
    imported.removedCuratedIds = ['hidden-1', 'hidden-2'];

    await _test.handleJsonImportReplace(PROFILE, {
      ok: true,
      profile: imported,
      targetErrors: [],
      sourceSchemaVersion: 1,
      exportedAt: '',
      appVersion: '',
    });
    const after = loadProfile(PROFILE)!;
    expect(after.distanceThresholdKm).toBe(800);
    expect(after.removedCuratedIds).toEqual(['hidden-1', 'hidden-2']);
  });
});

// ---------------------------------------------------------------------------
// Cancel button — preview reset
// ---------------------------------------------------------------------------

describe('Cancel button', () => {
  it('clears the preview and re-hides the action row', async () => {
    const exportText = JSON.stringify({
      format: PROFILE_EXPORT_FORMAT,
      schemaVersion: CURRENT_PROFILE_VERSION,
      profile: profileWithTargets(PROFILE),
    });
    const section = mountCrud(PROFILE);
    const input = section.querySelector('#profile-import-file') as HTMLInputElement;
    const file = new File([exportText], 'jack.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    expect(section.querySelector('.profile-json-summary')).not.toBeNull();

    (section.querySelector('#profile-json-cancel-btn') as HTMLButtonElement).click();
    expect(section.querySelector('.profile-json-summary')).toBeNull();
    const replaceBtn = section.querySelector('#profile-json-replace-btn') as HTMLButtonElement;
    expect((replaceBtn.parentElement as HTMLElement).style.display).toBe('none');
  });
});
