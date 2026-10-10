import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVendorMap } from '../src/map/adapters/maplibre';
import { createClock } from '../src/map/map-core/clock';
import { createMapCore } from '../src/map/map-core/core';
import type { PopupHandle, VendorMap } from '../src/map/map-core/vendor-map';
import { currentMaplibreDouble, RecordingMap, RecordingPopup, resetMaplibreDouble } from './maplibre-double';

vi.mock('maplibre-gl', async () => (await import('./maplibre-double')).maplibreModuleMock());

class ContainerMap extends RecordingMap {
  getContainer(): HTMLElement {
    return this.options.container as HTMLElement;
  }
}

class ContainerPopup extends RecordingPopup {
  readonly element = document.createElement('div');
  readonly closeButton = document.createElement('button');
  readonly scroller = document.createElement('div');

  constructor(options?: Record<string, unknown>) {
    super(options);
    this.element.className = 'maplibregl-popup';
    this.scroller.className = 'maplibregl-popup-content';
    this.closeButton.className = 'maplibregl-popup-close-button';
    this.closeButton.addEventListener('click', () => this.remove());
    this.element.appendChild(this.scroller);
  }

  override setDOMContent(content: HTMLElement): this {
    super.setDOMContent(content);
    this.scroller.replaceChildren(content, this.closeButton);
    this.scroller.scrollTop = 80;
    return this;
  }

  override addTo(map: RecordingMap): this {
    super.addTo(map);
    if (!(map instanceof ContainerMap)) throw new Error('Popup requires a container-backed map');
    map.getContainer().appendChild(this.element);
    return this;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  override remove(): this {
    if (!this.isOpen()) return this;
    this.element.remove();
    super.remove();
    for (const listener of [...this.listeners.close ?? []]) listener();
    return this;
  }
}

const stylesheet = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8');
let vendor: VendorMap;
let map: ContainerMap;
let pane: HTMLElement;
let container: HTMLElement;
let inspector: HTMLElement;
let styles: HTMLStyleElement;
let frames: FrameRequestCallback[];

function openPopup(label = 'Dropped pin'): PopupHandle {
  const content = document.createElement('div');
  content.className = 'dropped-pin-popup';
  content.textContent = label;
  return vendor.openPopup({ at: [10, 20], content, closeOnClick: false });
}

function popupAt(index: number): ContainerPopup {
  const popup = currentMaplibreDouble().popups[index];
  if (!(popup instanceof ContainerPopup)) throw new Error(`Missing popup ${index}`);
  return popup;
}

function expectOpen(open: boolean): void {
  expect(pane.classList.contains('map-inspector-open')).toBe(open);
  expect(inspector.hidden).toBe(!open);
}

beforeEach(() => {
  const double = resetMaplibreDouble();
  double.maplibregl.Map.mockImplementation((options) => {
    const instance = new ContainerMap(options);
    double.constructed.push(instance);
    return instance;
  });
  double.maplibregl.Popup.mockImplementation((options) => {
    const popup = new ContainerPopup(options);
    double.popups.push(popup);
    return popup;
  });
  document.body.innerHTML = `
    <main id="view" class="view-map">
      <section id="map-pane" class="pane map-chrome-hidden">
        <div id="map" class="map"></div>
        <div class="map-control-dock"></div>
        <button id="map-chrome-toggle" class="map-chrome-toggle" type="button">Controls</button>
        <aside id="map-inspector" class="map-inspector" hidden></aside>
      </section>
    </main>`;
  pane = document.getElementById('map-pane')!;
  container = document.getElementById('map')!;
  inspector = document.getElementById('map-inspector')!;
  styles = document.createElement('style');
  styles.textContent = stylesheet;
  document.head.appendChild(styles);
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vendor = createVendorMap({
    container,
    style: { sources: {}, layers: [] },
    camera: { center: [10, 20], zoom: 3 },
  });
  map = double.constructed[0] as ContainerMap;
});

afterEach(() => {
  styles.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('container-backed map inspector', () => {
  it('reparents the popup out of the map stacking context and opens the inspector', () => {
    expectOpen(false);
    const appendToMap = vi.spyOn(container, 'appendChild');
    openPopup();
    const popup = popupAt(0);

    expect(appendToMap).toHaveBeenCalledWith(popup.element);
    expect(popup.element.parentElement).toBe(inspector);
    expect(inspector.parentElement).toBe(pane);
    expect(container.querySelector('.maplibregl-popup')).toBeNull();
    expectOpen(true);
    expect(popup.options).toMatchObject({ closeOnClick: false, focusAfterOpen: false });
    expect(document.activeElement).toBe(popup.closeButton);
    expect(popup.scroller.scrollTop).toBe(0);
    expect(map.cameraCalls).toEqual([]);
    for (const frame of frames.splice(0)) frame(0);
    expect(map.cameraCalls).toEqual([{ method: 'resize', args: [] }]);
  });

  it('keeps the inspector open until the last popup closes, including the close button path', () => {
    const first = openPopup('First pin');
    const second = openPopup('Another popup');
    const closed = vi.fn();
    second.onClose(closed);
    expect(inspector.querySelectorAll('.maplibregl-popup')).toHaveLength(2);
    expect(getComputedStyle(popupAt(0).element).display).toBe('none');
    expect(getComputedStyle(popupAt(1).element).display).toBe('flex');

    popupAt(1).closeButton.click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(popupAt(1).element.isConnected).toBe(false);
    expect(inspector.querySelectorAll('.maplibregl-popup')).toHaveLength(1);
    expect(getComputedStyle(popupAt(0).element).display).toBe('flex');
    expectOpen(true);
    first.remove();
    expect(inspector.querySelector('.maplibregl-popup')).toBeNull();
    expectOpen(false);
    second.remove();
    expect(closed).toHaveBeenCalledTimes(1);
    expectOpen(false);
  });

  it('replaces an owned pin without leaving stale popup DOM or losing inspector state', () => {
    const core = createMapCore(vendor, createClock());
    const firstContent = document.createElement('div');
    const nextContent = document.createElement('div');
    firstContent.textContent = 'First pin';
    nextContent.textContent = 'Replacement pin';
    core.openPopup({ at: [10, 20], content: firstContent, owner: 'pin' });
    core.openPopup({ at: [30, 40], content: nextContent, owner: 'pin' });

    expect(popupAt(0).element.isConnected).toBe(false);
    expect(inspector.querySelectorAll('.maplibregl-popup')).toHaveLength(1);
    expect(inspector.contains(firstContent)).toBe(false);
    expect(inspector.contains(nextContent)).toBe(true);
    expectOpen(true);
    core.closePopup('pin');
    expect(inspector.querySelector('.maplibregl-popup')).toBeNull();
    expectOpen(false);
  });

  it('does not steal a popup into an inspector belonging to a different map pane', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const otherMap = createVendorMap({
      container: outside,
      style: { sources: {}, layers: [] },
      camera: { center: [10, 20], zoom: 3 },
    });
    const handle = otherMap.openPopup({ at: [10, 20], content: document.createElement('div') });
    expect(popupAt(0).element.parentElement).toBe(outside);
    expect(popupAt(0).options).not.toHaveProperty('focusAfterOpen');
    expect(inspector.children).toHaveLength(0);
    expectOpen(false);
    handle.remove();
  });

  it('paints the reparented inspector above dock controls without raising the Controls toggle', () => {
    pane.classList.remove('map-chrome-hidden');
    openPopup();
    const popup = popupAt(0).element;
    const dock = pane.querySelector<HTMLElement>('.map-control-dock')!;
    const controls = document.getElementById('map-chrome-toggle')!;

    expect(getComputedStyle(pane).isolation).toBe('isolate');
    expect(getComputedStyle(container).zIndex).toBe('0');
    expect(popup.parentElement).toBe(inspector);
    expect(Number(getComputedStyle(inspector).zIndex)).toBeGreaterThan(Number(getComputedStyle(dock).zIndex));
    expect(getComputedStyle(inspector).pointerEvents).toBe('none');
    expect(getComputedStyle(popup).pointerEvents).toBe('auto');
    expect(getComputedStyle(controls).zIndex).toBe('20');
  });

  it.each([1280, 390])('limits the opaque panel to content and its scroll area at %ipx', (width) => {
    vi.stubGlobal('innerWidth', width);
    openPopup();
    const popup = popupAt(0);
    const slotStyle = getComputedStyle(inspector);
    const popupStyle = getComputedStyle(popup.element);
    const contentStyle = getComputedStyle(popup.scroller);

    expect(slotStyle.backgroundColor).toBe('transparent');
    expect(popupStyle.getPropertyValue('inset')).toBe('0 0 auto');
    expect(popupStyle.height).toBe('auto');
    expect(popupStyle.maxHeight).toBe('100%');
    expect(contentStyle.flexGrow).toBe('0');
    expect(contentStyle.flexShrink).toBe('1');
    expect(contentStyle.minHeight).toBe('0');
    expect(contentStyle.overflowY).toBe('auto');
    expect(slotStyle.pointerEvents).toBe('none');
    expect(getComputedStyle(container).right).toBe('0px');
  });
});
