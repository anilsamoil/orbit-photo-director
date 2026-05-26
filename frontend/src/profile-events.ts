/** Profile event bus — Slot 11 of design rev 2 (locked 2026-05-26).
 *
 *  Centralizes the cross-tab + in-tab "profile changed" signal so every
 *  subscriber (Map targets layer, queue/upcoming filter, topbar badge,
 *  picker re-render) listens with the same debounce + cross-tab story
 *  rather than each module wiring its own raw addEventListener.
 *
 *  Two underlying events feed one handler:
 *    1. `window.addEventListener('profile-changed', ...)` — fires
 *       synchronously from `saveProfile()` (Slot 1) inside THIS tab.
 *    2. `window.addEventListener('storage', ...)` — fires asynchronously
 *       in OTHER tabs whenever any tab writes to a key matching
 *       `opd-profile-*`. The storage event does NOT fire in the tab that
 *       made the write, so the two paths together cover both directions.
 *
 *  Filter discipline on the storage event: the page already writes other
 *  localStorage keys (terminator visibility, multi-orbit toggle, cloud
 *  toggle, snapshot, calibration queue...). Those must NOT trigger a
 *  profile-changed handler call. We filter on the `opd-profile-` prefix
 *  before dispatching.
 *
 *  Debounce contract: each subscriber's handler fires at most once per
 *  150ms window. We use a "leading + trailing" policy — the FIRST event
 *  fires the handler immediately so the UI responds without lag, and
 *  any subsequent events in the next 150ms are coalesced into a single
 *  trailing call. This matches the design doc's Issue 7 resolution
 *  (subscribers should see immediate first response + coalesced bursts).
 */

const DEBOUNCE_MS = 150;
const PROFILE_KEY_PREFIX = 'opd-profile-';

export type ProfileChangedHandler = () => void;

/** Subscribe to profile-changed events from both the in-tab CustomEvent
 *  and cross-tab `storage` events. Returns an unsubscribe function that
 *  removes BOTH listeners and clears any pending debounce timer.
 *
 *  Leading + trailing debounce: the first event in a quiet window calls
 *  the handler immediately. Subsequent events within 150ms are coalesced
 *  into a single trailing call once the window expires.
 *
 *  Multiple independent subscribers each get their own debounce state —
 *  the function is a factory, not a singleton. This matches how the
 *  three production subscribers (map.ts filter, main.ts badge,
 *  profile-ui.ts picker) need to be debounced independently.
 */
export function subscribeProfileChanged(
  handler: ProfileChangedHandler,
): () => void {
  let pendingTimer: number | null = null;
  let pendingTrailingCall = false;
  let lastFireAt = 0;

  const fire = () => {
    lastFireAt = Date.now();
    try {
      handler();
    } catch (e) {
      // Subscriber threw — don't let one bad handler break the bus for
      // other subscribers. Surface to console; production handlers
      // (map.ts, main.ts) catch their own failures, this is belt-and-
      // braces.
      // eslint-disable-next-line no-console
      console.warn('[profile-events] subscriber threw:', e);
    }
  };

  /** Schedule a trailing call to fire DEBOUNCE_MS after the last
   *  observed event. Cancels any existing timer so a rapid burst
   *  collapses into one trailing fire. */
  const scheduleTrailing = () => {
    if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    pendingTrailingCall = true;
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      if (pendingTrailingCall) {
        pendingTrailingCall = false;
        fire();
      }
    }, DEBOUNCE_MS);
  };

  const dispatch = () => {
    const now = Date.now();
    if (now - lastFireAt >= DEBOUNCE_MS && pendingTimer === null) {
      // Leading edge: fire immediately and start the suppression window
      // so subsequent calls within DEBOUNCE_MS are coalesced.
      fire();
      // Open the suppression window so any follow-on events in the next
      // DEBOUNCE_MS get coalesced into a single trailing call.
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        if (pendingTrailingCall) {
          pendingTrailingCall = false;
          fire();
        }
      }, DEBOUNCE_MS);
    } else {
      // Inside the suppression window: mark a trailing call so the
      // already-pending timer fires the handler one more time at the
      // end of the window. Reset the timer so the window slides with
      // the most recent event (max one trailing fire per quiet period).
      scheduleTrailing();
    }
  };

  const onCustomEvent = () => {
    dispatch();
  };

  const onStorage = (e: StorageEvent) => {
    // Filter: ignore writes to non-profile keys so terminator / cloud /
    // snapshot writes don't spuriously trigger profile subscribers.
    // localStorage.clear() fires storage with key=null and we treat that
    // as a profile change (defensive: a clear() wiped all keys including
    // the active profile, so re-reading is the right call).
    if (e.key !== null && !e.key.startsWith(PROFILE_KEY_PREFIX)) return;
    dispatch();
  };

  window.addEventListener('profile-changed', onCustomEvent);
  window.addEventListener('storage', onStorage);

  // Unsubscribe: remove both listeners + cancel any pending debounce.
  return () => {
    window.removeEventListener('profile-changed', onCustomEvent);
    window.removeEventListener('storage', onStorage);
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingTrailingCall = false;
  };
}

/** Test-only helper: synthesize a storage event for the given key. The
 *  real browser fires storage events from OTHER tabs only; happy-dom
 *  doesn't simulate cross-tab activity. Tests use this to verify the
 *  cross-tab subscriber path. */
export function _emitStorageEventForTests(key: string | null): void {
  const event = new StorageEvent('storage', { key });
  window.dispatchEvent(event);
}
