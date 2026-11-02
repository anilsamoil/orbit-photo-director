import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindInsets } from '../src/insets/host';
import type { Track } from '../src/types';

const track = { name: 'iss' } as unknown as Track;

type PointerKind = 'mouse' | 'touch' | 'pen';
type Point = { x: number; y: number };

function installViewport(width = 1280, height = 700): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
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

function bindPlanHost(): void {
  bindInsets({
    mounts: async () => null,
    track: () => track,
    nowMs: () => 0,
  });
}

function preparePlan(): { plan: HTMLButtonElement; tabMap: HTMLButtonElement; mapOpens: () => number } {
  installViewport();
  const { plan, tabMap } = mount();
  document.getElementById('view')!.className = 'view-iss';
  plan.hidden = false;
  let mapOpens = 0;
  tabMap.addEventListener('click', () => {
    mapOpens += 1;
    document.getElementById('view')!.className = 'view-map';
  });
  bindPlanHost();
  return { plan, tabMap, mapOpens: () => mapOpens };
}

function dispatchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  point: Point,
  kind: PointerKind,
  pointerId: number,
): void {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    clientX: point.x,
    clientY: point.y,
    pointerId,
    pointerType: kind,
    button: kind === 'mouse' ? 0 : undefined,
  }));
}

/** Pointer-origin click. Real browsers set detail >= 1; HTMLElement.click() is detail 0. */
function pointerClick(plan: HTMLButtonElement): void {
  plan.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
}

/** Keyboard-origin click. Enter/Space synthesize detail 0. */
function keyboardClick(plan: HTMLButtonElement): void {
  plan.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
}

/** Real browser order: pointerup microtasks run before the click. */
async function releaseThenClick(plan: HTMLButtonElement, point: Point, kind: PointerKind, pointerId: number): Promise<void> {
  dispatchPointer(plan, 'pointerup', point, kind, pointerId);
  await Promise.resolve();
  pointerClick(plan);
}

async function dragOnPlan(
  plan: HTMLButtonElement,
  kind: PointerKind,
  from: Point,
  to: Point,
  pointerId: number,
  clickAfter = true,
): Promise<void> {
  dispatchPointer(plan, 'pointerdown', from, kind, pointerId);
  dispatchPointer(plan, 'pointermove', to, kind, pointerId);
  if (clickAfter) await releaseThenClick(plan, to, kind, pointerId);
  else {
    dispatchPointer(plan, 'pointerup', to, kind, pointerId);
    await Promise.resolve();
  }
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
    bindPlanHost();
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

  it.each([
    ['mouse', 11] as const,
    ['touch', 12] as const,
    ['pen', 13] as const,
  ])('does not open Map when a %s drag releases inside the plan button', async (kind, pointerId) => {
    const { plan, mapOpens } = preparePlan();
    await dragOnPlan(plan, kind, { x: 40, y: 40 }, { x: 52, y: 40 }, pointerId);
    expect(mapOpens()).toBe(0);
    expect(document.getElementById('view')!.className).toBe('view-iss');
  });

  it.each([
    ['mouse', 21] as const,
    ['touch', 22] as const,
    ['pen', 23] as const,
  ])('does not open Map when a %s drag releases on the plan button rim', async (kind, pointerId) => {
    const { plan, mapOpens } = preparePlan();
    vi.spyOn(plan, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 110,
      bottom: 90,
      width: 100,
      height: 80,
      toJSON() {
        return {};
      },
    });
    await dragOnPlan(plan, kind, { x: 40, y: 40 }, { x: 10, y: 10 }, pointerId);
    expect(mapOpens()).toBe(0);
    expect(document.getElementById('view')!.className).toBe('view-iss');
  });

  it.each([
    ['mouse', 31] as const,
    ['touch', 32] as const,
    ['pen', 33] as const,
  ])('does not open Map when a %s drag releases outside the plan button', async (kind, pointerId) => {
    const { plan, mapOpens } = preparePlan();
    await dragOnPlan(plan, kind, { x: 40, y: 40 }, { x: 200, y: 200 }, pointerId, false);
    expect(mapOpens()).toBe(0);
    expect(document.getElementById('view')!.className).toBe('view-iss');
  });

  it.each([
    ['mouse', 41] as const,
    ['touch', 42] as const,
    ['pen', 43] as const,
  ])('opens Map on a real %s tap of the plan button', async (kind, pointerId) => {
    const { plan, tabMap, mapOpens } = preparePlan();
    dispatchPointer(plan, 'pointerdown', { x: 40, y: 40 }, kind, pointerId);
    await releaseThenClick(plan, { x: 40, y: 40 }, kind, pointerId);
    expect(mapOpens()).toBe(1);
    expect(document.activeElement).toBe(tabMap);
    expect(document.getElementById('view')!.className).toBe('view-map');
  });

  it('does not capture the plan button pointer so canvas pans keep their target', () => {
    installViewport();
    const { plan } = mount();
    document.getElementById('view')!.className = 'view-iss';
    plan.hidden = false;
    plan.setPointerCapture = () => {};
    const capture = vi.spyOn(plan, 'setPointerCapture');
    bindPlanHost();
    dispatchPointer(plan, 'pointerdown', { x: 40, y: 40 }, 'mouse', 51);
    expect(capture).not.toHaveBeenCalled();
  });

  it('keeps the drag ignore after the pointerup microtask at iPad 834x1194', async () => {
    installViewport(834, 1194);
    const { plan, tabMap } = mount();
    document.getElementById('view')!.className = 'view-iss';
    plan.hidden = false;
    let mapOpens = 0;
    tabMap.addEventListener('click', () => {
      mapOpens += 1;
      document.getElementById('view')!.className = 'view-map';
    });
    bindPlanHost();
    await dragOnPlan(plan, 'touch', { x: 40, y: 40 }, { x: 60, y: 55 }, 61);
    expect(mapOpens).toBe(0);
    expect(document.getElementById('view')!.className).toBe('view-iss');
  });

  it.each([
    { kind: 'mouse' as const, pointerId: 71, key: 'Enter' },
    { kind: 'mouse' as const, pointerId: 72, key: ' ' },
    { kind: 'touch' as const, pointerId: 73, key: 'Enter' },
    { kind: 'touch' as const, pointerId: 74, key: ' ' },
  ])('opens Map on the first $key after a $kind drag whose click never arrives', async ({ kind, pointerId, key }) => {
    const { plan, tabMap, mapOpens } = preparePlan();
    await dragOnPlan(plan, kind, { x: 40, y: 40 }, { x: 80, y: 55 }, pointerId, false);
    expect(mapOpens()).toBe(0);
    plan.focus();
    plan.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    if (key === ' ') {
      plan.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    }
    keyboardClick(plan);
    expect(mapOpens()).toBe(1);
    expect(document.activeElement).toBe(tabMap);
    expect(document.getElementById('view')!.className).toBe('view-map');
  });

  it('opens Map on the first Enter after a touch drag with no click at iPad 834x1194', async () => {
    installViewport(834, 1194);
    const { plan, tabMap } = mount();
    document.getElementById('view')!.className = 'view-iss';
    plan.hidden = false;
    let mapOpens = 0;
    tabMap.addEventListener('click', () => {
      mapOpens += 1;
      document.getElementById('view')!.className = 'view-map';
    });
    bindPlanHost();
    await dragOnPlan(plan, 'touch', { x: 40, y: 40 }, { x: 70, y: 60 }, 75, false);
    expect(mapOpens).toBe(0);
    plan.focus();
    plan.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    keyboardClick(plan);
    expect(mapOpens).toBe(1);
    expect(document.activeElement).toBe(tabMap);
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
