import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClock } from '../src/map/map-core/clock';

// The clock is the one answer to "what time does the map render". Every
// feature reads the view instant from it and every ticker is started
// through it, so nothing under src/map/ has to choose between Date.now()
// and the scrubbed instant.

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('view time', () => {
  it('opens live and renders the wall clock', () => {
    const clock = createClock();
    expect(clock.viewTime()).toEqual({ kind: 'live' });
    expect(clock.isScrubbed()).toBe(false);
    expect(clock.viewMs()).toBe(T0);
    expect(clock.viewMs(T0 + 5_000)).toBe(T0 + 5_000);
  });

  it('renders the scrubbed instant whatever the wall clock says', () => {
    const clock = createClock();
    clock.setViewTime({ kind: 'scrubbed', atMs: T0 + 45 * 60_000 });
    expect(clock.isScrubbed()).toBe(true);
    expect(clock.viewMs()).toBe(T0 + 45 * 60_000);
    vi.setSystemTime(T0 + 10 * 60_000);
    expect(clock.viewMs()).toBe(T0 + 45 * 60_000);
    clock.setViewTime({ kind: 'live' });
    expect(clock.viewMs()).toBe(T0 + 10 * 60_000);
  });

  it('reads the injected wall clock', () => {
    let wall = 1_000;
    const clock = createClock(() => wall);
    expect(clock.now()).toBe(1_000);
    wall = 2_000;
    expect(clock.viewMs()).toBe(2_000);
  });
});

describe('view time listeners', () => {
  it('hear a discrete change at once, with the new instant already readable', () => {
    const clock = createClock();
    const heard: number[] = [];
    clock.onViewTime(() => heard.push(clock.viewMs()));
    clock.setViewTime({ kind: 'scrubbed', atMs: T0 + 60_000 });
    expect(heard).toEqual([T0 + 60_000]);
    expect(clock.settle.armed).toBe(false);
  });

  it('hear a coalesced burst on its leading edge and once more when it settles', () => {
    const clock = createClock();
    const heard: number[] = [];
    clock.onViewTime(() => heard.push(clock.viewMs()));
    clock.setViewTime({ kind: 'scrubbed', atMs: T0 + 15 * 60_000 }, 'coalesced');
    clock.setViewTime({ kind: 'scrubbed', atMs: T0 + 30 * 60_000 }, 'coalesced');
    clock.setViewTime({ kind: 'scrubbed', atMs: T0 + 45 * 60_000 }, 'coalesced');
    expect(heard).toEqual([T0 + 15 * 60_000]);
    expect(clock.viewMs()).toBe(T0 + 45 * 60_000);
    expect(clock.settle.armed).toBe(true);
    vi.advanceTimersByTime(150);
    expect(heard).toEqual([T0 + 15 * 60_000, T0 + 45 * 60_000]);
  });

  it('hear a pending coalesced change now when the settle is flushed', () => {
    const clock = createClock();
    const listener = vi.fn();
    clock.onViewTime(listener);
    clock.setViewTime({ kind: 'scrubbed', atMs: T0 + 60_000 }, 'coalesced');
    vi.advanceTimersByTime(50);
    clock.setViewTime({ kind: 'live' }, 'coalesced');
    expect(listener).toHaveBeenCalledOnce();
    clock.settle.flush();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(clock.settle.armed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stop hearing once unsubscribed', () => {
    const clock = createClock();
    const listener = vi.fn();
    const stop = clock.onViewTime(listener);
    clock.setViewTime({ kind: 'live' });
    stop();
    clock.setViewTime({ kind: 'scrubbed', atMs: T0 + 60_000 });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('every', () => {
  it('ticks on the interval and hands the tick the wall clock at fire time', () => {
    const clock = createClock();
    const seen: number[] = [];
    clock.every(1_000, (nowMs) => seen.push(nowMs));
    vi.advanceTimersByTime(2_999);
    expect(seen).toEqual([T0 + 1_000, T0 + 2_000]);
  });

  it('stops when unsubscribed', () => {
    const clock = createClock();
    const tick = vi.fn();
    const stop = clock.every(1_000, tick);
    vi.advanceTimersByTime(1_000);
    stop();
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledOnce();
  });
});

describe('throttle', () => {
  it('runs on the leading edge, then defers a burst to one trailing run', () => {
    const clock = createClock();
    const runs: number[] = [];
    const throttle = clock.throttle(150, (nowMs) => runs.push(nowMs));
    throttle.schedule();
    expect(runs).toEqual([T0]);
    expect(throttle.armed).toBe(false);

    vi.advanceTimersByTime(40);
    throttle.schedule();
    vi.advanceTimersByTime(40);
    throttle.schedule();
    expect(runs).toEqual([T0]);
    expect(throttle.armed).toBe(true);

    vi.advanceTimersByTime(70);
    expect(runs).toEqual([T0, T0 + 150]);
    expect(throttle.armed).toBe(false);
  });

  it('runs on the leading edge again once the interval has passed', () => {
    const clock = createClock();
    const run = vi.fn();
    const throttle = clock.throttle(150, run);
    throttle.schedule();
    vi.advanceTimersByTime(150);
    throttle.schedule();
    expect(run).toHaveBeenCalledTimes(2);
    expect(throttle.armed).toBe(false);
  });

  it('flush runs the deferred work now and disarms the timer', () => {
    const clock = createClock();
    const run = vi.fn();
    const throttle = clock.throttle(150, run);
    throttle.schedule();
    vi.advanceTimersByTime(10);
    throttle.schedule();
    throttle.flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(throttle.armed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('flush with nothing pending runs nothing', () => {
    const clock = createClock();
    const run = vi.fn();
    const throttle = clock.throttle(150, run);
    throttle.flush();
    throttle.schedule();
    throttle.flush();
    expect(run).toHaveBeenCalledOnce();
  });

  it('reset drops the deferred work and lets the next schedule run at once', () => {
    const clock = createClock();
    const run = vi.fn();
    const throttle = clock.throttle(150, run);
    throttle.schedule();
    vi.advanceTimersByTime(10);
    throttle.schedule();
    throttle.reset();
    expect(throttle.armed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledOnce();
    throttle.schedule();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('treats a wall clock that stepped backwards as no time elapsed', () => {
    let wall = T0;
    const clock = createClock(() => wall);
    const run = vi.fn();
    const throttle = clock.throttle(150, run);
    throttle.schedule();
    wall = T0 - 60_000;
    throttle.schedule();
    expect(run).toHaveBeenCalledOnce();
    expect(throttle.armed).toBe(true);
    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
