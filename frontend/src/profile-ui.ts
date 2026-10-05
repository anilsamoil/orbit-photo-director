import {
  createDefaultProfile,
  isValidProfileName,
  listProfiles,
  loadProfile,
  parseProfileFromURL,
  saveProfile,
  DEFAULT_PROFILE_NAME,
  type Profile,
} from './profile';
import { subscribeProfileChanged } from './profile-events';
import { buildCrudSection } from './profile-crud';
import { isRosterProfile } from './crew-roster';
import {
  canSelectProfile,
  getAccountProfile,
  getAuthorizedProfiles,
  getSignedInAccountProfile,
  type AccountProfile,
} from './profile-session';

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

/** Suppress the picker dropdown's change event when we set its value. */
let suppressPickerChange = false;

/** One subscriber for cross-tab profile writes, bound on the first pane render. */
let profileChangedBound = false;
function bindProfileChangedSubscriber(): void {
  if (profileChangedBound) return;
  subscribeProfileChanged(() => {
    refreshPickerFromExternalChange();
  });
  profileChangedBound = true;
}

export function renderProfilePane(): void {
  const container = document.getElementById('profile-body');
  if (!container) return;
  container.replaceChildren(
    buildPickerSection(),
    buildThresholdSection(),
    buildCrudSection(readActiveProfileName()),
  );
  bindProfileChangedSubscriber();
}

function discoverProfileKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const m = key.match(/^opd-profile-([a-z0-9][a-z0-9-]{0,31})$/);
      if (!m || !m[1] || !isValidProfileName(m[1]) || isRosterProfile(m[1])) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const blob = JSON.parse(raw) as { version?: unknown; name?: unknown };
        if (typeof blob !== 'object' || blob === null) continue;
        if (typeof blob.version !== 'number') continue;
        if (typeof blob.name !== 'string' || blob.name !== m[1]) continue;
        out.push(m[1]);
      } catch {
        // The names-list cache lives at an opd-profile-* key and is not a profile.
      }
    }
  } catch {
    // Safari private mode throws on localStorage access.
  }
  return out;
}

function buildPickerSection(): HTMLElement {
  const account = getAccountProfile();
  if (account) return buildAccountSection(account);
  return buildLocalPickerSection();
}

function buildAccountSection(account: AccountProfile): HTMLElement {
  const section = document.createElement('section');
  section.className = 'profile-section';
  section.id = 'profile-picker-section';

  const heading = document.createElement('h3');
  const info = document.createElement('p');
  if (isRosterProfile(account.name)) {
    heading.textContent = `Crew roster · ${account.displayName}`;
    info.textContent = 'Crew roster profiles come with the app. Settings, ratings and hidden targets stay on this device.';
    section.append(heading, info);
    return section;
  }

  if (account.localOnly) return buildLocalPickerSection();

  const own = getSignedInAccountProfile();
  const managingCrew = own !== null && own.name !== account.name;
  heading.textContent = `${account.isVerified === false ? 'Active profile' : managingCrew ? 'Crew profile' : 'Your profile'} · ${account.displayName}`;
  info.textContent = account.isVerified === false
    ? 'Offline · using this tab’s last verified profile. Reconnect and reload to sync.'
    : managingCrew
      ? `Signed in as ${own.displayName}. You are managing ${account.displayName}’s targets, settings and ratings.`
      : 'Your Google account opens your own profile by default. Choose an available crew profile below to manage its targets, settings and ratings.';
  section.append(heading, info);

  const authorized = getAuthorizedProfiles();
  if (authorized.length > 1) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const label = document.createElement('label');
    label.htmlFor = 'profile-picker-select';
    label.textContent = 'Profile:';
    const select = document.createElement('select');
    select.id = 'profile-picker-select';
    select.className = 'profile-select';
    populateAuthorizedOptions(select);
    select.addEventListener('change', () => {
      if (!suppressPickerChange && select.value !== readActiveProfileName()) switchToProfile(select.value);
    });
    row.append(label, select);
    section.append(row);
  } else if (account.isVerified !== false) {
    info.textContent = 'Your Google account selects your profile automatically. Personal targets and ratings stay with your account, including when you open a shared map link.';
  }
  if (account.name === 'jessica') {
    const sources = document.createElement('p');
    const link = document.createElement('a');
    link.href = '/profile-research/jessica.html';
    link.textContent = 'Why these targets? Sources and shooting ideas';
    sources.appendChild(link);
    section.appendChild(sources);
  }
  return section;
}

function buildLocalPickerSection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'profile-section';
  section.id = 'profile-picker-section';

  const heading = document.createElement('h3');
  heading.textContent = 'Active profile';
  const desc = document.createElement('p');
  desc.textContent = 'Each profile keeps its own personal targets and threshold settings. Switching reloads the page so caches stay clean.';
  section.append(heading, desc);

  const pickerRow = document.createElement('div');
  pickerRow.className = 'profile-row';
  const pickerLabel = document.createElement('label');
  pickerLabel.htmlFor = 'profile-picker-select';
  pickerLabel.textContent = 'Profile:';
  const select = document.createElement('select');
  select.id = 'profile-picker-select';
  select.className = 'profile-select';
  const currentName = readActiveProfileName();
  fillLocalOptions(select, currentName);
  select.addEventListener('change', () => {
    if (suppressPickerChange) return;
    const next = select.value;
    if (!isValidProfileName(next) || isRosterProfile(next) || next === currentName) return;
    switchToProfile(next);
  });
  pickerRow.append(pickerLabel, select);
  section.appendChild(pickerRow);
  appendLocalCreateDelete(section);
  return section;
}

function localProfileNames(currentName: string): string[] {
  const names = new Set<string>(listProfiles().filter((name) => !isRosterProfile(name)));
  for (const name of discoverProfileKeys()) names.add(name);
  if (!isRosterProfile(currentName)) names.add(currentName);
  names.add(DEFAULT_PROFILE_NAME);
  return Array.from(names).sort();
}

function fillLocalOptions(select: HTMLSelectElement, currentName: string): void {
  select.replaceChildren();
  for (const name of localProfileNames(currentName)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === currentName) opt.selected = true;
    select.appendChild(opt);
  }
  if (!isRosterProfile(currentName)) select.value = currentName;
}

function appendLocalCreateDelete(section: HTMLElement): void {
  const currentName = readActiveProfileName();
  const newRow = document.createElement('div');
  newRow.className = 'profile-row';
  const newInput = document.createElement('input');
  newInput.type = 'text';
  newInput.id = 'profile-new-input';
  newInput.className = 'profile-input';
  newInput.placeholder = 'new profile name (a-z, 0-9, -)';
  newInput.autocomplete = 'off';
  newInput.spellcheck = false;
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'profile-btn';
  newBtn.id = 'profile-new-btn';
  newBtn.textContent = 'New profile';
  newRow.append(newInput, newBtn);
  const errorEl = document.createElement('div');
  errorEl.className = 'profile-error';
  errorEl.id = 'profile-new-error';
  errorEl.setAttribute('role', 'alert');
  newBtn.addEventListener('click', () => {
    const name = (newInput.value || '').trim();
    errorEl.textContent = '';
    if (isRosterProfile(name)) {
      errorEl.textContent = 'Crew roster profiles come with the app.';
      return;
    }
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
    switchToProfile(name);
  });
  section.append(newRow, errorEl);

  const delRow = document.createElement('div');
  delRow.className = 'profile-row';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'profile-btn danger';
  delBtn.id = 'profile-delete-btn';
  delBtn.textContent = 'Delete this profile';
  delBtn.addEventListener('click', () => {
    if (isRosterProfile(currentName)) return;
    if (!confirmDelete(currentName)) return;
    deleteProfileLocal(currentName);
    switchToProfile(DEFAULT_PROFILE_NAME);
  });
  delRow.appendChild(delBtn);
  section.appendChild(delRow);
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

  const errorEl = document.createElement('div');
  errorEl.className = 'profile-error';
  errorEl.id = 'profile-threshold-error';
  errorEl.setAttribute('role', 'alert');

  section.append(sliderRow, errorEl);
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
    const errorEl = document.getElementById('profile-threshold-error');
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

function readActiveProfileName(): string {
  return getAccountProfile()?.name ?? parseProfileFromURL(window.location.href);
}

export function switchToProfile(name: string): void {
  if (isRosterProfile(name)) return;
  const account = getAccountProfile();
  if (account && !account.localOnly && !canSelectProfile(name)) return;
  if (!isValidProfileName(name)) return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('u', name);
    window.history.pushState({}, '', url.toString());
  } catch { /* pushState unavailable in some test envs */ }
  try {
    window.location.reload();
  } catch { /* reload unavailable in some test envs */ }
}

function confirmDelete(name: string): boolean {
  if (typeof window.confirm !== 'function') return false;
  return window.confirm(`Delete profile "${name}"? Personal targets and threshold will be lost.`);
}

export function deleteProfileLocal(name: string): void {
  if (!isValidProfileName(name) || isRosterProfile(name)) return;
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

export function refreshPickerFromExternalChange(): void {
  const select = document.getElementById('profile-picker-select') as HTMLSelectElement | null;
  if (!select) return;
  const currentName = readActiveProfileName();
  suppressPickerChange = true;
  try {
    if (getAccountProfile()) {
      populateAuthorizedOptions(select);
      return;
    }
    fillLocalOptions(select, currentName);
  } finally {
    suppressPickerChange = false;
  }
}

function populateAuthorizedOptions(select: HTMLSelectElement): void {
  select.replaceChildren();
  const own = getSignedInAccountProfile();
  for (const profile of getAuthorizedProfiles()) {
    const option = document.createElement('option');
    option.value = profile.name;
    option.textContent = profile.name === own?.name ? `${profile.displayName} (Your profile)` : profile.displayName;
    option.selected = profile.name === readActiveProfileName();
    select.appendChild(option);
  }
}

export function _resetProfileUiForTests(): void {
  suppressPickerChange = false;
  if (thresholdTimer !== null) {
    window.clearTimeout(thresholdTimer);
    thresholdTimer = null;
  }
  pendingThresholdKm = null;
  profileChangedBound = false;
}
