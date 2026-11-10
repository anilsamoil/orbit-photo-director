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
  expect(sessionStorage.getItem('opd-account-session-v1')).toBeNull();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  await expect(session.resolveAccountProfile()).rejects.toThrow('Connect once');
});

it('rejects a session fetch that ignores abort once the deadline passes', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(() => {
      init?.signal?.addEventListener('abort', () => {});
    })));
    const session = await import('../src/profile-session');
    let outcome = 'pending';
    void session.resolveAccountProfile('https://map.astroanil.dev/?u=anil').then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('rejected');
  } finally {
    vi.useRealTimers();
  }
});

it('resumes the cached session when the session fetch ignores abort', async () => {
  const session = await login();
  vi.useFakeTimers();
  try {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(() => {
      init?.signal?.addEventListener('abort', () => {});
    })));
    let outcome: unknown = 'pending';
    void session.resolveAccountProfile().then(
      (profile) => { outcome = profile; },
      () => { outcome = 'rejected'; },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcome).toMatchObject({ name: 'u-jessica', isVerified: false });
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a session body that never finishes once the deadline passes', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream({ pull() {}, cancel() {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const session = await import('../src/profile-session');
    let outcome = 'pending';
    void session.resolveAccountProfile('https://map.astroanil.dev/?u=anil').then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('rejected');
  } finally {
    vi.useRealTimers();
  }
});

it('preserves read-only offline access when iOS reports online but transport fails', async () => {
  const session = await login();
  session.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
  expect(navigator.onLine).toBe(true);
  expect(await session.resolveAccountProfile()).toMatchObject({ name: 'u-jessica', isVerified: false });
  expect(sessionStorage.getItem('opd-account-session-v1')).toContain('u-jessica');
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

it('a denied session keeps Queue and does not render or enable Profile', async () => {
  document.body.innerHTML = [
    '<button id="tab-queue" class="tab" type="button">Queue</button>',
    '<button id="tab-upcoming" class="tab" type="button">Upcoming</button>',
    '<button id="tab-map" class="tab active" type="button">Map</button>',
    '<button id="tab-profile" class="tab" type="button">Profile</button>',
    '<button id="tab-log" class="tab" type="button">Log</button>',
    '<main id="view" class="view-map"><div id="cards"></div><div id="profile-body"></div></main>',
    '<footer id="status-banner">Loading…</footer>',
  ].join('');
  const previousUrl = window.location.href;
  window.history.replaceState({}, '', '/?u=anil');
  const profiles = await import('../src/profile');
  const validated = profiles.validatePersonalTargetInput({
    profileName: 'anil',
    name: 'Backyard shed',
    lat: 29.76,
    lon: -95.37,
    priority: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  if (!validated.ok) throw new Error(validated.error);
  profiles.saveProfile(profiles.addPersonalTarget(profiles.createDefaultProfile('anil'), validated.target));
  profiles.saveProfile(profiles.createDefaultProfile('guest'));
  const stored = {
    anil: localStorage.getItem('opd-profile-anil'),
    guest: localStorage.getItem('opd-profile-guest'),
    names: localStorage.getItem('opd-profile-names'),
  };
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 401 }))));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    const { init } = await import('../src/main');
    await init();
    (document.getElementById('tab-queue') as HTMLButtonElement).click();
    expect(document.getElementById('view')?.className).toBe('view-queue');
    expect(document.querySelector('#cards')?.childElementCount).toBe(0);
    const profileTab = document.getElementById('tab-profile') as HTMLButtonElement;
    profileTab.click();
    if (document.getElementById('view')?.className === 'view-profile') {
      await vi.waitFor(() => {
        expect(document.getElementById('profile-delete-btn')).toBeTruthy();
      });
    }
    const deleteButton = document.getElementById('profile-delete-btn');
    if (deleteButton instanceof HTMLButtonElement) deleteButton.click();
    expect({
      disabled: profileTab.disabled,
      ariaDisabled: profileTab.getAttribute('aria-disabled'),
      view: document.getElementById('view')?.className,
      profileActive: profileTab.classList.contains('active'),
      showsStoredProfile: (document.getElementById('profile-body')?.textContent ?? '').includes('guest'),
      showsPersonalTarget: (document.getElementById('profile-body')?.textContent ?? '').includes('Backyard shed'),
      deleteButton: deleteButton !== null,
      anil: localStorage.getItem('opd-profile-anil'),
      guest: localStorage.getItem('opd-profile-guest'),
      names: localStorage.getItem('opd-profile-names'),
    }).toEqual({
      disabled: true,
      ariaDisabled: 'true',
      view: 'view-queue',
      profileActive: false,
      showsStoredProfile: false,
      showsPersonalTarget: false,
      deleteButton: false,
      anil: stored.anil,
      guest: stored.guest,
      names: stored.names,
    });
  } finally {
    window.history.replaceState({}, '', previousUrl);
  }
});

it('a later sign-in enables Profile after a denied session', async () => {
  document.body.innerHTML = [
    '<button id="tab-queue" class="tab" type="button">Queue</button>',
    '<button id="tab-upcoming" class="tab" type="button">Upcoming</button>',
    '<button id="tab-map" class="tab active" type="button">Map</button>',
    '<button id="tab-profile" class="tab" type="button">Profile</button>',
    '<button id="tab-log" class="tab" type="button">Log</button>',
    '<main id="view" class="view-map"><div id="cards"></div><div id="profile-body"></div></main>',
    '<footer id="status-banner">Loading…</footer>',
  ].join('');
  const previousUrl = window.location.href;
  window.history.replaceState({}, '', '/?u=anil');
  let sessionCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/api/browser/session')) {
      sessionCalls += 1;
      if (sessionCalls === 1) return new Response('', { status: 401 });
      return new Response(JSON.stringify({
        ok: true, profile: { name: 'jessica', displayName: 'Jessica' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  }));
  const main = await import('../src/main');
  try {
    await main.init();
    const profileTab = document.getElementById('tab-profile') as HTMLButtonElement;
    expect(profileTab.disabled).toBe(true);
    expect(profileTab.getAttribute('aria-disabled')).toBe('true');
    await main.init();
    profileTab.click();
    await vi.waitFor(() => {
      const body = document.getElementById('profile-body')?.textContent ?? '';
      if (!profileTab.disabled && !body.includes('Jessica')) throw new Error('profile pane has not rendered');
    });
    expect({
      disabled: profileTab.disabled,
      ariaDisabled: profileTab.getAttribute('aria-disabled'),
      view: document.getElementById('view')?.className,
      showsAccount: (document.getElementById('profile-body')?.textContent ?? '').includes('Jessica'),
    }).toEqual({
      disabled: false,
      ariaDisabled: null,
      view: 'view-profile',
      showsAccount: true,
    });
  } finally {
    main.stopCountdown();
    main.stopPollScheduler();
    window.history.replaceState({}, '', previousUrl);
  }
});

it('a cold session failure still switches to Queue', async () => {
  document.body.innerHTML = [
    '<button id="tab-queue" class="tab" type="button">Queue</button>',
    '<button id="tab-upcoming" class="tab" type="button">Upcoming</button>',
    '<button id="tab-map" class="tab active" type="button">Map</button>',
    '<button id="tab-log" class="tab" type="button">Log</button>',
    '<main id="view" class="view-map"><div id="cards"></div></main>',
    '<footer id="status-banner">Loading…</footer>',
  ].join('');
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Load failed'))));
  const { init } = await import('../src/main');
  await init();
  (document.getElementById('tab-queue') as HTMLButtonElement).click();
  expect(document.getElementById('view')?.className).toBe('view-queue');
  expect(document.getElementById('tab-queue')?.classList.contains('active')).toBe(true);
  expect(document.querySelector('#cards')?.childElementCount).toBe(0);
});

it('a cold network error offers Sign in and Reload without opening the shell', async () => {
  document.body.innerHTML = '<footer id="status-banner">Loading…</footer><main id="view"><div id="cards"></div></main>';
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Load failed'))));
  const { init } = await import('../src/main');
  const started = performance.now();
  await init();
  expect(performance.now() - started).toBeLessThan(1_000);
  const banner = document.getElementById('status-banner');
  expect(banner?.textContent).toContain('Load failed');
  expect(banner?.querySelector('a.banner-action')?.textContent).toBe('Sign in');
  expect(banner?.querySelector('a.banner-action')?.getAttribute('href')).toBe('/api/app');
  expect(banner?.querySelector('button.banner-action')?.textContent).toBe('Reload');
  expect(document.querySelector('#cards')?.childElementCount).toBe(0);
});

it('a cold session that ignores abort offers Sign in and Reload at the deadline', async () => {
  vi.useFakeTimers();
  try {
    document.body.innerHTML = '<footer id="status-banner">Loading…</footer><main id="view"><div id="cards"></div></main>';
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(() => {
      init?.signal?.addEventListener('abort', () => {});
    })));
    const { init } = await import('../src/main');
    const boot = init();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(document.querySelector('#status-banner .banner-action')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await boot;
    const banner = document.getElementById('status-banner');
    expect(banner?.textContent).toContain('The session request timed out');
    expect(banner?.querySelector('a.banner-action')?.textContent).toBe('Sign in');
    expect(banner?.querySelector('button.banner-action')?.textContent).toBe('Reload');
    expect(document.querySelector('#cards')?.childElementCount).toBe(0);
  } finally {
    vi.useRealTimers();
  }
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

it('the account pane names only the signed-in account, never other locally saved profiles', async () => {
  await login();
  document.body.innerHTML = '<div id="profile-body"></div>';
  const p = await import('../src/profile');
  p.saveProfile(p.createDefaultProfile('anil'));
  p.loadOrCreateProfileFromURL('https://map.astroanil.dev/?u=anil');
  const ui = await import('../src/profile-ui');
  ui.renderProfilePane();
  const identity = document.querySelector('#profile-picker-section');
  expect(identity?.querySelector('h3')?.textContent).toBe('Your profile · Jessica');
  expect(identity?.textContent).not.toContain('anil');
});
