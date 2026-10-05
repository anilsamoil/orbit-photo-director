import { isRosterProfile, rosterProfiles } from './crew-roster';
import { getAccountProfile } from './profile-session';

const SWITCH_VIEW_KEY = 'opd-profile-switch-view';
const MENU_WIDTH_PX = 224;
const MENU_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;

/** Names the active profile in the top bar and lists the crew roster under it,
 *  then reopens the tab a switch left from. A switch reloads the page, so the
 *  account cannot change under a mounted menu. */
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
  menu.replaceChildren(...rosterProfiles().map((profile) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'profile-menu-item';
    item.dataset.profile = profile.name;
    item.setAttribute('popovertarget', 'profile-menu');
    item.setAttribute('popovertargetaction', 'hide');
    item.textContent = profile.displayName;
    if (profile.name === account.name) item.setAttribute('aria-current', 'true');
    return item;
  }));
  menu.addEventListener('beforetoggle', placeMenu);
  menu.addEventListener('click', chooseProfile);
  restoreSwitchedView();
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

function chooseProfile(event: MouseEvent): void {
  const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.profile-menu-item') : null;
  const name = item?.dataset.profile;
  if (!name || name === getAccountProfile()?.name) return;
  const activeTab = document.querySelector('.tabs .tab.active');
  try {
    if (activeTab?.id) sessionStorage.setItem(SWITCH_VIEW_KEY, activeTab.id);
  } catch { /* storage disabled: the switch lands on the default tab */ }
  const url = new URL(window.location.href);
  url.searchParams.set('u', name);
  window.location.assign(url.href);
}

function restoreSwitchedView(): void {
  let tabId: string | null = null;
  try {
    tabId = sessionStorage.getItem(SWITCH_VIEW_KEY);
    sessionStorage.removeItem(SWITCH_VIEW_KEY);
  } catch { /* storage disabled */ }
  const tab = tabId ? document.getElementById(tabId) : null;
  if (tab?.matches('.tabs .tab:not(.active)')) tab.click();
}
