import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NAVIGATION_FALLBACK_DENYLIST } from '../src/sw-navigation';

const savedProfile = '{"private":"keep this"}';
const savedQueue = '[{"private":"unsent"}]';

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  document.body.innerHTML = `
    <header class="topbar"><button id="tab-queue" class="tab" type="button">Queue</button></header>
    <main id="view" class="view-map"><section id="map-pane"><div id="map"></div></section></main>
    <footer id="status-banner" class="banner banner-loading">Loading…</footer>
  `;
  localStorage.setItem('opd-profile-anil', savedProfile);
  localStorage.setItem('opd-calib-queue', savedQueue);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function bootDenied(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
  const { init } = await import('../src/main');
  await init();
}

it.each([401, 403, 302])('session HTTP %s puts Sign in and Reload on the footer, not under the map', async (status) => {
  await bootDenied(status);
  expect(document.querySelector('#map-pane a')).toBeNull();
  const signIn = document.querySelector<HTMLAnchorElement>('#status-banner a');
  const reload = document.querySelector<HTMLButtonElement>('#status-banner button');
  expect(signIn?.textContent).toBe('Sign in');
  expect(signIn?.getAttribute('href')).toBe('/api/app');
  expect(NAVIGATION_FALLBACK_DENYLIST.some((rule) => rule.test(signIn?.getAttribute('href') ?? ''))).toBe(true);
  expect(reload?.textContent).toBe('Reload');
  expect(document.getElementById('status-banner')?.textContent).toContain('Please sign in again');
  expect(document.getElementById('status-banner')?.textContent).toContain('saved data has been kept');
  expect(localStorage.getItem('opd-profile-anil')).toBe(savedProfile);
  expect(localStorage.getItem('opd-calib-queue')).toBe(savedQueue);
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  const reloadPage = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  reload?.click();
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign.mock.calls[0]?.[0]).toBe('/api/app');
  expect(reloadPage).not.toHaveBeenCalled();
  expect(localStorage.getItem('opd-profile-anil')).toBe(savedProfile);
});

it('a later status paint leaves Sign in and Reload on the footer', async () => {
  await bootDenied(401);
  const { renderOfflineBanner } = await import('../src/main');
  renderOfflineBanner();
  expect(document.querySelector('#status-banner a')?.textContent).toBe('Sign in');
  expect(document.querySelector('#status-banner button')?.textContent).toBe('Reload');
  expect(document.getElementById('status-banner')?.textContent).toContain('Please sign in again');
  expect(document.getElementById('status-banner')?.textContent).not.toContain('no cached data');
});

it('an opaque Access redirect uses the same footer controls', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'opaqueredirect', status: 0, ok: false, redirected: false })));
  const { init } = await import('../src/main');
  await init();
  expect(document.querySelector('#status-banner a')?.textContent).toBe('Sign in');
  expect(document.querySelector('#status-banner button')?.textContent).toBe('Reload');
  expect(document.querySelector('#map-pane a')).toBeNull();
});

it('a local app shell is not a sign-in wall and keeps the saved profile', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/browser/session')) {
      return new Response('<footer id="status-banner"></footer>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  }));
  const session = await import('../src/profile-session');
  const profile = await session.resolveAccountProfile('http://127.0.0.1:43147/?u=anil');
  expect(profile).toMatchObject({ name: 'anil', isVerified: false, localOnly: true });
  expect(localStorage.getItem('opd-profile-anil')).toBe(savedProfile);
  const { init } = await import('../src/main');
  await init();
  expect(document.body.textContent).not.toContain('Please sign in again');
  expect(document.querySelector('#status-banner a')).toBeNull();
  expect(session.getAccountProfile()).toMatchObject({ name: 'anil', localOnly: true });
  expect(localStorage.getItem('opd-profile-anil')).toBe(savedProfile);
  expect(localStorage.getItem('opd-calib-queue')).toBe(savedQueue);
});

it('a missing session route is local, and a JSON 404 still requires sign-in', async () => {
  const session = await import('../src/profile-session');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not here', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  })));
  expect(await session.resolveAccountProfile('http://192.168.87.60:43147/?u=jessica')).toMatchObject({
    name: 'jessica', localOnly: true,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not_found"}', {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })));
  await expect(session.resolveAccountProfile('https://map.astroanil.dev/?u=anil')).rejects.toThrow('sign in');
  expect(session.getAccountProfile()).toBeNull();
});
