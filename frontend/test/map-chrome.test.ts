import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMapChrome, bindMapChrome, readMapChromeShown } from '../src/map-chrome';

function mount(): HTMLButtonElement {
  document.body.className = 'map-chrome-hidden';
  document.body.innerHTML = `
    <main id="view" class="view-map">
      <section id="map-pane" class="pane map-chrome-hidden">
        <button id="map-chrome-toggle" type="button" aria-expanded="false">Controls</button>
      </section>
    </main>
    <footer id="status-banner">Loading</footer>
  `;
  return document.getElementById('map-chrome-toggle') as HTMLButtonElement;
}

describe('map chrome', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts hidden and remembers show and hide on this device', () => {
    const button = mount();
    expect(readMapChromeShown()).toBe(false);
    bindMapChrome();
    expect(document.body.classList.contains('map-chrome-hidden')).toBe(true);
    expect(document.getElementById('map-pane')!.classList.contains('map-chrome-hidden')).toBe(true);
    expect(button.textContent).toBe('Controls');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('status-banner')!.textContent).toBe('Loading');

    button.click();
    expect(readMapChromeShown()).toBe(true);
    expect(document.body.classList.contains('map-chrome-hidden')).toBe(false);
    expect(button.textContent).toBe('Hide');
    expect(button.getAttribute('aria-expanded')).toBe('true');

    button.click();
    expect(localStorage.getItem('opd-map-chrome')).toBe('hidden');
    expect(button.textContent).toBe('Controls');

    localStorage.setItem('opd-map-chrome', 'shown');
    applyMapChrome(readMapChromeShown());
    expect(button.textContent).toBe('Hide');
    expect(document.getElementById('map-pane')!.classList.contains('map-chrome-hidden')).toBe(false);
  });

  it('leaves the dock scroll alone when the slots are unchanged', () => {
    const button = mount();
    const dock = document.createElement('div');
    dock.className = 'map-control-dock';
    document.getElementById('map-pane')!.appendChild(dock);
    bindMapChrome();
    dock.scrollLeft = 150;
    const toggle = document.body.classList.toggle.bind(document.body.classList);
    let writes = 0;
    document.body.classList.toggle = ((name: string, force?: boolean) => {
      writes += 1;
      return toggle(name, force);
    }) as typeof document.body.classList.toggle;
    (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome?.();
    expect(writes).toBe(0);
    expect(dock.scrollLeft).toBe(150);
    expect(button.textContent).toBe('Controls');
  });
});

function domRect(x: number, y: number, w: number, h: number): DOMRect {
  return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() { return {}; } } as DOMRect;
}

function cornerLift(): string {
  return document.body.style.getPropertyValue('--map-corner-lift');
}

function syncChrome(): void {
  (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome?.();
}

function point(target: HTMLElement, type: string, init: PointerEventInit): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init }));
}

async function paint(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function pinFloor(button: HTMLButtonElement): number {
  const banner = document.getElementById('status-banner') as HTMLElement;
  const bannerH = 80;
  const bannerY = window.innerHeight - bannerH;
  banner.getBoundingClientRect = () => domRect(0, bannerY, 400, bannerH);
  button.getBoundingClientRect = () => domRect(0, 0, 88, 44);
  return bannerY;
}

function demand372(button: HTMLButtonElement, bannerY: number): void {
  const naturalY = bannerY + 320;
  button.getBoundingClientRect = () => {
    const applied = Number.parseFloat(cornerLift()) || 0;
    return domRect(0, naturalY - applied, 88, 44);
  };
}

describe('map chrome pointer hold', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('restores the corner lift after a left and right chord without another click', async () => {
    const button = mount();
    stop = bindMapChrome();
    const bannerY = pinFloor(button);
    await paint();
    expect(cornerLift()).toBe('0px');
    point(button, 'pointerdown', { button: 0, buttons: 1 });
    demand372(button, bannerY);
    syncChrome();
    expect(cornerLift()).toBe('0px');
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 2 }));
    await paint();
    expect(cornerLift()).toBe('0px');
    point(button, 'pointerup', { button: 2, buttons: 0 });
    await paint();
    expect(cornerLift()).toBe('372px');
    expect(button.textContent).toBe('Controls');
  });

  it('keeps the hold while that pointer still has a button down', async () => {
    const button = mount();
    stop = bindMapChrome();
    const bannerY = pinFloor(button);
    await paint();
    point(button, 'pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand372(button, bannerY);
    syncChrome();
    expect(cornerLift()).toBe('0px');
    point(button, 'pointerup', { button: 0, buttons: 2, pointerId: 4 });
    await paint();
    expect(cornerLift()).toBe('0px');
    point(button, 'pointerup', { button: 2, buttons: 0, pointerId: 4 });
    await paint();
    expect(cornerLift()).toBe('372px');
  });

  it('keeps the hold when a different pointer ends', async () => {
    const button = mount();
    stop = bindMapChrome();
    const bannerY = pinFloor(button);
    await paint();
    point(button, 'pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand372(button, bannerY);
    syncChrome();
    expect(cornerLift()).toBe('0px');
    point(button, 'pointerup', { button: 0, buttons: 0, pointerId: 9 });
    point(button, 'pointercancel', { button: 0, buttons: 0, pointerId: 9 });
    point(button, 'lostpointercapture', { buttons: 0, pointerId: 9 });
    await paint();
    expect(cornerLift()).toBe('0px');
    syncChrome();
    expect(cornerLift()).toBe('0px');
    point(button, 'pointerup', { button: 2, buttons: 0, pointerId: 4 });
    await paint();
    expect(cornerLift()).toBe('372px');
  });

  it('restores the corner lift when the holding pointer is cancelled', async () => {
    const button = mount();
    stop = bindMapChrome();
    const bannerY = pinFloor(button);
    await paint();
    point(button, 'pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand372(button, bannerY);
    syncChrome();
    expect(cornerLift()).toBe('0px');
    point(button, 'pointercancel', { button: 0, buttons: 0, pointerId: 4 });
    await paint();
    expect(cornerLift()).toBe('372px');
  });

  it('restores the corner lift when the window blurs during the press', async () => {
    const button = mount();
    stop = bindMapChrome();
    const bannerY = pinFloor(button);
    await paint();
    point(button, 'pointerdown', { button: 0, buttons: 1 });
    demand372(button, bannerY);
    syncChrome();
    expect(cornerLift()).toBe('0px');
    window.dispatchEvent(new Event('blur'));
    await paint();
    expect(cornerLift()).toBe('372px');
  });

  it('restores the corner lift when the holding pointer loses capture', async () => {
    const button = mount();
    stop = bindMapChrome();
    const bannerY = pinFloor(button);
    await paint();
    point(button, 'pointerdown', { button: 0, buttons: 1, pointerId: 4 });
    demand372(button, bannerY);
    syncChrome();
    expect(cornerLift()).toBe('0px');
    point(button, 'lostpointercapture', { buttons: 2, pointerId: 4 });
    await paint();
    expect(cornerLift()).toBe('372px');
  });
});
