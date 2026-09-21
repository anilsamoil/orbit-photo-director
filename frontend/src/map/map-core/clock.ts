import type { Unsubscribe } from './vendor-map';

/** The instant the map renders. A scrubbed view carries its instant, so a
 *  scrub with no instant cannot be constructed. */
export type ViewTime = { kind: 'live' } | { kind: 'scrubbed'; atMs: number };

/** Leading edge when the interval has passed, one trailing run otherwise. */
export interface Throttle {
  schedule(): void;
  flush(): void;
  /** Forgets the last run too, so the next schedule runs at once. */
  reset(): void;
  readonly armed: boolean;
}

export const SETTLE_MS = 150;

export interface Clock {
  now(): number;
  viewTime(): ViewTime;
  setViewTime(time: ViewTime, cadence?: 'now' | 'coalesced'): void;
  onViewTime(listener: () => void): Unsubscribe;
  /** The throttle a coalesced setViewTime hands its listeners to. */
  readonly settle: Throttle;
  viewMs(nowMs?: number): number;
  isScrubbed(): boolean;
  every(intervalMs: number, tick: (nowMs: number) => void): Unsubscribe;
  throttle(intervalMs: number, run: (nowMs: number) => void): Throttle;
}

export function createClock(now: () => number = () => Date.now()): Clock {
  let view: ViewTime = { kind: 'live' };
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* the next listener still hears the change */ }
    }
  };

  const throttle = (intervalMs: number, run: (nowMs: number) => void): Throttle => {
    let lastRunMs = 0;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = (): void => {
      lastRunMs = now();
      pending = false;
      run(lastRunMs);
    };
    const disarm = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    return {
      schedule() {
        const since = Math.max(0, now() - lastRunMs);
        if (since >= intervalMs) {
          fire();
          return;
        }
        pending = true;
        if (timer === null) {
          timer = setTimeout(() => {
            timer = null;
            if (pending) fire();
          }, intervalMs - since);
        }
      },
      flush() {
        disarm();
        if (pending) fire();
      },
      reset() {
        disarm();
        lastRunMs = 0;
        pending = false;
      },
      get armed() {
        return timer !== null;
      },
    };
  };

  const settle = throttle(SETTLE_MS, notify);

  return {
    now,
    viewTime: () => view,
    setViewTime(time, cadence = 'now') {
      view = time;
      if (cadence === 'coalesced') settle.schedule();
      else notify();
    },
    onViewTime(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settle,
    viewMs(nowMs = now()) {
      return view.kind === 'scrubbed' ? view.atMs : nowMs;
    },
    isScrubbed: () => view.kind === 'scrubbed',
    every(intervalMs, tick) {
      const id = setInterval(() => tick(now()), intervalMs);
      return () => clearInterval(id);
    },
    throttle,
  };
}
