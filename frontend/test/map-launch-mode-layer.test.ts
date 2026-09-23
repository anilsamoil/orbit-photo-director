import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _getViewTimeMsForTest, _resetMapStateForTest, _setFollowEnvForTest,
  _syncMapLaunchModeForTest, applyFollowISS, focusLaunchOnMap, setLookahead,
} from '../src/map';
import type { MapCore, PopupOwner } from '../src/map/map-core/core';
import { getMapLaunchMode, setMapLaunchMode } from '../src/map-launch-mode';
import { launchStore } from '../src/launch-store';
import { launch, NOW, state } from './launch-fixtures';

const launchLayers = ['ascent-pad-layer', 'ascent-trajectory-layer'];
const targetLayers = ['targets-layer', 'my-targets-layer', 'my-targets-casing'];
const otherLayers = ['iss-track-layer', 'clouds-layer', 'terminator-line-layer'];

function fakeMap() {
  const visibility = new Map([...launchLayers, ...targetLayers, ...otherLayers].map((id) => [id, 'visible']));
  const sources = new Map(['ascent-pad', 'ascent-trajectory', 'targets', 'my-targets', 'iss-track', 'clouds']
    .map((id) => [id, { setData: vi.fn() }]));
  const styleListeners = new Set<() => void>();
  const popupQueue: ReturnType<typeof fakePopup>[] = [];
  return {
    visibility, sources, popupQueue,
    setCenter: vi.fn(), easeTo: vi.fn(), fitBounds: vi.fn(),
    openPopup: vi.fn(() => {
      const popup = popupQueue.shift();
      if (!popup) throw new Error('no fake popup queued');
      return popup;
    }),
    hasLayer: vi.fn((id: string) => visibility.has(id)),
    visibilityOf: vi.fn((id: string) => visibility.get(id)),
    setVisibility: vi.fn((id: string, next: string) => {
      visibility.set(id, next);
      for (const listener of [...styleListeners]) listener();
    }),
    hasSource: vi.fn((id: string) => sources.has(id)),
    setGeoJson: vi.fn((id: string, data: unknown) => { sources.get(id)?.setData(data); }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'styledata') styleListeners.add(listener);
      return () => { styleListeners.delete(listener); };
    }),
    fireStyleData: () => { for (const listener of [...styleListeners]) listener(); },
  };
}

beforeEach(() => {
  _resetMapStateForTest();
  _setFollowEnvForTest(null, false);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(launchStore, 'getState').mockReturnValue(state());
});
afterEach(() => {
  _resetMapStateForTest();
  _setFollowEnvForTest(null, false);
  localStorage.removeItem('opd-map-ascent-visible');
  vi.restoreAllMocks();
});

let core: MapCore;
function install() {
  const value = fakeMap();
  core = _setFollowEnvForTest(value, false)!;
  _syncMapLaunchModeForTest();
  return value;
}
function expectMode(value: ReturnType<typeof fakeMap>, enabled: boolean) {
  for (const id of launchLayers) expect(value.visibility.get(id)).toBe(enabled ? 'visible' : 'none');
  for (const id of targetLayers) expect(value.visibility.get(id)).toBe(enabled ? 'none' : 'visible');
  for (const id of otherLayers) expect(value.visibility.get(id)).toBe('visible');
}

function fakePopup() {
  let close: (() => void) | undefined;
  return {
    remove: vi.fn(),
    onClose: vi.fn((listener: () => void) => { close = listener; }),
    finishClose: () => close?.(),
  };
}

/** Open a popup through the real facade; the fake vendor hands back this popup. */
function openPopup(value: ReturnType<typeof fakeMap>, owner?: PopupOwner) {
  const popup = fakePopup();
  value.popupQueue.push(popup);
  core.openPopup({ at: [0, 0], content: document.createElement('div'), owner });
  return popup;
}

describe('map Launches mode layers', () => {
  it('starts off on a new page even if the old rocket preference was on', async () => {
    localStorage.setItem('opd-map-ascent-visible', '1');
    vi.resetModules();
    const freshMap = await import('../src/map');
    const freshMode = await import('../src/map-launch-mode');
    const value = fakeMap();
    try {
      freshMap._setFollowEnvForTest(value, false);
      freshMap._syncMapLaunchModeForTest();
      expect(freshMode.getMapLaunchMode()).toBe(false);
      expectMode(value, false);
      expect(localStorage.getItem('opd-map-ascent-visible')).toBe('1');
    } finally {
      freshMap._resetMapStateForTest();
      freshMap._setFollowEnvForTest(null, false);
    }
  });

  it('swaps launch and ordinary target pins, rebuilding current sources without changing orbit/clouds', () => {
    const value = install();
    expectMode(value, false);
    vi.mocked(launchStore.getState).mockReturnValue(state([launch({ event_id: 'current-revision' })]));
    setMapLaunchMode(true);
    expectMode(value, true);
    const padData = value.sources.get('ascent-pad')!.setData.mock.calls.at(-1)![0];
    expect(padData.features[0].properties.event_id).toBe('current-revision');
    for (const id of ['targets', 'my-targets', 'ascent-trajectory']) expect(value.sources.get(id)!.setData).toHaveBeenCalledOnce();
    setMapLaunchMode(false);
    expectMode(value, false);
    for (const id of ['iss-track', 'clouds']) expect(value.sources.get(id)!.setData).not.toHaveBeenCalled();
    expect(value.easeTo).not.toHaveBeenCalled();
    expect(value.setCenter).not.toHaveBeenCalled();
  });

  it('honors a mode chosen before map startup and after layers are recreated', () => {
    setMapLaunchMode(true);
    const value = install();
    expectMode(value, true);
    for (const id of [...targetLayers, ...launchLayers]) value.visibility.set(id, 'visible');
    value.fireStyleData();
    expectMode(value, true);
    setMapLaunchMode(false);
    for (const id of [...targetLayers, ...launchLayers]) value.visibility.set(id, 'visible');
    value.fireStyleData();
    expectMode(value, false);
    // setVisibility can itself emit styledata; unchanged values stop reentry.
    expect(value.setVisibility.mock.calls.length).toBeLessThan(30);
  });

  it('does not accumulate mode subscriptions across map rerenders', () => {
    const value = install();
    _syncMapLaunchModeForTest();
    _syncMapLaunchModeForTest();
    setMapLaunchMode(true);
    expect(value.sources.get('ascent-pad')!.setData).toHaveBeenCalledOnce();
    expect(value.on).toHaveBeenCalledOnce();
  });

  it('tolerates absent layers during style loading and applies mode when they return', () => {
    const value = install();
    value.visibility.clear();
    setMapLaunchMode(true);
    for (const id of [...launchLayers, ...targetLayers, ...otherLayers]) value.visibility.set(id, 'visible');
    value.fireStyleData();
    expectMode(value, true);
  });

  it('explicit focus opts in and preserves a scrubbed instant while releasing follow', () => {
    setLookahead(45, false);
    const viewTime = _getViewTimeMsForTest();
    const value = install();
    _setFollowEnvForTest(value, true);
    expect(focusLaunchOnMap('event-1')).toBe(true);
    expect(getMapLaunchMode()).toBe(true);
    expectMode(value, true);
    expect(_getViewTimeMsForTest()).toBe(viewTime);
    expect(value.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-80.6, 28.5] }));
    applyFollowISS({ lat: 0, lon: 0 });
    expect(value.setCenter).not.toHaveBeenCalled();
  });

  it('dismisses ordinary/personal target popups when Launches is selected and launch popups on return', () => {
    const value = install();
    const target = openPopup(value, 'target');
    const unrelated = openPopup(value); // Lookup/ISS/satellite popups are not mode-owned.
    setMapLaunchMode(true);
    expect(target.remove).toHaveBeenCalledOnce();
    const launchPopup = openPopup(value, 'launch');
    expect(launchPopup.remove).not.toHaveBeenCalled();
    setMapLaunchMode(false);
    expect(launchPopup.remove).toHaveBeenCalledOnce();
    expect(target.remove).toHaveBeenCalledOnce();
    expect(unrelated.remove).not.toHaveBeenCalled();
  });

  it('cleans replacement popups without letting an old close lose the new reference', () => {
    const value = install();
    const old = openPopup(value, 'target');
    const replacement = openPopup(value, 'target');
    expect(old.remove).toHaveBeenCalledOnce();
    old.finishClose(); // A queued close from the removed instance arrives late.
    setMapLaunchMode(true);
    expect(replacement.remove).toHaveBeenCalledOnce();
    expect(old.remove).toHaveBeenCalledOnce();
  });

  it('forgets a popup closed normally so mode changes do not remove it again', () => {
    const value = install();
    const target = openPopup(value, 'target');
    target.finishClose();
    setMapLaunchMode(true);
    expect(target.remove).not.toHaveBeenCalled();
  });
});
