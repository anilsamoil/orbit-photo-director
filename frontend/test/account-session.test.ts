import { beforeEach, afterEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules(); localStorage.clear(); sessionStorage.clear();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function login(name = 'u-jessica') {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ok: true, profile: { name, displayName: 'Jessica' },
  })));
  vi.stubGlobal('fetch', fetch);
  const session = await import('../src/profile-session');
  await session.resolveAccountProfile();
  return { ...session, fetch };
}

it('a copied anil URL opens the verified account and leaves owner data untouched', async () => {
  await login();
  const p = await import('../src/profile');
  const owner = p.createDefaultProfile('anil');
  owner.distanceThresholdKm = 700;
  p.saveProfile(owner);
  expect(p.loadOrCreateProfileFromURL('https://map.astroanil.dev/api/app?u=anil').name).toBe('u-jessica');
  expect(p.loadProfile('anil')?.distanceThresholdKm).toBe(700);
});

it('resumes only this tab offline and marks its session unverified', async () => {
  const session = await login();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  expect(await session.resolveAccountProfile()).toMatchObject({ name: 'u-jessica', isVerified: false });
  expect(session.fetch).toHaveBeenCalledTimes(1);
});

it('an expired session cannot fall back to a previous profile, even after going offline', async () => {
  const session = await login();
  session.fetch.mockResolvedValue(new Response('', { status: 401 }));
  await expect(session.resolveAccountProfile()).rejects.toThrow('sign in');
  expect(session.getAccountProfile()).toBeNull();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  await expect(session.resolveAccountProfile()).rejects.toThrow('Connect once');
});

it('preserves read-only offline access when iOS reports online but transport fails', async () => {
  const session = await login();
  session.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
  expect(navigator.onLine).toBe(true);
  expect(await session.resolveAccountProfile()).toMatchObject({ name: 'u-jessica', isVerified: false });
  const { postProfileTarget } = await import('../src/profile-api');
  const count = session.fetch.mock.calls.length;
  expect(await postProfileTarget('u-jessica', {} as never)).toMatchObject({ ok: false, reason: 'authentication' });
  expect(session.fetch.mock.calls).toHaveLength(count);
});

it('rejects redirected login HTML and malformed identities', async () => {
  const session = await login();
  session.fetch.mockResolvedValue(new Response('<html>Login</html>'));
  await expect(session.resolveAccountProfile()).rejects.toThrow();
  session.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, profile: { name: '../anil', displayName: 'X' } })));
  await expect(session.resolveAccountProfile()).rejects.toThrow('verify');
  expect(session.getAccountProfile()).toBeNull();
});

it('boot waits for identity and never renders or deletes previous personal data after denial', async () => {
  document.body.innerHTML = '<div id="status-banner"></div><main><div id="cards"></div></main>';
  localStorage.setItem('opd-profile-anil', '{"private":"keep this"}');
  localStorage.setItem('opd-calib-queue', '[{"private":"unsent"}]');
  const before = localStorage.getItem('opd-profile-anil');
  let deny!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { deny = resolve; })));
  const { init } = await import('../src/main');
  const boot = init();
  expect(document.querySelector('#cards')?.childElementCount).toBe(0);
  deny(new Response('', { status: 401 }));
  await boot;
  expect(document.querySelector('#cards')?.childElementCount).toBe(0);
  expect(localStorage.getItem('opd-profile-anil')).toBe(before);
  expect(localStorage.getItem('opd-calib-queue')).toBe('[{"private":"unsent"}]');
  expect(document.body.textContent).toContain('sign in again');
});

it('the account pane never lists other locally saved profiles or permits URL switching', async () => {
  await login();
  document.body.innerHTML = '<div id="profile-body"></div>';
  const p = await import('../src/profile');
  p.saveProfile(p.createDefaultProfile('anil'));
  p.loadOrCreateProfileFromURL('https://map.astroanil.dev/?u=anil');
  const ui = await import('../src/profile-ui');
  ui.renderProfilePane();
  expect(document.querySelector('#profile-picker-select')).toBeNull();
  expect(document.querySelector('#profile-picker-section')?.textContent).toContain('Jessica');
  const urlBefore = window.location.href;
  ui.switchToProfile('anil');
  expect(window.location.href).toBe(urlBefore);
});
