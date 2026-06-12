/** Profile-tab CRUD UI — Slot 6 of design rev 2 (locked 2026-05-26).
 *
 *  Owns three sub-sections inside the Profile pane:
 *    1. Add-target form (name + lat + lon + priority)
 *    2. Personal-targets list (delete button per row)
 *    3. Removed-curated input + chip list (toggle curated id removed-state)
 *
 *  Each mutation follows the optimistic-UI flow from the design doc:
 *    user click → client-side validate → mutate local profile + save() +
 *    re-render → fire API call → on failure, rollback local mutation +
 *    re-render + toast.
 *
 *  No event-bus emission — saveProfile() already dispatches
 *  `profile-changed` (Slot 11). When slot 11's debounced bus lands, this
 *  module gets the benefit for free.
 *
 *  XSS surface: every operator-provided string flows through textContent
 *  (premise 12 — no new XSS surfaces). The personal-target `name` is the
 *  one wholly operator-controlled string in this module; never interpolated
 *  into innerHTML.
 */

import {
  addPersonalTarget,
  addPersonalTargetsBatch,
  isValidProfileName,
  loadProfile,
  makePersonalTargetId,
  removePersonalTarget,
  saveProfile,
  toggleCuratedRemoved,
  validatePersonalTargetInput,
  type PersonalTarget,
  type Profile,
} from './profile';
import {
  deleteProfileTarget,
  getProfileTargets,
  postProfileTarget,
  putProfileTargets,
} from './profile-api';
import { parseTargetCsv, type ParsedValidRow, type ParseTargetCsvResult } from './csv-parse';
import {
  downloadProfileJson,
  readProfileImportFile,
  type ImportResult,
} from './profile-json-io';
import { fetchLog } from './log';
import { fetchCuratedTargets } from './manifest';
import type { CuratedTarget, Manifest } from './types';
import { getCurrentManifest } from './main';
import { geocode, type GeocodeResult } from './profile-geocode';

/** App version stamped into export envelopes. Injected by Vite's `define`
 *  at build time from the repo-root VERSION file (see vite.config.ts) so
 *  /ship's automatic version bump flows here without a manual edit. The
 *  `typeof` guard provides a `1.6.x.dev` fallback under vitest, where the
 *  define pass does not run. Tests that assert on the envelope shape
 *  should match either a real four-segment slug or this sentinel. */
const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.6.x.dev';

/** Per-error-code human-readable message. Mirrors worker validation
 *  codes from validatePersonalTargetInput. */
const ERROR_MESSAGES: Record<string, string> = {
  name_empty: 'Name is required.',
  name_too_long: 'Name is too long (max 200 chars).',
  lat_must_be_finite_number: 'Latitude must be a number.',
  lat_out_of_range: 'Latitude must be between -90 and 90.',
  lon_must_be_finite_number: 'Longitude must be a number.',
  lon_out_of_range: 'Longitude must be between -180 and 180.',
  priority_must_be_integer: 'Priority must be an integer 1-10.',
  priority_out_of_range: 'Priority must be between 1 and 10.',
  invalid_profile_name: 'Active profile name is invalid; reload the page.',
  invalid_id: 'Target id is malformed.',
  id_profile_mismatch: 'Target id does not match the active profile.',
  invalid_createdAt: 'Created-at timestamp is invalid.',
  // CSV-import-specific codes
  wrong_column_count: 'Wrong number of columns (expected name, lat, lon[, priority]).',
  invalid_header: 'CSV must have a header row: name,lat,lon (or name,lat,lon,priority).',
};

/** Show an inline toast (success / error). Reuses the existing #toast
 *  element from index.html so we don't duplicate the toast plumbing
 *  main.ts already owns. Falls back silently when the element isn't
 *  mounted (test envs without DOM fixtures). */
function showToast(text: string, kind: 'success' | 'warn' | 'error' = 'success'): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.className = `toast ${kind} show`;
  el.textContent = text;
  el.hidden = false;
  window.setTimeout(() => {
    el.classList.remove('show');
    window.setTimeout(() => { el.hidden = true; }, 250);
  }, 2400);
}

/** Re-render the CRUD section for the given profile. Idempotent —
 *  callers (profile-ui after a save, or the optimistic flow after
 *  every mutation) just call this and let it rebuild from scratch.
 *  Returns the rebuilt section so the caller can decide where to mount
 *  it. */
export function buildCrudSection(profileName: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'profile-section';
  section.id = 'profile-crud-section';

  const heading = document.createElement('h3');
  heading.textContent = 'Personal targets';
  section.appendChild(heading);

  const desc = document.createElement('p');
  desc.textContent = 'Targets you add here are synced to the Worker so the daemon scores them on the next tick. Curated targets you hide here are excluded from your scored view but stay shared with everyone else.';
  section.appendChild(desc);

  section.appendChild(buildAddForm(profileName));
  section.appendChild(buildPersonalList(profileName));
  section.appendChild(buildCuratedRemovedSection(profileName));
  section.appendChild(buildCsvImportSection(profileName));
  section.appendChild(buildJsonIoSection(profileName));

  // Slot 6b — fire-and-forget hydration from the server on the FIRST
  // mount per profile per session. Closes the "first open on a fresh
  // device shows 0 targets even though server has N" UX gap.
  // Intentionally not awaited: render must not block on the network,
  // and a failed hydrate is silent (see hydratePersonalTargets).
  // Re-renders after mutations (via rerenderCrudSection) reuse this
  // same code path but the once-per-session guard suppresses redundant
  // GETs — the operator's local state IS the truth after slot 6's
  // optimistic mutations land.
  if (!hydratedProfiles.has(profileName)) {
    hydratedProfiles.add(profileName);
    void hydratePersonalTargets(profileName);
  }

  // Slot 8b — independent fire-and-forget log fetch for shot-count
  // badges. Independent from the targets hydrate above so a log-fetch
  // failure (token missing, 4xx, network) can never kill target
  // rendering. Once-per-session per profile; re-renders consult the
  // module-scope cache rather than refetching.
  if (!shotCountsFetched.has(profileName)) {
    shotCountsFetched.add(profileName);
    void hydrateShotCounts(profileName);
  }

  return section;
}

/** Per-session record of which profiles we've already hydrated. Reset
 *  only on full page reload — that's the operator behaviour we care
 *  about (open the URL on a fresh device → hydrate once). */
const hydratedProfiles = new Set<string>();

/** v3 — module-scope cache of the curated targets catalog. The Profile-tab
 *  typeahead (Component C, Anil 2026-05-26) consults this on every
 *  keystroke; fetching once per Profile-pane mount keeps the network
 *  cost bounded to one hashed JSON pull per page load. State machine:
 *    null  → never attempted (initial render shows "Loading…")
 *    []    → fetch attempted but returned empty / failed (fall back
 *            to paste-id flow with "catalog unavailable" hint)
 *    [...] → ready for search
 *  Re-mounting the Profile pane refetches; rerenderCrudSection (post
 *  mutation) reuses the cache. */
let cachedCuratedTargets: CuratedTarget[] | null = null;
let curatedFetchInFlight: Promise<CuratedTarget[]> | null = null;
let curatedFetchFailed = false;

/** Slot 8b — session cache of `target_id → shoot count` per profile.
 *  Populated by `hydrateShotCounts` on the FIRST CRUD-section mount per
 *  profile. Re-reads on rerender consult this cache; they do NOT refetch
 *  /api/log (rerenders fire after every add/delete/toggle and would
 *  otherwise spam the worker). */
const shotCountsByProfile = new Map<string, Map<string, number>>();

/** Per-profile guard mirroring `hydratedProfiles` for the shot-count
 *  fetch. Independent from the targets hydrate so a log-fetch failure
 *  cannot prevent targets from hydrating (and vice versa). */
const shotCountsFetched = new Set<string>();

/** Slot 6b — one-shot GET on Profile-pane render that pulls the server's
 *  personal-target list into localStorage when the local copy is empty.
 *
 *  GUARD ("preserve local"): we only hydrate when local additions are
 *  empty. This is intentional — if the operator has any local targets,
 *  some of them may be in-flight optimistic adds whose POST hasn't
 *  resolved yet (slot 6 pattern). Clobbering them with the server's
 *  view would lose the just-added entry. The trade-off: a stale local
 *  cache won't pick up cross-device adds until the operator clears
 *  localStorage. For v1 this is the right call because:
 *    - the original bug (fresh device shows 0) is fully fixed
 *    - the alternative (union-merge by id) risks deleting in-flight
 *      adds whose id is local-only because POST hasn't completed
 *    - operators rarely edit the same profile from two devices at once
 *
 *  On any failure (token_missing / network / http / validation) this
 *  silently no-ops with a console.warn — first-render hydration should
 *  never pop a toast at the operator. */
export async function hydratePersonalTargets(profileName: string): Promise<void> {
  const current = safeLoadProfile(profileName);
  if (!current) return;
  if (current.additions.length > 0) {
    // "Preserve local" guard — see comment above. Also makes this function
    // idempotent for the success case: once additions are populated, a later
    // call (init + Profile-pane) returns here before re-fetching.
    return;
  }

  const apiResult = await getProfileTargets(profileName);
  if (!apiResult.ok) {
    console.warn(
      `profile-crud: hydrate failed for "${profileName}" (${apiResult.reason}${
        apiResult.detail ? `: ${apiResult.detail}` : ''
      })`,
    );
    return;
  }

  // Re-check local state — another tab / the operator may have added a
  // target between when we fired the GET and when it resolved. Only
  // overwrite when the local copy is still empty.
  const fresh = safeLoadProfile(profileName);
  if (!fresh) return;
  if (fresh.additions.length > 0) return;

  const merged: Profile = {
    ...fresh,
    additions: apiResult.data.targets,
  };
  try {
    saveProfile(merged);
  } catch (e) {
    console.warn(
      `profile-crud: hydrate save failed for "${profileName}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return;
  }
  rerenderCrudSection(profileName);
}

/** Slot 8b — one-shot GET against `/api/log` filtered to the active
 *  profile. Aggregates `action === 'shoot'` entries by `target_id` and
 *  caches the resulting count map in `shotCountsByProfile`. Re-renders
 *  the CRUD section so the personal-target rows pick up the badge.
 *
 *  Independent from `hydratePersonalTargets`: a log fetch failure is
 *  silent (the underlying `fetchLog` already swallows network + 4xx and
 *  returns `[]`), and a return of `[]` simply means "no badges to show"
 *  — never a crash. The shot-count cache stays empty for that profile
 *  for the remainder of the session. */
export async function hydrateShotCounts(profileName: string): Promise<void> {
  let entries: Awaited<ReturnType<typeof fetchLog>>;
  try {
    entries = await fetchLog('', 500, profileName);
  } catch {
    // Defensive: fetchLog already catches its own throws but a future
    // refactor (or a test stub that throws) shouldn't blow up the CRUD
    // mount. Treat as "no data" rather than letting the error escape.
    return;
  }
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.action !== 'shoot') continue;
    counts.set(e.target_id, (counts.get(e.target_id) ?? 0) + 1);
  }
  shotCountsByProfile.set(profileName, counts);
  rerenderCrudSection(profileName);
}

/** Replace the existing CRUD section in the DOM (if mounted) with a
 *  fresh re-render. Called after every mutation. No-op when the section
 *  isn't mounted (e.g., Profile tab not currently active). */
export function rerenderCrudSection(profileName: string): void {
  const existing = document.getElementById('profile-crud-section');
  if (!existing) return;
  const next = buildCrudSection(profileName);
  existing.replaceWith(next);
}

// ---------------------------------------------------------------------------
// Add-target form
// ---------------------------------------------------------------------------

function buildAddForm(profileName: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'profile-crud-add';

  // v3 — mode toggle (Anil 2026-05-26). "Manual lat/lon" (the existing
  // surface) + "Search by name" (Nominatim geocoder). Search-by-name
  // populates the existing lat/lon fields, then auto-switches back to
  // Manual mode so the operator can review/tweak before clicking Add.
  const modeToggle = document.createElement('div');
  modeToggle.className = 'profile-geocode-mode-toggle';
  const modeManualBtn = document.createElement('button');
  modeManualBtn.type = 'button';
  modeManualBtn.id = 'profile-add-mode-manual';
  modeManualBtn.textContent = 'Manual lat/lon';
  modeManualBtn.classList.add('active');
  const modeSearchBtn = document.createElement('button');
  modeSearchBtn.type = 'button';
  modeSearchBtn.id = 'profile-add-mode-search';
  modeSearchBtn.textContent = 'Search by name';
  modeToggle.append(modeManualBtn, modeSearchBtn);
  wrap.appendChild(modeToggle);

  const nameRow = document.createElement('div');
  nameRow.className = 'profile-row';
  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'profile-add-name';
  nameLabel.textContent = 'Name:';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'profile-add-name';
  nameInput.className = 'profile-input';
  nameInput.placeholder = 'e.g., My favorite reef';
  nameInput.autocomplete = 'off';
  nameInput.maxLength = 200;
  nameRow.append(nameLabel, nameInput);

  // Search-mode panel. Hidden by default; revealed when the operator
  // toggles to "Search by name." Holds its own input + Search button
  // + results pane + attribution caption. Clicking a result autofills
  // the lat/lon row above + switches back to Manual.
  const searchPanel = document.createElement('div');
  searchPanel.className = 'profile-geocode-search-panel';
  searchPanel.id = 'profile-add-search-panel';
  searchPanel.hidden = true;

  const searchRow = document.createElement('div');
  searchRow.className = 'profile-row';
  const searchLabel = document.createElement('label');
  searchLabel.htmlFor = 'profile-add-search-input';
  searchLabel.textContent = 'Search:';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.id = 'profile-add-search-input';
  searchInput.className = 'profile-input';
  searchInput.placeholder = 'e.g., San Diego, Mount Etna';
  searchInput.autocomplete = 'off';
  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'profile-btn';
  searchBtn.id = 'profile-add-search-btn';
  searchBtn.textContent = '🔎 Search';
  searchRow.append(searchLabel, searchInput, searchBtn);
  searchPanel.appendChild(searchRow);

  const searchStatus = document.createElement('div');
  searchStatus.className = 'profile-geocode-status';
  searchStatus.id = 'profile-add-search-status';
  searchPanel.appendChild(searchStatus);

  const searchResults = document.createElement('div');
  searchResults.className = 'profile-geocode-results';
  searchResults.id = 'profile-add-search-results';
  searchPanel.appendChild(searchResults);

  // Required Nominatim attribution. ToS demands visible attribution
  // wherever results are shown — renders even on empty / error states
  // because the operator may have seen the API logo or the network tab
  // and we want to be unambiguous about the upstream.
  const attribution = document.createElement('div');
  attribution.className = 'profile-geocode-attribution';
  attribution.id = 'profile-add-search-attribution';
  attribution.textContent = 'Geocoding © OpenStreetMap contributors via Nominatim';
  searchPanel.appendChild(attribution);

  wrap.appendChild(searchPanel);

  const latRow = document.createElement('div');
  latRow.className = 'profile-row';
  const latLabel = document.createElement('label');
  latLabel.htmlFor = 'profile-add-lat';
  latLabel.textContent = 'Lat:';
  const latInput = document.createElement('input');
  latInput.type = 'number';
  latInput.id = 'profile-add-lat';
  latInput.className = 'profile-input profile-input-coord';
  latInput.step = 'any';
  latInput.min = '-90';
  latInput.max = '90';
  latInput.placeholder = '-23.5';
  const lonLabel = document.createElement('label');
  lonLabel.htmlFor = 'profile-add-lon';
  lonLabel.textContent = 'Lon:';
  const lonInput = document.createElement('input');
  lonInput.type = 'number';
  lonInput.id = 'profile-add-lon';
  lonInput.className = 'profile-input profile-input-coord';
  lonInput.step = 'any';
  lonInput.min = '-180';
  lonInput.max = '180';
  lonInput.placeholder = '140.0';
  const prioLabel = document.createElement('label');
  prioLabel.htmlFor = 'profile-add-priority';
  prioLabel.textContent = 'Priority:';
  const prioInput = document.createElement('input');
  prioInput.type = 'number';
  prioInput.id = 'profile-add-priority';
  prioInput.className = 'profile-input profile-input-coord';
  prioInput.step = '1';
  prioInput.min = '1';
  prioInput.max = '10';
  prioInput.value = '5';
  latRow.append(latLabel, latInput, lonLabel, lonInput, prioLabel, prioInput);

  const btnRow = document.createElement('div');
  btnRow.className = 'profile-row';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'profile-btn';
  addBtn.id = 'profile-add-btn';
  addBtn.textContent = 'Add target';
  btnRow.appendChild(addBtn);

  const errorEl = document.createElement('div');
  errorEl.className = 'profile-error';
  errorEl.id = 'profile-add-error';
  errorEl.setAttribute('role', 'alert');

  // v3 — mode-toggle handler. Hide/show the search panel; gray out
  // the inactive toggle button. The name + lat/lon row stays visible
  // in BOTH modes so the operator can preview a search result before
  // committing it.
  const setMode = (mode: 'manual' | 'search') => {
    if (mode === 'search') {
      searchPanel.hidden = false;
      modeSearchBtn.classList.add('active');
      modeManualBtn.classList.remove('active');
      searchInput.focus();
    } else {
      searchPanel.hidden = true;
      modeManualBtn.classList.add('active');
      modeSearchBtn.classList.remove('active');
    }
  };
  modeManualBtn.addEventListener('click', () => setMode('manual'));
  modeSearchBtn.addEventListener('click', () => setMode('search'));

  // Debounced search trigger — both the Search button click and pressing
  // Enter in the search input route through here. Debounce 1000ms (one
  // request per second per Nominatim ToS); rapid clicks coalesce into
  // one network call.
  let lastSearchAt = 0;
  let pendingSearchHandle: number | null = null;
  const runGeocodeSearch = () => {
    const q = searchInput.value.trim();
    if (q.length === 0) {
      searchStatus.textContent = 'Enter a place name above.';
      searchResults.replaceChildren();
      return;
    }
    const now = Date.now();
    const wait = Math.max(0, 1000 - (now - lastSearchAt));
    if (pendingSearchHandle !== null) window.clearTimeout(pendingSearchHandle);
    if (wait > 0) {
      searchStatus.textContent = 'Searching…';
      pendingSearchHandle = window.setTimeout(() => {
        pendingSearchHandle = null;
        void executeGeocodeSearch();
      }, wait);
    } else {
      void executeGeocodeSearch();
    }
  };

  const executeGeocodeSearch = async () => {
    const q = searchInput.value.trim();
    if (q.length === 0) return;
    lastSearchAt = Date.now();
    searchStatus.textContent = 'Searching…';
    searchResults.replaceChildren();
    searchBtn.disabled = true;
    const result = await geocode(q);
    searchBtn.disabled = false;
    if (!result.ok) {
      searchStatus.textContent = geocodeErrorMessage(result.reason, result.detail, q);
      return;
    }
    if (result.data.length === 0) {
      searchStatus.textContent =
        `No matches found for "${q}" — try a more specific name or use Manual mode.`;
      return;
    }
    searchStatus.textContent = `${result.data.length} match${result.data.length === 1 ? '' : 'es'}.`;
    renderGeocodeResults(searchResults, result.data, (picked) => {
      // Autofill lat/lon + optionally pre-fill name; switch back to
      // Manual so operator reviews before Add.
      latInput.value = picked.lat.toFixed(4);
      lonInput.value = picked.lon.toFixed(4);
      if (nameInput.value.trim().length === 0) {
        nameInput.value = picked.shortName || picked.displayName.slice(0, 80);
      }
      setMode('manual');
      // Subtle visual nudge: focus the priority field so the operator
      // tabs through the autofilled rows naturally.
      prioInput.focus();
    });
  };

  searchBtn.addEventListener('click', runGeocodeSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runGeocodeSearch();
    }
  });

  addBtn.addEventListener('click', () => {
    errorEl.textContent = '';
    const id = makePersonalTargetId(profileName);
    const result = validatePersonalTargetInput({
      id,
      profileName,
      name: nameInput.value,
      lat: Number(latInput.value),
      lon: Number(lonInput.value),
      priority: Number(prioInput.value || '5'),
    });
    if (!result.ok) {
      errorEl.textContent = ERROR_MESSAGES[result.error] ?? `Invalid input (${result.error}).`;
      return;
    }
    void handleAdd(profileName, result.target).then((feedback) => {
      if (feedback === 'ok') {
        nameInput.value = '';
        latInput.value = '';
        lonInput.value = '';
        prioInput.value = '5';
        searchInput.value = '';
        searchStatus.textContent = '';
        searchResults.replaceChildren();
      } else {
        errorEl.textContent = feedback;
      }
    });
  });

  wrap.append(nameRow, latRow, btnRow, errorEl);
  return wrap;
}

/** Render geocode result tiles. Each tile is a button that calls
 *  `onPick` with the chosen result. Operator-controlled strings
 *  (display_name, country) flow through textContent only. */
function renderGeocodeResults(
  host: HTMLElement,
  results: GeocodeResult[],
  onPick: (r: GeocodeResult) => void,
): void {
  host.replaceChildren();
  const ul = document.createElement('ul');
  ul.className = 'profile-geocode-result-list';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'profile-geocode-result';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'profile-geocode-result-btn';
    const nameEl = document.createElement('span');
    nameEl.className = 'profile-geocode-result-name';
    nameEl.textContent = r.displayName.length > 110
      ? r.displayName.slice(0, 107) + '…'
      : r.displayName;
    const metaEl = document.createElement('span');
    metaEl.className = 'profile-geocode-result-meta';
    const metaParts: string[] = [];
    if (r.country) metaParts.push(r.country);
    metaParts.push(`${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`);
    metaEl.textContent = metaParts.join(' · ');
    btn.append(nameEl, metaEl);
    btn.addEventListener('click', () => onPick(r));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  host.appendChild(ul);
}

function geocodeErrorMessage(
  reason: string,
  detail: string | undefined,
  query: string,
): string {
  if (reason === 'timeout') return `Search timed out for "${query}" — try again or use Manual mode.`;
  if (reason === 'network') return `Geocoding failed: network unreachable. Try again or use Manual mode.`;
  if (reason === 'http') return `Geocoding failed: ${detail ?? 'server error'}. Try again later.`;
  if (reason === 'bad_json') return `Geocoding failed: ${detail ?? 'invalid response'}.`;
  if (reason === 'empty_query') return 'Enter a place name above.';
  return `Geocoding failed: ${detail ?? reason}`;
}

/** Optimistic add: persist locally, re-render, fire API, rollback on
 *  failure. Returns 'ok' on success or a human-readable error message
 *  on rollback. */
/** Exported for the map's pin-popup "Add to my targets" footer (Jack's
 *  ask, 2026-06-11): one add pathway app-wide — optimistic local save,
 *  POST, rollback + error toast on failure (D1=B: a mid-LOS add fails
 *  honestly; the operator retries when the link returns). */
export async function handleAdd(profileName: string, target: PersonalTarget): Promise<'ok' | string> {
  const before = safeLoadProfile(profileName);
  if (!before) return 'Could not load active profile.';
  let next: Profile;
  try {
    next = addPersonalTarget(before, target);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  try {
    saveProfile(next);
  } catch (e) {
    return `Could not save locally: ${e instanceof Error ? e.message : String(e)}`;
  }
  rerenderCrudSection(profileName);

  const apiResult = await postProfileTarget(profileName, target);
  if (apiResult.ok) {
    showToast(
      `Added "${target.name}" — appears on the map & queue after the next hourly update`,
      'success',
    );
    return 'ok';
  }
  // Rollback: restore the pre-mutation profile + re-render. The toast
  // tells the operator what went wrong.
  try {
    saveProfile(before);
  } catch { /* surface the network error rather than masking it */ }
  rerenderCrudSection(profileName);
  const msg = apiSyncErrorMessage(apiResult.reason, apiResult.detail);
  showToast(`Add failed: ${msg}`, 'error');
  return msg;
}

// ---------------------------------------------------------------------------
// Personal-target list (delete row per entry)
// ---------------------------------------------------------------------------

function buildPersonalList(profileName: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'profile-crud-list';

  const h = document.createElement('h4');
  h.className = 'profile-crud-subhead';
  h.textContent = 'Your targets';
  wrap.appendChild(h);

  const profile = safeLoadProfile(profileName);
  const targets = profile?.additions ?? [];
  if (targets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'profile-crud-empty';
    empty.textContent = 'No personal targets yet. Add one above.';
    wrap.appendChild(empty);
    return wrap;
  }

  const ul = document.createElement('ul');
  ul.className = 'profile-crud-ul';
  // Slot 8b — pull the cached shot-count map (if any) once per render so
  // each row lookup is O(1) without re-checking the outer Map.
  const counts = shotCountsByProfile.get(profileName) ?? null;
  for (const t of targets) {
    const n = counts?.get(t.id) ?? 0;
    ul.appendChild(buildPersonalRow(profileName, t, n));
  }
  wrap.appendChild(ul);
  return wrap;
}

function buildPersonalRow(
  profileName: string,
  target: PersonalTarget,
  shotCount: number,
): HTMLElement {
  const li = document.createElement('li');
  li.className = 'profile-crud-row';
  li.dataset.targetId = target.id;
  li.dataset.kind = 'personal';

  const nameEl = document.createElement('span');
  nameEl.className = 'profile-crud-name';
  nameEl.textContent = target.name;

  const coordEl = document.createElement('span');
  coordEl.className = 'profile-crud-coord';
  coordEl.textContent = `${target.lat.toFixed(3)}, ${target.lon.toFixed(3)} · p${target.priority}`;

  // Slot 8b — shot-count badge. Only rendered when the operator has
  // actually shot this target at least once (count > 0). Sits between
  // the coord span and the delete button so it reads as part of the
  // target's metadata rather than a control.
  const children: HTMLElement[] = [nameEl, coordEl];
  if (shotCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'profile-crud-shot-badge';
    badge.textContent = `✓ ${shotCount}`;
    badge.title = `Shot ${shotCount} time${shotCount === 1 ? '' : 's'}`;
    children.push(badge);
  }

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'profile-btn danger profile-crud-btn';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => {
    void handleDelete(profileName, target);
  });
  children.push(delBtn);

  li.append(...children);
  return li;
}

/** Optimistic delete: persist locally, re-render, fire API, rollback on
 *  failure. The Worker's DELETE is idempotent (missing id → 200) so a
 *  successful return after a stale-cache miss is benign. */
async function handleDelete(profileName: string, target: PersonalTarget): Promise<void> {
  const before = safeLoadProfile(profileName);
  if (!before) return;
  const next = removePersonalTarget(before, target.id);
  if (next === before) return; // already absent locally
  try {
    saveProfile(next);
  } catch (e) {
    showToast(`Delete failed locally: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return;
  }
  rerenderCrudSection(profileName);

  const apiResult = await deleteProfileTarget(profileName, target.id);
  if (apiResult.ok) {
    showToast(`Deleted "${target.name}"`, 'success');
    return;
  }
  // Rollback
  try {
    saveProfile(before);
  } catch { /* swallow — surface the network error */ }
  rerenderCrudSection(profileName);
  showToast(`Delete failed: ${apiSyncErrorMessage(apiResult.reason, apiResult.detail)}`, 'error');
}

// ---------------------------------------------------------------------------
// Curated-removed toggle. v1 surface: an input box + chip list. We don't
// know the curated catalog client-side (the frontend only sees scored
// passes), so we expose the raw id-string interface rather than a per-row
// toggle UI. Slot 5's manifest dual-source will eventually expose a curated
// list the operator can click; for v1, this is a power-user surface that
// matches what the daemon multiplexer (slot 4) already consumes.
// ---------------------------------------------------------------------------

function buildCuratedRemovedSection(profileName: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'profile-crud-curated';

  const h = document.createElement('h4');
  h.className = 'profile-crud-subhead';
  h.textContent = 'Hidden curated targets';
  wrap.appendChild(h);

  const desc = document.createElement('p');
  desc.className = 'profile-crud-empty';
  desc.textContent = 'Exclude curated targets from your scored view. Type to search by name; pick a match to hide. The daemon picks the change up on its next tick.';
  wrap.appendChild(desc);

  // v3 — typeahead UI (Anil 2026-05-26). Replaces the paste-exact-id
  // input as the primary surface; the paste-id flow stays below as a
  // fallback for catalog-fetch failures.
  wrap.appendChild(buildCuratedTypeahead(profileName));

  // Chip list of currently-hidden ids + summary count.
  const profile = safeLoadProfile(profileName);
  const removed = profile?.removedCuratedIds ?? [];

  const count = document.createElement('p');
  count.className = 'profile-crud-count';
  count.id = 'profile-curated-count';
  count.textContent = `${removed.length} curated target${removed.length === 1 ? '' : 's'} hidden`;
  wrap.appendChild(count);

  if (removed.length > 0) {
    const list = document.createElement('ul');
    list.className = 'profile-crud-ul profile-crud-chiplist';
    for (const id of removed) {
      list.appendChild(buildRemovedChip(profileName, id));
    }
    wrap.appendChild(list);
  }

  // Paste-exact-id fallback. Kept (spec preference) so an operator
  // isn't stuck if a NASA tile flake takes down the catalog fetch — the
  // daemon multiplexer reads removedCuratedIds regardless of how the
  // id got in there, so this path stays correct.
  wrap.appendChild(buildPasteIdFallback(profileName));

  return wrap;
}

/** v3 — Component C: curated-catalog typeahead. Input + results dropdown
 *  populated on each keystroke (debounced 200ms). Click a result → adds
 *  to removedCuratedIds + rerenders the CRUD section. Result tiles show
 *  name, id pill, region/category, and an "(already hidden)" indicator
 *  for ids already in removedCuratedIds (click is a no-op in that case).
 *  Substring + case-insensitive match against `target.name` AND
 *  `target.id` so operators can keep using partial ids if they prefer.
 *
 *  Fetch lifecycle:
 *    - first call kicks off ensureCatalogLoaded() (async, non-blocking)
 *    - while pending, results pane shows "Loading curated catalog…"
 *    - on success, cachedCuratedTargets populates + results render
 *    - on failure, the paste-id fallback below the chip list stays the
 *      operator's escape hatch; the typeahead shows
 *      "Curated catalog unavailable — use Or paste an exact id below."
 */
function buildCuratedTypeahead(profileName: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'profile-curated-typeahead';
  wrap.id = 'profile-curated-typeahead';

  const inputRow = document.createElement('div');
  inputRow.className = 'profile-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'profile-curated-search';
  input.className = 'profile-input';
  input.placeholder = 'Search curated targets (e.g., aurora, etna)';
  input.autocomplete = 'off';
  input.spellcheck = false;
  inputRow.appendChild(input);
  wrap.appendChild(inputRow);

  const results = document.createElement('div');
  results.className = 'profile-curated-results';
  results.id = 'profile-curated-results';
  wrap.appendChild(results);

  // Initial empty-state hint.
  renderTypeaheadEmpty(results);

  // Wire the search. Debounce keystrokes at 200ms — fast enough that
  // the operator's intent ("they typed all 4 letters") gets reflected,
  // slow enough that holding down Backspace doesn't shred the result
  // pane mid-render. Cache-only after the first fetch resolves; no
  // network beyond ensureCatalogLoaded().
  let debounceHandle: number | null = null;
  const runSearch = () => {
    const q = input.value.trim();
    if (q.length === 0) {
      renderTypeaheadEmpty(results);
      return;
    }
    if (cachedCuratedTargets === null) {
      renderTypeaheadLoading(results);
      return;
    }
    if (curatedFetchFailed && cachedCuratedTargets.length === 0) {
      renderTypeaheadFetchFailed(results);
      return;
    }
    const matches = searchCuratedTargets(cachedCuratedTargets, q, 8);
    renderTypeaheadResults(results, matches, q, profileName);
  };

  input.addEventListener('input', () => {
    if (debounceHandle !== null) window.clearTimeout(debounceHandle);
    debounceHandle = window.setTimeout(runSearch, 200);
  });

  // Kick off the catalog fetch on first mount per session. ensureCatalog
  // returns the cached array if already loaded; otherwise it fetches once,
  // memoizes, and re-runs the current search so the operator's
  // already-typed query immediately reflects the just-arrived catalog.
  void ensureCatalogLoaded().then(() => {
    // If the operator typed before the fetch resolved, re-run the search
    // now that we have data.
    if (input.value.trim().length > 0) runSearch();
    else if (curatedFetchFailed && cachedCuratedTargets?.length === 0) {
      renderTypeaheadFetchFailed(results);
    }
  });

  return wrap;
}

/** Pure: filter curated targets by substring + return up to `limit`
 *  matches. Match priority: name-match before id-match; within each,
 *  preserve catalog order (curated tier ordering already prioritizes
 *  the high-value targets). Case-insensitive. Operator-controlled `q`
 *  is never interpolated into a selector or regex. */
export function searchCuratedTargets(
  catalog: CuratedTarget[],
  q: string,
  limit: number,
): CuratedTarget[] {
  const needle = q.toLowerCase();
  if (needle.length === 0) return [];
  const nameMatches: CuratedTarget[] = [];
  const idMatches: CuratedTarget[] = [];
  for (const t of catalog) {
    if (t.name.toLowerCase().includes(needle)) {
      nameMatches.push(t);
    } else if (t.id.toLowerCase().includes(needle)) {
      idMatches.push(t);
    }
    if (nameMatches.length + idMatches.length >= limit * 2) break;
  }
  return [...nameMatches, ...idMatches].slice(0, limit);
}

function renderTypeaheadEmpty(host: HTMLElement): void {
  host.replaceChildren();
  const p = document.createElement('p');
  p.className = 'profile-crud-empty';
  p.textContent = 'Type to search curated targets.';
  host.appendChild(p);
}

function renderTypeaheadLoading(host: HTMLElement): void {
  host.replaceChildren();
  const p = document.createElement('p');
  p.className = 'profile-crud-empty';
  p.textContent = 'Loading curated catalog…';
  host.appendChild(p);
}

function renderTypeaheadFetchFailed(host: HTMLElement): void {
  host.replaceChildren();
  const p = document.createElement('p');
  p.className = 'profile-error';
  p.textContent = 'Curated catalog unavailable — use "Or paste an exact id" below.';
  host.appendChild(p);
}

function renderTypeaheadResults(
  host: HTMLElement,
  matches: CuratedTarget[],
  query: string,
  profileName: string,
): void {
  host.replaceChildren();
  if (matches.length === 0) {
    const p = document.createElement('p');
    p.className = 'profile-crud-empty';
    p.textContent = `No curated targets match "${query}".`;
    host.appendChild(p);
    return;
  }
  const profile = safeLoadProfile(profileName);
  const alreadyHidden = new Set(profile?.removedCuratedIds ?? []);
  const ul = document.createElement('ul');
  ul.className = 'profile-curated-result-list';
  for (const t of matches) {
    ul.appendChild(buildTypeaheadResult(profileName, t, alreadyHidden.has(t.id)));
  }
  host.appendChild(ul);
}

function buildTypeaheadResult(
  profileName: string,
  target: CuratedTarget,
  alreadyHidden: boolean,
): HTMLElement {
  const li = document.createElement('li');
  li.className = 'profile-curated-result';
  li.dataset.curatedId = target.id;
  if (alreadyHidden) li.classList.add('already-hidden');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'profile-curated-result-btn';
  btn.disabled = alreadyHidden;

  const nameEl = document.createElement('span');
  nameEl.className = 'profile-curated-result-name';
  nameEl.textContent = target.name;

  const idEl = document.createElement('code');
  idEl.className = 'profile-curated-result-id';
  idEl.textContent = target.id;

  // Region/category subtext (best-effort — both fields are optional in
  // the schema; older targets.json snapshots may not include them).
  const meta = document.createElement('span');
  meta.className = 'profile-curated-result-meta';
  const parts: string[] = [];
  if (target.category) parts.push(target.category);
  if (target.notes) parts.push(target.notes.slice(0, 80));
  if (parts.length > 0) meta.textContent = parts.join(' · ');

  const indicator = document.createElement('span');
  indicator.className = 'profile-curated-result-indicator';
  indicator.textContent = alreadyHidden ? '(already hidden)' : 'Hide';

  btn.append(nameEl, idEl, meta, indicator);

  if (!alreadyHidden) {
    btn.addEventListener('click', () => {
      void handleToggleCurated(profileName, target.id, true);
    });
  }

  li.appendChild(btn);
  return li;
}

/** Paste-exact-id fallback. Kept (spec preference) so an operator isn't
 *  stuck if the catalog fetch fails. Compact: collapsed-by-default
 *  details block so it doesn't visually compete with the typeahead. */
function buildPasteIdFallback(profileName: string): HTMLElement {
  const details = document.createElement('details');
  details.className = 'profile-curated-paste-fallback';
  details.id = 'profile-curated-paste-fallback';

  const summary = document.createElement('summary');
  summary.textContent = 'Or paste an exact id';
  details.appendChild(summary);

  const row = document.createElement('div');
  row.className = 'profile-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'profile-curated-input';
  input.className = 'profile-input';
  input.placeholder = 'curated target id (e.g., aurora-scandinavia)';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'profile-btn';
  btn.id = 'profile-curated-hide-btn';
  btn.textContent = 'Hide';
  row.append(input, btn);
  details.appendChild(row);

  const errEl = document.createElement('div');
  errEl.className = 'profile-error';
  errEl.id = 'profile-curated-error';
  errEl.setAttribute('role', 'alert');
  details.appendChild(errEl);

  btn.addEventListener('click', () => {
    errEl.textContent = '';
    const id = (input.value || '').trim();
    if (!id) {
      errEl.textContent = 'Enter a curated target id.';
      return;
    }
    if (id.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      errEl.textContent = 'Curated id must be lowercase a-z, 0-9, hyphen.';
      return;
    }
    void handleToggleCurated(profileName, id, true);
    input.value = '';
  });

  return details;
}

/** Lazy-load the curated catalog. Memoizes the in-flight Promise so
 *  concurrent calls from multiple typeahead instances (multi-tab during
 *  testing) share a single fetch. On failure, sets `curatedFetchFailed`
 *  + leaves the cache as [] so the next caller short-circuits to the
 *  fallback UI. */
export async function ensureCatalogLoaded(
  manifestOverride?: Manifest | null,
): Promise<CuratedTarget[]> {
  if (cachedCuratedTargets !== null) return cachedCuratedTargets;
  if (curatedFetchInFlight) return curatedFetchInFlight;
  const manifest = manifestOverride ?? getCurrentManifest();
  if (!manifest) {
    // No manifest available yet — cold boot / first launch with no
    // snapshot. Defer: leave cache null so the next call (typically
    // after refresh() resolves) tries again.
    return [];
  }
  curatedFetchInFlight = fetchCuratedTargets(manifest)
    .then((targets) => {
      cachedCuratedTargets = targets;
      curatedFetchFailed = targets.length === 0;
      return targets;
    })
    .catch((e) => {
      console.warn('profile-crud: curated catalog fetch failed:', e);
      cachedCuratedTargets = [];
      curatedFetchFailed = true;
      return [];
    })
    .finally(() => {
      curatedFetchInFlight = null;
    });
  return curatedFetchInFlight;
}

function buildRemovedChip(profileName: string, id: string): HTMLElement {
  const li = document.createElement('li');
  li.className = 'profile-crud-row profile-crud-chip';
  li.dataset.curatedId = id;
  li.dataset.kind = 'curated';

  const idEl = document.createElement('code');
  idEl.className = 'profile-crud-name';
  idEl.textContent = id;

  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'profile-btn profile-crud-btn';
  restoreBtn.textContent = 'Restore';
  restoreBtn.addEventListener('click', () => {
    void handleToggleCurated(profileName, id, false);
  });

  li.append(idEl, restoreBtn);
  return li;
}

/** Toggle a curated id's removed-state. `intendedHide=true` means
 *  the operator just clicked Hide; `false` means Restore. We compute
 *  the next profile via toggleCuratedRemoved (which is symmetric) and
 *  verify the resulting state matches the operator's intent — that
 *  guards against a stale local view where the id was already in the
 *  opposite state.
 *
 *  Curated removal is a local-only setting in v1 (the daemon multiplexer
 *  in slot 4 reads it from the profile JSON the daemon already fetches).
 *  No API call required — saveProfile() persists, and the daemon picks
 *  it up on the next tick. */
async function handleToggleCurated(
  profileName: string,
  curatedId: string,
  intendedHide: boolean,
): Promise<void> {
  const before = safeLoadProfile(profileName);
  if (!before) return;
  // toggleCuratedRemoved is symmetric; check current state to avoid a
  // double-flip if the operator double-clicks.
  const currentlyRemoved = before.removedCuratedIds.includes(curatedId);
  if (intendedHide && currentlyRemoved) {
    rerenderCrudSection(profileName);
    return;
  }
  if (!intendedHide && !currentlyRemoved) {
    rerenderCrudSection(profileName);
    return;
  }
  const next = toggleCuratedRemoved(before, curatedId);
  try {
    saveProfile(next);
  } catch (e) {
    showToast(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return;
  }
  rerenderCrudSection(profileName);
  showToast(
    intendedHide ? `Hid curated "${curatedId}"` : `Restored curated "${curatedId}"`,
    'success',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeLoadProfile(name: string): Profile | null {
  if (!isValidProfileName(name)) return null;
  try {
    return loadProfile(name);
  } catch {
    return null;
  }
}

function apiSyncErrorMessage(reason: string, detail?: string): string {
  if (reason === 'token_missing') return 'set the calib token in the Log tab first';
  if (reason === 'network') return 'network unreachable (queued for next sync)';
  if (reason === 'validation') return `server rejected (${detail ?? 'invalid'})`;
  if (reason === 'http') return `server error (${detail ?? 'http'})`;
  return detail ?? reason;
}

// ---------------------------------------------------------------------------
// Slot 9 — CSV import. File picker + paste textarea + preview + bulk POST.
// ---------------------------------------------------------------------------

/** Build the CSV import section. Layout:
 *    - File input (.csv) + paste textarea
 *    - Preview button
 *    - Preview area: "N valid, M errors" + scrollable error list
 *    - Import / Cancel buttons (Import disabled when valid.length === 0)
 *
 *  No fancy table virtualisation — operators rarely paste 5000+ rows,
 *  and a scrollable container handles the rare big paste.
 */
export function buildCsvImportSection(profileName: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'profile-crud-csv';
  wrap.id = 'profile-csv-import';

  const h = document.createElement('h4');
  h.className = 'profile-crud-subhead';
  h.textContent = 'Bulk import from CSV';
  wrap.appendChild(h);

  const desc = document.createElement('p');
  desc.className = 'profile-crud-empty';
  desc.textContent = 'Paste a CSV (name,lat,lon[,priority]) or choose a .csv file. Preview shows which rows will import.';
  wrap.appendChild(desc);

  // File picker
  const fileRow = document.createElement('div');
  fileRow.className = 'profile-row';
  const fileLabel = document.createElement('label');
  fileLabel.htmlFor = 'profile-csv-file';
  fileLabel.textContent = 'CSV file:';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'profile-csv-file';
  fileInput.accept = '.csv,text/csv';
  fileRow.append(fileLabel, fileInput);
  wrap.appendChild(fileRow);

  // Paste textarea
  const taRow = document.createElement('div');
  taRow.className = 'profile-row';
  const taLabel = document.createElement('label');
  taLabel.htmlFor = 'profile-csv-paste';
  taLabel.textContent = 'Or paste:';
  const ta = document.createElement('textarea');
  ta.id = 'profile-csv-paste';
  ta.className = 'profile-input';
  ta.rows = 6;
  ta.placeholder = 'name,lat,lon,priority\nBoston Aerial,42.3601,-71.0589,8';
  ta.spellcheck = false;
  taRow.append(taLabel, ta);
  wrap.appendChild(taRow);

  // Preview button + import / cancel buttons (Import disabled by default)
  const btnRow = document.createElement('div');
  btnRow.className = 'profile-row';
  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'profile-btn';
  previewBtn.id = 'profile-csv-preview-btn';
  previewBtn.textContent = 'Preview';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'profile-btn';
  importBtn.id = 'profile-csv-import-btn';
  importBtn.textContent = 'Import';
  importBtn.disabled = true;
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'profile-btn';
  cancelBtn.id = 'profile-csv-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.disabled = true;
  btnRow.append(previewBtn, importBtn, cancelBtn);
  wrap.appendChild(btnRow);

  // Preview area — populated lazily after Preview click
  const previewArea = document.createElement('div');
  previewArea.className = 'profile-csv-preview';
  previewArea.id = 'profile-csv-preview-area';
  wrap.appendChild(previewArea);

  // Mutable closure-state: the most recent parse result (set on Preview,
  // consumed on Import). Reset on Cancel and after a successful import.
  let lastParse: ParseTargetCsvResult | null = null;

  const resetPreview = () => {
    lastParse = null;
    previewArea.replaceChildren();
    importBtn.disabled = true;
    cancelBtn.disabled = true;
    importBtn.textContent = 'Import';
  };

  // File reader: when the operator picks a file, slurp its text into the
  // textarea so they can still see / edit before previewing.
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      ta.value = typeof reader.result === 'string' ? reader.result : '';
      resetPreview();
    };
    reader.onerror = () => {
      showToast(`Could not read file: ${reader.error?.message ?? 'unknown'}`, 'error');
    };
    reader.readAsText(file);
  });

  previewBtn.addEventListener('click', () => {
    const parsed = parseTargetCsv(ta.value);
    lastParse = parsed;
    renderPreview(previewArea, parsed);
    const hasValid = parsed.valid.length > 0 && !parsed.topLevelError;
    importBtn.disabled = !hasValid;
    cancelBtn.disabled = false;
    if (hasValid) {
      importBtn.textContent = `Import ${parsed.valid.length} valid`;
    } else {
      importBtn.textContent = 'Import';
    }
  });

  cancelBtn.addEventListener('click', () => {
    resetPreview();
  });

  importBtn.addEventListener('click', () => {
    if (!lastParse || lastParse.valid.length === 0) return;
    importBtn.disabled = true;
    cancelBtn.disabled = true;
    void handleCsvImport(profileName, lastParse.valid).then(() => {
      ta.value = '';
      fileInput.value = '';
      resetPreview();
    });
  });

  return wrap;
}

/** Render the parse result into the preview area. Shows "N valid, M
 *  errors" + the error rows in a scrollable container. The valid rows
 *  are summarised (count) — we trust the operator paste matches their
 *  spreadsheet; surfacing the errors is what they actually need to triage.
 *
 *  All operator-controlled strings (raw row content, error codes) go
 *  through textContent — never innerHTML. */
function renderPreview(host: HTMLElement, parsed: ParseTargetCsvResult): void {
  host.replaceChildren();

  if (parsed.topLevelError) {
    const err = document.createElement('div');
    err.className = 'profile-error';
    err.textContent = ERROR_MESSAGES[parsed.topLevelError.code]
      ?? `CSV header is invalid (${parsed.topLevelError.code}).`;
    host.appendChild(err);
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'profile-csv-summary';
  summary.textContent = `${parsed.valid.length} valid, ${parsed.errors.length} errors`;
  host.appendChild(summary);

  if (parsed.valid.length === 0 && parsed.errors.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'profile-crud-empty';
    empty.textContent = 'No rows found. Paste a CSV with a header row.';
    host.appendChild(empty);
    return;
  }

  if (parsed.valid.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'profile-error';
    hint.textContent = 'Fix the errors and re-paste.';
    host.appendChild(hint);
  }

  if (parsed.errors.length > 0) {
    const errH = document.createElement('h5');
    errH.className = 'profile-crud-subhead';
    errH.textContent = 'Errors';
    host.appendChild(errH);

    const errList = document.createElement('ul');
    errList.className = 'profile-csv-errors';
    for (const e of parsed.errors) {
      const li = document.createElement('li');
      li.className = 'profile-csv-error-row';
      const lineEl = document.createElement('span');
      lineEl.className = 'profile-csv-error-line';
      lineEl.textContent = `Line ${e.line}: `;
      const codeEl = document.createElement('span');
      codeEl.className = 'profile-csv-error-code';
      codeEl.textContent = ERROR_MESSAGES[e.code] ?? e.code;
      const rawEl = document.createElement('code');
      rawEl.className = 'profile-csv-error-raw';
      rawEl.textContent = e.raw;
      li.append(lineEl, codeEl, document.createElement('br'), rawEl);
      errList.appendChild(li);
    }
    host.appendChild(errList);
  }
}

/** Optimistic bulk-import flow. Builds PersonalTarget objects from the
 *  parsed valid rows, adds them all to local profile, then fires
 *  per-row POSTs in parallel via Promise.allSettled. Per-row failures
 *  roll back ONLY the failed rows — successful rows stay persisted.
 *
 *  This is the slot 9 "transactional preview" flow with partial-success
 *  semantics: operator sees one summary toast at the end, but the
 *  on-disk state matches what the server actually accepted. */
async function handleCsvImport(profileName: string, valid: ParsedValidRow[]): Promise<void> {
  const before = safeLoadProfile(profileName);
  if (!before) {
    showToast('Could not load active profile.', 'error');
    return;
  }

  // Mint id + createdAt for each row. We do this once here so the local
  // copy and the POST body carry the same identifiers (no drift).
  const stamp = new Date().toISOString();
  const targets: PersonalTarget[] = [];
  for (const row of valid) {
    const id = makePersonalTargetId(profileName);
    const validated = validatePersonalTargetInput({
      id,
      profileName,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      priority: row.priority,
      createdAt: stamp,
    });
    if (!validated.ok) {
      // Shouldn't happen — the parser already ran the same validator. But
      // guard defensively rather than POSTing a malformed row.
      showToast(`Skipped a row that re-failed validation (${validated.error}).`, 'warn');
      continue;
    }
    targets.push(validated.target);
  }

  if (targets.length === 0) {
    showToast('No importable rows after re-validation.', 'warn');
    return;
  }

  // Optimistic local apply
  let optimistic: Profile;
  try {
    optimistic = addPersonalTargetsBatch(before, targets);
    saveProfile(optimistic);
  } catch (e) {
    showToast(`Could not save locally: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return;
  }
  rerenderCrudSection(profileName);

  // Fire all POSTs in parallel.
  const settled = await Promise.allSettled(
    targets.map((t) => postProfileTarget(profileName, t)),
  );

  // Tally outcomes
  const failedIds: string[] = [];
  let okCount = 0;
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    const t = targets[i]!;
    if (s.status === 'fulfilled' && s.value.ok) {
      okCount += 1;
      continue;
    }
    failedIds.push(t.id);
  }

  if (failedIds.length === 0) {
    showToast(
      `Imported ${okCount} target${okCount === 1 ? '' : 's'} — they appear on the map & queue after the next hourly update.`,
      'success',
    );
    return;
  }

  // Roll back ONLY the failed rows. Re-load (don't reuse `optimistic`)
  // in case another tab mutated the profile mid-flight.
  const current = safeLoadProfile(profileName);
  if (!current) {
    showToast(
      `Imported ${okCount}, ${failedIds.length} failed (could not reload profile to roll back).`,
      'error',
    );
    return;
  }
  const failedSet = new Set(failedIds);
  const reconciled: Profile = {
    ...current,
    additions: current.additions.filter((t) => !failedSet.has(t.id)),
  };
  try {
    saveProfile(reconciled);
  } catch {
    // Surface the network failure, not the save failure.
  }
  rerenderCrudSection(profileName);
  showToast(
    `Imported ${okCount}, ${failedIds.length} failed.`,
    okCount > 0 ? 'warn' : 'error',
  );
}

// ---------------------------------------------------------------------------
// Slot 10 — JSON export / import section.
//
// Operator gets two buttons + a file picker:
//   - Export → downloads `{profileName}-profile.json`
//   - Import → file picker → preview (target count + warnings) →
//     Replace personal targets / Cancel
//
// The Replace path calls `putProfileTargets` (slot 6's API client) to
// REPLACE the entire server-side list. Local profile gets the imported
// `additions`, `removedCuratedIds`, `distanceThresholdKm` adopted but
// keeps the current profile's `name` (cross-profile imports merge by
// design — operator can copy Jack's targets into Anil's profile).
// ---------------------------------------------------------------------------

/** Per-import-error human-readable copy. Keyed by `ImportResult.code`. */
const IMPORT_ERROR_MESSAGES: Record<string, string> = {
  malformed_json: 'File is not valid JSON',
  wrong_format: 'Not an orbit-photo-director profile export',
  future_schema: 'This export was made by a newer app version',
  missing_schema_version: 'Export envelope is missing schemaVersion',
  missing_profile: 'Export envelope is missing the profile object',
  invalid_profile_name: 'Imported profile name is invalid',
  migration_failed: 'Could not migrate older schema to current version',
};

/** Build the JSON IO section. Layout:
 *    - Export button
 *    - Import file input (.json,application/json)
 *    - Preview area (target count, warnings, validation errors)
 *    - Replace personal targets / Cancel buttons
 */
export function buildJsonIoSection(profileName: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'profile-crud-jsonio';
  wrap.id = 'profile-json-io';

  const h = document.createElement('h4');
  h.className = 'profile-crud-subhead';
  h.textContent = 'Backup / Restore (JSON)';
  wrap.appendChild(h);

  const desc = document.createElement('p');
  desc.className = 'profile-crud-empty';
  desc.textContent = 'Export your profile as JSON for backup or transfer. Import replaces all personal targets on this profile.';
  wrap.appendChild(desc);

  // Export row
  const exportRow = document.createElement('div');
  exportRow.className = 'profile-row';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'profile-btn';
  exportBtn.id = 'profile-export-btn';
  exportBtn.textContent = 'Export profile';
  exportRow.appendChild(exportBtn);
  wrap.appendChild(exportRow);

  // Import row
  const importRow = document.createElement('div');
  importRow.className = 'profile-row';
  const importLabel = document.createElement('label');
  importLabel.htmlFor = 'profile-import-file';
  importLabel.textContent = 'Import file:';
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.id = 'profile-import-file';
  importInput.accept = '.json,application/json';
  importRow.append(importLabel, importInput);
  wrap.appendChild(importRow);

  // Preview area
  const previewArea = document.createElement('div');
  previewArea.className = 'profile-json-preview';
  previewArea.id = 'profile-json-preview-area';
  wrap.appendChild(previewArea);

  // Replace / Cancel row (hidden until a successful parse)
  const actionRow = document.createElement('div');
  actionRow.className = 'profile-row';
  actionRow.style.display = 'none';
  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'profile-btn';
  replaceBtn.id = 'profile-json-replace-btn';
  replaceBtn.textContent = 'Replace personal targets';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'profile-btn';
  cancelBtn.id = 'profile-json-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  actionRow.append(replaceBtn, cancelBtn);
  wrap.appendChild(actionRow);

  let lastParse: ImportResult | null = null;

  const resetPreview = () => {
    lastParse = null;
    previewArea.replaceChildren();
    actionRow.style.display = 'none';
  };

  exportBtn.addEventListener('click', () => {
    try {
      downloadProfileJson(profileName, APP_VERSION);
      showToast(`Exported ${profileName}-profile.json`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Export failed: ${msg}`, 'error');
    }
  });

  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (!file) {
      resetPreview();
      return;
    }
    void readProfileImportFile(file).then((result) => {
      lastParse = result;
      renderImportPreview(previewArea, profileName, result);
      // Show the Replace / Cancel buttons only when there's something to
      // import (at least the envelope parsed; per-target errors are
      // surfaced but the operator can still click Replace).
      if (result.ok) {
        actionRow.style.display = '';
        replaceBtn.disabled = result.profile.additions.length === 0;
        replaceBtn.textContent =
          result.targetErrors.length > 0
            ? `Import only valid (${result.profile.additions.length} of ${result.profile.additions.length + result.targetErrors.length})`
            : 'Replace personal targets';
      } else {
        actionRow.style.display = 'none';
      }
    });
  });

  cancelBtn.addEventListener('click', () => {
    importInput.value = '';
    resetPreview();
  });

  replaceBtn.addEventListener('click', () => {
    if (!lastParse || !lastParse.ok) return;
    replaceBtn.disabled = true;
    cancelBtn.disabled = true;
    void handleJsonImportReplace(profileName, lastParse).then(() => {
      importInput.value = '';
      resetPreview();
      cancelBtn.disabled = false;
    });
  });

  return wrap;
}

/** Render the import preview. Surfaces:
 *  - Source schema version + exportedAt + appVersion
 *  - Target count (valid + invalid breakdown)
 *  - Cross-profile name warning (imported profile.name !== current)
 *  - Per-target validation errors (if any)
 *  - Top-level error code + detail (if !ok)
 *
 *  All operator-controlled strings (profile name, raw target name) flow
 *  through textContent — no innerHTML. */
function renderImportPreview(
  host: HTMLElement,
  currentProfileName: string,
  result: ImportResult,
): void {
  host.replaceChildren();

  if (!result.ok) {
    const err = document.createElement('div');
    err.className = 'profile-error';
    const head = IMPORT_ERROR_MESSAGES[result.code] ?? 'Import failed';
    err.textContent = `${head}: ${result.detail}`;
    host.appendChild(err);
    return;
  }

  // Summary
  const summary = document.createElement('p');
  summary.className = 'profile-json-summary';
  const total = result.profile.additions.length + result.targetErrors.length;
  summary.textContent =
    `${result.profile.additions.length} valid target${result.profile.additions.length === 1 ? '' : 's'}` +
    (result.targetErrors.length > 0 ? `, ${result.targetErrors.length} invalid` : '') +
    ` (${total} total in file).`;
  host.appendChild(summary);

  // Meta line
  const meta = document.createElement('p');
  meta.className = 'profile-crud-empty';
  const metaParts: string[] = [];
  if (result.appVersion) metaParts.push(`from app v${result.appVersion}`);
  if (result.exportedAt) metaParts.push(`exported ${result.exportedAt}`);
  metaParts.push(`schema v${result.sourceSchemaVersion}`);
  meta.textContent = metaParts.join(' · ');
  host.appendChild(meta);

  // Cross-profile name warning
  if (result.profile.name !== currentProfileName) {
    const warn = document.createElement('p');
    warn.className = 'profile-error';
    // Use textContent to defang the imported name (operator-controlled).
    const span = document.createElement('span');
    span.textContent = `File is from "${result.profile.name}" profile. Import into "${currentProfileName}"?`;
    warn.appendChild(span);
    host.appendChild(warn);
  }

  // Item 4 — wipe warning. Surfaces BEFORE the generic "REPLACES all"
  // notice when the import would *reduce* the personal-target count
  // (e.g., importing an empty profile or one with fewer targets than
  // currently saved). Strict-less-than: an equal count might still
  // churn rows but isn't a net wipe. Empty current means nothing to
  // lose, so no warning regardless of import size.
  const currentProfile = safeLoadProfile(currentProfileName);
  const currentCount = currentProfile?.additions.length ?? 0;
  const importCount = result.profile.additions.length;
  if (currentCount > 0 && importCount < currentCount) {
    const wipeWarn = document.createElement('p');
    wipeWarn.className = 'profile-error profile-json-wipe-warn';
    const lost = currentCount - importCount;
    wipeWarn.textContent =
      `⚠ This import will delete ${lost} existing personal target${lost === 1 ? '' : 's'} ` +
      `(your current: ${currentCount} → after import: ${importCount}).`;
    host.appendChild(wipeWarn);
  }

  // Replacement warning (always shown — Replace REPLACES all)
  const replaceWarn = document.createElement('p');
  replaceWarn.className = 'profile-error';
  replaceWarn.textContent = 'This REPLACES all personal targets on this profile, both locally and on the server.';
  host.appendChild(replaceWarn);

  // Per-target validation errors
  if (result.targetErrors.length > 0) {
    const errH = document.createElement('h5');
    errH.className = 'profile-crud-subhead';
    errH.textContent = 'Skipped targets';
    host.appendChild(errH);
    const errList = document.createElement('ul');
    errList.className = 'profile-json-errors';
    for (const e of result.targetErrors) {
      const li = document.createElement('li');
      li.className = 'profile-json-error-row';
      const idxEl = document.createElement('span');
      idxEl.className = 'profile-json-error-idx';
      idxEl.textContent = `Target ${e.index + 1}: `;
      const codeEl = document.createElement('span');
      codeEl.className = 'profile-json-error-code';
      codeEl.textContent = ERROR_MESSAGES[e.code] ?? e.code;
      const nameEl = document.createElement('code');
      nameEl.className = 'profile-json-error-name';
      nameEl.textContent = e.rawName || '(unnamed)';
      li.append(idxEl, codeEl, document.createElement('br'), nameEl);
      errList.appendChild(li);
    }
    host.appendChild(errList);
  }
}

/** Optimistic Replace: write the imported profile locally, fire
 *  `putProfileTargets` to REPLACE the server list, roll back local
 *  state on API failure. Surfaces a toast either way. */
async function handleJsonImportReplace(
  currentProfileName: string,
  parse: Extract<ImportResult, { ok: true }>,
): Promise<void> {
  const before = safeLoadProfile(currentProfileName);
  if (!before) {
    showToast('Could not load active profile.', 'error');
    return;
  }

  // Build the merged Profile: keep current name (operator imports INTO this
  // profile), adopt imported additions / removedCuratedIds /
  // distanceThresholdKm. `instantBuffer` stays empty (slot 5b territory).
  const merged: Profile = {
    version: parse.profile.version,
    name: currentProfileName,
    additions: parse.profile.additions,
    removedCuratedIds: parse.profile.removedCuratedIds,
    distanceThresholdKm: parse.profile.distanceThresholdKm,
    instantBuffer: [],
  };

  try {
    saveProfile(merged);
  } catch (e) {
    showToast(`Could not save locally: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return;
  }
  rerenderCrudSection(currentProfileName);

  // Server-side replace via PUT
  const apiResult = await putProfileTargets(currentProfileName, merged.additions);
  if (apiResult.ok) {
    showToast(
      `Imported ${merged.additions.length} target${merged.additions.length === 1 ? '' : 's'}.`,
      'success',
    );
    return;
  }

  // Rollback locally so the operator's view matches what the server has.
  try {
    saveProfile(before);
  } catch { /* surface the API failure instead */ }
  rerenderCrudSection(currentProfileName);
  showToast(
    `Import failed (server): ${apiSyncErrorMessage(apiResult.reason, apiResult.detail)}`,
    'error',
  );
}

/** Test-only handles. Exported so unit tests can drive the optimistic
 *  + rollback flow directly without going through DOM-click simulation. */
export const _test = {
  handleAdd,
  handleDelete,
  handleToggleCurated,
  handleCsvImport,
  handleJsonImportReplace,
  hydratePersonalTargets,
  hydrateShotCounts,
  /** Reset the per-session hydrated-profiles set. Tests use this to
   *  simulate "fresh page load" between assertions. */
  resetHydrationState: (): void => {
    hydratedProfiles.clear();
    shotCountsFetched.clear();
    shotCountsByProfile.clear();
  },
  /** v3 — reset curated-catalog cache between tests so a stub catalog
   *  from one test doesn't leak into the next. Production code never
   *  calls this — the cache naturally invalidates on page reload. */
  resetCuratedCatalog: (): void => {
    cachedCuratedTargets = null;
    curatedFetchInFlight = null;
    curatedFetchFailed = false;
  },
  /** v3 — seed the curated cache directly. Used by tests to skip the
   *  ensureCatalogLoaded()/fetchCuratedTargets() path. */
  seedCuratedCatalog: (targets: CuratedTarget[]): void => {
    cachedCuratedTargets = targets;
    curatedFetchFailed = false;
  },
};
