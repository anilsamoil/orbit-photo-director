/** Slot 7 tests for the Profile tab UI.
 *
 *  Slot 7 (threshold slider): slider value persists to profile after the
 *  150ms debounce; reading from the active profile renders the right
 *  starting value; filter integration is covered by map.ts unit tests
 *  but verified at the data layer here too.
 *
 *  Test env is happy-dom (vite.config). localStorage is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetProfileUiForTests, renderProfilePane } from '../src/profile-ui';
import {
  createDefaultProfile,
  listProfiles,
  loadProfile,
  saveProfile,
} from '../src/profile';

// happy-dom serves the same window/document the production code expects.
// Each test rebuilds the minimal DOM main.ts / profile-ui.ts touch.
const DOM = `
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

beforeEach(() => {
  localStorage.clear();
  _resetProfileUiForTests();
  setupDom();
  setLocation('/?u=anil');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('renderProfilePane', () => {
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

describe('fresh-app recovery profile', () => {
  it('opens Anil and keeps his settings at the bare recovery URL', () => {
    const anil = createDefaultProfile('anil');
    anil.distanceThresholdKm = 700;
    saveProfile(anil);
    setLocation('/api/app');
    renderProfilePane();
    expect((document.getElementById('profile-threshold-slider') as HTMLInputElement).value).toBe('700');
    expect(listProfiles()).not.toContain('api');
  });
});
