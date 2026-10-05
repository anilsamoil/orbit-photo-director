import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetProfileUiForTests,
  deleteProfileLocal,
  refreshPickerFromExternalChange,
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
const ORIGINAL_LOCATION = window.location;

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

beforeEach(() => {
  localStorage.clear();
  _resetProfileUiForTests();
  setupDom();
  Object.defineProperty(window, 'location', { configurable: true, value: ORIGINAL_LOCATION });
  setLocation('/?u=anil');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, value: ORIGINAL_LOCATION });
});

describe('renderProfilePane', () => {
  it('renders the picker with the active profile selected', () => {
    saveProfile(createDefaultProfile('anil'));
    saveProfile(createDefaultProfile('jack'));
    setLocation('https://map.example.test/?u=jack');
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('jack');
    const opts = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('anil');
    expect(opts).toContain('jack');
  });

  it('always includes the default profile name even with empty localStorage', () => {
    setLocation('https://map.example.test/');
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    const opts = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('anil');
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
    saveProfile(createDefaultProfile('jack'));
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    for (const opt of Array.from(select.querySelectorAll('option'))) {
      expect(opt.textContent).toBe(opt.value);
    }
  });

  it('discovers profiles from localStorage even when names-list cache is stale', () => {
    saveProfile(createDefaultProfile('anil'));
    saveProfile(createDefaultProfile('jack'));
    localStorage.setItem('opd-profile-names', JSON.stringify(['anil']));
    expect(listProfiles()).toEqual(['anil']);
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    const opts = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('anil');
    expect(opts).toContain('jack');
  });

  it('does NOT surface the names-list key as a profile named "names"', () => {
    saveProfile(createDefaultProfile('anil'));
    expect(localStorage.getItem('opd-profile-names')).not.toBeNull();
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    const opts = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('anil');
    expect(opts).not.toContain('names');
  });

  it('filters malformed opd-profile-* keys via isValidProfileName', () => {
    saveProfile(createDefaultProfile('anil'));
    localStorage.setItem('opd-profile-WITH_CAPS', '{}');
    localStorage.setItem('opd-profile-', '{}');
    localStorage.setItem('opd-profile-has_underscore', '{}');
    renderProfilePane();
    const select = document.getElementById('profile-picker-select') as HTMLSelectElement;
    const opts = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('anil');
    expect(opts).not.toContain('WITH_CAPS');
    expect(opts).not.toContain('');
    expect(opts).not.toContain('has_underscore');
  });

  it('leaves crew roster names out of the local picker', () => {
    saveProfile(createDefaultProfile('anil'));
    saveProfile(createDefaultProfile('watkins'));
    renderProfilePane();
    const opts = Array.from(document.querySelectorAll('#profile-picker-select option')).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('anil');
    expect(opts).not.toContain('watkins');
    const input = document.getElementById('profile-new-input') as HTMLInputElement;
    input.value = 'kutryk';
    (document.getElementById('profile-new-btn') as HTMLButtonElement).click();
    expect(document.getElementById('profile-new-error')?.textContent).toBe('Crew roster profiles come with the app.');
    expect(listProfiles()).not.toContain('kutryk');
  });
});

describe('switchToProfile', () => {
  it('calls history.pushState with the new ?u= value', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy, href: window.location.origin + '/?u=anil' },
    });
    switchToProfile('jack');
    expect(pushSpy).toHaveBeenCalled();
    expect(pushSpy.mock.calls.at(-1)?.[2]).toContain('u=jack');
    expect(reloadSpy).toHaveBeenCalled();
  });

  it('ignores invalid profile names', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    switchToProfile('INVALID');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('does not switch into a crew roster profile', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    switchToProfile('watkins');
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

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
    expect(pushSpy.mock.calls.at(-1)?.[2]).toContain('u=jack');
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

describe('new profile button', () => {
  it('rejects an invalid name without crashing', () => {
    renderProfilePane();
    const input = document.getElementById('profile-new-input') as HTMLInputElement;
    const btn = document.getElementById('profile-new-btn') as HTMLButtonElement;
    input.value = 'BAD NAME';
    btn.click();
    expect(document.getElementById('profile-new-error')?.textContent).toMatch(/invalid/i);
    expect(listProfiles()).not.toContain('BAD NAME');
  });

  it('rejects an empty name', () => {
    renderProfilePane();
    (document.getElementById('profile-new-btn') as HTMLButtonElement).click();
    expect(document.getElementById('profile-new-error')?.textContent).toMatch(/invalid/i);
  });

  it('rejects a duplicate name with a clear message', () => {
    saveProfile(createDefaultProfile('jack'));
    renderProfilePane();
    const input = document.getElementById('profile-new-input') as HTMLInputElement;
    input.value = 'jack';
    (document.getElementById('profile-new-btn') as HTMLButtonElement).click();
    expect(document.getElementById('profile-new-error')?.textContent).toMatch(/already exists/i);
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
    input.value = 'jack';
    (document.getElementById('profile-new-btn') as HTMLButtonElement).click();
    expect(listProfiles()).toContain('jack');
    expect(loadProfile('jack')).not.toBeNull();
    expect(pushSpy).toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalled();
  });
});

describe('delete button', () => {
  it('does nothing when the user cancels the confirm', () => {
    saveProfile(createDefaultProfile('jack'));
    setLocation('https://map.example.test/?u=jack');
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderProfilePane();
    (document.getElementById('profile-delete-btn') as HTMLButtonElement).click();
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
    (document.getElementById('profile-delete-btn') as HTMLButtonElement).click();
    expect(listProfiles()).not.toContain('jack');
    expect(loadProfile('jack')).toBeNull();
    expect(pushSpy.mock.calls.at(-1)?.[2]).toContain('u=anil');
  });
});

describe('deleteProfileLocal', () => {
  it('removes the profile + updates the known-names list', () => {
    saveProfile(createDefaultProfile('jack'));
    saveProfile(createDefaultProfile('anil'));
    deleteProfileLocal('jack');
    expect(loadProfile('jack')).toBeNull();
    expect(listProfiles()).not.toContain('jack');
    expect(listProfiles()).toContain('anil');
  });

  it('refuses to delete an invalid name or a crew roster profile', () => {
    saveProfile(createDefaultProfile('watkins'));
    deleteProfileLocal('../etc');
    deleteProfileLocal('watkins');
    expect(listProfiles()).toContain('watkins');
  });
});

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

  it('shows a failed save under the slider', () => {
    vi.useFakeTimers();
    saveProfile(createDefaultProfile('anil'));
    renderProfilePane();
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const slider = document.getElementById('profile-threshold-slider') as HTMLInputElement;
    slider.value = '700';
    slider.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(160);
    expect(document.getElementById('profile-threshold-error')?.textContent)
      .toBe('Couldn\'t save threshold: failed to save profile "anil": quota exceeded');
  });
});

describe('refreshPickerFromExternalChange', () => {
  it('repopulates the picker without firing the change handler', () => {
    saveProfile(createDefaultProfile('anil'));
    renderProfilePane();
    saveProfile(createDefaultProfile('jack'));
    const pushSpy = vi.spyOn(window.history, 'pushState');
    refreshPickerFromExternalChange();
    const opts = Array.from(document.querySelectorAll('#profile-picker-select option')).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('jack');
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe('fresh-app recovery profile', () => {
  it('opens Anil and keeps his settings at the bare recovery URL', () => {
    const anil = createDefaultProfile('anil');
    anil.distanceThresholdKm = 700;
    saveProfile(anil);
    setLocation('/api/app');
    renderProfilePane();
    expect(document.querySelector<HTMLSelectElement>('#profile-picker-select')?.value).toBe('anil');
    expect((document.getElementById('profile-threshold-slider') as HTMLInputElement).value).toBe('700');
    expect(listProfiles()).not.toContain('api');
  });
});
