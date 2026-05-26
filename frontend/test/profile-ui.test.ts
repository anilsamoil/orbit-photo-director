/** Slot 2 + Slot 7 tests for the Profile tab UI.
 *
 *  Slot 2 (picker): renders picker, switches profile (mutates URL +
 *  reload), creates new profile (with validation), deletes profile,
 *  updates topbar badge on 'profile-changed'.
 *
 *  Slot 7 (threshold slider): slider value persists to profile after the
 *  150ms debounce; reading from the active profile renders the right
 *  starting value; filter integration is covered by map.ts unit tests
 *  but verified at the data layer here too.
 *
 *  Test env is happy-dom (vite.config). localStorage is real; window.confirm
 *  / history.pushState / location.reload need stubs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetProfileUiForTests,
  deleteProfileLocal,
  refreshPickerFromExternalChange,
  renderProfileBadge,
  renderProfilePane,
  switchToProfile,
} from '../src/profile-ui';
import {
  createDefaultProfile,
  listProfiles,
  loadProfile,
  saveProfile,
} from '../src/profile';

// happy-dom serves the same window/document the production code expects.
// Each test rebuilds the minimal DOM main.ts / profile-ui.ts touch.
const DOM = `
  <span id="profile-badge" hidden></span>
  <main id="view">
    <section id="profile-pane">
      <div id="profile-body"></div>
    </section>
  </main>
`;

function setupDom(): void {
  document.body.innerHTML = DOM;
}

function setLocation(href: string): void {
  // happy-dom's history APIs reject cross-origin URLs (SecurityError).
  // We only need pathname + search to drive parseProfileFromURL, so feed
  // a same-origin path with the ?u= query attached.
  try {
    const u = new URL(href, window.location.origin);
    window.history.replaceState({}, '', u.pathname + u.search);
  } catch {
    window.history.replaceState({}, '', href);
  }
}

// Save the original window.location so tests that monkey-patch it can
// restore the real object in afterEach. happy-dom serves a real Location
// with proper origin/href getters; tests stub it with a plain object to
// observe reload() calls, which would otherwise navigate the harness.
const ORIGINAL_LOCATION = window.location;

beforeEach(() => {
  localStorage.clear();
  _resetProfileUiForTests();
  setupDom();
  // Reset location to the harness origin before each test so we have a
  // known parseProfileFromURL input. setLocation strips to pathname+search
  // so this stays same-origin.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: ORIGINAL_LOCATION,
  });
  setLocation('/?u=anil');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // Restore the genuine Location so the next test's setLocation works.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: ORIGINAL_LOCATION,
  });
});

// ---------------------------------------------------------------------------
// renderProfilePane — picker dropdown + scaffold
// ---------------------------------------------------------------------------

describe('renderProfilePane', () => {
  it('renders the picker with the active profile selected', () => {
    saveProfile(createDefaultProfile('anil'));
    saveProfile(createDefaultProfile('jack'));
    setLocation('https://map.example.test/?u=jack');
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('jack');
    const opts = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(opts).toContain('anil');
    expect(opts).toContain('jack');
  });

  it('always includes the default profile name even with empty localStorage', () => {
    setLocation('https://map.example.test/');
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    const opts = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(opts).toContain('anil'); // DEFAULT_PROFILE_NAME
  });

  it('renders the New profile input + button', () => {
    renderProfilePane();
    expect(document.getElementById('profile-new-input')).toBeTruthy();
    expect(document.getElementById('profile-new-btn')).toBeTruthy();
  });

  it('renders the Delete button', () => {
    renderProfilePane();
    expect(document.getElementById('profile-delete-btn')).toBeTruthy();
  });

  it('renders the threshold section with slider + display (slot 7)', () => {
    renderProfilePane();
    expect(document.getElementById('profile-threshold-section')).toBeTruthy();
    expect(document.getElementById('profile-threshold-slider')).toBeTruthy();
    expect(document.getElementById('profile-threshold-display')).toBeTruthy();
  });

  it('renders the threshold slider with the active profile value', () => {
    const p = createDefaultProfile('anil');
    p.distanceThresholdKm = 800;
    saveProfile(p);
    renderProfilePane();
    const slider = document.getElementById('profile-threshold-slider') as HTMLInputElement;
    expect(slider.value).toBe('800');
    const display = document.getElementById('profile-threshold-display') as HTMLElement;
    expect(display.textContent).toBe('800 km');
  });

  it('falls back to 1500 km when no profile is loaded', () => {
    setLocation('/?u=newbie');
    renderProfilePane();
    const slider = document.getElementById('profile-threshold-slider') as HTMLInputElement;
    expect(slider.value).toBe('1500');
  });

  it('uses textContent (no innerHTML) for option labels — XSS defense', () => {
    // We can't directly inject a malicious name (validation refuses), but
    // verify the structural property: every <option>'s textContent equals
    // its value (i.e., no HTML was interpolated). Belt-and-braces.
    saveProfile(createDefaultProfile('jack'));
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    for (const opt of Array.from(select.querySelectorAll('option'))) {
      expect(opt.textContent).toBe(opt.value);
    }
  });
});

// ---------------------------------------------------------------------------
// switchToProfile — mutates URL via pushState + reloads.
// ---------------------------------------------------------------------------

describe('switchToProfile', () => {
  it('calls history.pushState with the new ?u= value', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    // happy-dom's location.reload exists but throws "not implemented".
    // Catch via the try/catch already in switchToProfile.
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy, href: window.location.origin + '/?u=anil' },
    });
    switchToProfile('jack');
    expect(pushSpy).toHaveBeenCalled();
    const lastCall = pushSpy.mock.calls.at(-1);
    expect(lastCall?.[2]).toContain('u=jack');
    expect(reloadSpy).toHaveBeenCalled();
  });

  it('ignores invalid profile names', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    switchToProfile('INVALID');
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Picker change handler — fires switchToProfile.
// ---------------------------------------------------------------------------

describe('picker dropdown change', () => {
  it('triggers switchToProfile when the user picks a different option', () => {
    saveProfile(createDefaultProfile('anil'));
    saveProfile(createDefaultProfile('jack'));
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy, href: window.location.origin + '/?u=anil' },
    });
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    select.value = 'jack';
    select.dispatchEvent(new Event('change'));
    expect(pushSpy).toHaveBeenCalled();
    const lastCall = pushSpy.mock.calls.at(-1);
    expect(lastCall?.[2]).toContain('u=jack');
    expect(reloadSpy).toHaveBeenCalled();
  });

  it('does nothing when the user re-selects the current profile', () => {
    saveProfile(createDefaultProfile('anil'));
    const pushSpy = vi.spyOn(window.history, 'pushState');
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    select.value = 'anil';
    select.dispatchEvent(new Event('change'));
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// New profile flow — validates, persists, switches.
// ---------------------------------------------------------------------------

describe('new profile button', () => {
  it('rejects an invalid name without crashing', () => {
    renderProfilePane();
    const input = document.getElementById('profile-new-input') as HTMLInputElement;
    const btn = document.getElementById('profile-new-btn') as HTMLButtonElement;
    const err = document.getElementById('profile-new-error') as HTMLElement;
    input.value = 'BAD NAME';
    btn.click();
    expect(err.textContent).toMatch(/invalid/i);
    expect(listProfiles()).not.toContain('BAD NAME');
  });

  it('rejects an empty name', () => {
    renderProfilePane();
    const input = document.getElementById('profile-new-input') as HTMLInputElement;
    const btn = document.getElementById('profile-new-btn') as HTMLButtonElement;
    const err = document.getElementById('profile-new-error') as HTMLElement;
    input.value = '';
    btn.click();
    expect(err.textContent).toMatch(/invalid/i);
  });

  it('rejects a duplicate name with a clear message', () => {
    saveProfile(createDefaultProfile('jack'));
    renderProfilePane();
    const input = document.getElementById('profile-new-input') as HTMLInputElement;
    const btn = document.getElementById('profile-new-btn') as HTMLButtonElement;
    const err = document.getElementById('profile-new-error') as HTMLElement;
    input.value = 'jack';
    btn.click();
    expect(err.textContent).toMatch(/already exists/i);
  });

  it('creates + persists + switches into the new profile on a valid name', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy, href: window.location.origin + '/?u=anil' },
    });
    renderProfilePane();
    const input = document.getElementById('profile-new-input') as HTMLInputElement;
    const btn = document.getElementById('profile-new-btn') as HTMLButtonElement;
    input.value = 'jack';
    btn.click();
    expect(listProfiles()).toContain('jack');
    expect(loadProfile('jack')).not.toBeNull();
    expect(pushSpy).toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Delete button — confirms, removes from localStorage, switches to default.
// ---------------------------------------------------------------------------

describe('delete button', () => {
  it('does nothing when the user cancels the confirm', () => {
    saveProfile(createDefaultProfile('jack'));
    setLocation('https://map.example.test/?u=jack');
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderProfilePane();
    const btn = document.getElementById('profile-delete-btn') as HTMLButtonElement;
    btn.click();
    expect(listProfiles()).toContain('jack');
  });

  it('removes from listProfiles + switches to default on confirm', () => {
    saveProfile(createDefaultProfile('anil'));
    saveProfile(createDefaultProfile('jack'));
    setLocation('https://map.example.test/?u=jack');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy, href: window.location.origin + '/?u=jack' },
    });
    renderProfilePane();
    const btn = document.getElementById('profile-delete-btn') as HTMLButtonElement;
    btn.click();
    expect(listProfiles()).not.toContain('jack');
    expect(loadProfile('jack')).toBeNull();
    // Switched to default
    expect(pushSpy).toHaveBeenCalled();
    const last = pushSpy.mock.calls.at(-1);
    expect(last?.[2]).toContain('u=anil');
  });
});

describe('deleteProfileLocal', () => {
  it('removes the profile + updates the known-names list', () => {
    saveProfile(createDefaultProfile('jack'));
    saveProfile(createDefaultProfile('anil'));
    expect(listProfiles()).toContain('jack');
    deleteProfileLocal('jack');
    expect(loadProfile('jack')).toBeNull();
    expect(listProfiles()).not.toContain('jack');
    expect(listProfiles()).toContain('anil');
  });

  it('refuses to delete an invalid name', () => {
    deleteProfileLocal('../etc');
    // No assertion needed beyond "did not crash"; localStorage untouched.
    expect(listProfiles()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Topbar badge updates.
// ---------------------------------------------------------------------------

describe('renderProfileBadge', () => {
  it('shows the profile name with the 👤 emoji prefix', () => {
    renderProfileBadge('jack');
    const el = document.getElementById('profile-badge') as HTMLElement;
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('👤 jack');
    expect(el.title).toContain('jack');
  });

  it('hides the badge when name is null', () => {
    renderProfileBadge('jack');
    renderProfileBadge(null);
    const el = document.getElementById('profile-badge') as HTMLElement;
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
  });

  it('uses textContent (no innerHTML) — no XSS surface', () => {
    // The badge is updated through textContent so even a hypothetical
    // malicious name can't inject markup. Verify by checking that the
    // rendered text equals the literal string we passed.
    renderProfileBadge('a-b-1');
    const el = document.getElementById('profile-badge') as HTMLElement;
    expect(el.innerHTML).toContain('👤 a-b-1');
    // No script/img tags injected
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// External profile-changed refresh (suppress recursion guard).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Threshold slider (Slot 7) — debounced persist + display.
// ---------------------------------------------------------------------------

describe('threshold slider', () => {
  it('persists the value to the profile after the 150ms debounce', () => {
    vi.useFakeTimers();
    saveProfile(createDefaultProfile('anil'));
    renderProfilePane();
    const slider = document.getElementById('profile-threshold-slider') as HTMLInputElement;
    slider.value = '900';
    slider.dispatchEvent(new Event('input'));
    // Before debounce fires, profile is unchanged.
    expect(loadProfile('anil')?.distanceThresholdKm).toBe(1500);
    vi.advanceTimersByTime(160);
    expect(loadProfile('anil')?.distanceThresholdKm).toBe(900);
  });

  it('coalesces rapid drags into one persist (150ms window)', () => {
    vi.useFakeTimers();
    saveProfile(createDefaultProfile('anil'));
    renderProfilePane();
    const slider = document.getElementById('profile-threshold-slider') as HTMLInputElement;
    for (const v of ['800', '900', '1000', '1100', '1200']) {
      slider.value = v;
      slider.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(10);
    }
    // All within debounce window — still nothing persisted yet.
    expect(loadProfile('anil')?.distanceThresholdKm).toBe(1500);
    vi.advanceTimersByTime(200);
    expect(loadProfile('anil')?.distanceThresholdKm).toBe(1200);
  });

  it('updates the display label immediately on input (before debounce)', () => {
    vi.useFakeTimers();
    saveProfile(createDefaultProfile('anil'));
    renderProfilePane();
    const slider = document.getElementById('profile-threshold-slider') as HTMLInputElement;
    const display = document.getElementById('profile-threshold-display') as HTMLElement;
    slider.value = '750';
    slider.dispatchEvent(new Event('input'));
    expect(display.textContent).toBe('750 km');
    // Profile not yet persisted (still in debounce window).
    expect(loadProfile('anil')?.distanceThresholdKm).toBe(1500);
  });

  it('auto-creates a profile when the slider is moved before any save', () => {
    vi.useFakeTimers();
    setLocation('/?u=newbie');
    renderProfilePane();
    const slider = document.getElementById('profile-threshold-slider') as HTMLInputElement;
    slider.value = '600';
    slider.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(160);
    const p = loadProfile('newbie');
    expect(p).not.toBeNull();
    expect(p!.distanceThresholdKm).toBe(600);
  });

  it('fires the profile-changed event after persisting', () => {
    vi.useFakeTimers();
    saveProfile(createDefaultProfile('anil'));
    renderProfilePane();
    const slider = document.getElementById('profile-threshold-slider') as HTMLInputElement;
    const listener = vi.fn();
    window.addEventListener('profile-changed', listener);
    slider.value = '500';
    slider.dispatchEvent(new Event('input'));
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('profile-changed', listener);
  });
});

describe('refreshPickerFromExternalChange', () => {
  it('repopulates the picker without firing the change handler', () => {
    saveProfile(createDefaultProfile('anil'));
    renderProfilePane();
    // Add a new profile externally (simulating another tab's save).
    saveProfile(createDefaultProfile('jack'));
    const pushSpy = vi.spyOn(window.history, 'pushState');
    refreshPickerFromExternalChange();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    const opts = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(opts).toContain('jack');
    // No recursion into switchToProfile.
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
