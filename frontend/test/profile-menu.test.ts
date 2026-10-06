import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const own = { name: 'anil', displayName: 'Anil' };
const crew = { name: 'jessica', displayName: 'Jessica Meir' };
const TOPBAR_HTML = readFileSync(resolve('index.html'), 'utf8').match(/<header class="topbar">[\s\S]*?<div id="profile-menu"[^>]*><\/div>/)![0];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear(); sessionStorage.clear();
  document.body.innerHTML = TOPBAR_HTML;
  window.history.replaceState({}, '', '/');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountOn(url: string) {
  window.history.replaceState({}, '', url);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, profile: own, profiles: [own, crew] }))));
  const session = await import('../src/profile-session');
  await session.resolveAccountProfile();
  const { mountProfileMenu } = await import('../src/profile-menu');
  mountProfileMenu();
  return { session, mountProfileMenu };
}

const badgeName = () => document.querySelector('#profile-badge .profile-badge-name')?.textContent;
const menuRows = () => [...document.querySelectorAll<HTMLElement>('#profile-menu > *')]
  .map((row) => [row.tagName, row.dataset.profile, row.textContent, row.getAttribute('aria-current')]);
const chooseRow = (name: string) => document.querySelector<HTMLButtonElement>(`#profile-menu [data-profile="${name}"]`)!.click();

describe('top-bar profile menu', () => {
  it('puts the name between the readout and Status, and the menu outside the top bar', () => {
    const badge = document.getElementById('profile-badge')!;
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.getAttribute('popovertarget')).toBe('profile-menu');
    expect(badge.parentElement?.className).toBe('topbar-identity');
    expect(badge.previousElementSibling?.id).toBe('live-readout');
    expect(badge.nextElementSibling?.id).toBe('live-readout-toggle');
    const menu = document.getElementById('profile-menu')!;
    expect(menu.hasAttribute('popover')).toBe(true);
    expect(menu.closest('header')).toBeNull();
  });

  it('lists the signed-in profile above the three crew and marks Watkins', async () => {
    await mountOn('/?u=watkins');
    expect(document.getElementById('profile-badge')?.hidden).toBe(false);
    expect(badgeName()).toBe('Jessica Watkins (Watty)');
    expect(menuRows()).toEqual([
      ['BUTTON', 'anil', 'Anil', null],
      ['BUTTON', 'watkins', 'Jessica Watkins (Watty)', 'true'],
      ['BUTTON', 'kutryk', 'Josh Kutryk', null],
      ['BUTTON', 'delaney', 'Luke Delaney', null],
    ]);
    expect(document.querySelector('#profile-menu [data-profile="anil"]')?.hasAttribute('data-profile-home')).toBe(true);
    const closers = [...document.querySelectorAll('#profile-menu button')]
      .map((row) => [row.getAttribute('popovertarget'), row.getAttribute('popovertargetaction')]);
    expect(closers).toEqual([['profile-menu', 'hide'], ['profile-menu', 'hide'], ['profile-menu', 'hide'], ['profile-menu', 'hide']]);
  });

  it('marks Anil when his profile is active', async () => {
    const profiles = await import('../src/profile');
    profiles.saveProfile(profiles.createDefaultProfile('jack'));
    await mountOn('/');
    expect(badgeName()).toBe('Anil');
    expect(menuRows()).toEqual([
      ['BUTTON', 'anil', 'Anil', 'true'],
      ['BUTTON', 'watkins', 'Jessica Watkins (Watty)', null],
      ['BUTTON', 'kutryk', 'Josh Kutryk', null],
      ['BUTTON', 'delaney', 'Luke Delaney', null],
    ]);
  });

  it('returns to the signed-in profile by removing ?u= and keeping the tab', async () => {
    await mountOn('/?e2e&u=watkins#launch');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    document.getElementById('tab-map')!.classList.remove('active');
    document.getElementById('tab-queue')!.classList.add('active');
    chooseRow('anil');
    expect(assign).toHaveBeenCalledTimes(1);
    const next = new URL(String(assign.mock.calls[0]?.[0]));
    expect(next.searchParams.has('u')).toBe(false);
    expect([next.pathname, next.search, next.hash]).toEqual(['/', '?e2e=', '#launch']);
    expect(sessionStorage.getItem('opd-profile-switch-view')).toBe('tab-queue');
  });

  it('choosing the signed-in profile again does not navigate', async () => {
    await mountOn('/');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    chooseRow('anil');
    expect(assign).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('opd-profile-switch-view')).toBeNull();
  });

  it('switches from Queue to Josh Kutryk with one navigation that keeps the other params and the hash', async () => {
    await mountOn('/?e2e&u=watkins#launch');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    document.getElementById('tab-map')!.classList.remove('active');
    document.getElementById('tab-queue')!.classList.add('active');
    chooseRow('kutryk');
    expect(assign).toHaveBeenCalledTimes(1);
    const next = new URL(String(assign.mock.calls[0]?.[0]));
    expect([next.pathname, next.search, next.hash]).toEqual(['/', '?e2e=&u=kutryk', '#launch']);
    expect(sessionStorage.getItem('opd-profile-switch-view')).toBe('tab-queue');
  });

  it('choosing the active profile does not navigate', async () => {
    await mountOn('/?u=watkins');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    chooseRow('watkins');
    expect(assign).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('opd-profile-switch-view')).toBeNull();
  });

  it('the load after a switch clicks the stored tab once and forgets it', async () => {
    sessionStorage.setItem('opd-profile-switch-view', 'tab-queue');
    const clicks = vi.fn();
    document.getElementById('tab-queue')!.addEventListener('click', clicks);
    const { mountProfileMenu } = await mountOn('/?u=kutryk');
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('opd-profile-switch-view')).toBeNull();
    mountProfileMenu();
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(menuRows()).toHaveLength(4);
  });

  it('leaves the default tab alone when the switch left from it', async () => {
    sessionStorage.setItem('opd-profile-switch-view', 'tab-map');
    const clicks = vi.fn();
    document.getElementById('tab-map')!.addEventListener('click', clicks);
    await mountOn('/?u=kutryk');
    expect(clicks).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('opd-profile-switch-view')).toBeNull();
  });

  it('marks an offline resume of a server profile and never a roster profile', async () => {
    const { session, mountProfileMenu } = await mountOn('/');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await session.resolveAccountProfile('https://map.astroanil.dev/');
    mountProfileMenu();
    expect(badgeName()).toBe('Anil · Offline');
    await session.resolveAccountProfile('https://map.astroanil.dev/?u=delaney');
    mountProfileMenu();
    expect(badgeName()).toBe('Luke Delaney');
  });

  it('names a local copy without the offline mark', async () => {
    window.history.replaceState({}, '', '/?u=chris');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })));
    const session = await import('../src/profile-session');
    await session.resolveAccountProfile();
    const { mountProfileMenu } = await import('../src/profile-menu');
    mountProfileMenu();
    expect(badgeName()).toBe('chris');
  });

  it('opens the menu under the name, kept 8px inside a narrow screen', async () => {
    await mountOn('/?u=watkins');
    vi.spyOn(document.getElementById('profile-badge')!, 'getBoundingClientRect').mockReturnValue({ bottom: 48, left: 300 } as DOMRect);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    const menu = document.getElementById('profile-menu')!;
    menu.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' }));
    expect([menu.style.top, menu.style.left]).toEqual(['52px', '158px']);
  });
});
