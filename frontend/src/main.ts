/**
 * Orbit Photo Director — frontend entry point.
 *
 * Loads manifest.json once, dereferences every artifact through it (so mixed-version
 * reads are impossible), renders the queue, wires up Shoot/Skip POST actions, and
 * refreshes every 60s. The map view is loaded lazily when the user toggles to it.
 */

import { renderCards } from './card';
import { bannerError, bannerFromManifest, bannerLoading, bannerOffline, bannerWithTleOverlay } from './banner';
import { buildPayload, clearToken, drainQueue, getToken, postCalib, queuedCalibCount, setToken } from './calib';
import type { BannerState } from './banner';
import { liveIssNow } from './iss';
import { createPollScheduler, isOnline, type PollScheduler } from './network-status';
import { clearSnapshot, readSnapshot, saveSnapshot, type Snapshot } from './snapshot';
import type { Manifest, PassEntry, Track } from './types';
import { fetchManifest, fetchTop24h, fetchTop5, fetchTrack } from './manifest';
import { fetchLog, mergeLogEntries, openRateModal, renderLog } from './log';
import type { MergedRow } from './log';

const REFRESH_MS = 60_000;
const COUNTDOWN_TICK_MS = 1_000;

let currentManifest: Manifest | null = null;
let currentTop5: PassEntry[] = [];
let currentTop24h: PassEntry[] = [];
let currentTrack: Track | null = null;
// Held to keep the scheduler's listeners alive and reachable. Production
// code never tears down (single-page lifetime); reserved for future SW
// upgrade flow that may want pollScheduler.stop() before reload.
let pollScheduler: PollScheduler | null = null;
// Re-entrancy guard. createPollScheduler explicitly does NOT serialize
// onPoll calls (see network-status.ts); visibility-resume can fire
// onPoll while a prior interval-driven refresh is still in flight.
// Returning the in-flight promise is cheaper than running two parallel
// fetch+JSON.parse+saveSnapshot pipelines.
let refreshInFlight: Promise<void> | null = null;
// Last-saved manifest version. saveSnapshot is idempotent for the same
// version (the only thing that changes between intra-tick polls is the
// counter on R2), so skipping unchanged writes drops ~350K localStorage
// writes over an 8-month mission to ~5K.
let lastSavedManifestVersion: string | null = null;

function setBanner(state: BannerState): void {
  const el = document.getElementById('status-banner');
  if (!el) return;
  el.className = `banner banner-${state.level}`;
  el.textContent = state.text;
}

/** Render or hide the topbar "N pending sync" badge based on the calib queue.
 *  The badge sits inside the Log tab button so the user sees the count
 *  regardless of which view they're on. */
function updatePendingSyncBadge(): void {
  const el = document.getElementById('pending-sync-badge');
  if (!el) return;
  const n = queuedCalibCount();
  if (n === 0) {
    el.hidden = true;
    el.textContent = '';
  } else {
    el.hidden = false;
    el.textContent = String(n);
    el.title = `${n} calibration ${n === 1 ? 'entry' : 'entries'} queued — will sync when online`;
  }
}

function isStaleManifest(manifest: Manifest, nowMs: number): boolean {
  const generated = Date.parse(manifest.generated_at);
  if (Number.isNaN(generated)) return true;
  const ageMin = (nowMs - generated) / 60000;
  return ageMin >= 60 || !manifest.freshness.ok;
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<void> {
  // Skip the network round-trip entirely when the OS says we're offline —
  // saves a doomed fetch + the error banner flash on every poll while LOS.
  if (!isOnline()) {
    renderOfflineBanner();
    return;
  }
  try {
    const manifest = await fetchManifest();
    // Stage everything before mutating module state so a partial failure
    // (any artifact 404, JSON parse, etc.) leaves currentManifest/Top5/Track
    // pointing at the previous snapshot. This is the transactional refresh
    // discipline from the V2 plan: versioned URLs guarantee artifact
    // separation; an aborted refresh never produces a torn snapshot.
    const [top5, top24h, track] = await Promise.all([
      fetchTop5(manifest),
      fetchTop24h(manifest),
      fetchTrack(manifest),
    ]);
    currentManifest = manifest;
    currentTop5 = top5;
    currentTop24h = top24h;
    currentTrack = track;

    // Persist atomically AFTER all artifacts loaded successfully — but ONLY
    // when the manifest version is STRICTLY NEWER than what's on disk. Two
    // protections in one check:
    //   1. Skip identical-version writes (the poll fires every 60s; the
    //      generator only ticks every 60 min, so 59 of 60 polls return the
    //      same manifest — saves ~350K wasted localStorage writes / 8 mo).
    //   2. Block monotonicity regressions. A CDN edge serving a stale
    //      manifest, a multi-tab race, or a re-published version would
    //      otherwise overwrite a newer snapshot with older data — silent
    //      data corruption the user never sees. Versions are timestamped
    //      slugs (YYYYMMDDTHHMMSSZ), so lexicographic comparison works.
    const onDiskVersion = readSnapshot()?.manifest.version ?? null;
    const isNewer = manifest.version !== lastSavedManifestVersion
      && (onDiskVersion === null || manifest.version > onDiskVersion);
    if (isNewer) {
      saveSnapshot({
        manifest,
        top5,
        top_24h: top24h,
        track,
        // Status isn't currently fetched in the live path; null is allowed
        // and the consuming UI degrades gracefully.
        status: null,
        savedAt: Date.now(),
      });
      lastSavedManifestVersion = manifest.version;
    }

    renderQueue();
    setBanner(bannerWithTleOverlay(
      bannerFromManifest(manifest.generated_at, manifest.freshness.ok, Date.now()),
      track.tle_age_hours,
    ));
    updatePendingSyncBadge();
  } catch (e) {
    // Refresh failed — keep showing whatever the snapshot path rendered and
    // surface the failure in the banner. currentManifest/Top5/etc still hold
    // the last good state because we only mutated them after Promise.all
    // resolved. A snapshot-restored manifest counts as "has data" here, so
    // transient fetch errors get the offline banner rather than a red toast.
    if (currentManifest) {
      renderOfflineBanner();
    } else {
      setBanner(bannerError((e as Error).message));
    }
  }
}

/** Render the Queue + Upcoming panes from current module state. Extracted so
 *  both the snapshot boot and a normal refresh share one render path. */
function renderQueue(): void {
  if (!currentManifest) return;
  const cards = document.getElementById('cards');
  const empty = document.getElementById('empty');
  if (!cards || !empty) return;
  const now = Date.now();
  const stale = isStaleManifest(currentManifest, now);
  if (currentTop5.length === 0) {
    cards.replaceChildren();
    empty.hidden = false;
  } else {
    empty.hidden = true;
    renderCards(cards, currentTop5, now, stale, onCardAction, { tokenSet: !!getToken() });
  }
  renderUpcoming(now, stale);
}

/** Boot the queue from localStorage before the first network round-trip
 *  resolves. Lets the page render the previous-known-good UI within a few
 *  ms of loading instead of staring at "Loading…" until manifest.json
 *  comes back (or worse, never comes back during LOS). Returns true if a
 *  snapshot was loaded, false if there was nothing to restore.
 *
 *  Caller is expected to wrap this in a try/catch + clearSnapshot — even
 *  with readSnapshot's shape validation, a snapshot whose nested fields
 *  fail (e.g. manifest.freshness.ok missing) would throw inside one of
 *  the consumers below and brick boot permanently. The init() try/catch
 *  is the recovery surface. */
function bootFromSnapshot(): boolean {
  const snap: Snapshot | null = readSnapshot();
  if (!snap) return false;
  currentManifest = snap.manifest;
  currentTop5 = snap.top5;
  currentTop24h = snap.top_24h;
  currentTrack = snap.track;
  // Init the version-skip cache from the loaded snapshot so the first
  // refresh doesn't write a redundant identical-version snapshot.
  lastSavedManifestVersion = snap.manifest.version;
  renderQueue();
  // The banner reflects the snapshot's manifest age, NOT current freshness —
  // refresh() will overwrite it the moment the network call resolves.
  setBanner(bannerFromManifest(snap.manifest.generated_at, snap.manifest.freshness.ok, Date.now()));
  return true;
}

/** Banner shown when the manifest fetch fails or navigator.onLine is false.
 *  The level escalates with snapshot age (green <1h → yellow <3h → orange
 *  <12h → red beyond) — the user is reading data from localStorage and
 *  the banner is the only signal of how stale it might be.
 *  When there's no snapshot AND no network, this still renders something
 *  useful instead of leaving the previous banner stuck. */
function renderOfflineBanner(): void {
  const snap = readSnapshot();
  if (!snap) {
    setBanner(bannerError('offline — no cached data'));
    return;
  }
  // Clamp to 0: a backward clock skew (NTP correction after a long
  // offline period) would otherwise yield a negative ageMin and render
  // "Offline · <1 min ago — last sync recent", which misleads the user
  // into thinking they just synced when they haven't. 0 means "treat as
  // freshest possible" which is wrong but at least conservative.
  const ageMin = Math.max(0, (Date.now() - snap.savedAt) / 60_000);
  setBanner(bannerWithTleOverlay(
    bannerOffline(ageMin),
    snap.track.tle_age_hours,
  ));
}

function renderUpcoming(nowMs: number, stale: boolean): void {
  const cards = document.getElementById('upcoming-cards');
  const empty = document.getElementById('upcoming-empty');
  if (!cards || !empty) return;
  if (currentTop24h.length === 0) {
    cards.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  renderCards(cards, currentTop24h, nowMs, stale, onCardAction, { variant: 'forecast' });
}

function rerenderCountdowns(): void {
  updateIssNow();
  if (!currentManifest) return;
  const now = Date.now();
  const stale = isStaleManifest(currentManifest, now);
  if (currentTop5.length > 0) {
    const cards = document.getElementById('cards');
    if (cards) renderCards(cards, currentTop5, now, stale, onCardAction, { tokenSet: !!getToken() });
  }
  if (currentTop24h.length > 0) {
    renderUpcoming(now, stale);
  }
  setBanner(bannerFromManifest(currentManifest.generated_at, currentManifest.freshness.ok, now));
}

async function onCardAction(action: 'shoot' | 'skip', p: PassEntry): Promise<void> {
  const payload = buildPayload(action, p.target_id, p.closest_approach, p.score);
  const result = await postCalib(payload);
  // postCalib may have queued the action (offline / token missing / 5xx);
  // refresh the badge regardless so the user sees the new count immediately.
  updatePendingSyncBadge();
  // Dim the card briefly as before — keep this for visual locality.
  // We iterate + dataset-compare instead of interpolating into a CSS
  // selector. A target_id containing '"' (personal-targets.csv is
  // user-controlled) would otherwise throw SyntaxError out of
  // querySelector and silently swallow the toast — the calibration
  // posted, but the user sees no confirmation and re-clicks.
  let card: HTMLElement | null = null;
  for (const el of document.querySelectorAll<HTMLElement>('.card')) {
    if (el.dataset.targetId === p.target_id && el.dataset.passTime === p.closest_approach) {
      card = el;
      break;
    }
  }
  if (card) {
    card.style.opacity = result.ok ? '0.5' : '0.7';
    setTimeout(() => { card.style.opacity = ''; }, 1500);
  }

  // Toast: explicit confirmation that the click actually did something.
  // The previous silent dim was easy to miss on first-use.
  const verb = action === 'shoot' ? 'Shoot' : 'Skip';
  if (result.ok) {
    showToast(`✓ ${verb} logged: ${p.target_name}`, 'success');
  } else if (result.reason === 'token_missing') {
    showToast(`Saved offline — set token in Log tab to sync`, 'warn');
  } else if (result.reason === 'network') {
    showToast(`Offline — ${verb.toLowerCase()} queued for next visit`, 'warn');
  } else if (result.reason?.startsWith('server_4')) {
    showToast(`Server rejected ${verb.toLowerCase()} (${result.reason})`, 'error');
  } else {
    showToast(`${verb} queued — server unreachable`, 'warn');
  }
}

let toastFadeTimer: number | null = null;
let toastHideTimer: number | null = null;
function showToast(text: string, kind: 'success' | 'warn' | 'error' = 'success'): void {
  const el = document.getElementById('toast');
  if (!el) return;
  // Cancel BOTH pending timers so a rapid re-show doesn't get yanked
  // into hidden=true by the previous toast's fade-out timer.
  if (toastFadeTimer !== null) window.clearTimeout(toastFadeTimer);
  if (toastHideTimer !== null) window.clearTimeout(toastHideTimer);
  el.className = `toast ${kind} show`;
  el.textContent = text;
  el.hidden = false;
  toastFadeTimer = window.setTimeout(() => {
    el.classList.remove('show');
    toastHideTimer = window.setTimeout(() => { el.hidden = true; }, 250);
  }, 2400);
}

/** Update the topbar's live ISS sub-point. Called every second from
 *  rerenderCountdowns so the user always sees where the station is right
 *  now — solves "is the queue empty because of geography or because it's
 *  stale?" without making them open the Map tab.
 *
 *  In window: polynomial. Past window: SGP4 from track.tle (V2). Both
 *  paths return null only when the polynomial start is malformed AND the
 *  TLE is missing/malformed — at which point "live track expired" is the
 *  right thing to show. */
function updateIssNow(): void {
  const el = document.getElementById('iss-now');
  if (!el || !currentTrack) return;
  const pos = liveIssNow(currentTrack, Date.now());
  if (!pos) {
    // Both polynomial AND SGP4 returned null — track shape is unusable.
    el.classList.add('ready');
    el.innerHTML = '<span class="iss-label">ISS</span><span class="iss-region">live track expired</span>';
    return;
  }
  const ns = pos.lat >= 0 ? 'N' : 'S';
  const ew = pos.lon >= 0 ? 'E' : 'W';
  const region = roughRegion(pos.lat, pos.lon);
  el.classList.add('ready');
  el.innerHTML =
    `<span class="iss-label">ISS</span>` +
    `${Math.abs(pos.lat).toFixed(1)}°${ns}, ${Math.abs(pos.lon).toFixed(1)}°${ew}` +
    `<span class="iss-region">over ${region}</span>`;
}

/** Coarse ocean / continent label for an ISS sub-point. Intentionally crude
 *  — the user wants "is it over land or water, roughly which one" not a
 *  precise reverse-geocode. Boundaries are rough lat/lon boxes; near coasts
 *  we may show the wrong one. Good enough for the topbar context. */
function roughRegion(lat: number, lon: number): string {
  // NaN comparisons are all false — without this guard, a NaN lat/lon
  // would fall through every branch and silently render "Pacific Ocean"
  // for a position that's actually unknown.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'unknown region';
  // Polar caps first
  if (lat > 66) return 'Arctic';
  if (lat < -60) return 'Antarctica';
  // Continents (rough lat/lon boxes; ocean fall-through below)
  if (lat > 12 && lat < 72 && lon > -170 && lon < -50) return 'North America';
  if (lat > -55 && lat < 12 && lon > -82 && lon < -34) return 'South America';
  if (lat > 35 && lat < 72 && lon > -10 && lon < 60) return 'Europe';
  if (lat > -35 && lat < 37 && lon > -18 && lon < 52) return 'Africa';
  if (lat > -10 && lat < 60 && lon > 25 && lon < 145) return 'Asia';
  if (lat > -45 && lat < -10 && lon > 110 && lon < 155) return 'Australia';
  // Oceans by hemisphere
  if (lon > -30 && lon < 25) return 'Atlantic Ocean';
  if (lon >= 25 && lon < 110) return 'Indian Ocean';
  return 'Pacific Ocean';
}

function bindTabs(): void {
  const view = document.getElementById('view');
  const tabQueue = document.getElementById('tab-queue');
  const tabUpcoming = document.getElementById('tab-upcoming');
  const tabMap = document.getElementById('tab-map');
  const tabLog = document.getElementById('tab-log');
  if (!view || !tabQueue || !tabUpcoming || !tabMap || !tabLog) return;

  const setActive = (className: string, activeTab: HTMLElement) => {
    view.className = className;
    [tabQueue, tabUpcoming, tabMap, tabLog].forEach((t) => t.classList.toggle('active', t === activeTab));
  };

  tabQueue.addEventListener('click', () => setActive('view-queue', tabQueue));
  tabUpcoming.addEventListener('click', () => setActive('view-upcoming', tabUpcoming));
  tabMap.addEventListener('click', () => {
    void loadMapPane();
    setActive('view-map', tabMap);
  });
  tabLog.addEventListener('click', () => {
    setActive('view-log', tabLog);
    void loadLogPane();
  });
}

async function loadLogPane(): Promise<void> {
  const listEl = document.getElementById('log-list');
  const emptyEl = document.getElementById('log-empty');
  const statsEl = document.getElementById('log-stats');
  if (!listEl || !emptyEl || !statsEl) return;
  renderTokenStatus();
  const entries = await fetchLog();
  const merged = mergeLogEntries(entries);
  renderLog(listEl, emptyEl, statsEl, merged, async (row: MergedRow) => {
    const ok = await openRateModal(row);
    if (ok) {
      await loadLogPane();
    }
  });
}

/** Render the calibration-token status row in the log pane header. Lets the
 *  user paste/clear the x-calib-token without opening DevTools.
 */
function renderTokenStatus(): void {
  const slot = document.getElementById('log-token');
  if (!slot) return;
  slot.replaceChildren();
  const hasToken = !!getToken();

  const status = document.createElement('span');
  status.className = `token-status ${hasToken ? 'set' : 'unset'}`;
  status.textContent = hasToken ? 'token: set' : 'token: not set';
  slot.appendChild(status);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'token-btn';
  btn.textContent = hasToken ? 'change' : 'set';
  btn.addEventListener('click', async () => {
    const result = await openTokenModal(hasToken);
    if (result === null) return; // cancel
    if (result === '') {
      clearToken();
      showToast('Token cleared — Shoot/Skip will queue offline', 'warn');
    } else {
      setToken(result);
      showToast('Token saved — Shoot/Skip will sync to the Worker', 'success');
      void drainQueue();
    }
    void loadLogPane();
    // Re-render the Queue so its buttons reflect the new token state.
    if (currentManifest && currentTop5.length > 0) {
      const cards = document.getElementById('cards');
      if (cards) {
        const now = Date.now();
        const stale = isStaleManifest(currentManifest, now);
        renderCards(cards, currentTop5, now, stale, onCardAction, { tokenSet: !!getToken() });
      }
    }
  });
  slot.appendChild(btn);
}

/** In-page token modal. Replaces window.prompt — which exposed the token to
 *  shoulder-surfers (plain text, no field masking) and persisted entries in
 *  the browser's autofill history. The new modal uses a password-type
 *  field so the token reads as bullets, no autofill capture, and the input
 *  field is wiped on close. Resolves to:
 *    - null on cancel/backdrop click
 *    - "" when the user submits an empty input (clear-token intent)
 *    - the trimmed token otherwise
 */
export function openTokenModal(hasToken: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal token-modal';

    const title = document.createElement('h3');
    title.textContent = hasToken ? 'Change calibration token' : 'Set calibration token';
    const help = document.createElement('p');
    help.className = 'modal-meta';
    help.textContent = hasToken
      ? 'Paste a new token, or leave empty + Save to clear the current one.'
      : 'Paste the calibration token (issued by the Worker).';

    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.className = 'token-input';
    input.placeholder = 'paste token here';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-skip';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-shoot';
    save.textContent = 'Save';

    let resolved = false;
    const close = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      // Wipe the input value before removal so it doesn't persist in any
      // browser-internal field cache between sessions.
      input.value = '';
      backdrop.remove();
      resolve(value);
    };

    cancel.addEventListener('click', () => close(null));
    save.addEventListener('click', () => close(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        close(input.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      }
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    actions.append(cancel, save);
    modal.append(title, help, input, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    // Focus on next frame so screen-readers announce the title first.
    requestAnimationFrame(() => input.focus());
  });
}

let mapModule: typeof import('./map') | null = null;

async function loadMapPane(): Promise<void> {
  if (!currentManifest) return;
  if (!mapModule) {
    mapModule = await import('./map');
  }
  await mapModule.renderMap(currentManifest);
  // MapLibre needs explicit resize() after its container becomes visible.
  // The container starts hidden (display: none) so the canvas was 0×0 at init.
  // Defer one frame so the browser reflows the now-visible container first.
  requestAnimationFrame(() => mapModule!.resizeMap());
}

async function init(): Promise<void> {
  bindTabs();
  // Restore the previous-known-good UI synchronously BEFORE the network call
  // so the user sees their queue + map within ms of the page loading. If the
  // refresh below succeeds, snapshot is overwritten transactionally; if it
  // fails (LOS, bad gateway), the snapshot UI keeps showing.
  //
  // Recovery: bootFromSnapshot can throw if a torn write or hostile browser
  // extension left malformed nested fields in the snapshot (e.g.,
  // manifest.freshness missing). Without this catch, init's promise rejects,
  // the poll scheduler is never created, refresh() never runs, and the page
  // is permanently bricked because reload would just re-read the same poison.
  // On catch we discard the snapshot — staleness is precious, corruption is
  // worse than nothing — and proceed with the loading banner.
  let hadSnapshot = false;
  try {
    hadSnapshot = bootFromSnapshot();
  } catch (e) {
    console.warn('snapshot restore failed, discarding:', e);
    clearSnapshot();
    currentManifest = null;
    currentTop5 = [];
    currentTop24h = [];
    currentTrack = null;
    lastSavedManifestVersion = null;
  }
  if (!hadSnapshot) setBanner(bannerLoading());

  // Drain any queued calibrations from the previous session (network may have failed)
  void drainQueue().then(updatePendingSyncBadge);
  // Initial badge from whatever's already queued, before drain finishes.
  updatePendingSyncBadge();

  await refresh();

  // Visibility-aware polling: pause while the tab is hidden, fetch
  // immediately on visible-again. Saves ISS bandwidth on tabs nobody is
  // watching and gives the user fresh data the moment they look at the
  // page after a long pause.
  pollScheduler = createPollScheduler({
    intervalMs: REFRESH_MS,
    onPoll: () => void refresh(),
  });
  // Per-second countdown updates without re-fetching the manifest
  window.setInterval(rerenderCountdowns, COUNTDOWN_TICK_MS);
}

if (typeof document !== 'undefined') {
  void init();
}

export { init, refresh, rerenderCountdowns };
