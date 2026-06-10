import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';

import {
  _resetFollowStateForTest,
  _resetMapStateForTest,
  _setFollowEnvForTest,
  applyFollowISS as realApplyFollowISS,
  setLookahead,
} from '../src/map';

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
  flyCalls: { center: [number, number]; duration: number; essential?: boolean }[] = [];
  dragHandler: (() => void) | null = null;
  zoomHandler: ((e: unknown) => void) | null = null;

  setCenter(c: [number, number]): void {
    this.centerCalls.push(c);
  }
  easeTo(opts: { center: [number, number] }): void {
    this.easeCalls.push(opts.center);
  }
  flyTo(opts: { center: [number, number]; duration: number; essential?: boolean }): void {
    this.flyCalls.push(opts);
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

/** Mirror of the one-shot toggle-on click handler in map.ts (v2 hotfix).
 *  Toggle-OFF (already following) leaves state false, no camera op.
 *  Toggle-ON (not yet following) enters follow + flyTo's the camera. */
function clickFollowToggle(state: FollowState, map: FakeMap, pos: { lat: number; lon: number }): void {
  if (state.followISS) {
    state.followISS = false;
    return;
  }
  state.followISS = true;
  map.flyTo({ center: [pos.lon, pos.lat], duration: 800, essential: true });
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

describe('follow-ISS one-shot click contract (v2 hotfix)', () => {
  // v2 hotfix (Anil same-day feedback after v1.6.16.0): the toggle-on
  // click now flies the camera to the ISS via flyTo({duration:800,
  // essential:true}) instead of easeTo({duration:500}). easeTo's linear
  // pan looked frozen at high zoom; flyTo zooms out + pans + zooms in.
  let state: FollowState;
  let map: FakeMap;

  beforeEach(() => {
    state = { followISS: false };
    map = new FakeMap();
    setupFollow(state, map);
  });

  it('toggle-ON click enters follow + flies to ISS pos (NOT easeTo)', () => {
    clickFollowToggle(state, map, { lat: 30, lon: 50 });
    expect(state.followISS).toBe(true);
    expect(map.flyCalls).toHaveLength(1);
    expect(map.easeCalls).toHaveLength(0);
    expect(map.flyCalls[0]?.center).toEqual([50, 30]);
    expect(map.flyCalls[0]?.duration).toBe(800);
    expect(map.flyCalls[0]?.essential).toBe(true);
  });

  it('toggle-OFF click (already following) exits follow with no camera op', () => {
    // Preserve the existing semantics: clicking while followISS=true
    // just sets it false; no flyTo, no easeTo, no setCenter.
    state.followISS = true;
    clickFollowToggle(state, map, { lat: 30, lon: 50 });
    expect(state.followISS).toBe(false);
    expect(map.flyCalls).toHaveLength(0);
    expect(map.easeCalls).toHaveLength(0);
    expect(map.centerCalls).toHaveLength(0);
  });
});

// REGRESSION (feat/time-slider, 4A 2026-06-10): applyFollowISS gained an
// isScrubbed() gate — the 1Hz caller passes the LIVE ISS position, and
// recentering on it while the map shows a future instant makes the camera
// chase a marker that isn't on screen. Unlike the mirror contract above,
// these tests drive the REAL applyFollowISS via the _setFollowEnvForTest
// seam (map-like object — no MapLibre runtime needed for this gate).
describe('applyFollowISS scrub gate (4A — real implementation)', () => {
  let fake: FakeMap;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
    _resetMapStateForTest();
    _resetFollowStateForTest();
    fake = new FakeMap();
  });

  afterEach(() => {
    _setFollowEnvForTest(null, false);
    vi.useRealTimers();
  });

  it('live + following → recenters on the ISS position', () => {
    _setFollowEnvForTest(fake, true);
    realApplyFollowISS({ lat: 30, lon: 50 });
    expect(fake.centerCalls).toEqual([[50, 30]]);
  });

  it('scrubbed + following → no-op (camera must not chase the live position)', () => {
    _setFollowEnvForTest(fake, true);
    setLookahead(90, /*recenter=*/false);
    realApplyFollowISS({ lat: 30, lon: 50 });
    expect(fake.centerCalls).toHaveLength(0);
  });

  it('follow resumes when the view returns to live (Now reset)', () => {
    _setFollowEnvForTest(fake, true);
    setLookahead(90, false);
    realApplyFollowISS({ lat: 30, lon: 50 });
    setLookahead(0, false);
    realApplyFollowISS({ lat: 31, lon: 51 });
    expect(fake.centerCalls).toEqual([[51, 31]]);
  });

  it('follow OFF → no-op even when live', () => {
    _setFollowEnvForTest(fake, false);
    realApplyFollowISS({ lat: 30, lon: 50 });
    expect(fake.centerCalls).toHaveLength(0);
  });

  it('no map → no-op regardless of follow + scrub state', () => {
    _setFollowEnvForTest(null, true);
    expect(() => realApplyFollowISS({ lat: 30, lon: 50 })).not.toThrow();
  });
});
