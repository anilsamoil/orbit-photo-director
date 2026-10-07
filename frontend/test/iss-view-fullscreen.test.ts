import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountIssScene, type IssScene, type MountIssSceneOptions } from '../src/iss-view';
import { bindIssFullscreen } from '../src/iss-view/fullscreen';
import type { SceneSnapshot } from '../src/iss-view/model';
import type { IssRendererFactory } from '../src/iss-view/renderer';
import { launchStore } from '../src/launch-store';
import type { LaunchSelection } from '../src/launch-selectors';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };
import { installFullscreenDouble, type FullscreenApi, type FullscreenDouble } from './fullscreen-double';
import { NOW, artifact, assessment, envelope, iso, launch, supported } from './launch-fixtures';

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const startMs = Date.parse(fixture.start);
const STYLE_CSS = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8');
const AIM_KEY = 'opd-iss-aim';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type Mounted = {
  host: HTMLElement;
  scene: IssScene;
  root: HTMLElement;
  frame: HTMLElement;
  button: HTMLButtonElement;
};

function shot(): SceneSnapshot {
  return {
    manifestVersion: 'fullscreen',
    generatedAtMs: startMs,
    track: {
      iss_polynomial: fixture.iss_polynomial,
      tle: fixture.tle,
      tle_epoch: '2024-10-16T18:58:11.999Z',
      tle_age_hours: 17,
      tle_freshness_factor: 1,
    },
  };
}

function renderer(boot: () => Promise<void> = () => Promise.resolve()): IssRendererFactory {
  return () => ({
    ready: boot,
    aim: () => Promise.resolve(),
    resize: () => {},
    destroy: () => {},
  });
}

function browser(api: FullscreenApi): FullscreenDouble {
  const double = installFullscreenDouble(api);
  cleanups.push(() => double.restore());
  return double;
}

async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
}

async function mounted(options: {
  session?: MountIssSceneOptions['session'];
  createRenderer?: IssRendererFactory;
  launches?: () => readonly LaunchSelection[];
  nowMs?: () => number;
} = {}): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.append(host);
  const scene = mountIssScene(host, {
    nowMs: options.nowMs ?? (() => startMs + 60_000),
    createRenderer: options.createRenderer ?? renderer(),
    drive: 'manual',
    session: options.session ?? { mode: 'horizon' },
    launches: options.launches,
  });
  cleanups.push(() => {
    scene.dispose();
    host.remove();
  });
  await settle();
  scene.update(shot());
  await settle();
  const button = query(host, '[data-iss-fullscreen]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('fullscreen control is not a native button');
  return { host, scene, root: query(host, '[data-iss-scene]'), frame: query(host, '[data-iss-frame]'), button };
}

function query(parent: ParentNode, selector: string): HTMLElement {
  const found = parent.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`missing ${selector}`);
  return found;
}

function marked(root: HTMLElement): boolean {
  return root.hasAttribute('data-iss-fullscreen-active');
}

function name(button: HTMLButtonElement): string | null {
  return button.getAttribute('aria-label');
}

function key(target: EventTarget, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function box(element: Element, size: () => { width: number; height: number }): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => size().width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => size().height });
}

function observedResizes(): { resize(): void } {
  const callbacks = new Set<() => void>();
  const original = globalThis.ResizeObserver;
  class ResizeObserverDouble implements ResizeObserver {
    private readonly notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this);
    }
    observe(): void {
      callbacks.add(this.notify);
    }
    unobserve(): void {
      callbacks.delete(this.notify);
    }
    disconnect(): void {
      callbacks.delete(this.notify);
    }
  }
  globalThis.ResizeObserver = ResizeObserverDouble;
  cleanups.push(() => {
    globalThis.ResizeObserver = original;
  });
  return {
    resize() {
      for (const notify of [...callbacks]) notify();
    },
  };
}

function place(element: Element, x: number, y: number, width: number, height: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(x, y, width, height),
  });
}

function installHitTest(): void {
  const original = document.elementFromPoint.bind(document);
  document.elementFromPoint = (x: number, y: number): Element | null => {
    const hits: { el: Element; z: number; order: number }[] = [];
    let order = 0;
    const walk = (el: Element): void => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const box = el.getBoundingClientRect();
      const covers = box.width > 0 && box.height > 0 && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      if (covers && style.pointerEvents !== 'none') {
        const z = Number(style.zIndex);
        hits.push({ el, z: Number.isFinite(z) ? z : 0, order });
      }
      order += 1;
      for (const child of el.children) walk(child);
    };
    walk(document.body);
    hits.sort((a, b) => a.z - b.z || a.order - b.order);
    return hits.at(-1)?.el ?? original(x, y);
  };
  cleanups.push(() => {
    document.elementFromPoint = original;
  });
}

function styled(): void {
  const style = document.createElement('style');
  style.textContent = STYLE_CSS;
  document.head.append(style);
  cleanups.push(() => style.remove());
}

function installSplitMedia(matches: boolean): void {
  const previous = window.matchMedia.bind(window);
  const media = {
    matches,
    media: '',
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
    onchange: null,
    addListener() {},
    removeListener() {},
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => media,
  });
  cleanups.push(() => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: previous });
  });
}

async function mountedSplit(): Promise<Mounted & { pane: HTMLElement }> {
  installSplitMedia(true);
  const pane = document.createElement('section');
  pane.id = 'iss-pane';
  pane.innerHTML = `
    <div data-iss-split-stack>
      <div class="iss-split-map">
        <button type="button" data-pip="plan"><span data-pip-frame="plan"></span></button>
        <div data-iss-split-chrome></div>
      </div>
      <div data-iss-split-dock></div>
    </div>
    <div id="iss-host"></div>
  `;
  document.body.append(pane);
  const host = pane.querySelector('#iss-host');
  if (!(host instanceof HTMLElement)) throw new Error('host missing');
  const scene = mountIssScene(host, {
    nowMs: () => startMs + 60_000,
    createRenderer: renderer(),
    drive: 'manual',
    session: { mode: 'horizon' },
  });
  cleanups.push(() => {
    scene.dispose();
    pane.remove();
  });
  await settle();
  scene.update(shot());
  await settle();
  const button = query(pane, '[data-iss-fullscreen]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('fullscreen control is not a native button');
  return { host, scene, root: query(pane, '[data-iss-scene]'), frame: query(pane, '[data-iss-frame]'), button, pane };
}

describe('ISS fullscreen toggle', () => {
  it.each(['standard', 'webkit', 'both'] as const)('enters and leaves element fullscreen through the %s API', async (api) => {
    const fullscreen = browser(api);
    const view = await mounted();
    expect(view.button.parentElement).toBe(view.root);
    expect(view.root.contains(view.button)).toBe(true);
    expect(name(view.button)).toBe('Full screen');
    expect(view.button.title).toBe('Full screen');
    expect(view.button.hasAttribute('aria-pressed')).toBe(false);

    view.button.click();
    expect(marked(view.root)).toBe(true);
    expect(name(view.button)).toBe('Exit full screen');
    fullscreen.grant();
    expect(fullscreen.current()).toBe(view.root);
    expect(marked(view.root)).toBe(true);
    expect(view.button.title).toBe('Exit full screen');

    view.button.click();
    await settle();
    expect(fullscreen.current()).toBeNull();
    expect(marked(view.root)).toBe(false);
    expect(name(view.button)).toBe('Full screen');
  });

  it('shows the overlay alone when the browser has no Fullscreen API', async () => {
    browser('missing');
    const view = await mounted();
    view.button.click();
    expect(marked(view.root)).toBe(true);
    expect(name(view.button)).toBe('Exit full screen');
    view.button.click();
    expect(marked(view.root)).toBe(false);
    expect(name(view.button)).toBe('Full screen');
  });

  it.each(['standard', 'webkit'] as const)('keeps the overlay when the %s API refuses, and the next press clears it', async (api) => {
    const fullscreen = browser(api);
    const view = await mounted();
    view.button.click();
    fullscreen.refuse();
    await settle();
    expect(fullscreen.current()).toBeNull();
    expect(marked(view.root)).toBe(true);
    expect(name(view.button)).toBe('Exit full screen');
    view.button.click();
    expect(marked(view.root)).toBe(false);
    expect(name(view.button)).toBe('Full screen');
  });

  it('gives back a grant that lands after the press was cancelled', async () => {
    const fullscreen = browser('standard');
    const view = await mounted();
    view.button.click();
    view.button.click();
    expect(marked(view.root)).toBe(false);
    fullscreen.grant();
    await settle();
    expect(fullscreen.current()).toBeNull();
    expect(marked(view.root)).toBe(false);
    expect(name(view.button)).toBe('Full screen');
  });

  it('ends when the browser leaves fullscreen by itself', async () => {
    const fullscreen = browser('webkit');
    const view = await mounted();
    view.button.click();
    fullscreen.grant();
    fullscreen.leave();
    expect(marked(view.root)).toBe(false);
    expect(name(view.button)).toBe('Full screen');
  });

  it('ends when focus lands outside the scene, not when it moves inside', async () => {
    browser('missing');
    const view = await mounted();
    const outside = document.createElement('button');
    document.body.append(outside);
    cleanups.push(() => outside.remove());
    view.button.focus();
    view.button.click();
    view.frame.focus();
    expect(marked(view.root)).toBe(true);
    outside.focus();
    expect(marked(view.root)).toBe(false);
  });

  it('keeps the overlay through suspend and resume', async () => {
    browser('missing');
    const view = await mounted();
    view.button.click();
    view.scene.suspend();
    expect(view.scene.phase()).toBe('suspended');
    expect(marked(view.root)).toBe(true);
    view.scene.resume();
    expect(marked(view.root)).toBe(true);
  });

  it('leaves the browser fullscreen and clears the marker on dispose', async () => {
    const fullscreen = browser('standard');
    const view = await mounted();
    view.button.click();
    fullscreen.grant();
    view.scene.dispose();
    await settle();
    expect(fullscreen.current()).toBeNull();
    expect(marked(view.root)).toBe(false);
    expect(view.root.querySelector('[data-iss-fullscreen]')).toBeNull();
  });

  it('ignores a grant that lands after dispose', async () => {
    const fullscreen = browser('standard');
    const view = await mounted();
    view.button.click();
    view.scene.dispose();
    expect(marked(view.root)).toBe(false);
    fullscreen.grant();
    await settle();
    expect(marked(view.root)).toBe(false);
  });
});

describe('ISS fullscreen Escape', () => {
  const seeded = JSON.stringify({
    mode: 'nadir',
    azimuthDeg: 0,
    windowId: null,
    look: { rightDeg: 0, upDeg: 0 },
    opticalFovDeg: 40,
  });

  function seedAim(): void {
    sessionStorage.setItem(AIM_KEY, seeded);
    localStorage.setItem(AIM_KEY, seeded);
    cleanups.push(() => {
      sessionStorage.removeItem(AIM_KEY);
      localStorage.removeItem(AIM_KEY);
    });
  }

  it('leaves the overlay on Escape without resetting the aim, holds the repeat, and resets on a fresh press', async () => {
    seedAim();
    browser('missing');
    const view = await mounted({ session: { mode: 'nadir' } });
    view.button.focus();
    view.button.click();
    expect(marked(view.root)).toBe(true);

    expect(key(view.button, 'Escape').defaultPrevented).toBe(true);
    expect(marked(view.root)).toBe(false);
    expect(document.activeElement).toBe(view.button);
    expect(key(view.button, 'Escape', { repeat: true }).defaultPrevented).toBe(true);
    key(view.button, 'Escape', { repeat: true });
    expect(view.scene.mode()).toBe('nadir');
    expect(sessionStorage.getItem(AIM_KEY)).toBe(seeded);
    expect(localStorage.getItem(AIM_KEY)).toBe(seeded);

    view.button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    key(view.button, 'Escape');
    expect(view.scene.mode()).toBe('horizon');
    expect(sessionStorage.getItem(AIM_KEY)).toBeNull();
  });

  it('holds the repeat after the browser ends fullscreen on its own Escape', async () => {
    seedAim();
    const fullscreen = browser('standard');
    const view = await mounted({ session: { mode: 'nadir' } });
    view.button.click();
    fullscreen.grant();
    fullscreen.leave();
    key(document.body, 'Escape', { repeat: true });
    expect(view.scene.mode()).toBe('nadir');
    expect(sessionStorage.getItem(AIM_KEY)).toBe(seeded);
    window.dispatchEvent(new Event('blur'));
    key(document.body, 'Escape', { repeat: true });
    expect(view.scene.mode()).toBe('horizon');
  });

  it('closes an open shortcut sheet on enter, so aim keys work and Escape does not bring it back', async () => {
    styled();
    installHitTest();
    browser('missing');
    const view = await mounted({ session: { mode: 'horizon' } });
    const help = query(view.root, '[data-iss-aim-help]');
    if (!(help instanceof HTMLButtonElement)) throw new Error('shortcut button is not a native button');
    help.click();
    expect(view.root.hasAttribute('data-iss-aim-open')).toBe(true);
    expect(query(view.root, '[data-iss-aim-sheet]').hidden).toBe(false);
    expect(help.getAttribute('aria-expanded')).toBe('true');

    view.frame.focus();
    const toolbar = query(view.root, '[data-iss-toolbar]');
    const scrim = query(view.root, '[data-iss-aim-scrim]');
    const card = query(view.root, '[data-iss-card]');
    expect(getComputedStyle(toolbar).pointerEvents).toBe('none');
    expect(getComputedStyle(card).pointerEvents).toBe('none');
    expect(getComputedStyle(view.button).pointerEvents).toBe('auto');
    expect(Number(getComputedStyle(view.button).zIndex)).toBeGreaterThan(Number(getComputedStyle(scrim).zIndex));
    expect(Number(getComputedStyle(toolbar).zIndex)).toBeGreaterThan(Number(getComputedStyle(scrim).zIndex));
    expect(Number(getComputedStyle(card).zIndex)).toBeGreaterThan(Number(getComputedStyle(scrim).zIndex));
    place(view.root, 0, 0, 800, 600);
    place(scrim, 0, 0, 800, 600);
    place(view.button, 744, 544, 44, 44);
    const box = view.button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(hit === view.button || view.button.contains(hit)).toBe(true);
    if (!(hit instanceof HTMLElement)) throw new Error('fullscreen hit is not an element');
    hit.click();
    expect(marked(view.root)).toBe(true);
    expect(view.root.hasAttribute('data-iss-aim-open')).toBe(false);
    expect(query(view.root, '[data-iss-aim-sheet]').hidden).toBe(true);
    expect(help.getAttribute('aria-expanded')).toBe('false');

    key(view.frame, 'n');
    expect(view.scene.mode()).toBe('nadir');

    key(view.button, 'Escape');
    expect(marked(view.root)).toBe(false);
    expect(view.root.hasAttribute('data-iss-aim-open')).toBe(false);
    expect(query(view.root, '[data-iss-aim-sheet]').hidden).toBe(true);
    expect(view.scene.mode()).toBe('nadir');
  });

  it('lets an open modal take Escape first', async () => {
    browser('missing');
    const view = await mounted();
    view.button.click();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    document.body.append(backdrop);
    cleanups.push(() => backdrop.remove());
    expect(key(document.body, 'Escape').defaultPrevented).toBe(false);
    expect(marked(view.root)).toBe(true);
    backdrop.remove();
    key(document.body, 'Escape');
    expect(marked(view.root)).toBe(false);
  });
});

describe('ISS fullscreen frame', () => {
  it('fits the frame to the fullscreen box after a grant, and back after the exit', async () => {
    const fullscreen = browser('standard');
    const view = await mounted();
    box(view.host, () => ({ width: 800, height: 600 }));
    box(view.root, () => (fullscreen.current() === view.root ? { width: 1920, height: 1080 } : { width: 800, height: 600 }));
    await view.scene.paint();
    expect(view.frame.style.width).toBe('800px');
    expect(view.frame.style.height).toBe('533px');

    view.button.click();
    expect(view.frame.style.width).toBe('800px');
    fullscreen.grant();
    expect(view.frame.style.width).toBe('1620px');
    expect(view.frame.style.height).toBe('1080px');

    view.button.click();
    await settle();
    expect(view.frame.style.width).toBe('800px');
    expect(view.frame.style.height).toBe('533px');
  });

  it('hides a stale offline launch in fullscreen and restores it with the selection', async () => {
    browser('missing');
    const chance = launch({
      event_id: 'crew',
      name: 'Crew',
      assessment: assessment({ checked_at: iso(1) }),
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
      launch_window: { net: iso(10), start: iso(10), end: iso(97), precision: 'Minute' },
      sources: [{ kind: 'schedule', url: 'https://example.org/launch', fetched_at: iso(1) }],
    });
    const body = await envelope(artifact([chance], { revision: 'r-stale', generated_at: iso(1) }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      return new Response(path.includes('launch/latest.json') ? JSON.stringify(body.pointer) : body.body);
    }));
    const shown: string[][] = [];
    try {
      await launchStore.refresh();
      const view = await mounted({
        nowMs: () => NOW + 2 * 60_000,
        session: { mode: 'horizon' },
        createRenderer: () => ({
          ready: () => Promise.resolve(),
          aim: () => Promise.resolve(),
          showLaunches: (sites) => shown.push(sites.map((site) => site.eventId)),
          resize: () => {},
          destroy: () => {},
        }),
      });
      const picker = query(view.host, '[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement)) throw new Error('launch picker is not a select');
      picker.value = 'crew';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await view.scene.paint();
      expect(shown.at(-1)).toEqual(['crew']);
      await launchStore.refresh(false);
      await settle();
      await view.scene.paint();
      expect(launchStore.getState().availability).toBe('offline');
      expect(picker.value).toBe('crew');
      expect(shown.at(-1)).toEqual(['crew']);

      view.button.click();
      expect(marked(view.root)).toBe(true);
      expect(shown.at(-1)).toEqual([]);
      expect(picker.value).toBe('crew');

      view.button.click();
      expect(marked(view.root)).toBe(false);
      expect(shown.at(-1)).toEqual(['crew']);
      expect(picker.value).toBe('crew');
      expect(view.host.querySelector('[data-iss-launch]')?.getAttribute('data-iss-launch')).toBe('crew');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('takes the launch corridor off the earth while fullscreen', async () => {
    browser('missing');
    const shown: string[][] = [];
    const cape = supported({
      event_id: 'cape',
      name: 'Crew',
      assessment: assessment(),
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
    });
    const view = await mounted({
      launches: () => [{ item: cape, interval: cape.capture_intervals[0] ?? null, expired: false }],
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: () => Promise.resolve(),
        showLaunches: (sites) => shown.push(sites.map((site) => site.eventId)),
        resize: () => {},
        destroy: () => {},
      }),
    });
    const picker = query(view.host, '[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) throw new Error('launch picker is not a select');
    picker.value = 'cape';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(shown.at(-1)).toEqual(['cape']);
    view.button.click();
    expect(shown.at(-1)).toEqual([]);
    view.button.click();
    expect(shown.at(-1)).toEqual(['cape']);
  });

  it('repaints when the scene box changes, and not for a repeated or empty box', async () => {
    const observers = observedResizes();
    const clock = { now: startMs + 60_000 };
    const aimedAt: number[] = [];
    const view = await mounted({
      nowMs: () => clock.now,
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: (aim) => {
          aimedAt.push(aim.lightingUtcMs);
          return Promise.resolve();
        },
        resize: () => {},
        destroy: () => {},
      }),
    });
    expect(aimedAt.at(-1)).toBe(startMs + 60_000);
    const size = { width: 800, height: 600 };
    box(view.host, () => size);
    box(view.root, () => size);
    clock.now = startMs + 70_000;
    observers.resize();
    expect(view.frame.style.width).toBe('800px');
    expect(aimedAt.at(-1)).toBe(startMs + 70_000);

    clock.now = startMs + 80_000;
    observers.resize();
    expect(aimedAt.at(-1)).toBe(startMs + 70_000);

    size.width = 1200;
    observers.resize();
    expect(view.frame.style.width).toBe('900px');
    expect(view.frame.style.height).toBe('600px');
    expect(aimedAt.at(-1)).toBe(startMs + 80_000);

    size.width = 0;
    size.height = 0;
    clock.now = startMs + 90_000;
    observers.resize();
    expect(view.frame.style.width).toBe('900px');
    expect(aimedAt.at(-1)).toBe(startMs + 80_000);

    size.width = 1200;
    size.height = 600;
    observers.resize();
    expect(view.frame.style.width).toBe('900px');
    expect(aimedAt.at(-1)).toBe(startMs + 90_000);
  });
});

describe('ISS control placement', () => {
  it('puts SNAP help between the launch menu and the site name, and parks fullscreen on the scene corner', async () => {
    styled();
    browser('missing');
    const view = await mounted();
    const help = query(view.root, '[data-iss-snap-help]');
    const picker = query(view.root, '[data-iss-launch-picker-wrap]');
    const launches = query(view.root, '[data-iss-launches]');
    expect(help.textContent).toBe('?');
    expect(help.getAttribute('aria-label')).toBe('Help — how to use SNAP');
    expect(help.getAttribute('title')).toBe('Help');
    expect(picker.nextElementSibling).toBe(help);
    expect(help.nextElementSibling).toBe(launches);
    expect(view.button.parentElement).toBe(view.root);
    expect(getComputedStyle(view.button).position).toBe('absolute');
    expect(STYLE_CSS).toContain('right: max(0.75rem, env(safe-area-inset-right))');
    expect(STYLE_CSS).toContain('bottom: max(0.75rem, env(safe-area-inset-bottom))');
    expect(STYLE_CSS).toContain('[data-iss-scene][data-iss-aim-open] [data-iss-snap-help]');
    if (!(help instanceof HTMLButtonElement)) throw new Error('help control is not a native button');
    help.click();
    const dialog = document.querySelector('.help-modal');
    expect(dialog?.getAttribute('aria-label')).toBe('Help — how to use SNAP');
    cleanups.push(() => document.querySelector('.modal-backdrop')?.remove());
  });
});

describe('ISS fullscreen binding', () => {
  it('mounts when the controls sit outside the scene', () => {
    const scene = document.createElement('section');
    const controls = document.createElement('div');
    controls.dataset.issControls = '';
    const telemetry = document.createElement('button');
    telemetry.type = 'button';
    telemetry.dataset.issTelemetry = '';
    telemetry.textContent = 'Telemetry';
    controls.append(telemetry);
    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.append(scene, controls, outside);
    cleanups.push(() => {
      scene.remove();
      controls.remove();
      outside.remove();
    });
    const binding = bindIssFullscreen({ scene, controls, relayout() {} });
    cleanups.push(() => binding.dispose());
    const button = scene.querySelector('[data-iss-fullscreen]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('fullscreen button missing');
    expect(button.parentElement).toBe(scene);
    expect(controls.contains(button)).toBe(false);
    expect(scene.contains(controls)).toBe(false);
    button.click();
    expect(scene.hasAttribute('data-iss-fullscreen-active')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Exit full screen');
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    telemetry.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(scene.hasAttribute('data-iss-fullscreen-active')).toBe(true);
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(scene.hasAttribute('data-iss-fullscreen-active')).toBe(false);
  });
});

describe('ISS fullscreen styles', () => {
  it('zeroes the chrome around the frame and keeps the clock, the labels, and the exit button', async () => {
    styled();
    browser('missing');
    const view = await mounted();
    const css = (selector: string): CSSStyleDeclaration => getComputedStyle(query(view.root, selector));
    expect(getComputedStyle(view.root).position).toBe('absolute');
    view.button.click();
    // happy-dom keeps a descendant's cached selector matches until focus moves.
    view.frame.focus();

    expect(getComputedStyle(view.root).position).toBe('fixed');
    expect(getComputedStyle(view.root).zIndex).toBe('95');
    expect(getComputedStyle(view.root).gap).toBe('0');
    expect(css('[data-iss-stage]').gap).toBe('0');
    expect(css('[data-iss-toolbar]').height).toBe('0px');
    expect(getComputedStyle(document.body).overflow).toBe('hidden');

    expect(css('[data-iss-port]').width).toBe('0px');
    expect(css('[data-iss-starboard]').width).toBe('0px');
    expect(css('[data-iss-port]').height).toBe('0px');
    expect(css('[data-iss-port]').color).toBe('rgba(244, 247, 251, 0.62)');
    expect(css('[data-iss-stage] > :first-child').left).toBe('17.6px');
    expect(css('[data-iss-stage] > :last-child').right).toBe('17.6px');

    expect(css('[data-iss-card]').display).toBe('block');
    const telemetry = query(view.root, '[data-iss-telemetry]');
    const body = query(view.root, '[data-iss-telemetry-body]');
    expect(telemetry.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(css('[data-iss-telemetry-body]').display).toBe('none');
    telemetry.click();
    expect(telemetry.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(css('[data-iss-telemetry-body]').display).toBe('block');
    expect(css('[data-iss-telemetry]').height).toBe('44px');
    expect(css('[data-iss-fullscreen]').height).toBe('44px');
    const place = document.createElement('div');
    place.className = 'iss-place iss-place-country maplibregl-marker';
    place.textContent = 'Pacific Ocean';
    view.frame.append(place);
    expect(getComputedStyle(place).display).not.toBe('none');
    expect(css('[data-iss-presets]').display).toBe('none');
    expect(css('[data-iss-edition]').display).toBe('none');
    expect(css('[data-iss-aim-anchor]').display).toBe('none');
    expect(css('[data-iss-fov]').display).toBe('none');
    expect(css('[data-iss-hint]').display).toBe('none');
    expect(css('[data-iss-clock]').display).toBe('flex');
    expect(css('[data-iss-fullscreen]').display).toBe('inline-flex');
    expect(css('[data-iss-utc]').fontSize).toBe('16px');
    expect(css('[data-iss-gmt-day]').fontSize).toBe('16px');

    view.button.click();
    view.button.focus();
    expect(marked(view.root)).toBe(false);
    expect(getComputedStyle(view.root).position).toBe('absolute');
    expect(css('[data-iss-stage]').gap).toBe('0.4rem');
    expect(css('[data-iss-card]').display).toBe('block');
    expect(getComputedStyle(document.body).overflow).not.toBe('hidden');
  });

  it('dresses the button like the keyboard help button beside it', async () => {
    styled();
    browser('missing');
    const view = await mounted();
    const button = getComputedStyle(view.button);
    expect(button.borderTopLeftRadius).toBe('3px');
    expect(button.backgroundColor).toBe('#10161c');
    expect(button.borderTopColor).toBe('#617585');
  });

  it('keeps Telemetry and Exit on the card when split fullscreen parks it', async () => {
    styled();
    browser('missing');
    const view = await mountedSplit();
    const pane = view.pane;
    const card = query(pane, '[data-iss-card]');
    const telemetry = query(pane, '[data-iss-telemetry]');
    const dock = query(pane, '[data-iss-split-dock]');
    expect(dock.contains(card)).toBe(true);
    expect(view.root.getAttribute('data-iss-split')).toBe('on');

    view.button.click();
    view.frame.focus();

    expect(view.root.hasAttribute('data-iss-fullscreen-active')).toBe(true);
    expect(card.parentElement).toBe(view.root);
    const telemetryBox = telemetry.getBoundingClientRect();
    const exitBox = view.button.getBoundingClientRect();
    const parked = `card ${getComputedStyle(card).display} telemetry ${telemetryBox.width}x${telemetryBox.height} exit ${exitBox.width}x${exitBox.height}`;
    expect(getComputedStyle(card).display, parked).toBe('block');
    expect(view.button.parentElement).toBe(view.root);
    expect(getComputedStyle(telemetry).height).toBe('44px');
    expect(getComputedStyle(view.button).width).toBe('44px');
    expect(getComputedStyle(view.button).height).toBe('44px');
    expect(getComputedStyle(view.button).position).toBe('absolute');

    telemetry.click();
    const body = query(pane, '[data-iss-telemetry-body]');
    expect(telemetry.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(getComputedStyle(body).display).toBe('block');

    view.button.click();
    view.button.focus();
    expect(view.root.hasAttribute('data-iss-fullscreen-active')).toBe(false);
    expect(view.root.getAttribute('data-iss-split')).toBe('on');
    expect(dock.contains(card)).toBe(true);
  });

  it('keeps the error card in fullscreen', async () => {
    styled();
    browser('missing');
    const view = await mounted({ createRenderer: renderer(() => Promise.reject(new Error('WebGL2 unavailable'))) });
    expect(view.scene.phase()).toBe('error');
    view.button.click();
    expect(marked(view.root)).toBe(true);
    expect(getComputedStyle(query(view.root, '[data-iss-card]')).display).toBe('block');
  });

  it('marks a window at 564px or shorter so layout can use the pane', async () => {
    const previous = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 564 });
    const short = await mounted();
    expect(short.root.hasAttribute('data-iss-short')).toBe(true);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 665 });
    const tall = await mounted();
    expect(tall.root.hasAttribute('data-iss-short')).toBe(false);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: previous });
  });

  it('styles fullscreen through the valueless marker only', () => {
    expect(STYLE_CSS).toContain('[data-iss-scene][data-iss-fullscreen-active]');
    expect(STYLE_CSS).not.toContain(':fullscreen');
    expect(STYLE_CSS).not.toContain('[data-iss-fullscreen-active=');
  });
});
