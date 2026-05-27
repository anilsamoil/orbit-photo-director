/** Slot 8b — per-target shot-count badge tests.
 *
 *  Covers:
 *    - `/api/log` fetch is filtered to the active profile + aggregated by
 *      `target_id` for `action === 'shoot'` entries
 *    - rows with count > 0 render the badge; others do not
 *    - log-fetch failure is silent (no crash, no badges)
 *    - rerenderCrudSection consults the per-session cache; no refetch
 *    - shot-count fetch is independent from targets hydrate (one's failure
 *      cannot kill the other)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPersonalTarget,
  createDefaultProfile,
  makePersonalTargetId,
  saveProfile,
  type PersonalTarget,
} from '../src/profile';
import {
  _test,
  buildCrudSection,
  rerenderCrudSection,
} from '../src/profile-crud';

const PROFILE = 'jack';
const TOKEN_KEY = 'opd-calib-token';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'test-token');
  _test.resetHydrationState();
  document.body.innerHTML = `
    <div id="toast" hidden></div>
    <main>
      <section id="profile-pane">
        <div id="profile-body"></div>
      </section>
    </main>
  `;
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function seedTargets(): {
  alpha: PersonalTarget;
  beta: PersonalTarget;
  gamma: PersonalTarget;
} {
  const alpha: PersonalTarget = {
    id: makePersonalTargetId(PROFILE),
    name: 'Alpha',
    lat: 10,
    lon: 20,
    priority: 5,
    createdAt: '2026-05-26T00:00:00Z',
  };
  const beta: PersonalTarget = {
    id: makePersonalTargetId(PROFILE),
    name: 'Beta',
    lat: 11,
    lon: 21,
    priority: 5,
    createdAt: '2026-05-26T00:00:01Z',
  };
  const gamma: PersonalTarget = {
    id: makePersonalTargetId(PROFILE),
    name: 'Gamma',
    lat: 12,
    lon: 22,
    priority: 5,
    createdAt: '2026-05-26T00:00:02Z',
  };
  let p = createDefaultProfile(PROFILE);
  p = addPersonalTarget(p, alpha);
  p = addPersonalTarget(p, beta);
  p = addPersonalTarget(p, gamma);
  saveProfile(p);
  return { alpha, beta, gamma };
}

describe('hydrateShotCounts', () => {
  it('aggregates `shoot` entries by target_id and badges only counted rows', async () => {
    const { alpha, beta } = seedTargets();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          entries: [
            { target_id: alpha.id, pass_time: '2026-05-26T01:00:00Z', action: 'shoot' },
            { target_id: alpha.id, pass_time: '2026-05-26T02:00:00Z', action: 'shoot' },
            { target_id: alpha.id, pass_time: '2026-05-26T03:00:00Z', action: 'shoot' },
            { target_id: beta.id, pass_time: '2026-05-26T04:00:00Z', action: 'shoot' },
            // Skip entries should NOT contribute to the shoot count.
            { target_id: beta.id, pass_time: '2026-05-26T05:00:00Z', action: 'skip' },
            // Rate entries should NOT contribute either.
            { target_id: alpha.id, pass_time: '2026-05-26T06:00:00Z', action: 'rate', rating: 5 },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    document.getElementById('profile-body')!.appendChild(buildCrudSection(PROFILE));
    // hydrateShotCounts is fire-and-forget; let the microtask drain and
    // the rerender land before asserting.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // /api/log was called with profile=jack
    const logCalls = (fetchMock.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).includes('/api/log'),
    );
    expect(logCalls).toHaveLength(1);
    expect(String(logCalls[0]![0])).toContain('profile=jack');

    const rows = document.querySelectorAll('[data-kind="personal"]');
    const byName: Record<string, HTMLElement> = {};
    for (const r of Array.from(rows) as HTMLElement[]) {
      const name = r.querySelector('.profile-crud-name')!.textContent!;
      byName[name] = r;
    }
    expect(byName.Alpha!.querySelector('.profile-crud-shot-badge')?.textContent).toBe('✓ 3');
    expect(byName.Beta!.querySelector('.profile-crud-shot-badge')?.textContent).toBe('✓ 1');
    expect(byName.Gamma!.querySelector('.profile-crud-shot-badge')).toBeNull();
  });

  it('is silent on log-fetch failure — no badges, no crash', async () => {
    seedTargets();
    // fetchLog's wrapper swallows non-200 + network errors and returns [];
    // simulate the 500 path to be thorough.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'kv_unavailable' }), { status: 500 }),
      ),
    );
    document.getElementById('profile-body')!.appendChild(buildCrudSection(PROFILE));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('.profile-crud-shot-badge')).toHaveLength(0);
    // Rows still rendered — failure doesn't kill the list
    expect(document.querySelectorAll('[data-kind="personal"]')).toHaveLength(3);
  });

  it('is silent when the calib token is missing', async () => {
    localStorage.removeItem(TOKEN_KEY);
    seedTargets();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    document.getElementById('profile-body')!.appendChild(buildCrudSection(PROFILE));
    await new Promise((r) => setTimeout(r, 0));
    // fetchLog short-circuits on token_missing — no /api/log call fires
    const logCalls = (fetchMock.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).includes('/api/log'),
    );
    expect(logCalls).toHaveLength(0);
    expect(document.querySelectorAll('.profile-crud-shot-badge')).toHaveLength(0);
  });

  it('rerender consults the cache and does not re-fetch /api/log', async () => {
    const { alpha } = seedTargets();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          entries: [
            { target_id: alpha.id, pass_time: '2026-05-26T01:00:00Z', action: 'shoot' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    document.getElementById('profile-body')!.appendChild(buildCrudSection(PROFILE));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const firstLogCalls = (fetchMock.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).includes('/api/log'),
    ).length;
    expect(firstLogCalls).toBe(1);

    // Re-render (as happens after every add/delete/toggle) must reuse
    // the cached counts rather than firing a second log fetch.
    rerenderCrudSection(PROFILE);
    await new Promise((r) => setTimeout(r, 0));
    const secondLogCalls = (fetchMock.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).includes('/api/log'),
    ).length;
    expect(secondLogCalls).toBe(1);
    // The badge is still present after the rerender (cache works).
    const alphaRow = document.querySelector(`[data-target-id="${alpha.id}"]`)!;
    expect(alphaRow.querySelector('.profile-crud-shot-badge')?.textContent).toBe('✓ 1');
  });
});
