import { afterEach, describe, expect, it } from 'vitest';

import { mountIssScene, type IssScene } from '../src/iss-view';
import type { IssRenderer, IssRendererFactory, IssRendererHooks } from '../src/iss-view/renderer';

type Media = {
  matches: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  fire: () => void;
};

function installMedia(matches: boolean): Media {
  let listener: (() => void) | null = null;
  const media: Media = {
    matches,
    addEventListener(_type, next) {
      listener = next;
    },
    removeEventListener() {
      listener = null;
    },
    fire() {
      listener?.();
    },
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => media,
  });
  return media;
}

function renderer(): IssRendererFactory {
  return (_frame: HTMLElement, _hooks: IssRendererHooks): IssRenderer => ({
    ready: () => Promise.resolve(),
    aim: () => Promise.resolve(),
    resize() {},
    destroy() {},
  });
}

function mount(): { scene: IssScene; pane: HTMLElement } {
  const pane = document.createElement('section');
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
    nowMs: () => Date.parse('2026-10-06T12:00:00Z'),
    createRenderer: renderer(),
    drive: 'manual',
    session: { mode: 'horizon' },
  });
  return { scene, pane };
}

describe('ISS split layout', () => {
  let scene: IssScene | null = null;

  afterEach(() => {
    scene?.dispose();
    scene = null;
    document.body.replaceChildren();
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('parks the clock and telemetry on the map column when the inset gate matches', () => {
    const media = installMedia(true);
    const mounted = mount();
    scene = mounted.scene;
    const pane = mounted.pane;
    expect(pane.querySelector('[data-iss-split-chrome]')?.contains(pane.querySelector('[data-iss-clock]') ?? null)).toBe(true);
    expect(pane.querySelector('[data-iss-split-chrome]')?.contains(pane.querySelector('[data-iss-edition]') ?? null)).toBe(true);
    expect(pane.querySelector('[data-iss-split-dock]')?.contains(pane.querySelector('[data-iss-card]') ?? null)).toBe(true);
    expect(pane.querySelector('[data-iss-scene]')?.getAttribute('data-iss-split')).toBe('on');
    expect(pane.querySelector('[data-iss-toolbar]')?.contains(pane.querySelector('[data-iss-presets]') ?? null)).toBe(true);

    media.matches = false;
    media.fire();
    const toolbar = pane.querySelector('[data-iss-toolbar]');
    expect(toolbar?.contains(pane.querySelector('[data-iss-clock]') ?? null)).toBe(true);
    expect(toolbar?.contains(pane.querySelector('[data-iss-edition]') ?? null)).toBe(true);
    expect(pane.querySelector('[data-iss-scene]')?.contains(pane.querySelector('[data-iss-card]') ?? null)).toBe(true);
    expect(pane.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-split')).toBe(false);
  });

  it('leaves the phone column when the gate does not match', () => {
    installMedia(false);
    const mounted = mount();
    scene = mounted.scene;
    const pane = mounted.pane;
    const toolbar = pane.querySelector('[data-iss-toolbar]');
    expect(toolbar?.contains(pane.querySelector('[data-iss-clock]') ?? null)).toBe(true);
    expect(pane.querySelector('[data-iss-scene]')?.contains(pane.querySelector('[data-iss-card]') ?? null)).toBe(true);
    expect(pane.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-split')).toBe(false);
  });
});
