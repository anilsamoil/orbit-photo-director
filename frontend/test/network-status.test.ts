import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPollScheduler, isOnline, isVisible } from '../src/network-status';

describe('isOnline', () => {
  it('returns true when navigator.onLine is true', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    expect(isOnline()).toBe(true);
  });

  it('returns false when navigator.onLine is false', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    expect(isOnline()).toBe(false);
  });
});

describe('isVisible', () => {
  it('returns true when document.visibilityState is visible', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(isVisible()).toBe(true);
  });

  it('returns false when document.visibilityState is hidden', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    expect(isVisible()).toBe(false);
  });
});

describe('createPollScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore visibility/online globals so test order changes (or future
    // describe blocks in this file) inherit a clean baseline. Without this,
    // a previous test that left visibilityState='hidden' would leak into
    // the next file via the shared happy-dom document.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('does not call onPoll synchronously on creation', () => {
    const onPoll = vi.fn();
    const sched = createPollScheduler({ intervalMs: 1000, onPoll });
    expect(onPoll).not.toHaveBeenCalled();
    sched.stop();
  });

  it('fires onPoll every intervalMs while visible', () => {
    const onPoll = vi.fn();
    const sched = createPollScheduler({ intervalMs: 1000, onPoll });
    vi.advanceTimersByTime(3500);
    expect(onPoll).toHaveBeenCalledTimes(3);
    sched.stop();
  });

  it('pauses polling when the tab becomes hidden', () => {
    const onPoll = vi.fn();
    const sched = createPollScheduler({ intervalMs: 1000, onPoll });
    vi.advanceTimersByTime(2500);
    expect(onPoll).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    vi.advanceTimersByTime(5000);
    // Still 2 — no more polls fire while hidden
    expect(onPoll).toHaveBeenCalledTimes(2);
    sched.stop();
  });

  it('fires onResume immediately when the tab becomes visible again', () => {
    const onPoll = vi.fn();
    const onResume = vi.fn();
    const sched = createPollScheduler({ intervalMs: 1000, onPoll, onResume });

    // Hide
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5000);
    expect(onResume).not.toHaveBeenCalled();

    // Show again
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onResume).toHaveBeenCalledTimes(1);
    // And the interval resumes
    vi.advanceTimersByTime(2500);
    expect(onPoll).toHaveBeenCalledTimes(2);
    sched.stop();
  });

  it('defaults onResume to onPoll when not provided', () => {
    const onPoll = vi.fn();
    const sched = createPollScheduler({ intervalMs: 1000, onPoll });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onPoll).toHaveBeenCalledTimes(1);
    sched.stop();
  });

  it('stop() halts the timer and removes the listener', () => {
    const onPoll = vi.fn();
    const sched = createPollScheduler({ intervalMs: 1000, onPoll });
    vi.advanceTimersByTime(1500);
    expect(onPoll).toHaveBeenCalledTimes(1);

    sched.stop();
    vi.advanceTimersByTime(5000);
    expect(onPoll).toHaveBeenCalledTimes(1); // no more after stop

    // visibility events post-stop don't trigger anything either
    const onResume = vi.fn();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onResume).not.toHaveBeenCalled();
  });

  it('stop() is idempotent', () => {
    const onPoll = vi.fn();
    const sched = createPollScheduler({ intervalMs: 1000, onPoll });
    sched.stop();
    expect(() => sched.stop()).not.toThrow();
  });
});
