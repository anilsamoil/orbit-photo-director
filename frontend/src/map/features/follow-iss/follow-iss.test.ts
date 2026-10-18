import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fixture from '../../../../test/fixtures/iss-sgp4-fixture.json';
import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import type { Track } from '../../../types';
import { createClock } from '../../map-core/clock';
import { createMapCore, type MapCore } from '../../map-core/core';
import type { CameraMove } from '../../map-core/vendor-map';
import { PREF_KEYS } from '../../map-core/prefs';

const loaded: { mod: typeof import('./index') | null } = { mod: null };

function api(): typeof import('./index') {
  const mod = loaded.mod;
  if (!mod) throw new Error('follow-iss module was not loaded');
  return mod;
}

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  loaded.mod = await import('./index');
});

afterEach(() => {
  localStorage.clear();
});

describe('follow-iss', () => {
  it('ships ISS up as the default control', () => {
    const html = readFileSync(resolve(__dirname, '../../../../index.html'), 'utf8');
    const doc = document.createElement('template');
    doc.innerHTML = html;
    const north = doc.content.querySelector('#bearing-north');
    const iss = doc.content.querySelector('#bearing-iss');
    expect(north?.classList.contains('active')).toBe(false);
    expect(iss?.classList.contains('active')).toBe(true);
    expect(north?.getAttribute('title') ?? '').not.toMatch(/default/i);
    expect(iss?.getAttribute('title') ?? '').toMatch(/default/i);
    expect(iss?.getAttribute('title') ?? '').toMatch(/direction of travel/i);
  });

  it('reads iss-up unless the stored bearing is north', () => {
    expect(api().readBearingMode()).toBe('iss-up');
    localStorage.setItem(PREF_KEYS.bearingMode, 'north');
    expect(api().readBearingMode()).toBe('north');
    localStorage.setItem(PREF_KEYS.bearingMode, 'sideways');
    expect(api().readBearingMode()).toBe('iss-up');
  });
});

const TRACK = {
  ...fixture,
  tle_epoch: fixture.start,
  tle_age_hours: 0,
  tle_freshness_factor: 1,
} as Track;

function heldCamera(): { vendor: VendorDouble; calls: CameraMove[] } {
  const vendor = createVendorDouble();
  const calls: CameraMove[] = [];
  vendor.easeTo = (move) => { calls.push(move); };
  return { vendor, calls };
}

function arm(nowMs: number): { vendor: VendorDouble; calls: CameraMove[]; north: HTMLButtonElement; iss: HTMLButtonElement } {
  const { vendor, calls } = heldCamera();
  const core = createMapCore(vendor, createClock(() => nowMs));
  core.setTrack(TRACK);
  api().noteFollowCore(core);
  document.body.innerHTML = '<button id="bearing-north"></button><button id="bearing-iss"></button>';
  api().bindBearingToggle();
  return {
    vendor,
    calls,
    north: document.getElementById('bearing-north') as HTMLButtonElement,
    iss: document.getElementById('bearing-iss') as HTMLButtonElement,
  };
}

describe('bearing retarget while an ease is in flight', () => {
  const nowMs = Date.parse(fixture.start);

  it('sends North to bearing 0 while the camera still reads 0 and an ISS-up ease is in flight', () => {
    const { calls, north } = arm(nowMs);
    api().applyBearing(true);
    expect(calls[0]?.bearing).toBeGreaterThan(1);
    north.click();
    expect(calls.at(-1)).toMatchObject({ bearing: 0 });
    expect(calls.length).toBeGreaterThan(1);
  });

  it('sends ISS-up back to the heading while a North ease has not painted yet', () => {
    const { vendor, calls, north, iss } = arm(nowMs);
    const heading = api().computeIssHeading(nowMs);
    expect(heading).not.toBeNull();
    vendor.setBearing(heading!);
    north.click();
    iss.click();
    expect(calls.at(-1)?.bearing).toBeCloseTo(heading!, 5);
  });

  it('accepts a second North tap after the first one retargets', () => {
    const { calls, north } = arm(nowMs);
    api().applyBearing(true);
    north.click();
    const afterFirst = calls.length;
    north.click();
    expect(afterFirst).toBeGreaterThan(1);
    expect(calls.length).toBe(afterFirst);
  });

  it('does not ease when a gesture ends away from the mode', () => {
    const { vendor, calls, north } = arm(nowMs);
    api().applyBearing(true);
    const started = calls.length;
    vendor.fire('moveend', undefined);
    vendor.setBearing(33);
    expect(calls.length).toBe(started);
    north.click();
    expect(calls.at(-1)).toMatchObject({ bearing: 0 });
  });
});

describe('deferred north recenter', () => {
  const nowMs = Date.parse(fixture.start);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function armFollow(): {
    vendor: VendorDouble;
    calls: CameraMove[];
    frames: FrameRequestCallback[];
    centers: () => [number, number][];
    depth: () => number;
    core: MapCore;
    north: HTMLButtonElement;
    iss: HTMLButtonElement;
  } {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const { vendor, calls } = heldCamera();
    let depth = 0;
    let maxDepth = 0;
    const orig = vendor.setCenter.bind(vendor);
    vendor.setCenter = (at) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      orig(at);
      vendor.fire('moveend', undefined);
      depth -= 1;
    };
    vendor.easeTo = (move) => {
      calls.push(move);
      if (move.duration === 0) vendor.fire('moveend', undefined);
    };
    const core = createMapCore(vendor, createClock(() => nowMs));
    core.setTrack(TRACK);
    api().noteFollowCore(core);
    api().setFollowEnv(core, true);
    document.body.innerHTML = '<button id="toggle-follow-iss"></button><button id="bearing-north"></button><button id="bearing-iss"></button>';
    api().bindFollowToggle();
    api().bindBearingToggle();
    return {
      vendor,
      calls,
      frames,
      centers: () => vendor.cameraCalls.filter((call) => call.method === 'setCenter').map((call) => call.args[0] as [number, number]),
      depth: () => maxDepth,
      core,
      north: document.getElementById('bearing-north') as HTMLButtonElement,
      iss: document.getElementById('bearing-iss') as HTMLButtonElement,
    };
  }

  it('applies a follow tick from a north ease on the next frame, not inside moveend', () => {
    const { vendor, calls, frames, centers, depth, north } = armFollow();
    vendor.setBearing(80);
    north.click();
    expect(calls.at(-1)).toMatchObject({ bearing: 0, duration: 600 });
    api().applyFollowISS({ lat: 12, lon: 34 });
    expect(centers()).toEqual([]);
    vendor.setBearing(0);
    vendor.fire('moveend', undefined);
    expect(centers()).toEqual([]);
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(centers()).toEqual([[34, 12]]);
    expect(depth()).toBe(1);
    expect(calls.filter((call) => call.duration === 600)).toHaveLength(1);
  });

  it('does not apply the deferred recenter after the view is scrubbed', () => {
    const { vendor, frames, centers, core, north } = armFollow();
    vendor.setBearing(80);
    north.click();
    api().applyFollowISS({ lat: 12, lon: 34 });
    vendor.setBearing(0);
    vendor.fire('moveend', undefined);
    expect(frames).toHaveLength(1);
    core.clock.setViewTime({ kind: 'scrubbed', atMs: nowMs + 45 * 60_000 });
    frames[0]!(0);
    expect(centers()).toEqual([]);
    expect(vendor.bearing()).toBe(0);
  });

  it('holds a follow tick while a right-button rotate is waiting for its first frame', () => {
    const { centers } = armFollow();
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, pointerId: 4 }));
    api().applyFollowISS({ lat: 12, lon: 34 });
    expect(centers()).toEqual([]);
    expect(document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed')).toBe('true');
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2, pointerId: 4 }));
    api().applyFollowISS({ lat: 1, lon: 2 });
    expect(centers()).toEqual([[2, 1]]);
    expect(document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('drops the deferred center when a duration-0 cancel ends the north ease', () => {
    const { vendor, calls, frames, centers, north, iss } = armFollow();
    const heading = api().computeIssHeading(nowMs);
    expect(heading).not.toBeNull();
    vendor.setBearing(heading!);
    north.click();
    api().applyFollowISS({ lat: 3, lon: 4 });
    iss.click();
    expect(calls.at(-1)).toMatchObject({ bearing: heading, duration: 0 });
    expect(frames).toHaveLength(0);
    expect(centers()).toEqual([]);
  });

  it('skips the deferred center when a new ease starts before the frame', () => {
    const { vendor, frames, centers, north, iss } = armFollow();
    vendor.setBearing(80);
    north.click();
    api().applyFollowISS({ lat: 12, lon: 34 });
    vendor.setBearing(0);
    vendor.fire('moveend', undefined);
    expect(frames).toHaveLength(1);
    const heading = api().computeIssHeading(nowMs);
    expect(heading).not.toBeNull();
    vendor.setBearing(heading! + 90);
    iss.click();
    frames[0]!(0);
    expect(centers()).toEqual([]);
  });

  it('a follow tick does not snap bearing when recenter delivers the user rotate', () => {
    const { vendor, north } = armFollow();
    vendor.setBearing(0);
    north.click();
    expect(api().currentBearingMode()).toBe('north');
    expect(localStorage.getItem(PREF_KEYS.bearingMode)).toBe('north');
    vendor.setBearing(40);
    const orig = vendor.setCenter.bind(vendor);
    vendor.setCenter = (at) => {
      orig(at);
      vendor.fire('rotatestart', { byUser: true });
    };
    const before = vendor.cameraCalls.length;
    api().applyFollowISS({ lat: 12, lon: 34 });
    expect(vendor.cameraCalls.slice(before).filter((call) => call.method === 'setBearing')).toEqual([]);
    expect(vendor.bearing()).toBe(40);
    expect(api().currentBearingMode()).toBe('north');
    expect(localStorage.getItem(PREF_KEYS.bearingMode)).toBe('north');
    expect(document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a click just after a user rotate still selects North', () => {
    const { vendor, calls, north } = armFollow();
    vendor.setBearing(40);
    vendor.fire('rotatestart', { byUser: true });
    north.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    north.click();
    expect(calls.at(-1)).toMatchObject({ bearing: 0, duration: 600 });
    expect(api().currentBearingMode()).toBe('north');
    expect(localStorage.getItem(PREF_KEYS.bearingMode)).toBe('north');
  });

  it('a keyboard rotate still accepts the next North click', () => {
    const { vendor, calls, north } = armFollow();
    vendor.setBearing(40);
    vendor.fire('rotatestart', { byUser: true });
    north.click();
    expect(calls.at(-1)).toMatchObject({ bearing: 0, duration: 600 });
  });

  it('a user rotate releases follow and does not recenter', () => {
    const { vendor, frames, centers } = armFollow();
    vendor.setBearing(80);
    (document.getElementById('bearing-north') as HTMLButtonElement).click();
    api().applyFollowISS({ lat: 1, lon: 2 });
    vendor.fire('rotatestart', { byUser: false });
    expect(document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed')).toBe('true');
    vendor.fire('rotatestart', { byUser: true });
    expect(document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed')).toBe('false');
    vendor.setBearing(0);
    vendor.fire('moveend', undefined);
    expect(frames).toHaveLength(0);
    expect(centers()).toEqual([]);
  });
});
