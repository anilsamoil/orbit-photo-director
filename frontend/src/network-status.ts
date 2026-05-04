/** Network + visibility state machine for the manifest poll loop.
 *
 *  Two signals drive the cadence:
 *    - navigator.onLine: skip the fetch entirely if the OS says we're offline
 *    - document.visibility: pause polling when the tab is hidden, fire an
 *      immediate fetch when it comes back. Saves ISS bandwidth (a tab nobody
 *      is looking at shouldn't pull manifest.json every 60s).
 */

export function isOnline(): boolean {
  // navigator.onLine is undefined in some test environments — treat unknown
  // as online so we don't lock the user out of fetching when the signal is
  // missing.
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export interface PollScheduler {
  /** Stop the scheduler and remove all listeners. Idempotent. */
  stop(): void;
}

export interface PollSchedulerOptions {
  /** Interval between polls when the tab is visible (ms). */
  intervalMs: number;
  /** Called whenever a poll should happen. May return a promise; overlapping
   *  invocations are NOT serialized — caller must guard against re-entry if
   *  that matters. */
  onPoll: () => void | Promise<void>;
  /** Called when the tab becomes visible after being hidden. Defaults to onPoll
   *  so visibility-resume always pulls fresh data immediately. */
  onResume?: () => void | Promise<void>;
}

/** Visibility-aware poll scheduler.
 *
 *  Visible: fires onPoll every intervalMs.
 *  Hidden:  pauses (no timer running). Saves bandwidth on tabs nobody's watching.
 *  Visible-again: fires onResume immediately, then resumes the interval.
 *
 *  Does NOT call onPoll on creation — caller is responsible for the initial
 *  fetch. The scheduler manages cadence, not the first paint.
 */
export function createPollScheduler(options: PollSchedulerOptions): PollScheduler {
  const { intervalMs, onPoll, onResume = onPoll } = options;
  let timer: ReturnType<typeof setInterval> | null = null;

  function startTimer(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      void onPoll();
    }, intervalMs);
  }

  function stopTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function handleVisibility(): void {
    if (isVisible()) {
      void onResume();
      startTimer();
    } else {
      stopTimer();
    }
  }

  // Initial state: only run the timer if the tab is visible right now.
  if (isVisible()) startTimer();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility);
  }

  return {
    stop(): void {
      stopTimer();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    },
  };
}
