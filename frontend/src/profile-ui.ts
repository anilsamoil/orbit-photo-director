import {
  createDefaultProfile,
  isValidProfileName,
  loadProfile,
  parseProfileFromURL,
  saveProfile,
  type Profile,
} from './profile';
import { buildCrudSection } from './profile-crud';
import { isRosterProfile } from './crew-roster';
import { getAccountProfile, getSignedInAccountProfile } from './profile-session';

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

export function renderProfilePane(): void {
  const container = document.getElementById('profile-body');
  if (!container) return;
  container.replaceChildren(
    buildIdentitySection(),
    buildThresholdSection(),
    buildCrudSection(readActiveProfileName()),
  );
}

function buildIdentitySection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'profile-section';
  section.id = 'profile-identity-section';

  const heading = document.createElement('h3');
  heading.textContent = 'Active profile';
  section.appendChild(heading);

  const account = getAccountProfile();
  if (!account) return section;
  const info = document.createElement('p');
  if (isRosterProfile(account.name)) {
    heading.textContent = `Crew roster · ${account.displayName}`;
    info.textContent = 'Crew roster profiles come with the app. Settings, ratings and hidden targets stay on this device.';
  } else {
    const own = getSignedInAccountProfile();
    const managingCrew = own !== null && own.name !== account.name;
    heading.textContent = `${account.isVerified === false ? 'Active profile' : managingCrew ? 'Crew profile' : 'Your profile'} · ${account.displayName}`;
    info.textContent = account.localOnly
      ? 'This copy has no Google sign-in. Your saved targets and ratings stay on this device.'
      : account.isVerified === false
        ? 'Offline · using this tab’s last verified profile. Reconnect and reload to sync.'
        : managingCrew
          ? `Signed in as ${own.displayName}. You are managing ${account.displayName}’s targets, settings and ratings.`
          : 'Your Google account selects your profile automatically. Use the name in the top bar to open a crew roster profile.';
  }
  section.appendChild(info);
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

/** Read the active profile name from the URL (?u=<name>) without
 *  importing main.ts's getCurrentProfile (which would create a
 *  circular dependency at module load time). Same precedence as
 *  parseProfileFromURL. */
function readActiveProfileName(): string {
  return getAccountProfile()?.name ?? parseProfileFromURL(window.location.href);
}

export function _resetProfileUiForTests(): void {
  if (thresholdTimer !== null) {
    window.clearTimeout(thresholdTimer);
    thresholdTimer = null;
  }
  pendingThresholdKm = null;
}
