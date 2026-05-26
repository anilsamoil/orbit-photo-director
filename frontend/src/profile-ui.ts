/** Profile tab UI — Slot 2 of design rev 2 (locked 2026-05-26).
 *
 *  Owns the entire Profile pane DOM tree: picker dropdown, new-profile
 *  CTA, delete CTA, and (Slot 7) the distance-threshold slider.
 *
 *  Rendering is one-shot per Map / Log pane convention — `renderProfilePane()`
 *  rebuilds the pane into the `#profile-body` container on every tab
 *  activation. Picker re-renders also fire from the `'profile-changed'`
 *  event (Slot 11) so other tabs / cross-tab writes keep this pane in sync.
 *
 *  Switching the picker dropdown mutates the URL (`?u=<name>` via
 *  `history.pushState`) AND triggers a full page reload. Reload is
 *  intentional in v1 — Slot 5 refines to an in-place manifest swap once
 *  the per-profile manifest fetch path lands. The reload guarantees all
 *  stale caches (currentManifest, snapshots, MapLibre sources) are
 *  flushed; trying to swap in place before Slot 5 would leave dangling
 *  data with the wrong profile.
 *
 *  XSS surface: every operator-provided string (profile names) flows
 *  through `textContent` only — never `innerHTML`. Premise 12 of the
 *  design doc requires no new XSS surfaces; `isValidProfileName` already
 *  caps the character set, but defense-in-depth uses textContent anyway.
 */

import {
  createDefaultProfile,
  isValidProfileName,
  listProfiles,
  loadProfile,
  saveProfile,
  DEFAULT_PROFILE_NAME,
  type Profile,
} from './profile';
import { subscribeProfileChanged } from './profile-events';
import { buildCrudSection } from './profile-crud';

/** Min/max for the distance threshold slider (km). Range chosen to span
 *  "tight nadir only" (100 km) through "well past ISS horizon" (2000 km).
 *  Default 1500 km matches ISS_HORIZON_KM in map.ts. Step 50 km gives the
 *  operator coarse-enough granularity to feel productive without micro-
 *  tweaking. */
const THRESHOLD_MIN_KM = 100;
const THRESHOLD_MAX_KM = 2000;
const THRESHOLD_STEP_KM = 50;
const THRESHOLD_DEFAULT_KM = 1500;

/** Debounce interval for the threshold slider's persistence. Matches the
 *  150ms event-bus debounce (Slot 11). Without this, dragging the slider
 *  would fire 60+ saveProfile calls per second; downstream subscribers
 *  (map.ts re-filter) would thrash. */
const THRESHOLD_DEBOUNCE_MS = 150;

/** Holds the in-flight debounce timer for the threshold slider so a
 *  rapid drag coalesces into one persist + one 'profile-changed' fire. */
let thresholdTimer: number | null = null;
/** Latest pending threshold value while the debounce timer is armed.
 *  Read by the timer when it fires. */
let pendingThresholdKm: number | null = null;

/** Suppress the picker dropdown's 'change' event when WE programmatically
 *  set its value (e.g., from a 'profile-changed' subscriber re-render).
 *  Without this guard, our own re-render would loop back through the
 *  switch-profile reload path. */
let suppressPickerChange = false;

/** One-time bind for the cross-tab + in-tab profile-changed subscriber.
 *  Bound the first time the Profile pane renders. Slot 11 — debounced
 *  150ms + cross-tab storage event automatically handled by the bus. */
let profileChangedBound = false;
function bindProfileChangedSubscriber(): void {
  if (profileChangedBound) return;
  subscribeProfileChanged(() => {
    // The pane may be torn down or unmounted; refreshPickerFromExternalChange
    // is a no-op when #profile-picker-select doesn't exist.
    refreshPickerFromExternalChange();
  });
  profileChangedBound = true;
}

/** Pane render is idempotent. Tab dispatcher calls renderProfilePane()
 *  every time the Profile tab is activated; that's fine — rebuilding the
 *  pane is cheap and ensures picker contents reflect the latest
 *  listProfiles() (e.g., after a new profile was created in another tab). */
export function renderProfilePane(): void {
  const container = document.getElementById('profile-body');
  if (!container) return;
  container.replaceChildren();
  container.appendChild(buildPickerSection());
  container.appendChild(buildThresholdSection());
  // Slot 6 — CRUD UI (add target form + personal list + curated hide).
  // Lives in profile-crud.ts so the file stays scoped per slot; mounted
  // here so the Profile tab is the single home for per-astronaut config.
  const activeName = readActiveProfileName();
  container.appendChild(buildCrudSection(activeName));
  // Subscribe once so subsequent cross-tab edits or other-pane edits
  // refresh the picker dropdown without requiring the user to re-open
  // the Profile tab.
  bindProfileChangedSubscriber();
}

/** Build the picker section: dropdown of known profiles + add/delete CTAs.
 *  Returns the section element ready to be inserted; caller decides
 *  parent layout. */
function buildPickerSection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'profile-section';
  section.id = 'profile-picker-section';

  const heading = document.createElement('h3');
  heading.textContent = 'Active profile';
  section.appendChild(heading);

  const desc = document.createElement('p');
  desc.textContent = 'Each profile keeps its own personal targets and threshold settings. Switching reloads the page so caches stay clean.';
  section.appendChild(desc);

  // --- Picker row --------------------------------------------------------
  const pickerRow = document.createElement('div');
  pickerRow.className = 'profile-row';
  const pickerLabel = document.createElement('label');
  pickerLabel.htmlFor = 'profile-picker-select';
  pickerLabel.textContent = 'Profile:';
  pickerRow.appendChild(pickerLabel);

  const select = document.createElement('select');
  select.id = 'profile-picker-select';
  select.className = 'profile-select';

  // Include the active profile name even if it hasn't been saved yet —
  // listProfiles() reads the persisted name list, but the first-launch
  // profile is added to that list on save. Belt-and-braces: union of
  // listProfiles + active name so the dropdown is never empty.
  const currentName = readActiveProfileName();
  const names = new Set<string>(listProfiles());
  names.add(currentName);
  // Always include the default so first-launchers see a sensible row.
  names.add(DEFAULT_PROFILE_NAME);
  for (const name of Array.from(names).sort()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === currentName) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    if (suppressPickerChange) return;
    const next = select.value;
    if (!isValidProfileName(next)) return;
    if (next === currentName) return;
    switchToProfile(next);
  });
  pickerRow.appendChild(select);
  section.appendChild(pickerRow);

  // --- New profile row ---------------------------------------------------
  const newRow = document.createElement('div');
  newRow.className = 'profile-row';
  const newInput = document.createElement('input');
  newInput.type = 'text';
  newInput.id = 'profile-new-input';
  newInput.className = 'profile-input';
  newInput.placeholder = 'new profile name (a-z, 0-9, -)';
  newInput.autocomplete = 'off';
  newInput.spellcheck = false;
  newRow.appendChild(newInput);
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'profile-btn';
  newBtn.id = 'profile-new-btn';
  newBtn.textContent = 'New profile';
  newRow.appendChild(newBtn);
  const errorEl = document.createElement('div');
  errorEl.className = 'profile-error';
  errorEl.id = 'profile-new-error';
  errorEl.setAttribute('role', 'alert');
  newBtn.addEventListener('click', () => {
    const name = (newInput.value || '').trim();
    errorEl.textContent = '';
    if (!isValidProfileName(name)) {
      errorEl.textContent = 'Invalid name — use a-z, 0-9, or hyphen (max 32 chars).';
      return;
    }
    if (listProfiles().includes(name)) {
      errorEl.textContent = `Profile "${name}" already exists.`;
      return;
    }
    try {
      saveProfile(createDefaultProfile(name));
    } catch (e) {
      errorEl.textContent = (e instanceof Error ? e.message : String(e));
      return;
    }
    newInput.value = '';
    // Switch into the freshly-created profile.
    switchToProfile(name);
  });
  section.appendChild(newRow);
  section.appendChild(errorEl);

  // --- Delete row --------------------------------------------------------
  const delRow = document.createElement('div');
  delRow.className = 'profile-row';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'profile-btn danger';
  delBtn.id = 'profile-delete-btn';
  delBtn.textContent = 'Delete this profile';
  delBtn.addEventListener('click', () => {
    if (!confirmDelete(currentName)) return;
    deleteProfileLocal(currentName);
    // After deletion the URL should fall back to the default profile.
    // switchToProfile handles the pushState + reload pair.
    const fallback = currentName === DEFAULT_PROFILE_NAME
      ? DEFAULT_PROFILE_NAME
      : DEFAULT_PROFILE_NAME;
    switchToProfile(fallback);
  });
  delRow.appendChild(delBtn);
  section.appendChild(delRow);

  return section;
}

/** Build the distance-threshold section (Slot 7 of design rev 2). Slider
 *  binds to `profile.distanceThresholdKm` with a 150ms debounce. Pulls the
 *  initial value from the active profile (falls back to 1500 km when the
 *  profile is missing — same fallback the map uses). */
function buildThresholdSection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'profile-section';
  section.id = 'profile-threshold-section';

  const heading = document.createElement('h3');
  heading.textContent = 'Viable distance threshold';
  section.appendChild(heading);

  const desc = document.createElement('p');
  desc.textContent = 'Passes whose closest approach exceeds this distance are filtered out of the queue, upcoming list, and map. 1500 km matches the default ISS horizon; tighten for nadir-only passes.';
  section.appendChild(desc);

  const initial = readThresholdKm();

  const sliderRow = document.createElement('div');
  sliderRow.className = 'profile-row';
  const sliderLabel = document.createElement('label');
  sliderLabel.htmlFor = 'profile-threshold-slider';
  sliderLabel.textContent = 'Viable distance:';
  sliderRow.appendChild(sliderLabel);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = 'profile-threshold-slider';
  slider.className = 'profile-threshold-slider';
  slider.min = String(THRESHOLD_MIN_KM);
  slider.max = String(THRESHOLD_MAX_KM);
  slider.step = String(THRESHOLD_STEP_KM);
  slider.value = String(initial);
  sliderRow.appendChild(slider);

  const display = document.createElement('span');
  display.id = 'profile-threshold-display';
  display.className = 'profile-threshold-display';
  display.textContent = `${initial} km`;
  sliderRow.appendChild(display);

  // On input: update the display instantly + arm the debounce timer.
  // Debounce coalesces a rapid drag into one saveProfile call + one
  // 'profile-changed' event so downstream subscribers don't thrash.
  slider.addEventListener('input', () => {
    const v = clampThreshold(Number(slider.value));
    display.textContent = `${v} km`;
    pendingThresholdKm = v;
    if (thresholdTimer !== null) window.clearTimeout(thresholdTimer);
    thresholdTimer = window.setTimeout(() => {
      thresholdTimer = null;
      const pending = pendingThresholdKm;
      pendingThresholdKm = null;
      if (pending === null) return;
      persistThreshold(pending);
    }, THRESHOLD_DEBOUNCE_MS);
  });

  section.appendChild(sliderRow);
  return section;
}

function clampThreshold(v: number): number {
  if (!Number.isFinite(v)) return THRESHOLD_DEFAULT_KM;
  if (v < THRESHOLD_MIN_KM) return THRESHOLD_MIN_KM;
  if (v > THRESHOLD_MAX_KM) return THRESHOLD_MAX_KM;
  return Math.round(v);
}

/** Read the active profile's threshold from localStorage. Falls back to
 *  1500 km when the profile is missing — same as the map's existing
 *  ISS_HORIZON_KM behavior. Exported so map.ts can read the threshold
 *  without re-implementing the lookup. */
export function readThresholdKm(): number {
  const name = readActiveProfileName();
  const profile = safeLoadProfile(name);
  return profile?.distanceThresholdKm ?? THRESHOLD_DEFAULT_KM;
}

/** Persist the threshold value to the active profile. If the profile
 *  doesn't exist yet (first-launch + slider moved before any other
 *  save), auto-create + persist. Failures (quota exceeded / private
 *  mode) surface in the picker error area when one exists. */
function persistThreshold(km: number): void {
  const name = readActiveProfileName();
  let profile = safeLoadProfile(name);
  if (!profile) {
    if (!isValidProfileName(name)) return;
    profile = createDefaultProfile(name);
  }
  profile.distanceThresholdKm = km;
  try {
    saveProfile(profile);
  } catch (e) {
    const errorEl = document.getElementById('profile-new-error');
    if (errorEl) errorEl.textContent = `Couldn't save threshold: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function safeLoadProfile(name: string): Profile | null {
  try {
    return loadProfile(name);
  } catch {
    return null;
  }
}

/** Read the active profile name from the URL (?u=<name>) without
 *  importing main.ts's getCurrentProfile (which would create a
 *  circular dependency at module load time). Same precedence as
 *  parseProfileFromURL. */
function readActiveProfileName(): string {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get('u');
    if (q && isValidProfileName(q)) return q;
    const seg = url.pathname.replace(/^\//, '').split('/')[0];
    if (seg && isValidProfileName(seg)) return seg;
  } catch { /* fallthrough */ }
  return DEFAULT_PROFILE_NAME;
}

/** Switch the active profile: mutate URL via pushState + reload so all
 *  in-memory caches are flushed. v1 design decision — Slot 5 will refine
 *  to an in-place swap once the per-profile manifest fetch path lands.
 *
 *  Split out for unit testing — tests stub `history.pushState` and
 *  `location.reload` to verify the URL mutation contract without
 *  actually navigating. */
export function switchToProfile(name: string): void {
  if (!isValidProfileName(name)) return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('u', name);
    window.history.pushState({}, '', url.toString());
  } catch { /* pushState unavailable in some test envs */ }
  try {
    window.location.reload();
  } catch { /* reload unavailable in some test envs (happy-dom default ok) */ }
}

/** Confirm-then-delete. Wraps window.confirm so tests can monkey-patch
 *  it. Returns true if the user confirmed. */
function confirmDelete(name: string): boolean {
  // In test environments without window.confirm, default to false (safer).
  if (typeof window.confirm !== 'function') return false;
  return window.confirm(`Delete profile "${name}"? Personal targets and threshold will be lost.`);
}

/** Remove a profile from localStorage + the known-profiles list. Exposed
 *  for tests; production callers go through the delete button. */
export function deleteProfileLocal(name: string): void {
  if (!isValidProfileName(name)) return;
  try {
    localStorage.removeItem(`opd-profile-${name}`);
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem('opd-profile-names');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((n) => n !== name);
        localStorage.setItem('opd-profile-names', JSON.stringify(filtered));
      }
    }
  } catch { /* ignore */ }
}

/** Re-render the picker dropdown when a 'profile-changed' event fires
 *  (e.g., from a cross-tab save or another module's saveProfile). Slot 11
 *  wires this into the subscribeProfileChanged event bus. Suppresses its
 *  own 'change' event during the value-set so the listener doesn't recurse
 *  into switchToProfile. */
export function refreshPickerFromExternalChange(): void {
  const select = document.getElementById('profile-picker-select') as HTMLSelectElement | null;
  if (!select) return;
  const currentName = readActiveProfileName();
  // Rebuild option list — a 'profile-changed' from another tab may have
  // added/removed profiles. textContent only.
  suppressPickerChange = true;
  try {
    select.replaceChildren();
    const names = new Set<string>(listProfiles());
    names.add(currentName);
    names.add(DEFAULT_PROFILE_NAME);
    for (const name of Array.from(names).sort()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === currentName) opt.selected = true;
      select.appendChild(opt);
    }
    select.value = currentName;
  } finally {
    suppressPickerChange = false;
  }
}

/** Update the topbar profile badge. Reads textContent only (no innerHTML),
 *  per premise 12 of the design doc — no new XSS surfaces. */
export function renderProfileBadge(name: string | null): void {
  const el = document.getElementById('profile-badge');
  if (!el) return;
  if (!name) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  // Plain emoji + name. textContent escapes any unusual characters; the
  // name is also already validated by isValidProfileName before it gets
  // here (lowercase ASCII + digits + hyphen), so the worst case is a
  // visual oddity, not a script-injection surface.
  el.textContent = `👤 ${name}`;
  el.title = `Active profile: ${name}`;
}

/** Test-only state reset. Clears the suppress-recursion flag + the
 *  threshold debounce timer + pending value + the one-time subscriber
 *  guard so consecutive tests don't inherit a poisoned state. Tests
 *  that need the subscriber bound must call renderProfilePane() again
 *  after this reset. */
export function _resetProfileUiForTests(): void {
  suppressPickerChange = false;
  if (thresholdTimer !== null) {
    window.clearTimeout(thresholdTimer);
    thresholdTimer = null;
  }
  pendingThresholdKm = null;
  profileChangedBound = false;
}
