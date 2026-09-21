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

export interface Clock {
  now(): number;
  viewTime(): ViewTime;
  setViewTime(time: ViewTime): void;
  viewMs(nowMs?: number): number;
  isScrubbed(): boolean;
  every(intervalMs: number, tick: (nowMs: number) => void): Unsubscribe;
  throttle(intervalMs: number, run: (nowMs: number) => void): Throttle;
}

export function createClock(now: () => number = () => Date.now()): Clock {
  let view: ViewTime = { kind: 'live' };

  return {
    now,
    viewTime: () => view,
    setViewTime(time) {
      view = time;
    },
    viewMs(nowMs = now()) {
      return view.kind === 'scrubbed' ? view.atMs : nowMs;
    },
    isScrubbed: () => view.kind === 'scrubbed',
    every(intervalMs, tick) {
      const id = setInterval(() => tick(now()), intervalMs);
      return () => clearInterval(id);
    },
    throttle(intervalMs, run) {
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
    },
  };
}
