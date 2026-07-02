/** Jack's edit-a-target flow (2026-06-23).
 *
 *  Covers the inline edit form + the optimistic fresh-GET→apply→PUT pathway:
 *    - optimistic local update lands before the network resolves;
 *    - id + createdAt are preserved, only name/lat/lon/priority change (R3-edit);
 *    - the PUT body is the FRESH server list with the one target swapped, so a
 *      target that exists only on the server is NOT clobbered (R1-edit);
 *    - rollback-all-fields on PUT failure and on "deleted elsewhere" (R2/R5-edit);
 *    - the popup deep-link (openEditTargetForm) opens the form, gated to the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPersonalTarget,
  createDefaultProfile,
  loadProfile,
  makePersonalTargetId,
  saveProfile,
  type PersonalTarget,
} from '../src/profile';
import { _test, buildCrudSection } from '../src/profile-crud';

const PROFILE = 'jack';
const TOKEN_KEY = 'opd-calib-token';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'test-token');
  _test.resetHydrationState();
  document.body.innerHTML = `
    <div id="toast" hidden></div>
    <main><section id="profile-pane"><div id="profile-body"></div></section></main>
  `;
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  _test.resetHydrationState();
});

function makeTarget(overrides: Partial<PersonalTarget> = {}): PersonalTarget {
  return {
    id: overrides.id ?? makePersonalTargetId(PROFILE),
    name: 'Reef',
    lat: 12.5,
    lon: -34.25,
    priority: 5,
    createdAt: '2026-05-26T12:00:00Z',
    ...overrides,
  };
}

function mount(name: string): HTMLElement {
  const body = document.getElementById('profile-body')!;
  body.replaceChildren();
  const section = buildCrudSection(name);
  body.appendChild(section);
  return section;
}

/** Fetch mock that answers GET /targets with `serverTargets`, then PUT with
 *  `putStatus`. Records the PUT body for assertions. */
function mockGetThenPut(serverTargets: PersonalTarget[], putStatus = 200) {
  const putBodies: Array<{ targets: PersonalTarget[] }> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      return new Response(JSON.stringify({ ok: true, targets: serverTargets }), { status: 200 });
    }
    if (method === 'PUT') {
      putBodies.push(JSON.parse(String(init?.body)) as { targets: PersonalTarget[] });
      return new Response(JSON.stringify({ ok: true, count: serverTargets.length }), { status: putStatus });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, putBodies };
}

describe('handleEdit — optimistic fresh-GET → apply → PUT', () => {
  it('updates local immediately, preserving id + createdAt (R3-edit)', async () => {
    const t = makeTarget();
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), t));
    mount(PROFILE);
    mockGetThenPut([t]);

    const edited: PersonalTarget = { ...t, lon: -34.5, name: 'Reef (fixed)' };
    const result = await _test.handleEdit(PROFILE, edited);

    expect(result).toBe('ok');
    const after = loadProfile(PROFILE)!;
    expect(after.additions).toHaveLength(1);
    expect(after.additions[0]!.lon).toBe(-34.5);
    expect(after.additions[0]!.name).toBe('Reef (fixed)');
    expect(after.additions[0]!.id).toBe(t.id); // id untouched
    expect(after.additions[0]!.createdAt).toBe('2026-05-26T12:00:00Z'); // createdAt untouched
  });

  it('PUTs the FRESH server list with one target swapped — server-only target survives (R1-edit)', async () => {
    const mine = makeTarget({ name: 'Mine', lon: 10 });
    const serverOnly = makeTarget({ id: makePersonalTargetId(PROFILE), name: 'From other device', lon: 99 });
    // Local knows only about `mine`; the server also has `serverOnly`.
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), mine));
    mount(PROFILE);
    const { fetchMock, putBodies } = mockGetThenPut([mine, serverOnly]);

    await _test.handleEdit(PROFILE, { ...mine, lon: 11 });

    // GET then PUT.
    const methods = fetchMock.mock.calls.map((c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase());
    expect(methods).toEqual(['GET', 'PUT']);
    // PUT body kept BOTH targets — the edit applied to mine, serverOnly untouched.
    expect(putBodies).toHaveLength(1);
    const put = putBodies[0]!.targets;
    expect(put).toHaveLength(2);
    expect(put.find((x) => x.id === mine.id)!.lon).toBe(11);
    expect(put.find((x) => x.id === serverOnly.id)!.lon).toBe(99);
  });

  it('rolls back ALL fields on PUT failure (R5-edit)', async () => {
    const t = makeTarget({ lon: -34.25 });
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), t));
    mount(PROFILE);
    mockGetThenPut([t], 503);

    const result = await _test.handleEdit(PROFILE, { ...t, lon: -99, name: 'Bad' });
    expect(result).not.toBe('ok');
    const after = loadProfile(PROFILE)!.additions[0]!;
    expect(after.lon).toBe(-34.25); // reverted
    expect(after.name).toBe('Reef'); // reverted
  });

  it('aborts (no PUT) + rolls back when the target was deleted on the server (R2-edit)', async () => {
    const t = makeTarget();
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), t));
    mount(PROFILE);
    // Server list does NOT contain our id anymore.
    const { fetchMock } = mockGetThenPut([makeTarget({ id: makePersonalTargetId(PROFILE), name: 'Other' })]);

    const result = await _test.handleEdit(PROFILE, { ...t, lon: -1 });
    expect(result).not.toBe('ok');
    const methods = fetchMock.mock.calls.map((c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase());
    expect(methods).toEqual(['GET']); // never PUT
    expect(loadProfile(PROFILE)!.additions[0]!.lon).toBe(-34.25); // reverted
  });

  it('surgical rollback preserves a concurrent local add (only the edited target reverts)', async () => {
    const t = makeTarget({ name: 'Reef', lon: -34.25 });
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), t));
    mount(PROFILE);
    const concurrent = makeTarget({ id: makePersonalTargetId(PROFILE), name: 'Added on phone', lon: 5 });
    // GET resolves the server list AND simulates another device/tab adding a
    // target locally mid-flight; then the PUT fails so rollback runs.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        saveProfile(addPersonalTarget(loadProfile(PROFILE)!, concurrent));
        return new Response(JSON.stringify({ ok: true, targets: [t] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await _test.handleEdit(PROFILE, { ...t, lon: -99, name: 'Bad' });
    expect(result).not.toBe('ok');
    const after = loadProfile(PROFILE)!;
    // Concurrent add survived; only the edited target reverted to pre-edit.
    expect(after.additions.find((x) => x.id === concurrent.id)).toBeTruthy();
    const reverted = after.additions.find((x) => x.id === t.id)!;
    expect(reverted.lon).toBe(-34.25);
    expect(reverted.name).toBe('Reef');
  });

  it('returns an error (no fetch) when the id is not in the local profile', async () => {
    saveProfile(createDefaultProfile(PROFILE)); // no additions
    mount(PROFILE);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await _test.handleEdit(PROFILE, makeTarget());
    expect(result).not.toBe('ok');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('inline edit form (DOM)', () => {
  it('Edit button opens the form pre-filled; the normal row is replaced', () => {
    const t = makeTarget({ name: 'Etna', lat: 37.75, lon: 15.0, priority: 7 });
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), t));
    const section = mount(PROFILE);

    const editBtn = Array.from(section.querySelectorAll('button')).find((b) => b.textContent === 'Edit');
    expect(editBtn).toBeTruthy();
    editBtn!.click();

    const formRow = document.querySelector('[data-kind="personal-edit"]');
    expect(formRow).toBeTruthy();
    const nameInput = formRow!.querySelector<HTMLInputElement>('input[type="text"]');
    expect(nameInput?.value).toBe('Etna');
    const numbers = Array.from(formRow!.querySelectorAll<HTMLInputElement>('input[type="number"]')).map((i) => i.value);
    expect(numbers).toEqual(['37.75', '15', '7']);
  });

  it('Save with an out-of-range lat shows an inline error and fires NO request', () => {
    const t = makeTarget();
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), t));
    mount(PROFILE);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    _test.setEditingTargetId(t.id);
    // Re-render so the form mounts, then drive it.
    const body = document.getElementById('profile-body')!;
    body.replaceChildren(buildCrudSection(PROFILE));
    const formRow = document.querySelector('[data-kind="personal-edit"]')!;
    const latInput = formRow.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]!;
    latInput.value = '999'; // out of range
    const saveBtn = Array.from(formRow.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    saveBtn.click();

    expect(formRow.querySelector('.profile-error')?.textContent).toMatch(/Latitude/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Cancel closes the form back to the normal row', () => {
    const t = makeTarget({ name: 'Etna' });
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), t));
    mount(PROFILE);
    _test.setEditingTargetId(t.id);
    const body = document.getElementById('profile-body')!;
    body.replaceChildren(buildCrudSection(PROFILE));

    const cancelBtn = Array.from(document.querySelectorAll('[data-kind="personal-edit"] button'))
      .find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    cancelBtn.click();
    expect(document.querySelector('[data-kind="personal-edit"]')).toBeNull();
    expect(_test.getEditingTargetId()).toBeNull();
  });

  it('openEditTargetForm (popup deep-link) opens the form for the id', () => {
    const t = makeTarget({ name: 'Deep link' });
    saveProfile(addPersonalTarget(createDefaultProfile(PROFILE), t));
    mount(PROFILE);

    _test.openEditTargetForm(PROFILE, t.id);
    const formRow = document.querySelector('[data-kind="personal-edit"]');
    expect(formRow).toBeTruthy();
    expect(formRow!.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Deep link');
  });
});
