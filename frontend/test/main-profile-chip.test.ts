/** Bug 1 — topbar profile chip becomes a discoverable profile switcher.
 *
 *  Covers `renderTopbarProfileBadge` (in src/main.ts):
 *    - chip carries role + tabindex + aria-label so it's keyboard-reachable
 *    - clicking the chip activates the Profile tab
 *    - Enter / Space keydown on the chip activates the Profile tab
 *    - scroll-into-view fires when the picker section is mounted
 *
 *  Tests bypass main.init() — we only need the badge renderer and a
 *  minimal DOM with the IDs it touches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DOM = `
  <header>
    <span id="profile-badge" hidden></span>
    <button id="tab-profile"></button>
  </header>
  <main>
    <section id="profile-pane">
      <section id="profile-picker-section"></section>
    </section>
  </main>
`;

beforeEach(() => {
  document.body.innerHTML = DOM;
  // Reset module state so the per-test renderTopbarProfileBadge calls
  // re-bind listeners cleanly. The badge module-scope guard otherwise
  // persists between tests and the click handler would point at a
  // previous test's DOM node.
  vi.resetModules();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('renderTopbarProfileBadge — Bug 1 affordance', () => {
  it('adds role=button, aria-label, tabindex, and pointer cursor', async () => {
    const { renderTopbarProfileBadge } = await import('../src/main');
    renderTopbarProfileBadge('jack');
    const el = document.getElementById('profile-badge')!;
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('aria-label')).toBe('Switch profile');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.style.cursor).toBe('pointer');
    expect(el.title).toMatch(/click to switch/i);
  });

  it('clicking the chip activates the Profile tab', async () => {
    const { renderTopbarProfileBadge } = await import('../src/main');
    renderTopbarProfileBadge('jack');
    const tab = document.getElementById('tab-profile')!;
    const tabClick = vi.fn();
    tab.addEventListener('click', tabClick);
    const el = document.getElementById('profile-badge')!;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(tabClick).toHaveBeenCalledTimes(1);
  });

  it('Enter key on the chip activates the Profile tab', async () => {
    const { renderTopbarProfileBadge } = await import('../src/main');
    renderTopbarProfileBadge('jack');
    const tab = document.getElementById('tab-profile')!;
    const tabClick = vi.fn();
    tab.addEventListener('click', tabClick);
    const el = document.getElementById('profile-badge')!;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(tabClick).toHaveBeenCalledTimes(1);
  });

  it('Space key on the chip activates the Profile tab', async () => {
    const { renderTopbarProfileBadge } = await import('../src/main');
    renderTopbarProfileBadge('jack');
    const tab = document.getElementById('tab-profile')!;
    const tabClick = vi.fn();
    tab.addEventListener('click', tabClick);
    const el = document.getElementById('profile-badge')!;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(tabClick).toHaveBeenCalledTimes(1);
  });

  it('scrolls the picker section into view after activation', async () => {
    const { renderTopbarProfileBadge } = await import('../src/main');
    renderTopbarProfileBadge('jack');
    const picker = document.getElementById('profile-picker-section')!;
    const scrollSpy = vi.fn();
    picker.scrollIntoView = scrollSpy as unknown as typeof picker.scrollIntoView;

    const el = document.getElementById('profile-badge')!;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Two rAF ticks deferred — flush them.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('does not stack duplicate click handlers across re-renders', async () => {
    const { renderTopbarProfileBadge } = await import('../src/main');
    renderTopbarProfileBadge('jack');
    renderTopbarProfileBadge('jack');
    renderTopbarProfileBadge('anil');
    const tab = document.getElementById('tab-profile')!;
    const tabClick = vi.fn();
    tab.addEventListener('click', tabClick);
    const el = document.getElementById('profile-badge')!;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(tabClick).toHaveBeenCalledTimes(1);
  });
});
