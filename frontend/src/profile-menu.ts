import { isRosterProfile, rosterProfiles } from './crew-roster';
import { getAccountProfile, getSignedInAccountProfile } from './profile-session';

const SWITCH_VIEW_KEY = 'opd-profile-switch-view';
const MENU_WIDTH_PX = 224;
const MENU_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;

export function mountProfileMenu(): void {
  const account = getAccountProfile();
  const badge = document.getElementById('profile-badge');
  const menu = document.getElementById('profile-menu');
  if (!account || !badge || !menu) return;
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '👤';
  const name = document.createElement('span');
  name.className = 'profile-badge-name';
  name.textContent = account.isVerified === false && !account.localOnly && !isRosterProfile(account.name)
    ? `${account.displayName} · Offline`
    : account.displayName;
  badge.replaceChildren(icon, name);
  badge.hidden = false;
  const signedIn = getSignedInAccountProfile();
  const home = signedIn ?? (isRosterProfile(account.name) ? null : account);
  menu.replaceChildren(
    ...(home ? [menuButton(home, !isRosterProfile(account.name) && account.name === home.name, true)] : []),
    ...rosterProfiles().map((profile) => menuButton(profile, profile.name === account.name, false)),
  );
  const legend = document.getElementById('personal-targets-legend');
  if (legend) legend.textContent = personalTargetsLegend(account.displayName);
  menu.addEventListener('beforetoggle', onMenuToggle);
  menu.addEventListener('click', chooseProfile);
  restoreSwitchedView();
}

function onMenuToggle(event: ToggleEvent): void {
  placeMenu(event);
  window.removeEventListener('keydown', keepMenuEscape, true);
  if (event.newState === 'open') window.addEventListener('keydown', keepMenuEscape, true);
}

function keepMenuEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const menu = document.getElementById('profile-menu');
  if (!(menu instanceof HTMLElement) || !menu.matches(':popover-open')) return;
  event.stopPropagation();
  menu.hidePopover();
}

function placeMenu(event: ToggleEvent): void {
  const menu = event.currentTarget;
  const badge = document.getElementById('profile-badge');
  if (event.newState !== 'open' || !(menu instanceof HTMLElement) || !badge) return;
  const rect = badge.getBoundingClientRect();
  const maxLeft = window.innerWidth - MENU_WIDTH_PX - VIEWPORT_MARGIN_PX;
  menu.style.top = `${Math.round(rect.bottom + MENU_GAP_PX)}px`;
  menu.style.left = `${Math.round(Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.left, maxLeft)))}px`;
}

export function personalTargetsLegend(displayName: string): string {
  return `${displayName}'s targets`;
}

function menuButton(profile: { name: string; displayName: string }, active: boolean, home: boolean): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = home ? 'profile-menu-item profile-menu-home' : 'profile-menu-item';
  item.dataset.profile = profile.name;
  if (home) item.setAttribute('data-profile-home', '');
  item.setAttribute('popovertarget', 'profile-menu');
  item.setAttribute('popovertargetaction', 'hide');
  item.textContent = profile.displayName;
  if (active) item.setAttribute('aria-current', 'true');
  return item;
}

function rememberTab(): void {
  const activeTab = document.querySelector('.tabs .tab.active');
  try {
    if (activeTab?.id) sessionStorage.setItem(SWITCH_VIEW_KEY, activeTab.id);
  } catch {}
}

function chooseProfile(event: MouseEvent): void {
  const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.profile-menu-item') : null;
  if (!item) return;
  const account = getAccountProfile();
  const url = new URL(window.location.href);
  if (item.hasAttribute('data-profile-home')) {
    const onHome = account !== null && !isRosterProfile(account.name) && account.name === item.dataset.profile;
    if (onHome && !url.searchParams.has('u')) return;
    rememberTab();
    url.searchParams.delete('u');
    window.location.assign(url.href);
    return;
  }
  const name = item.dataset.profile;
  if (!name || name === account?.name) return;
  rememberTab();
  url.searchParams.set('u', name);
  window.location.assign(url.href);
}

function restoreSwitchedView(): void {
  let tabId: string | null = null;
  try {
    tabId = sessionStorage.getItem(SWITCH_VIEW_KEY);
    sessionStorage.removeItem(SWITCH_VIEW_KEY);
  } catch {}
  const tab = tabId ? document.getElementById(tabId) : null;
  if (tab?.matches('.tabs .tab:not(.active)')) tab.click();
}
