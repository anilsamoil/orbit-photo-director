import type { Track } from '../types';
import { insetViewportFits } from './gate';

export type InsetHandle = {
  setTrack(track: Track): void;
  dispose(): void;
};

export type InsetMounts = {
  mountHorizonInset(frame: HTMLElement, track: Track, nowMs: () => number): InsetHandle;
  mountPlanInset(frame: HTMLElement, track: Track, nowMs: () => number): InsetHandle;
};

export type InsetHost = {
  sync(): void;
  releaseHorizon(): void;
  releasePlan(): void;
};

type ButtonName = 'plan' | 'horizon';

function buttonOf(name: ButtonName): HTMLButtonElement | null {
  const node = document.querySelector(`[data-pip="${name}"]`);
  return node instanceof HTMLButtonElement ? node : null;
}

function frameOf(button: HTMLButtonElement): HTMLElement | null {
  const frame = button.querySelector('[data-pip-frame]');
  return frame instanceof HTMLElement ? frame : null;
}

function fullscreenActive(): boolean {
  return document.querySelector('[data-iss-fullscreen-active]') !== null;
}

function horizonBlocked(): boolean {
  const pane = document.getElementById('map-pane');
  const picker = document.getElementById('satellite-picker-panel');
  const pickerOpen = picker !== null && !picker.hidden;
  return pane?.classList.contains('map-inspector-open') === true || pickerOpen;
}

export function bindInsets(options: {
  mounts: () => Promise<InsetMounts | null>;
  track: () => Track | null;
  nowMs: () => number;
}): InsetHost {
  let horizon: InsetHandle | null = null;
  let plan: InsetHandle | null = null;
  let horizonPending = false;
  let planPending = false;
  let horizonSerial = 0;
  let planSerial = 0;
  let horizonQueued: Track | null = null;
  let planQueued: Track | null = null;
  const media = window.matchMedia('(min-width: 800px) and (min-height: 800px)');

  const fitsNow = (): boolean => insetViewportFits(window.innerWidth, window.innerHeight) && media.matches;

  const want = (name: ButtonName): Track | null => {
    if (!fitsNow() || document.visibilityState === 'hidden') return null;
    const track = options.track();
    if (!track) return null;
    const view = document.getElementById('view')?.className;
    if (name === 'plan') {
      if (view !== 'view-iss' || fullscreenActive()) return null;
      return track;
    }
    if (view !== 'view-map' || horizonBlocked() || document.querySelector('[data-iss-scene]')) return null;
    return track;
  };

  const setHidden = (button: HTMLButtonElement, hidden: boolean): void => {
    if (button.hidden !== hidden) button.hidden = hidden;
  };

  const releaseHorizon = (): void => {
    horizonSerial += 1;
    horizonPending = false;
    horizonQueued = null;
    const current = horizon;
    horizon = null;
    current?.dispose();
  };

  const releasePlan = (): void => {
    planSerial += 1;
    planPending = false;
    planQueued = null;
    const current = plan;
    plan = null;
    current?.dispose();
  };

  const ensure = (name: ButtonName, track: Track): void => {
    const button = buttonOf(name);
    const frame = button ? frameOf(button) : null;
    if (!button || !frame) return;
    if (name === 'horizon') horizonQueued = track;
    else planQueued = track;
    if (name === 'horizon' && horizon) {
      horizon.setTrack(track);
      return;
    }
    if (name === 'plan' && plan) {
      plan.setTrack(track);
      return;
    }
    if (name === 'horizon' ? horizonPending : planPending) return;
    if (name === 'horizon') horizonPending = true;
    else planPending = true;
    const serial = name === 'horizon' ? horizonSerial : planSerial;
    void options.mounts().then((mounts) => {
      if (name === 'horizon') horizonPending = false;
      else planPending = false;
      if (!mounts) return;
      if (name === 'horizon' && serial !== horizonSerial) return;
      if (name === 'plan' && serial !== planSerial) return;
      const queued = name === 'horizon' ? horizonQueued : planQueued;
      if (!queued || !want(name)) return;
      const liveButton = buttonOf(name);
      const liveFrame = liveButton ? frameOf(liveButton) : null;
      if (!liveFrame) return;
      const handle = name === 'horizon'
        ? mounts.mountHorizonInset(liveFrame, queued, options.nowMs)
        : mounts.mountPlanInset(liveFrame, queued, options.nowMs);
      if (name === 'horizon' && serial !== horizonSerial) {
        handle.dispose();
        return;
      }
      if (name === 'plan' && serial !== planSerial) {
        handle.dispose();
        return;
      }
      if (name === 'horizon') horizon = handle;
      else plan = handle;
    }).catch(() => {
      if (name === 'horizon' && serial === horizonSerial) horizonPending = false;
      if (name === 'plan' && serial === planSerial) planPending = false;
    });
  };

  const sync = (): void => {
    const planTrack = want('plan');
    const horizonTrack = want('horizon');
    const planButton = buttonOf('plan');
    const horizonButton = buttonOf('horizon');
    if (planButton) setHidden(planButton, planTrack === null);
    if (horizonButton) setHidden(horizonButton, horizonTrack === null);
    if (planTrack) ensure('plan', planTrack);
    else releasePlan();
    if (horizonTrack) ensure('horizon', horizonTrack);
    else releaseHorizon();
  };

  const onMedia = (): void => sync();
  media.addEventListener('change', onMedia);
  window.addEventListener('resize', onMedia);
  document.addEventListener('visibilitychange', onMedia);
  const watch = (node: Element | null, filter: string[], subtree: boolean): void => {
    if (!node) return;
    const observer = new MutationObserver(() => sync());
    observer.observe(node, { attributes: true, subtree, attributeFilter: filter });
  };
  watch(document.getElementById('view'), ['class'], false);
  watch(document.getElementById('map-pane'), ['class'], false);
  watch(document.getElementById('satellite-picker-panel'), ['hidden'], false);
  watch(document.getElementById('iss-pane'), ['data-iss-fullscreen-active'], true);
  buttonOf('plan')?.addEventListener('click', () => {
    document.getElementById('tab-map')?.click();
  });
  buttonOf('horizon')?.addEventListener('click', () => {
    document.getElementById('tab-iss')?.click();
  });
  sync();
  return { sync, releaseHorizon, releasePlan };
}
