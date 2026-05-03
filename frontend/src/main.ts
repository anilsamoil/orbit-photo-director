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
import type { Manifest, PassEntry } from './types';
import { fetchManifest, fetchTop24h, fetchTop5 } from './manifest';
import { fetchLog, mergeLogEntries, openRateModal, renderLog } from './log';
import type { MergedRow } from './log';

const REFRESH_MS = 60_000;

let currentManifest: Manifest | null = null;
let currentTop5: PassEntry[] = [];
let currentTop24h: PassEntry[] = [];
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
    const [top5, top24h] = await Promise.all([
      fetchTop5(manifest),
      fetchTop24h(manifest),
    ]);
    currentTop5 = top5;
    currentTop24h = top24h;

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
      renderCards(cards, top5, now, stale, onCardAction);
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
  renderCards(cards, currentTop24h, nowMs, stale, onCardAction, 'forecast');
}

function rerenderCountdowns(): void {
  if (!currentManifest) return;
  const now = Date.now();
  const stale = isStaleManifest(currentManifest, now);
  if (currentTop5.length > 0) {
    const cards = document.getElementById('cards');
    if (cards) renderCards(cards, currentTop5, now, stale, onCardAction);
  }
  if (currentTop24h.length > 0) {
    renderUpcoming(now, stale);
  }
  setBanner(bannerFromManifest(currentManifest.generated_at, currentManifest.freshness.ok, now));
}

async function onCardAction(action: 'shoot' | 'skip', p: PassEntry): Promise<void> {
  const payload = buildPayload(action, p.target_id, p.closest_approach, p.score);
  const result = await postCalib(payload);
  // Visual feedback: dim the card's button row briefly
  const card = document.querySelector<HTMLElement>(
    `.card[data-target-id="${p.target_id}"][data-pass-time="${p.closest_approach}"]`
  );
  if (card) {
    card.style.opacity = result.ok ? '0.5' : '0.7';
    setTimeout(() => {
      card.style.opacity = '';
    }, 1500);
  }
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
  btn.addEventListener('click', () => {
    const next = window.prompt(
      hasToken
        ? 'Paste a new calibration token (or leave empty to clear):'
        : 'Paste your calibration token (from the Worker):',
      '',
    );
    if (next === null) return; // cancel
    if (next.trim() === '') {
      clearToken();
    } else {
      setToken(next.trim());
    }
    void loadLogPane();
  });
  slot.appendChild(btn);
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
