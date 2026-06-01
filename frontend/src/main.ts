/**
 * Orbit Photo Director — frontend entry point.
 *
 * Loads manifest.json once, dereferences every artifact through it (so mixed-version
 * reads are impossible), renders the queue, wires up Shoot/Skip POST actions, and
 * refreshes every 60s. The map view is loaded lazily when the user toggles to it.
 */

import { renderCards, type CardAction } from './card';
import { renderPassThumbnail } from './pass-thumbnail';
import { bindHelp } from './help';
import { formatCountdown } from './countdown';
import {
  bannerError,
  bannerFromManifest,
  bannerLoading,
  bannerOffline,
  bannerWithLaunchesOverlay,
  bannerWithTleOverlay,
} from './banner';
import { buildPayload, clearToken, drainQueue, getToken, postCalib, queuedCalibCount, setToken } from './calib';
import type { BannerState } from './banner';
import { liveIssNow } from './iss';
import { createPollScheduler, isOnline, type PollScheduler } from './network-status';
import { emptyQueueHint } from './empty-hint';
import { fetchKpData, initKpWidget, renderKpWidget } from './aurora';
import { initSunWidget } from './sun';
import { loadOrCreateProfileFromURL, loadProfile, removePersonalTarget, saveProfile, toggleCuratedRemoved, type Profile } from './profile';
import { hydratePersonalTargets } from './profile-crud';
import { subscribeProfileChanged } from './profile-events';
import { clearSnapshot, readSnapshot, saveSnapshot, type Snapshot } from './snapshot';
import { getSortOrder, setSortOrder, sortPassesByOrder, type SortOrder } from './sort-pref';
import { applyTargetFilter, getTargetFilter, setTargetFilter, type TargetFilter } from './target-filter-pref';
import type { Manifest, PassEntry, Status, Track } from './types';
import { fetchManifest, fetchStatus, fetchTop24h, fetchTop5, fetchTrack } from './manifest';
import { gibsTrueColorUrl, precacheTilesForTargets, yesterdayIso } from './tile-precache';
import { fetchLog, mergeLogEntries, openRateModal, renderLog } from './log';
import type { MergedRow } from './log';

const REFRESH_MS = 60_000;
const COUNTDOWN_TICK_MS = 1_000;

let currentManifest: Manifest | null = null;
let currentTop5: PassEntry[] = [];
let currentTop24h: PassEntry[] = [];
let currentTrack: Track | null = null;
// V3.0: status drives the launches-stale banner overlay (per ARCH-1, the
// `launches_last_successful_fetch` field on status.json is the source of
// truth for "is the launches feature degraded?").
let currentStatus: Status | null = null;
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
    // status.json is fetched alongside the others — V3 needs the
    // launches_last_successful_fetch field to drive the stale-launches
    // banner overlay. Older manifests without status in the artifacts map
    // would 404; we tolerate it (the launches overlay simply doesn't fire).
    //
    // v1.6.7.0+ slot 5: per-profile manifest variant selection. When the
    // operator is on `?u=jack` (or any non-default profile), fetch the
    // per-profile variant of passes/status/top5/top_24h if the manifest
    // declares one. Falls back to canonical when no variant exists.
    // Track is profile-agnostic (ISS orbit is universal) and stays
    // canonical-only.
    const profileName = currentProfile?.name;
    const [top5, top24h, track, status] = await Promise.all([
      fetchTop5(manifest, '', profileName),
      fetchTop24h(manifest, '', profileName),
      fetchTrack(manifest),
      // Promise.resolve() defends against synchronous undefined returns
      // (test mocks default to undefined; the real fetchStatus is async).
      // .catch() then handles the actual fetch-rejection case for older
      // manifests that don't have status.json in the artifacts map.
      Promise.resolve(fetchStatus(manifest, '', profileName)).catch(() => null),
    ]);
    currentManifest = manifest;
    currentTop5 = top5;
    currentTop24h = top24h;
    currentTrack = track;
    currentStatus = status ?? null;

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
        // Status now fetched alongside the others (V3.0). Tolerates null
        // for older snapshots that predate this field.
        status,
        savedAt: Date.now(),
      });
      lastSavedManifestVersion = manifest.version;
      // V4-P2 (Chris 2026-05-05): pre-cache basemap + cloud tiles for the
      // top-3 Queue targets at z6/z8/z10. Fire-and-forget; SW's CacheFirst
      // rules write to the tile caches automatically. Skipped when offline.
      // GATED on `isNewer` (same as saveSnapshot): refresh() runs every
      // 60s but the manifest only republishes hourly. Without the gate
      // we'd fire 18 tiles × 60 polls/h = 1080 fetches/h instead of 18 —
      // 60× over the budgeted carto rate limit, plus pointless because
      // the same tile bytes are already in the SW cache from the previous
      // version. Top-3 targets only change when the manifest does.
      precacheTilesForTargets(top5, gibsTrueColorUrl(yesterdayIso()));
    }

    // V4-P2 aurora indicator: fetch + render on EVERY refresh, not just
    // when the manifest version changes. Originally gated inside the
    // `if (isNewer)` block above on the same hourly-cadence reasoning as
    // tile precache; that was wrong for a live UI element.
    //
    // Bug it caused (anilsamoilenko, iPhone, 2026-05-17): on a return
    // visit within the same manifest hour, isNewer=false, fetchKpData
    // never fires, and the widget stays hidden in its HTML-default
    // `hidden` state. Operator sees no Kp number until the next manifest
    // tick, which can be up to an hour away.
    //
    // Precache stays gated (same tiles for same manifest version, no
    // need to re-fetch). Kp is different — it's a live indicator the
    // operator expects to see on every page load. Worker's edge cache
    // (5min TTL) bounds the upstream load to ~12 SWPC fetches/hour
    // regardless of how many refresh ticks happen client-side.
    void fetchKpData().then((kp) => {
      const widget = document.getElementById('kp-widget');
      if (widget) renderKpWidget(kp, widget);
    });

    renderQueue();
    setBanner(bannerWithLaunchesOverlay(
      bannerWithTleOverlay(
        bannerFromManifest(manifest.generated_at, manifest.freshness.ok, Date.now()),
        track.tle_age_hours,
      ),
      launchesStaleHours(status, Date.now()),
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

/** Drop passes whose closest_approach has already happened. The generator
 *  publishes top5 as the next-90-min slice from the manifest's tick time;
 *  by the time the user looks 30-60 min later, several picks may already
 *  be in the past. Showing them as "Past" cards (Chris, 2026-05-10) is
 *  worse than honest empty state — the user wonders what they're meant
 *  to do with cards they can no longer shoot. */
function upcomingPasses(passes: PassEntry[], nowMs: number): PassEntry[] {
  return passes.filter((p) => Date.parse(p.closest_approach) > nowMs);
}

/** Apply the active profile's distance threshold to a passes array
 *  (Slot 7 of design rev 2). Falls back to 1500 km when no profile is
 *  loaded — matches the existing ISS_HORIZON_KM behavior so first-launch
 *  users see no behavioral change. Re-reads the threshold from the
 *  in-memory profile each call; the 'profile-changed' subscriber below
 *  refreshes currentProfile so this stays in sync with slider edits.
 *
 *  Pure function — same input → same output. Tested via the
 *  filterPassesByDistance helper in map.ts which this delegates to.
 */
function applyDistanceFilter(passes: PassEntry[]): PassEntry[] {
  const threshold = currentProfile?.distanceThresholdKm ?? 1500;
  if (!Number.isFinite(threshold) || threshold <= 0) return passes;
  return passes.filter((p) => {
    const d = p.nadir_distance_km;
    if (typeof d !== 'number' || !Number.isFinite(d)) return true;
    return d <= threshold;
  });
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
  const filter = getTargetFilter();
  const visible = applyTargetFilter(
    applyDistanceFilter(upcomingPasses(currentTop5, now)),
    filter,
  );
  if (visible.length === 0) {
    cards.replaceChildren();
    // V4-P3 hint: when manifest is 90+ min old, empty Queue is caused
    // by generator lag (every pick has aged out of the 90-min window),
    // not orbital geometry. Surface a specific hint so the operator
    // knows to wait for the next tick rather than wondering whether
    // there are simply no passes coming.
    // 'mine' filter empties differently — it's a filter choice, not lag —
    // so name that cause instead of the generator-lag hint.
    if (filter === 'mine') {
      empty.textContent = 'None of your targets pass in the next 90 minutes. Switch to All to see shared targets.';
    } else {
      const hint = emptyQueueHint(currentManifest, now);
      empty.textContent = hint ?? 'No passes in the next 90 minutes.';
    }
    empty.hidden = false;
  } else {
    empty.hidden = true;
    // Operator preference governs display order. Generator emits
    // score-descending; we re-sort here without changing the SELECTION
    // (top-5-by-score within 90 min stays the pool of candidates).
    const sorted = sortPassesByOrder(visible, getSortOrder());
    renderCards(cards, sorted, now, stale, onCardAction, {
      tokenSet: !!getToken(),
      renderThumbnail: thumbnailRenderer(),
    });
  }
  renderUpcoming(now, stale);
}

/** Build a thumbnail-renderer that closes over the current track. Returns
 *  undefined when no track is available (suppresses the 🌍 button on the
 *  Queue until track.json has resolved). v2 — Component 1. */
function thumbnailRenderer(): ((p: PassEntry) => HTMLElement) | undefined {
  if (!currentTrack) return undefined;
  const t = currentTrack;
  return (p: PassEntry) => renderPassThumbnail(p, t, Date.now());
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
  currentStatus = snap.status;
  // Init the version-skip cache from the loaded snapshot so the first
  // refresh doesn't write a redundant identical-version snapshot.
  lastSavedManifestVersion = snap.manifest.version;
  renderQueue();
  // The banner reflects the snapshot's manifest age, NOT current freshness —
  // refresh() will overwrite it the moment the network call resolves.
  setBanner(bannerWithLaunchesOverlay(
    bannerFromManifest(snap.manifest.generated_at, snap.manifest.freshness.ok, Date.now()),
    launchesStaleHours(snap.status, Date.now()),
  ));
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
  setBanner(bannerWithLaunchesOverlay(
    bannerWithTleOverlay(
      bannerOffline(ageMin),
      snap.track.tle_age_hours,
    ),
    launchesStaleHours(snap.status, Date.now()),
  ));
}

function renderUpcoming(nowMs: number, stale: boolean): void {
  const cards = document.getElementById('upcoming-cards');
  const empty = document.getElementById('upcoming-empty');
  if (!cards || !empty) return;
  const filter = getTargetFilter();
  const visible = applyTargetFilter(
    applyDistanceFilter(upcomingPasses(currentTop24h, nowMs)),
    filter,
  );
  if (visible.length === 0) {
    cards.replaceChildren();
    empty.textContent = filter === 'mine'
      ? 'None of your targets have an upcoming pass. Switch to All to see shared targets.'
      : 'No upcoming passes in the next 36 hours.';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const sorted = sortPassesByOrder(visible, getSortOrder());
  renderCards(cards, sorted, nowMs, stale, onCardAction, {
    variant: 'forecast',
    renderThumbnail: thumbnailRenderer(),
  });
}

function rerenderCountdowns(): void {
  updateIssNow();
  if (!currentManifest) return;
  const now = Date.now();
  // V2-P3 perf fix (TODOS.md, 2026-05-17). Fast path: just update the
  // countdown text node in each existing card, no DOM rebuild. The
  // slow path (renderQueue) only fires when a pass crosses the
  // past-boundary, the data-passTime attribute is missing, or any
  // other unexpected DOM state — full rebuild fixes empty-state copy
  // and the upcomingPasses filter in one go.
  //
  // Why: rerenderCountdowns runs at 1Hz, so the prior `renderQueue()`
  // every tick = 86,400 full DOM rebuilds/day × 8 months unattended
  // = ~21M wasted re-renders. Same correctness for the Queue + Upcoming
  // panes; the fast path preserves the score-breakdown panel state
  // (OPEN_BREAKDOWNS) which would otherwise need a separate restore.
  if (!tryUpdateCountdownsInPlace(now)) {
    renderQueue();
  }
  setBanner(bannerWithLaunchesOverlay(
    bannerFromManifest(currentManifest.generated_at, currentManifest.freshness.ok, now),
    launchesStaleHours(currentStatus, now),
  ));
}

/** Walk both card containers, update each card's countdown text in
 *  place. Return false if any card has crossed the past-boundary
 *  (caller should renderQueue to re-run upcomingPasses + the empty-
 *  state messaging). Returns false on unexpected DOM state too —
 *  caller's fallback is the safe path. */
function tryUpdateCountdownsInPlace(now: number): boolean {
  for (const containerId of ['cards', 'upcoming-cards']) {
    const container = document.getElementById(containerId);
    if (!container) continue;
    // Snapshot children — we don't remove anything in the fast path
    // but defensive against future code changes.
    for (const child of Array.from(container.children)) {
      const card = child as HTMLElement;
      const passTime = card.dataset.passTime;
      if (!passTime) return false;  // unexpected DOM shape; safe path
      const t = Date.parse(passTime);
      if (Number.isNaN(t)) return false;  // bad timestamp; safe path
      if (t <= now) return false;  // crossed past boundary; needs re-filter
      const countdownEl = card.querySelector('.card-countdown');
      if (countdownEl) {
        countdownEl.textContent = formatCountdown(passTime, now);
      }
    }
  }
  return true;
}

/** How many hours since the generator's last successful LL2 fetch. Returns
 *  undefined when status / the field is absent (older snapshots, LL2 has
 *  never succeeded), which `bannerWithLaunchesOverlay` reads as "no overlay
 *  needed." Reads `launches_last_successful_fetch` per ARCH-1's status.json
 *  fold-in. */
function launchesStaleHours(status: Status | null, nowMs: number): number | undefined {
  if (!status || !status.launches_last_successful_fetch) return undefined;
  const t = Date.parse(status.launches_last_successful_fetch);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, (nowMs - t) / 3_600_000);
}

async function onCardAction(action: CardAction, p: PassEntry): Promise<void> {
  // v3 — Hide path (Anil 2026-05-26). One-tap dismiss for curated cards.
  // We MUTATE the profile + save synchronously and rip the card from the
  // DOM immediately so the operator sees instant feedback rather than
  // waiting for the next manifest refresh (~1 min away). The daemon
  // multiplex (slot 4) will filter the id out on the next tick so the
  // hide persists across refreshes.
  if (action === 'hide') {
    handleHideAction(p);
    return;
  }
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
  } else if (result.reason === 'server_401') {
    // v2 token-bug fix (Chris feedback 2026-05-27): the payload has been
    // queued; the operator's token field still shows what they pasted so
    // they can correct it without re-typing the whole thing.
    showToast(
      'Token rejected — re-paste in Log tab (your current token was not accepted by the server)',
      'error',
    );
  } else if (result.reason?.startsWith('server_4')) {
    showToast(`Server rejected ${verb.toLowerCase()} (${result.reason})`, 'error');
  } else {
    showToast(`${verb} queued — server unreachable`, 'warn');
  }
}

/** v3 — Hide-from-card handler (Anil 2026-05-26). The card emits 'hide';
 *  we mutate the active profile, persist, and pull the card out of the
 *  DOM by data-targetId match. The Profile tab's slot 11
 *  'profile-changed' subscriber re-renders the queue too, so the
 *  operator's persisted change survives the next refresh.
 *
 *  v3.2 — Hide now applies to BOTH curated and personal cards with
 *  different semantics per type:
 *  - curated id → toggleCuratedRemoved (adds to removedCuratedIds;
 *    restorable via the Profile-tab Hidden-curated typeahead)
 *  - personal id (`personal:` prefix) → removePersonalTarget (deletes
 *    the target outright; restorable by re-adding via the Profile-tab
 *    CRUD form). This matches the per-row Delete already in the Profile
 *    tab — Hide-from-card is the queue-side shortcut to the same op.
 *
 *  Defensive no-ops:
 *  - no active profile (shouldn't happen — init() always creates one)
 *  - id already-removed (curated: daemon multiplex would have filtered
 *    it before render; personal: target already gone from additions) —
 *    we still remove the card from DOM so the operator's tap does
 *    something.
 */
function handleHideAction(p: PassEntry): void {
  const profile = currentProfile ? loadProfile(currentProfile.name) : null;
  if (!profile) {
    showToast(`Could not hide — profile unavailable`, 'error');
    return;
  }
  const isPersonal = p.target_id.startsWith('personal:');
  let next: Profile = profile;
  if (isPersonal) {
    // removePersonalTarget is idempotent — returns the profile unchanged
    // if the id isn't in additions, so we can call it unconditionally.
    next = removePersonalTarget(profile, p.target_id);
  } else if (!profile.removedCuratedIds.includes(p.target_id)) {
    next = toggleCuratedRemoved(profile, p.target_id);
  }
  if (next !== profile) {
    try {
      saveProfile(next);
    } catch (e) {
      showToast(
        `Could not hide: ${e instanceof Error ? e.message : String(e)}`,
        'error',
      );
      return;
    }
  }
  // Remove the matching card(s) from BOTH containers — the same id can
  // appear in Queue + Upcoming. dataset comparison (not querySelector
  // interpolation) avoids the same quoting hazard onCardAction defends
  // against above.
  for (const el of document.querySelectorAll<HTMLElement>('.card')) {
    if (el.dataset.targetId === p.target_id) {
      el.remove();
    }
  }
  if (isPersonal) {
    showToast(
      `Removed personal target "${p.target_name}" — re-add in Profile tab`,
      'success',
    );
  } else {
    showToast(
      `Hidden "${p.target_name}" — restore in Profile tab`,
      'success',
    );
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
  let html =
    `<span class="iss-label">ISS</span>` +
    `${Math.abs(pos.lat).toFixed(1)}°${ns}, ${Math.abs(pos.lon).toFixed(1)}°${ew}` +
    `<span class="iss-region">over ${region}</span>`;
  // v1.6.0.2: append compact sub-point readouts for any non-ISS selected
  // satellites. Each in its track color. Empty array when no extras are
  // selected → existing single-ISS layout is unchanged.
  if (mapModule?.getSatelliteTopbarReadouts) {
    for (const r of mapModule.getSatelliteTopbarReadouts()) {
      // r.label and r.text contain only ASCII / formatted numerics (no
      // user-controlled strings) — safe to interpolate. Color is from
      // the curated SatelliteMeta list.
      html += `<span class="sat-sep">|</span>`
        + `<span class="sat-readout" style="color:${r.color}">`
        + `<span class="sat-readout-label">${r.label}</span>${r.text}</span>`;
    }
  }
  el.innerHTML = html;
  // v1.5.2.0 — Chris feedback 2026-05-21. If the map's follow-ISS toggle is
  // on, recenter the map on this fresh sub-point. Only fires when the map
  // module has already been loaded (Map tab opened at least once) — we
  // reuse the existing lazy-loaded `mapModule` cache rather than triggering
  // a dynamic import per tick. Follow-ISS is a map-only feature, so if the
  // operator never opened the Map tab, this is a no-op (and shouldn't
  // force-download MapLibre).
  if (mapModule?.applyFollowISS) mapModule.applyFollowISS(pos);
  // v1.6.0.0: also tick non-ISS satellite live markers at 1Hz.
  if (mapModule?.tickSatelliteMarkers) mapModule.tickSatelliteMarkers();
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

/** Wire the Time / Score sort toggle on Queue + Upcoming panes.
 *  Single preference applies to both. Click flips the persisted order,
 *  updates the visual active state on BOTH panes (so they stay in sync),
 *  and re-renders the cards via renderQueue() which routes through
 *  sortPassesByOrder. */
function bindSortToggles(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.sort-btn');
  if (buttons.length === 0) return;
  const syncActiveState = (order: SortOrder) => {
    buttons.forEach((b) => {
      b.classList.toggle('active', b.dataset.order === order);
    });
  };
  syncActiveState(getSortOrder());
  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      const order = (b.dataset.order as SortOrder | undefined) ?? 'time';
      setSortOrder(order);
      syncActiveState(order);
      renderQueue();
    });
  });
}

/** Wire the "All / Mine" target-filter toggles on Queue + Upcoming. The
 *  preference is global (the Map reads it too), so a click syncs the active
 *  state across every .filter-btn, persists the choice, and re-renders the
 *  card panes. The Map picks up the change on its next render (tab switch /
 *  refresh tick) — the toggles only live in the card panes, so there's no
 *  way to flip the filter while the Map is on screen. Mirrors bindSortToggles. */
function bindFilterToggles(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.filter-btn');
  if (buttons.length === 0) return;
  const syncActiveState = (filter: TargetFilter) => {
    buttons.forEach((b) => {
      b.classList.toggle('active', b.dataset.filter === filter);
    });
  };
  syncActiveState(getTargetFilter());
  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      const filter = (b.dataset.filter as TargetFilter | undefined) ?? 'all';
      setTargetFilter(filter);
      syncActiveState(filter);
      renderQueue();
    });
  });
}

function bindTabs(): void {
  const view = document.getElementById('view');
  const tabQueue = document.getElementById('tab-queue');
  const tabUpcoming = document.getElementById('tab-upcoming');
  const tabMap = document.getElementById('tab-map');
  const tabProfile = document.getElementById('tab-profile');
  const tabLog = document.getElementById('tab-log');
  if (!view || !tabQueue || !tabUpcoming || !tabMap || !tabLog) return;

  // tabProfile may be missing in older integration-test DOM fixtures; we
  // still want the rest of the dispatcher to wire up cleanly.
  // tab-lookup was removed in v1.6.6.0 — photo lookup now lives INSIDE
  // the Profile pane. Operators reach it via tab-profile.
  const allTabs = [tabQueue, tabUpcoming, tabMap, tabProfile, tabLog]
    .filter((t): t is HTMLElement => t !== null);
  const setActive = (className: string, activeTab: HTMLElement) => {
    view.className = className;
    allTabs.forEach((t) => t.classList.toggle('active', t === activeTab));
  };

  tabQueue.addEventListener('click', () => setActive('view-queue', tabQueue));
  tabUpcoming.addEventListener('click', () => setActive('view-upcoming', tabUpcoming));
  tabMap.addEventListener('click', () => {
    void loadMapPane();
    setActive('view-map', tabMap);
  });
  if (tabProfile) {
    tabProfile.addEventListener('click', () => {
      setActive('view-profile', tabProfile);
      void loadProfilePane();
      // Photo lookup widget lives inside the Profile pane now. Bind on
      // first Profile-tab visit so the exifr import only fires once and
      // matches the lazy-load convention.
      loadLookupPane();
    });
  }
  tabLog.addEventListener('click', () => {
    setActive('view-log', tabLog);
    void loadLogPane();
  });
}

/** Lazy-load the Profile tab. Same pattern as loadMapPane / loadLogPane —
 *  the profile-ui module imports nothing heavy, but lazy-importing keeps
 *  it out of the initial boot bundle and matches the "tab modules
 *  initialize on first visit" convention. */
let profilePaneModule: typeof import('./profile-ui') | null = null;
async function loadProfilePane(): Promise<void> {
  if (!profilePaneModule) {
    profilePaneModule = await import('./profile-ui');
  }
  profilePaneModule.renderProfilePane();
}

let lookupPaneBound = false;
function loadLookupPane(): void {
  if (lookupPaneBound) return;
  const pane = document.getElementById('lookup-pane');
  if (!pane) return;
  // Lazy-import the photo-lookup module so the exifr dependency only
  // loads when the operator actually opens the Lookup tab.
  void import('./photo-lookup').then(({ renderLookupTab }) => {
    renderLookupTab(pane, () => currentTrack, async (result) => {
      // Switch to Map tab + drop the lookup pin. Lazy-import map.ts (same
      // pattern as loadMapPane) so the MapLibre bundle stays gated.
      const tabMap = document.getElementById('tab-map') as HTMLElement | null;
      if (tabMap) tabMap.click();
      if (!mapModule) {
        mapModule = await import('./map');
      }
      // dropLookupPin re-uses MapLibre primitives; defined in map.ts.
      mapModule.dropLookupPin?.(result);
    });
    lookupPaneBound = true;
  });
}

async function loadLogPane(): Promise<void> {
  const listEl = document.getElementById('log-list');
  const emptyEl = document.getElementById('log-empty');
  const statsEl = document.getElementById('log-stats');
  if (!listEl || !emptyEl || !statsEl) return;
  renderTokenStatus();
  // Pass the active profile name so the Log tab shows the current
  // astronaut's records — without this, the Worker's legacy-default
  // filter returns Anil's records to anyone with a token (e.g. Jack).
  const entries = await fetchLog('', 100, getCurrentProfile()?.name);
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
        renderCards(cards, currentTop5, now, stale, onCardAction, {
          tokenSet: !!getToken(),
          renderThumbnail: thumbnailRenderer(),
        });
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

/** Selected profile for this page load. Resolved from the URL before any
 *  manifest fetch (per design rev 2, premise 4 — URL is authoritative).
 *  Slot 1 of design rev 2 ships this as foundation; Slot 5 wires
 *  per-profile manifest fetches that consume `currentProfile.name`.
 *
 *  Modules that need to read the active profile import this getter
 *  instead of re-parsing the URL on demand. Initialized in init() before
 *  any UI render so downstream callers can rely on a non-null value. */
let currentProfile: Profile | null = null;
export function getCurrentProfile(): Profile | null {
  return currentProfile;
}

/** Getter for the latest-fetched manifest. v3 — exposed so the
 *  Profile-tab typeahead (Component C, Anil 2026-05-26) can resolve the
 *  curated `targets.json` artifact through the same manifest the queue
 *  is reading from. Snapshot-restored manifests also flow through here,
 *  so the typeahead works offline / on cold boot. Returns null when no
 *  manifest has been loaded yet (first-launch + cold-cache); callers
 *  fall back to the paste-id flow in that case. */
export function getCurrentManifest(): Manifest | null {
  return currentManifest;
}

/** Update the topbar profile badge ("👤 Jack") to reflect the active
 *  profile name. textContent only (no innerHTML) — premise 12 of design
 *  rev 2 forbids new XSS surfaces, and profile names are user-influenced
 *  (URL ?u=<name>) even though isValidProfileName already constrains them.
 *
 *  Subscribers in Slot 11 call this on 'profile-changed' events; init()
 *  calls it once at boot. Stays a thin DOM-only function here so the
 *  profile-ui lazy module isn't forced into the boot bundle.
 */
export function renderTopbarProfileBadge(name: string | null): void {
  const el = document.getElementById('profile-badge');
  if (!el) return;
  if (!name) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = `👤 ${name}`;
  el.title = `Active profile: ${name} — click to switch`;
  // Bug 1 — make the chip discoverable as a profile switcher. Click
  // (or Enter / Space when focused) activates the Profile tab and
  // scrolls the picker section into view. a11y: role=button + tabindex
  // so screen-readers + keyboard users can reach it.
  bindProfileBadgeAffordance(el);
}

/** Track whether the badge has been wired for click/keyboard switching
 *  yet — `renderTopbarProfileBadge` runs on every `profile-changed` event
 *  (which fires per slider tick + per cross-tab storage event) so we must
 *  not stack duplicate listeners. */
let profileBadgeBound = false;

function bindProfileBadgeAffordance(el: HTMLElement): void {
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', 'Switch profile');
  el.setAttribute('tabindex', '0');
  el.style.cursor = 'pointer';
  if (profileBadgeBound) return;
  profileBadgeBound = true;
  const activate = () => {
    const tabProfile = document.getElementById('tab-profile') as HTMLElement | null;
    if (tabProfile) tabProfile.click();
    // Defer the scroll one frame — the Profile pane is loaded lazily via
    // `loadProfilePane`, so the picker section may not exist on the same
    // tick that the tab click fires. Two requestAnimationFrame ticks
    // is enough to land after the dynamic import + initial render in
    // every test we tried; setTimeout 0 also works but rAF aligns with
    // the browser's paint cycle.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const picker = document.getElementById('profile-picker-section');
        picker?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  };
  el.addEventListener('click', activate);
  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  });
}

async function init(): Promise<void> {
  // Resolve the profile from the URL FIRST. Future slots make the
  // manifest fetch profile-aware; today this just stamps the topbar
  // and primes localStorage. Failure (e.g., corrupted profile JSON in
  // localStorage from an older build) is non-fatal — we log + discard +
  // recreate so the page never bricks on profile errors alone.
  try {
    currentProfile = loadOrCreateProfileFromURL(window.location.href);
  } catch (e) {
    console.warn('[profile] failed to load, recreating default:', e);
    // The loadOrCreate path already catches most issues, but a
    // future-versioned profile would throw. Recreate the default.
    try {
      const url = new URL(window.location.href);
      const name = url.searchParams.get('u') ?? 'anil';
      localStorage.removeItem(`opd-profile-${name}`);
      currentProfile = loadOrCreateProfileFromURL(window.location.href);
    } catch {
      currentProfile = null;
    }
  }
  renderTopbarProfileBadge(currentProfile?.name ?? null);
  // Slot 11 — subscribe via the central event bus (in-tab CustomEvent +
  // cross-tab storage event, debounced 150ms). Re-read currentProfile on
  // each fire so the slot 7 distance filter reflects the just-saved
  // value, then re-render the queue so dropped/restored passes appear.
  subscribeProfileChanged(() => {
    try {
      currentProfile = loadOrCreateProfileFromURL(window.location.href);
    } catch {
      /* keep existing currentProfile on load failure */
    }
    renderTopbarProfileBadge(currentProfile?.name ?? null);
    if (currentManifest) renderQueue();
  });
  bindTabs();
  bindSortToggles();
  bindFilterToggles();
  bindHelp();
  // Hydrate this profile's server-side targets into localStorage on load so
  // the my-targets map rings (and the Profile list) reflect them without
  // needing a Profile-tab visit first. No-ops without a calibration token and
  // stays retryable until one is set. saveProfile fires 'profile-changed', so
  // an already-open map picks the rings up. Fire-and-forget.
  if (currentProfile) void hydratePersonalTargets(currentProfile.name);
  // V4-P2 aurora widget: attach the click handler once. Widget content is
  // rendered later by refresh() once /api/kp resolves.
  const kpWidget = document.getElementById('kp-widget');
  if (kpWidget) initKpWidget(kpWidget);
  // V4-P3 sun widget (Pettit feedback 2026-05-19): direct SDO HMI image
  // embed (no worker proxy in v1). Init fires the fetch immediately; if
  // SWPC is reachable the widget reveals itself, otherwise stays hidden.
  const sunWidget = document.getElementById('sun-widget');
  if (sunWidget) initSunWidget(sunWidget);
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

// Auto-init in the browser. Skipped under vitest so test files can drive
// init() explicitly with seeded localStorage + DOM fixtures + module mocks.
if (typeof document !== 'undefined' && import.meta.env.MODE !== 'test') {
  void init();
}

export {
  init,
  refresh,
  rerenderCountdowns,
  // Test surface — exposed so frontend/test/main-integration.test.ts can
  // exercise the orchestration helpers without going through the full
  // init() / setInterval chain. Production code should use init().
  bootFromSnapshot,
  doRefresh,
  renderOfflineBanner,
  renderQueue,
  updatePendingSyncBadge,
  // v3 — exposed so the hide-from-card flow can be tested at the
  // handler boundary (DOM removal + profile save + toast) without
  // simulating the full Queue render path. Card-test side covers
  // the button-renders-the-event surface.
  handleHideAction,
  onCardAction,
};
