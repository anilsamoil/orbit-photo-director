/**
 * Orbit Photo Director — frontend entry point.
 *
 * Loads manifest.json once, dereferences every artifact through it (so mixed-version
 * reads are impossible), renders the queue, wires up Shoot/Skip POST actions, and
 * refreshes every 60s. The map view is loaded lazily when the user toggles to it.
 */

import { renderCards } from './card';
import { bannerError, bannerFromManifest, bannerLoading } from './banner';
import { buildPayload, clearToken, drainQueue, getToken, postCalib, setToken } from './calib';
import type { BannerState } from './banner';
import { liveIssPosition } from './iss';
import type { Manifest, PassEntry, Track } from './types';
import { fetchManifest, fetchTop24h, fetchTop5, fetchTrack } from './manifest';
import { fetchLog, mergeLogEntries, openRateModal, renderLog } from './log';
import type { MergedRow } from './log';

const REFRESH_MS = 60_000;

let currentManifest: Manifest | null = null;
let currentTop5: PassEntry[] = [];
let currentTop24h: PassEntry[] = [];
let currentTrack: Track | null = null;
let refreshTimer: number | null = null;

function setBanner(state: BannerState): void {
  const el = document.getElementById('status-banner');
  if (!el) return;
  el.className = `banner banner-${state.level}`;
  el.textContent = state.text;
}

function isStaleManifest(manifest: Manifest, nowMs: number): boolean {
  const generated = Date.parse(manifest.generated_at);
  if (Number.isNaN(generated)) return true;
  const ageMin = (nowMs - generated) / 60000;
  return ageMin >= 60 || !manifest.freshness.ok;
}

async function refresh(): Promise<void> {
  try {
    const manifest = await fetchManifest();
    currentManifest = manifest;
    const [top5, top24h, track] = await Promise.all([
      fetchTop5(manifest),
      fetchTop24h(manifest),
      fetchTrack(manifest),
    ]);
    currentTop5 = top5;
    currentTop24h = top24h;
    currentTrack = track;

    const cards = document.getElementById('cards');
    const empty = document.getElementById('empty');
    if (!cards || !empty) return;

    const now = Date.now();
    const stale = isStaleManifest(manifest, now);

    if (top5.length === 0) {
      cards.replaceChildren();
      empty.hidden = false;
    } else {
      empty.hidden = true;
      renderCards(cards, top5, now, stale, onCardAction, { tokenSet: !!getToken() });
    }

    // Render Upcoming pane too — uses forecast variant.
    renderUpcoming(now, stale);

    setBanner(bannerFromManifest(manifest.generated_at, manifest.freshness.ok, now));
  } catch (e) {
    setBanner(bannerError((e as Error).message));
  }
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
  // Dim the card briefly as before — keep this for visual locality.
  const card = document.querySelector<HTMLElement>(
    `.card[data-target-id="${p.target_id}"][data-pass-time="${p.closest_approach}"]`
  );
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

/** Update the topbar's live ISS sub-point from the polynomial fit. Called
 *  every second from rerenderCountdowns so the user always sees where the
 *  station is right now — solves "is the queue empty because of geography
 *  or because it's stale?" without making them open the Map tab. */
function updateIssNow(): void {
  const el = document.getElementById('iss-now');
  if (!el || !currentTrack) return;
  const pos = liveIssPosition(currentTrack, Date.now());
  if (!pos) {
    // Polynomial window expired — surface that visibly so the user knows
    // the live update is stale (separate from manifest staleness).
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
  setBanner(bannerLoading());
  bindTabs();
  // Drain any queued calibrations from the previous session (network may have failed)
  void drainQueue();
  await refresh();
  refreshTimer = window.setInterval(() => void refresh(), REFRESH_MS);
  // Per-second countdown updates without re-fetching the manifest
  window.setInterval(rerenderCountdowns, 1000);
}

if (typeof document !== 'undefined') {
  void init();
}

export { init, refresh, rerenderCountdowns };
