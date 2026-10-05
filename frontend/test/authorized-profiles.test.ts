import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const own = { name: 'anil', displayName: 'Anil' };
const crew = { name: 'jessica', displayName: 'Jessica Meir' };
const sessionBody = { ok: true, profile: own, profiles: [own, crew] };

vi.mock('../src/profile-crud', () => ({ buildCrudSection: () => document.createElement('section') }));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear(); sessionStorage.clear();
  document.body.innerHTML = '<div id="profile-body"></div>';
  window.history.replaceState({}, '', '/');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function signIn(url = '/', body: unknown = sessionBody) {
  window.history.replaceState({}, '', url);
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetch);
  const session = await import('../src/profile-session');
  await session.resolveAccountProfile();
  return { ...session, fetch };
}

describe('server-authorized profile selection', () => {
  it('defaults to the signed-in own profile and accepts an explicitly granted crew URL', async () => {
    const session = await signIn();
    expect(session.getAccountProfile()?.name).toBe('anil');
    await session.resolveAccountProfile('https://map.astroanil.dev/api/app?u=jessica');
    expect(session.getAccountProfile()).toMatchObject({ ...crew, isVerified: true });
    expect(session.getSignedInAccountProfile()).toMatchObject(own);
  });

  it('ignores a copied URL for a profile the signed-in account cannot access', async () => {
    const session = await signIn('/?u=jack');
    expect(session.getAccountProfile()?.name).toBe('anil');
    const profiles = await import('../src/profile');
    expect(profiles.loadOrCreateProfileFromURL(window.location.href).name).toBe('anil');
    expect(profiles.loadProfile('jack')).toBeNull();
  });

  it('works with the previous own-profile-only Worker response', async () => {
    const session = await signIn('/?u=jessica', { ok: true, profile: own });
    expect(session.getAccountProfile()?.name).toBe('anil');
  });

  it.each([
    null, [], [crew], [own, crew, crew], [own, { name: '../jack', displayName: 'Jack' }],
    [own, { name: 'jack', displayName: '' }], [{ ...own, displayName: 'Different' }, crew],
  ])('rejects the entire malformed authorization list %j and removes cached access', async (profiles) => {
    const session = await signIn('/?u=jessica');
    session.fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true, profile: own, profiles })));
    await expect(session.resolveAccountProfile()).rejects.toThrow('verify');
    expect(session.getAccountProfile()).toBeNull();
    expect(session.getSignedInAccountProfile()).toBeNull();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(session.resolveAccountProfile()).rejects.toThrow('Connect once');
  });

  it('resumes only the last selected profile offline, with no sync', async () => {
    const session = await signIn('/?u=jessica');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await session.resolveAccountProfile('https://map.astroanil.dev/?u=anil');
    expect(session.getAccountProfile()).toMatchObject({ name: 'jessica', isVerified: false });
    expect(session.getSignedInAccountProfile()).toBeNull();
    const { getProfileTargets } = await import('../src/profile-api');
    expect(await getProfileTargets('jessica')).toMatchObject({ ok: false, reason: 'authentication' });
    expect(session.fetch).toHaveBeenCalledTimes(1);
    const ui = await import('../src/profile-ui');
    ui.renderProfilePane();
    expect(document.querySelector('#profile-identity-section h3')?.textContent).toBe('Active profile · Jessica Meir');
    expect(document.querySelector('#profile-identity-section p')?.textContent)
      .toBe('Offline · using this tab’s last verified profile. Reconnect and reload to sync.');
  });

  it('drops a revoked grant on the next successful sign-in and returns to the own profile', async () => {
    const session = await signIn('/?u=jessica');
    session.fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true, profile: own, profiles: [own] })));
    await session.resolveAccountProfile();
    expect(session.getAccountProfile()?.name).toBe('anil');
  });

  it('keeps target API and ratings scoped to the selected crew profile', async () => {
    const session = await signIn('/?u=jessica');
    const { getProfileTargets } = await import('../src/profile-api');
    session.fetch.mockImplementation(async () => new Response('{"ok":true,"targets":[]}'));
    expect(await getProfileTargets('jessica')).toMatchObject({ ok: true });
    expect(session.fetch).toHaveBeenLastCalledWith('/api/browser/profiles/jessica/targets', expect.any(Object));
    const calls = session.fetch.mock.calls.length;
    expect(await getProfileTargets('anil')).toMatchObject({ ok: false, reason: 'authentication' });
    expect(session.fetch).toHaveBeenCalledTimes(calls);
    const { buildPayload, postCalib } = await import('../src/calib');
    const payload = buildPayload('shoot', 'tuvalu-funafuti', '2026-09-13T12:00:00Z', 50);
    expect(payload.profile).toBe('jessica');
    session.fetch.mockImplementation(async () => new Response('{"ok":true}'));
    expect(await postCalib(payload)).toEqual({ ok: true });
    expect(JSON.parse(session.fetch.mock.lastCall?.[1].body).profile).toBe('jessica');
  });
});

describe('crew roster profiles from ?u=', () => {
  const cachedSession = () => JSON.parse(sessionStorage.getItem('opd-account-session-v1') ?? 'null');

  it('opens the roster profile over the signed-in session and caches only the session', async () => {
    const session = await signIn('/?u=watkins');
    expect(session.getAccountProfile()).toEqual({ name: 'watkins', displayName: 'Jessica Watkins (Watty)', isVerified: false });
    expect(session.getSignedInAccountProfile()).toEqual({ ...own, isVerified: true });
    expect(cachedSession()).toEqual({ ...own, isVerified: true });
  });

  it('keeps the granted profile the tab had in the cache across a roster visit', async () => {
    const session = await signIn('/?u=jessica');
    await session.resolveAccountProfile('https://map.astroanil.dev/?u=kutryk');
    expect(session.getAccountProfile()).toEqual({ name: 'kutryk', displayName: 'Josh Kutryk', isVerified: false });
    expect(cachedSession()).toEqual({ ...crew, isVerified: true });
  });

  it('resolves ?u=anil and a granted name exactly as before', async () => {
    const session = await signIn('/?u=anil');
    expect(session.getAccountProfile()).toEqual({ ...own, isVerified: true });
    await session.resolveAccountProfile('https://map.astroanil.dev/?u=jessica');
    expect(session.getAccountProfile()).toEqual({ ...crew, isVerified: true });
  });

  it('still requires sign-in, and offline still requires a cached session', async () => {
    window.history.replaceState({}, '', '/?u=watkins');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const session = await import('../src/profile-session');
    await expect(session.resolveAccountProfile()).rejects.toThrow('Please sign in again to open your own profile.');
    expect(session.getAccountProfile()).toBeNull();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(session.resolveAccountProfile()).rejects.toThrow('Connect once to verify your Google account.');
    expect(session.getAccountProfile()).toBeNull();
  });

  it('opens a roster profile offline over the cached session', async () => {
    const session = await signIn();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await session.resolveAccountProfile('https://map.astroanil.dev/?u=delaney')).toEqual({
      name: 'delaney', displayName: 'Luke Delaney', isVerified: false,
    });
    expect(session.fetch).toHaveBeenCalledTimes(1);
    expect(cachedSession()).toEqual({ ...own, isVerified: true });
  });

  it('keeps a local copy on its own profile under a roster profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })));
    const session = await import('../src/profile-session');
    await session.resolveAccountProfile('http://127.0.0.1:5173/?u=chris');
    expect(await session.resolveAccountProfile('http://127.0.0.1:5173/?u=watkins')).toEqual({
      name: 'watkins', displayName: 'Jessica Watkins (Watty)', isVerified: false,
    });
    expect(session.getSignedInAccountProfile()).toEqual({ name: 'chris', displayName: 'chris', isVerified: false, localOnly: true });
  });
});

describe('Profile pane identity', () => {
  async function identity(url: string) {
    await signIn(url);
    const ui = await import('../src/profile-ui');
    ui.renderProfilePane();
    const section = document.querySelector('#profile-identity-section')!;
    return {
      heading: section.querySelector('h3')?.textContent,
      info: section.querySelector('p')?.textContent,
      link: section.querySelector('a')?.getAttribute('href') ?? null,
    };
  }

  it('names a granted crew profile and the signed-in account managing it', async () => {
    expect(await identity('/?u=jessica')).toEqual({
      heading: 'Crew profile · Jessica Meir',
      info: 'Signed in as Anil. You are managing Jessica Meir’s targets, settings and ratings.',
      link: '/profile-research/jessica.html',
    });
  });

  it('names a crew roster profile and says how to return to the signed-in profile', async () => {
    expect(await identity('/?u=kutryk')).toEqual({
      heading: 'Crew roster · Josh Kutryk',
      info: 'Crew roster profiles come with the app. Settings, ratings and hidden targets stay on this device. Open the map without ?u=kutryk to return to your own profile.',
      link: null,
    });
  });

  it('points the signed-in profile at the name in the top bar', async () => {
    expect(await identity('/')).toEqual({
      heading: 'Your profile · Anil',
      info: 'Your Google account selects your profile automatically. Use the name in the top bar to open a crew roster profile.',
      link: null,
    });
  });
});
