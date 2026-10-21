import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fixture from '../../../../test/fixtures/iss-sgp4-fixture.json';
import { createVendorDouble, type VendorDouble } from '../../../../test/vendor-map-double';
import type { Track } from '../../../types';
import { createClock } from '../../map-core/clock';
import { createMapCore } from '../../map-core/core';
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

  it('does not restart an ISS-up ease already aimed at the heading', () => {
    const { calls, iss } = arm(nowMs);
    api().applyBearing(true);
    const started = calls.length;
    iss.click();
    expect(calls.length).toBe(started);
  });

  it('does not ease when the camera is already inside the north noop band', () => {
    const { vendor, calls, north } = arm(nowMs);
    api().applyBearing(true);
    vendor.fire('moveend', undefined);
    vendor.setBearing(0.4);
    const before = calls.length;
    north.click();
    expect(calls.length).toBe(before);
  });

  it('reapplies active ISS-up after a gesture settles away from the commanded heading', () => {
    const { vendor, calls, iss } = arm(nowMs);
    api().applyBearing(true);
    const heading = api().computeIssHeading(nowMs)!;
    vendor.setBearing(33);
    vendor.fire('moveend', undefined);
    const beforeTap = calls.length;
    iss.click();
    expect(calls.length).toBe(beforeTap + 1);
    expect(calls.at(-1)?.bearing).toBeCloseTo(heading, 5);
  });
});
