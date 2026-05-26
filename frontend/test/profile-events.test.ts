/** Slot 11 of design rev 2 — profile event bus + storage event + debounce.
 *
 *  Verifies the subscribeProfileChanged contract:
 *    - in-tab 'profile-changed' CustomEvent triggers the subscriber
 *    - cross-tab 'storage' events for opd-profile-* keys trigger the
 *      subscriber
 *    - 'storage' events for non-profile keys do NOT trigger
 *    - rapid events coalesce within the 150ms debounce window
 *    - unsubscribe cancels both listeners + any pending timer
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _emitStorageEventForTests,
  subscribeProfileChanged,
} from '../src/profile-events';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('subscribeProfileChanged', () => {
  it('fires the handler on a local "profile-changed" CustomEvent', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);
    window.dispatchEvent(new CustomEvent('profile-changed'));
    // Leading-edge fire — handler should run immediately.
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('fires the handler on a cross-tab storage event for opd-profile-* keys', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);
    _emitStorageEventForTests('opd-profile-jack');
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('fires on the known-profiles list key (opd-profile-names) — picker needs it', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);
    _emitStorageEventForTests('opd-profile-names');
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('does NOT fire on storage events for non-profile keys', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);
    _emitStorageEventForTests('opd-map-terminator-visible');
    _emitStorageEventForTests('opd-map-clouds-visible');
    _emitStorageEventForTests('opd-snapshot');
    _emitStorageEventForTests('opd-calib-queue');
    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('treats a localStorage.clear() (storage event with key=null) as a profile change', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);
    _emitStorageEventForTests(null);
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('coalesces multiple rapid events within the 150ms debounce window', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);

    // First event fires immediately (leading edge).
    window.dispatchEvent(new CustomEvent('profile-changed'));
    expect(handler).toHaveBeenCalledTimes(1);

    // 4 more within the 150ms window — should coalesce into ONE trailing
    // call after the window expires.
    window.dispatchEvent(new CustomEvent('profile-changed'));
    vi.advanceTimersByTime(20);
    window.dispatchEvent(new CustomEvent('profile-changed'));
    vi.advanceTimersByTime(20);
    window.dispatchEvent(new CustomEvent('profile-changed'));
    vi.advanceTimersByTime(20);
    window.dispatchEvent(new CustomEvent('profile-changed'));

    // Still inside the window: only the leading call has fired.
    expect(handler).toHaveBeenCalledTimes(1);

    // Advance past the trailing timeout.
    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('coalesces in-tab + cross-tab events together (one debouncer per subscriber)', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);

    window.dispatchEvent(new CustomEvent('profile-changed'));
    _emitStorageEventForTests('opd-profile-jack');
    _emitStorageEventForTests('opd-profile-anil');

    // Leading fire happened once for the first event; the rest collapse.
    expect(handler).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('lets a second leading-edge fire happen after a quiet period', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);

    window.dispatchEvent(new CustomEvent('profile-changed'));
    expect(handler).toHaveBeenCalledTimes(1);

    // Wait out the debounce window with no events.
    vi.advanceTimersByTime(300);

    // New event after the quiet period should fire immediately again.
    window.dispatchEvent(new CustomEvent('profile-changed'));
    expect(handler).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('unsubscribe removes both listeners and cancels pending timers', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeProfileChanged(handler);

    window.dispatchEvent(new CustomEvent('profile-changed'));
    expect(handler).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent('profile-changed')); // arms trailing

    unsubscribe();
    // Advance past the trailing window — handler must NOT fire because
    // unsubscribe cancels the pending timer.
    vi.advanceTimersByTime(500);
    expect(handler).toHaveBeenCalledTimes(1);

    // Subsequent events do not reach the handler either.
    window.dispatchEvent(new CustomEvent('profile-changed'));
    _emitStorageEventForTests('opd-profile-jack');
    vi.advanceTimersByTime(500);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports multiple independent subscribers', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeProfileChanged(a);
    const unsubB = subscribeProfileChanged(b);
    window.dispatchEvent(new CustomEvent('profile-changed'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    window.dispatchEvent(new CustomEvent('profile-changed'));
    // a is unsubscribed; only b should hear the second event (after its
    // debounce window has passed since the previous call).
    vi.advanceTimersByTime(300);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b.mock.calls.length).toBeGreaterThanOrEqual(2);
    unsubB();
  });

  it('does not propagate a subscriber exception to other subscribers or the bus', () => {
    const bad = vi.fn(() => { throw new Error('handler crashed'); });
    const good = vi.fn();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    const unsubBad = subscribeProfileChanged(bad);
    const unsubGood = subscribeProfileChanged(good);
    window.dispatchEvent(new CustomEvent('profile-changed'));
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalled();
    unsubBad();
    unsubGood();
  });
});
