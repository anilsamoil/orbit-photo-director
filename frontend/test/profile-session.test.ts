import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATION_FALLBACK_DENYLIST } from '../src/sw-navigation';
import { deleteProfileTarget, getProfileTargets, postProfileTarget, putProfileTargets } from '../src/profile-api';

const target = { id: 'personal:jack:test', name: 'Test', lat: 0, lon: 0, priority: 5, createdAt: '2026-09-09T00:00:00Z' };
beforeEach(() => localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); });

describe('profile sync using the signed-in session', () => {
  it('opens the recovery URL through the network instead of the offline navigation shell', () => {
    expect(NAVIGATION_FALLBACK_DENYLIST.some((rule) => rule.test('/api/app?u=anil'))).toBe(true);
  });
  it('sends every CRUD method without a browser token', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      init.method === 'GET' ? { targets: [target] } : { ok: true, count: 1, removed: true },
    )));
    vi.stubGlobal('fetch', fetchMock);
    for (const result of [await getProfileTargets('jack'), await postProfileTarget('jack', target),
      await putProfileTargets('jack', [target]), await deleteProfileTarget('jack', target.id)]) {
      expect(result.ok).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
      expect(new Headers(init.headers).has('x-calib-token')).toBe(false);
    }
  });
  it('treats Access redirects and expired sessions as sign-in failures', async () => {
    for (const response of [new Response(null, { status: 302 }), new Response('{}', { status: 401 }),
      { type: 'opaqueredirect', status: 0, ok: false }]) {
      vi.stubGlobal('fetch', vi.fn(async () => response));
      expect(await postProfileTarget('jack', target)).toMatchObject({ ok: false, reason: 'authentication' });
    }
  });
  it('does not acknowledge a login page or missing write receipt', async () => {
    for (const body of ['<html>Sign in</html>', '{}', 'null', '{"ok":false}']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      expect(await postProfileTarget('jack', target)).toMatchObject({ ok: false });
    }
  });
  it('rejects malformed target lists instead of treating them as successful hydration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')));
    expect(await getProfileTargets('jack')).toMatchObject({ ok: false });
  });
});
