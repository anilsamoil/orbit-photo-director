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
let resizeObservers: ResizeObserverDouble[];
let mutationObservers: MutationObserverDouble[];

class ResizeObserverDouble {
  readonly observed = new Set<Element>();
  readonly disconnect = vi.fn(() => this.observed.clear());

  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(element: Element): void { this.observed.add(element); }
  unobserve(element: Element): void { this.observed.delete(element); }
}

class MutationObserverDouble {
  readonly observed = new Map<Node, MutationObserverInit>();
  readonly disconnect = vi.fn(() => this.observed.clear());

  constructor(readonly callback: MutationCallback) {
    mutationObservers.push(this);
  }

  observe(element: Node, options: MutationObserverInit): void { this.observed.set(element, options); }
  takeRecords(): MutationRecord[] { return []; }
}

interface TestRect { left: number; top: number; width: number; height: number }

function mockRect(element: Element, rectangle: TestRect): TestRect {
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() =>
    new DOMRect(rectangle.left, rectangle.top, rectangle.width, rectangle.height));
  return rectangle;
}

function viewport(width: number, height: number, bounds: TestRect = {
  left: 0, top: 80, width, height: height - 80,
}): void {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  mockRect(pane, bounds);
  mockRect(container, { ...bounds });
  for (const ancestor of [pane.parentElement!, document.body, document.documentElement]) {
    mockRect(ancestor, { left: 0, top: 0, width, height });
  }
}

function chrome(selector: string, bounds: TestRect, parent = pane): HTMLElement {
  let element = parent.querySelector<HTMLElement>(selector);
  if (!element) {
    element = document.createElement(selector.startsWith('#') ? 'button' : 'div');
    if (selector.startsWith('#')) element.id = selector.slice(1);
    else element.className = selector.slice(1);
    parent.appendChild(element);
  }
  mockRect(element, bounds);
  return element;
}

function flushFrames(): void {
  for (let iteration = 0; frames.length > 0 && iteration < 10; iteration++) {
    for (const frame of frames.splice(0)) frame(iteration);
  }
  expect(frames, 'inspector layout must settle without a resize/frame loop').toHaveLength(0);
}

function notifyResize(element: Element): void {
  const observers = resizeObservers.filter((observer) => observer.observed.has(element));
  expect(observers.length, `ResizeObserver must cover ${element.id || element.className}`).toBeGreaterThan(0);
  for (const observer of observers) {
    observer.callback([{ target: element } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
  }
  flushFrames();
}

function notifyMutation(target: Node, attributeName = 'class'): void {
  const observers = mutationObservers.filter((observer) => [...observer.observed].some(([root, options]) =>
    (root === target || (options.subtree && root.contains(target)))
      && options.attributes
      && (!options.attributeFilter || options.attributeFilter.includes(attributeName))));
  expect(observers.length, 'MutationObserver must cover chrome visibility changes').toBeGreaterThan(0);
  for (const observer of observers) {
    observer.callback([{ target, type: 'attributes', attributeName } as unknown as MutationRecord], observer as unknown as MutationObserver);
  }
  flushFrames();
}

function inspectorRect(): DOMRect {
  const [left = 0, top = 0, width = 0, height = 0] = ['left', 'top', 'width', 'height'].map((property) => {
    const value = inspector.style.getPropertyValue(property);
    expect(value, `the inspector ${property} must come from measured geometry`).toMatch(/^\d+(?:\.\d+)?px$/);
    return Number.parseFloat(value);
  });
  const paneRect = pane.getBoundingClientRect();
  return new DOMRect(paneRect.left + left, paneRect.top + top, width, height);
}

function expectInsideMap(rectangle: DOMRect): void {
  const mapRect = container.getBoundingClientRect();
  expect(rectangle.width).toBeGreaterThan(0);
  expect(rectangle.height).toBeGreaterThan(0);
  expect(rectangle.left).toBeGreaterThanOrEqual(Math.max(0, mapRect.left) + 8);
  expect(rectangle.top).toBeGreaterThanOrEqual(Math.max(0, mapRect.top) + 8);
  expect(rectangle.right).toBeLessThanOrEqual(Math.min(innerWidth, mapRect.right) - 8);
  expect(rectangle.bottom).toBeLessThanOrEqual(Math.min(innerHeight, mapRect.bottom) - 8);
}

function expectClear(rectangle: DOMRect, ...elements: HTMLElement[]): void {
  for (const element of elements) {
    const obstacle = element.getBoundingClientRect();
    const gap = Math.max(obstacle.left - rectangle.right, rectangle.left - obstacle.right,
      obstacle.top - rectangle.bottom, rectangle.top - obstacle.bottom);
    expect(gap, `inspector overlaps visible ${element.id || element.className}`).toBeGreaterThanOrEqual(8);
  }
}

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
  resizeObservers = [];
  mutationObservers = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', ResizeObserverDouble);
  vi.stubGlobal('MutationObserver', MutationObserverDouble);
  viewport(1400, 900);
  vendor = createVendorMap({
    container,
    style: { sources: {}, layers: [] },
    camera: { center: [10, 20], zoom: 3 },
  });
  map = double.constructed[0] as ContainerMap;
});

afterEach(() => {
  for (const popup of currentMaplibreDouble().popups) popup.remove();
  styles.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('measured inspector chrome clearance', () => {
  beforeEach(() => {
    styles.textContent = `
      #map-pane { overflow-x: hidden; overflow-y: hidden; }
      .map-control-dock { overflow-y: auto; }
      [hidden] { display: none !important; }
      #map-pane.map-chrome-hidden .map-control-dock,
      #map-pane.map-chrome-hidden .map-toolbar,
      #map-pane.map-chrome-hidden .map-command,
      #map-pane.map-chrome-hidden .map-legend,
      #map-pane.map-chrome-hidden .maplibregl-ctrl-top-left,
      #map-pane.map-chrome-hidden #satellite-picker-panel,
      #map-pane.map-chrome-hidden #map-launch-coverage { display: none; }
      .map-legend-toggle:not([aria-expanded='true']) + .map-legend-panel { display: none; }
    `;
  });

  it.each([[1400, 900], [1194, 834]])('places a 320px panel beside the dock and above commands at %i×%i', (width, height) => {
    viewport(width, height);
    pane.classList.remove('map-chrome-hidden');
    const dock = chrome('.map-control-dock', { left: width - 84, top: 90, width: 76, height: height - 210 });
    const toolbar = chrome('.map-toolbar', { left: 10, top: 90, width: 240, height: 50 });
    const navigation = chrome('.maplibregl-ctrl-group', { left: 10, top: 150, width: 44, height: 132 }, container);
    const command = chrome('.map-command', { left: 8, top: height - 120, width: width - 210, height: 112 });
    const time = chrome('.map-controls-time', { left: 8, top: height - 120, width: width - 210, height: 90 }, command);
    const controls = chrome('#map-chrome-toggle', { left: width - 100, top: height - 54, width: 88, height: 44 });
    const legend = chrome('.map-legend', { left: width - 470, top: height - 215, width: 360, height: 205 });
    const legendToggle = chrome('#map-legend-toggle', { left: width - 194, top: height - 54, width: 86, height: 44 }, legend);
    legendToggle.setAttribute('aria-expanded', 'true');
    const legendPanel = chrome('#map-legend-panel', { left: width - 470, top: height - 215, width: 360, height: 148 }, legend);
    legendPanel.className = 'map-legend-panel';

    openPopup();
    flushFrames();
    const bounds = inspectorRect();

    expectInsideMap(bounds);
    expect(bounds.width).toBe(320);
    expect(bounds.height).toBeGreaterThan(250);
    expect(bounds.right).toBeLessThanOrEqual(dock.getBoundingClientRect().left - 8);
    expect(bounds.bottom).toBeLessThanOrEqual(time.getBoundingClientRect().top - 8);
    expectClear(bounds, dock, toolbar, navigation, time, controls, legendToggle, legendPanel);
    expectOpen(true);
  });

  it('reclaims hidden chrome space and responds to show/hide without resizing the map', () => {
    const dock = chrome('.map-control-dock', { left: 1260, top: 88, width: 132, height: 730 });
    const controls = chrome('#map-chrome-toggle', { left: 1292, top: 838, width: 96, height: 44 });
    openPopup();
    flushFrames();
    const hidden = inspectorRect();
    expectClear(hidden, controls);
    expect(hidden.right).toBeGreaterThan(dock.getBoundingClientRect().left);
    const cameraCalls = [...map.cameraCalls];

    pane.classList.remove('map-chrome-hidden');
    notifyMutation(pane);
    const shown = inspectorRect();
    expectClear(shown, dock, controls);
    expect(shown.right).toBeLessThanOrEqual(dock.getBoundingClientRect().left - 8);
    expect(map.cameraCalls).toEqual(cameraCalls);

    pane.classList.add('map-chrome-hidden');
    notifyMutation(pane);
    expect(inspectorRect().toJSON()).toEqual(hidden.toJSON());
    expect(map.cameraCalls).toEqual(cameraCalls);
    expectOpen(true);
  });

  it('avoids expanded Legend paint and restores space after its toggle closes', () => {
    pane.classList.remove('map-chrome-hidden');
    const legend = chrome('.map-legend', { left: 1040, top: 240, width: 348, height: 642 });
    const toggle = chrome('#map-legend-toggle', { left: 1196, top: 838, width: 88, height: 44 }, legend);
    toggle.className = 'map-legend-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    const panel = chrome('#map-legend-panel', { left: 1040, top: 240, width: 348, height: 580 }, legend);
    panel.className = 'map-legend-panel';
    openPopup();
    flushFrames();
    const closed = inspectorRect();
    expect(closed.right).toBeGreaterThan(panel.getBoundingClientRect().left);

    toggle.setAttribute('aria-expanded', 'true');
    notifyMutation(toggle, 'aria-expanded');
    expectClear(inspectorRect(), toggle, panel);
    expectInsideMap(inspectorRect());

    toggle.setAttribute('aria-expanded', 'false');
    notifyMutation(toggle, 'aria-expanded');
    expect(inspectorRect().toJSON()).toEqual(closed.toJSON());
    expectOpen(true);
  });

  it('measures actual wrapped time buttons outside the nominal command rect and follows wrap changes', () => {
    viewport(390, 844);
    pane.classList.remove('map-chrome-hidden');
    pane.style.setProperty('--map-command-height', '72px');
    const command = chrome('.map-command', { left: 8, top: 756, width: 266, height: 72 });
    const time = chrome('.map-controls-time', { left: 8, top: 756, width: 266, height: 64 }, command);
    const back = chrome('#time-back-90', { left: 8, top: 632, width: 120, height: 44 }, time);
    const forward = chrome('#time-fwd-45', { left: 132, top: 632, width: 142, height: 44 }, time);
    const controls = chrome('#map-chrome-toggle', { left: 282, top: 770, width: 96, height: 48 });
    openPopup();
    flushFrames();
    const wrapped = inspectorRect();
    expectInsideMap(wrapped);
    expectClear(wrapped, time, back, forward, controls);
    expect(wrapped.height).toBeLessThanOrEqual(260);
    expect(wrapped.bottom).toBeLessThanOrEqual(624);

    mockRect(back, { left: 8, top: 540, width: 120, height: 44 });
    mockRect(forward, { left: 132, top: 540, width: 142, height: 44 });
    notifyResize(time);
    const moreWrapped = inspectorRect();
    expectClear(moreWrapped, time, back, forward, controls);
    expect(moreWrapped.bottom).toBeLessThanOrEqual(532);
    expect(moreWrapped.top).toBeLessThan(wrapped.top);
    expectOpen(true);
  });

  it('leaves the compass and clipped dock hittable in short landscape and recalculates on orientation change', () => {
    viewport(844, 390, { left: 0, top: 60, width: 844, height: 330 });
    pane.classList.remove('map-chrome-hidden');
    const navigation = chrome('.maplibregl-ctrl-group', { left: 8, top: 156, width: 44, height: 132 }, container);
    const dock = chrome('.map-control-dock', { left: 776, top: 70, width: 60, height: 214 });
    const command = chrome('.map-command', { left: 8, top: 306, width: 620, height: 76 });
    const time = chrome('.map-controls-time', { left: 8, top: 306, width: 620, height: 68 }, command);
    const controls = chrome('#map-chrome-toggle', { left: 736, top: 326, width: 96, height: 44 });
    const legend = chrome('.map-legend', { left: 542, top: 205, width: 185, height: 169 });
    const toggle = chrome('#map-legend-toggle', { left: 642, top: 326, width: 86, height: 44 }, legend);
    toggle.className = 'map-legend-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    const panel = chrome('#map-legend-panel', { left: 542, top: 205, width: 185, height: 104 }, legend);
    panel.className = 'map-legend-panel';
    openPopup();
    flushFrames();
    const landscape = inspectorRect();
    expectInsideMap(landscape);
    expectClear(landscape, navigation, dock, time, controls, toggle, panel);
    expect(landscape.height).toBeLessThanOrEqual(120);
    expect(landscape.height).toBeGreaterThanOrEqual(96);
    expect(landscape.width).toBeGreaterThanOrEqual(240);

    viewport(390, 844);
    mockRect(navigation, { left: 8, top: 96, width: 44, height: 132 });
    mockRect(dock, { left: 320, top: 90, width: 62, height: 540 });
    mockRect(command, { left: 8, top: 674, width: 266, height: 160 });
    mockRect(time, { left: 8, top: 674, width: 266, height: 146 });
    mockRect(controls, { left: 282, top: 778, width: 96, height: 44 });
    toggle.setAttribute('aria-expanded', 'false');
    mockRect(toggle, { left: 184, top: 778, width: 90, height: 44 });
    window.dispatchEvent(new Event('resize'));
    flushFrames();
    const portrait = inspectorRect();
    expectInsideMap(portrait);
    expectClear(portrait, navigation, dock, time, controls, toggle);
    expect(portrait.height).toBeGreaterThan(landscape.height);
    expect(portrait.height).toBeLessThanOrEqual(260);
    expectOpen(true);
  });

  it('uses pane-relative coordinates and intersects map bounds with the visible viewport', () => {
    viewport(1000, 760, { left: 100, top: 90, width: 1100, height: 800 });
    mockRect(container, { left: 112, top: 134, width: 1080, height: 730 });
    const controls = chrome('#map-chrome-toggle', { left: 878, top: 702, width: 96, height: 44 });
    openPopup();
    flushFrames();
    const bounds = inspectorRect();
    expectInsideMap(bounds);
    expectClear(bounds, controls);
    expect(bounds.width).toBe(320);
    expect(Number.parseFloat(inspector.style.left)).toBe(bounds.left - 100);
    expect(Number.parseFloat(inspector.style.top)).toBe(bounds.top - 90);
  });

  it('ignores hidden, zero-area and scrolled-out controls but follows visible secondary panels', () => {
    pane.classList.remove('map-chrome-hidden');
    const dock = chrome('.map-control-dock', { left: 1308, top: 88, width: 84, height: 120 });
    dock.style.overflowY = 'auto';
    const clipped = chrome('#toggle-labels', { left: 1308, top: 500, width: 84, height: 44 }, dock);
    const hidden = chrome('#satellite-picker-panel', { left: 1000, top: 230, width: 392, height: 570 });
    hidden.hidden = true;
    const zero = chrome('#map-launch-coverage', { left: 1100, top: 300, width: 0, height: 400 });
    openPopup();
    flushFrames();
    const initial = inspectorRect();
    expectClear(initial, dock);
    expect(initial.right).toBeGreaterThan(clipped.getBoundingClientRect().left);
    expect(initial.top).toBeLessThan(clipped.getBoundingClientRect().top);
    expect(initial.bottom).toBeGreaterThan(clipped.getBoundingClientRect().bottom);

    hidden.hidden = false;
    notifyMutation(hidden, 'hidden');
    expectClear(inspectorRect(), dock, hidden);
    hidden.hidden = true;
    notifyMutation(hidden, 'hidden');
    expect(inspectorRect().toJSON()).toEqual(initial.toJSON());

    mockRect(zero, { left: 1000, top: 230, width: 392, height: 570 });
    notifyResize(zero);
    expectClear(inspectorRect(), dock, zero);
    expectOpen(true);
  });

  it('remeasures external status and shot-list banners without moving their controls', () => {
    const status = chrome('#status-banner', { left: 0, top: 740, width: 1400, height: 160 }, document.body);
    const shotlist = chrome('#shotlist-bar', { left: 0, top: 88, width: 1400, height: 60 }, document.body);
    openPopup();
    flushFrames();
    const first = inspectorRect();
    expectClear(first, status, shotlist);
    expectInsideMap(first);
    const cameraCalls = [...map.cameraCalls];

    mockRect(status, { left: 0, top: 640, width: 1400, height: 260 });
    notifyResize(status);
    expectClear(inspectorRect(), status, shotlist);
    expect(inspectorRect().bottom).toBeLessThan(first.bottom);
    expect(status.style.cssText).toBe('');
    expect(shotlist.style.cssText).toBe('');
    expect(map.cameraCalls).toEqual(cameraCalls);

    status.hidden = true;
    notifyMutation(status, 'hidden');
    expect(inspectorRect().bottom).toBeGreaterThan(first.bottom);
    expectClear(inspectorRect(), shotlist);
    expectOpen(true);
  });

  it('coalesces geometry signals, ignores popup mutations and disconnects only after the last close', () => {
    const navigation = chrome('.maplibregl-ctrl-group', { left: 8, top: 96, width: 44, height: 132 }, container);
    const compass = chrome('.maplibregl-ctrl-compass', { left: 8, top: 184, width: 44, height: 44 }, navigation);
    const icon = chrome('.maplibregl-ctrl-icon', { left: 20, top: 196, width: 20, height: 20 }, compass);
    const first = openPopup('First');
    const second = openPopup('Second');
    flushFrames();
    const observers = [...resizeObservers];
    const mutations = mutationObservers.filter((observer) => observer.observed.has(pane));
    expect(observers.length).toBeGreaterThan(0);
    expect(mutations.length).toBeGreaterThan(0);
    const cameraCalls = [...map.cameraCalls];
    for (const observer of observers) {
      observer.callback([{ target: pane } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
      observer.callback([{ target: pane } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
    expect(frames).toHaveLength(1);
    flushFrames();
    expect(map.cameraCalls).toEqual(cameraCalls);
    for (const observer of mutations) {
      observer.callback([{ target: popupAt(1).scroller, type: 'attributes', attributeName: 'style' } as unknown as MutationRecord],
        observer as unknown as MutationObserver);
      observer.callback([{ target: icon, type: 'attributes', attributeName: 'style' } as unknown as MutationRecord],
        observer as unknown as MutationObserver);
    }
    expect(frames).toHaveLength(0);

    first.remove();
    flushFrames();
    expectOpen(true);
    for (const observer of [...observers, ...mutations]) expect(observer.disconnect).not.toHaveBeenCalled();
    second.remove();
    flushFrames();
    expectOpen(false);
    for (const observer of [...observers, ...mutations]) expect(observer.disconnect).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('resize'));
    expect(frames).toHaveLength(0);
  });
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
