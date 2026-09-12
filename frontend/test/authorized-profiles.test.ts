import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const own = { name: 'anil', displayName: 'Anil' };
const crew = { name: 'jessica', displayName: 'Jessica Meir' };
const sessionBody = { ok: true, profile: own, profiles: [own, crew] };

// Rendering the picker does not need a target hydration or event-bus timer.
vi.mock('../src/profile-crud', () => ({ buildCrudSection: () => document.createElement('section') }));
vi.mock('../src/profile-events', () => ({ subscribeProfileChanged: () => () => {} }));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear(); sessionStorage.clear();
  document.body.innerHTML = '<span id="profile-badge"></span><div id="profile-body"></div>';
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
    expect(session.getAuthorizedProfiles().map((profile) => profile.name)).toEqual(['anil', 'jessica']);
    expect(session.canSelectProfile('jessica')).toBe(true);
  });

  it('ignores a copied URL for a profile the signed-in account cannot access', async () => {
    const session = await signIn('/?u=jack');
    expect(session.getAccountProfile()?.name).toBe('anil');
    expect(session.canSelectProfile('jack')).toBe(false);
    const profiles = await import('../src/profile');
    expect(profiles.loadOrCreateProfileFromURL(window.location.href).name).toBe('anil');
    expect(profiles.loadProfile('jack')).toBeNull();
  });

  it('works with the previous own-profile-only Worker response', async () => {
    const session = await signIn('/?u=jessica', { ok: true, profile: own });
    expect(session.getAccountProfile()?.name).toBe('anil');
    expect(session.getAuthorizedProfiles()).toHaveLength(1);
    expect(session.canSelectProfile('jessica')).toBe(false);
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
    expect(session.getAuthorizedProfiles()).toEqual([]);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(session.resolveAccountProfile()).rejects.toThrow('Connect once');
  });

  it('resumes only the last selected profile offline, with no selectable permissions or sync', async () => {
    const session = await signIn('/?u=jessica');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await session.resolveAccountProfile('https://map.astroanil.dev/?u=anil');
    expect(session.getAccountProfile()).toMatchObject({ name: 'jessica', isVerified: false });
    expect(session.getSignedInAccountProfile()).toBeNull();
    expect(session.getAuthorizedProfiles()).toEqual([]);
    expect(session.canSelectProfile('anil')).toBe(false);
    expect(session.canSelectProfile('jessica')).toBe(false);
    const { getProfileTargets } = await import('../src/profile-api');
    expect(await getProfileTargets('jessica')).toMatchObject({ ok: false, reason: 'authentication' });
    expect(session.fetch).toHaveBeenCalledTimes(1);
    const ui = await import('../src/profile-ui');
    ui.renderProfilePane();
    expect(document.querySelector('#profile-picker-select')).toBeNull();
    expect(document.querySelector('#profile-picker-section')?.textContent).toContain('Offline');
  });

  it('drops a revoked grant on the next successful sign-in and returns to the own profile', async () => {
    const session = await signIn('/?u=jessica');
    session.fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true, profile: own, profiles: [own] })));
    await session.resolveAccountProfile();
    expect(session.getAccountProfile()?.name).toBe('anil');
    expect(session.canSelectProfile('jessica')).toBe(false);
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

describe('visible crew profile chooser', () => {
  it('lists Jessica from the server on a fresh device, with clear managing and signed-in labels', async () => {
    await signIn('/?u=jessica');
    const ui = await import('../src/profile-ui');
    ui.renderProfilePane();
    const select = document.querySelector<HTMLSelectElement>('#profile-picker-select')!;
    expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
      ['anil', 'Anil (Your profile)'], ['jessica', 'Jessica Meir'],
    ]);
    expect(select.value).toBe('jessica');
    expect(document.querySelector('#profile-picker-section')?.textContent).toContain('Crew profile · Jessica Meir');
    expect(document.querySelector('#profile-picker-section')?.textContent).toContain('Signed in as Anil');
    expect(document.querySelector('#profile-picker-section')?.textContent).toContain('Jessica Meir’s targets, settings and ratings');
    expect(document.querySelector<HTMLAnchorElement>('#profile-picker-section a')?.getAttribute('href')).toBe('/profile-research/jessica.html');
    expect(document.querySelector('#profile-new-btn')).toBeNull();
    expect(document.querySelector('#profile-delete-btn')).toBeNull();
    const { renderTopbarProfileBadge } = await import('../src/main');
    renderTopbarProfileBadge('jessica');
    expect(document.querySelector('#profile-badge')?.textContent).toBe('👤 Jessica Meir');
    expect(document.querySelector('#profile-badge')?.getAttribute('aria-label')).toBe('Switch profile');
  });

  it('never adds locally saved unrelated profiles, including during cross-tab refresh', async () => {
    await signIn();
    const p = await import('../src/profile');
    p.saveProfile(p.createDefaultProfile('jack'));
    const ui = await import('../src/profile-ui');
    ui.renderProfilePane();
    p.saveProfile(p.createDefaultProfile('josh'));
    ui.refreshPickerFromExternalChange();
    const select = document.querySelector<HTMLSelectElement>('#profile-picker-select')!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['anil', 'jessica']);
    expect(select.value).toBe('anil');
  });

  it('switching through the chooser changes the requested profile and reloads exactly once', async () => {
    await signIn();
    const ui = await import('../src/profile-ui');
    ui.renderProfilePane();
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const select = document.querySelector<HTMLSelectElement>('#profile-picker-select')!;
    select.value = 'jessica';
    select.dispatchEvent(new Event('change'));
    expect(new URL(window.location.href).searchParams.get('u')).toBe('jessica');
    expect(reload).toHaveBeenCalledTimes(1);
    ui.switchToProfile('jack');
    expect(new URL(window.location.href).searchParams.get('u')).toBe('jessica');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
