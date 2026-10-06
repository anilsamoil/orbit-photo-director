import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindInsets } from '../src/insets/host';
import type { Track } from '../src/types';

const track = { name: 'iss' } as Track;

function installViewport(): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: true,
      media: '',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }),
  });
}

function mount(): { horizon: HTMLButtonElement; plan: HTMLButtonElement; tabMap: HTMLButtonElement; tabIss: HTMLButtonElement } {
  document.body.innerHTML = `
    <button id="tab-map" type="button">Map</button>
    <button id="tab-iss" type="button">ISS view</button>
    <main id="view" class="view-map">
      <section id="map-pane">
        <button type="button" class="pip-inset pip-horizon" data-pip="horizon" aria-label="Show the ISS view">
          <span data-pip-frame="horizon"></span>
        </button>
      </section>
    </main>
    <section id="iss-pane">
      <button type="button" class="pip-inset pip-plan" data-pip="plan" hidden aria-label="Show the map">
        <span data-pip-frame="plan"></span>
      </button>
    </section>
  `;
  return {
    horizon: document.querySelector('[data-pip="horizon"]') as HTMLButtonElement,
    plan: document.querySelector('[data-pip="plan"]') as HTMLButtonElement,
    tabMap: document.getElementById('tab-map') as HTMLButtonElement,
    tabIss: document.getElementById('tab-iss') as HTMLButtonElement,
  };
}

describe('inset host', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('moves focus to the destination tab when Enter or Space activates an inset', async () => {
    installViewport();
    const { horizon, plan, tabMap, tabIss } = mount();
    tabIss.addEventListener('click', () => {
      document.getElementById('view')!.className = 'view-iss';
    });
    tabMap.addEventListener('click', () => {
      document.getElementById('view')!.className = 'view-map';
    });
    bindInsets({
      mounts: async () => null,
      track: () => track,
      nowMs: () => 0,
    });
    horizon.focus();
    expect(document.activeElement).toBe(horizon);
    horizon.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    horizon.click();
    await Promise.resolve();
    expect(document.activeElement).toBe(tabIss);
    expect(document.activeElement).not.toBe(document.body);

    document.getElementById('view')!.className = 'view-iss';
    plan.hidden = false;
    plan.focus();
    plan.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    plan.click();
    await Promise.resolve();
    expect(document.activeElement).toBe(tabMap);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps the horizon inset off while map chrome is hidden', async () => {
    installViewport();
    const { horizon } = mount();
    document.getElementById('map-pane')!.classList.add('map-chrome-hidden');
    const mountHorizon = vi.fn(() => ({ setTrack() {}, dispose() {} }));
    const host = bindInsets({
      mounts: async () => ({
        mountHorizonInset: mountHorizon,
        mountPlanInset: vi.fn(() => ({ setTrack() {}, dispose() {} })),
      }),
      track: () => track,
      nowMs: () => 0,
    });
    await Promise.resolve();
    expect(horizon.hidden).toBe(true);
    expect(mountHorizon).not.toHaveBeenCalled();

    document.getElementById('map-pane')!.classList.remove('map-chrome-hidden');
    host.sync();
    await Promise.resolve();
    await Promise.resolve();
    expect(horizon.hidden).toBe(false);
    expect(mountHorizon).toHaveBeenCalledTimes(1);

    document.getElementById('map-pane')!.classList.add('map-chrome-hidden');
    host.sync();
    expect(horizon.hidden).toBe(true);
  });
});
