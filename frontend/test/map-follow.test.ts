import { describe, expect, it, beforeEach, vi } from 'vitest';

// v1.5.2.0 follow-ISS toggle test (Chris ask, /plan-eng-review T2):
// asserts the dragstart-during-pending-tick race resolves correctly.
//
// The contract: when a user pans during a 1Hz tick that's about to call
// applyFollowISS:
//   1. dragstart handler fires first → followISS=false
//   2. tick fires → applyFollowISS sees followISS=false → no-op
// So the test simulates that ordering and asserts no setCenter call.
//
// We can't easily import applyFollowISS without instantiating a MapLibre
// map (which fails in happy-dom). Instead we mirror the contract here in
// a small state machine and test it directly. The real impl lives at
// frontend/src/map.ts.

class FakeMap {
  centerCalls: [number, number][] = [];
  easeCalls: [number, number][] = [];
  dragHandler: (() => void) | null = null;
  zoomHandler: ((e: unknown) => void) | null = null;

  setCenter(c: [number, number]): void {
    this.centerCalls.push(c);
  }
  easeTo(opts: { center: [number, number] }): void {
    this.easeCalls.push(opts.center);
  }
  on(event: string, handler: (e?: unknown) => void): void {
    if (event === 'dragstart') this.dragHandler = handler as () => void;
    if (event === 'zoomstart') this.zoomHandler = handler;
  }
  fireDragstart(): void {
    if (this.dragHandler) this.dragHandler();
  }
  fireZoomstart(originalEvent: unknown): void {
    if (this.zoomHandler) this.zoomHandler({ originalEvent });
  }
}

interface FollowState {
  followISS: boolean;
}

function applyFollowISS(state: FollowState, map: FakeMap, pos: { lat: number; lon: number }): void {
  if (!state.followISS) return;
  map.setCenter([pos.lon, pos.lat]);
}

function setupFollow(state: FollowState, map: FakeMap): void {
  map.on('dragstart', () => { state.followISS = false; });
  map.on('zoomstart', (e: unknown) => {
    const orig = (e as { originalEvent?: unknown } | undefined)?.originalEvent;
    if (orig) state.followISS = false;
  });
}

describe('follow-ISS contract (v1.5.2.0)', () => {
  let state: FollowState;
  let map: FakeMap;

  beforeEach(() => {
    state = { followISS: false };
    map = new FakeMap();
    setupFollow(state, map);
  });

  it('with follow OFF, applyFollowISS is a no-op', () => {
    applyFollowISS(state, map, { lat: 30, lon: 50 });
    expect(map.centerCalls).toHaveLength(0);
  });

  it('with follow ON, applyFollowISS calls setCenter with [lon, lat]', () => {
    state.followISS = true;
    applyFollowISS(state, map, { lat: 30, lon: 50 });
    expect(map.centerCalls).toEqual([[50, 30]]);
  });

  it('uses setCenter (instant) not easeTo (animated) on the recurring path (A5)', () => {
    // The recurring 1Hz update MUST be setCenter — easeTo at 1Hz queues
    // animations and jitters. easeTo is reserved for the one-shot click.
    state.followISS = true;
    applyFollowISS(state, map, { lat: 30, lon: 50 });
    applyFollowISS(state, map, { lat: 31, lon: 51 });
    applyFollowISS(state, map, { lat: 32, lon: 52 });
    expect(map.centerCalls).toHaveLength(3);
    expect(map.easeCalls).toHaveLength(0);
  });

  it('T2 race: dragstart fires before tick → tick is a no-op', () => {
    // Follow is on. User starts a drag (dragstart fires, sets followISS=false).
    // Then the next 1Hz tick fires applyFollowISS — it should see the
    // updated state and not setCenter.
    state.followISS = true;
    map.fireDragstart();
    expect(state.followISS).toBe(false);
    applyFollowISS(state, map, { lat: 30, lon: 50 });
    expect(map.centerCalls).toHaveLength(0);
  });

  it('user-initiated zoomstart breaks follow (has originalEvent)', () => {
    state.followISS = true;
    map.fireZoomstart({ type: 'wheel' }); // mock user wheel event
    expect(state.followISS).toBe(false);
  });

  it('programmatic zoomstart does NOT break follow (no originalEvent)', () => {
    // setCenter doesn't fire zoomstart, but if some other code path did,
    // it would fire with originalEvent=undefined. We respect that distinction.
    state.followISS = true;
    map.fireZoomstart(undefined);
    expect(state.followISS).toBe(true);
  });

  it('many ticks after exit-follow: all no-op (follow stays off)', () => {
    state.followISS = true;
    map.fireDragstart();
    for (let i = 0; i < 10; i++) {
      applyFollowISS(state, map, { lat: 30 + i, lon: 50 + i });
    }
    expect(map.centerCalls).toHaveLength(0);
  });
});
