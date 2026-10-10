import { solveChromeSlots, type Box, type ChromeMeasure, type ChromeSlots } from './chrome-slots';

const STORAGE_KEY = 'opd-map-chrome';
const timeLinePx = 44;

export function readMapChromeShown(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'shown';
  } catch {
    return false;
  }
}

export function applyMapChrome(shown: boolean): void {
  document.body.classList.toggle('map-chrome-hidden', !shown);
  document.getElementById('map-pane')?.classList.toggle('map-chrome-hidden', !shown);
  const button = document.getElementById('map-chrome-toggle');
  if (!(button instanceof HTMLButtonElement)) return;
  button.setAttribute('aria-expanded', shown ? 'true' : 'false');
  button.textContent = shown ? 'Hide' : 'Controls';
  button.title = shown ? 'Hide map controls' : 'Show map controls';
}

function emptyBox(): Box {
  return { x: 0, y: 0, w: 0, h: 0 };
}

function boxOf(node: Element | null): Box {
  if (!(node instanceof HTMLElement)) return emptyBox();
  const rect = node.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

function unionBox(nodes: Element[]): Box {
  const boxes = nodes.map(boxOf).filter((box) => box.w >= 1 && box.h >= 1);
  if (!boxes.length) return emptyBox();
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const far = Math.max(...boxes.map((box) => box.x + box.w));
  const low = Math.max(...boxes.map((box) => box.y + box.h));
  return { x, y, w: far - x, h: low - y };
}

function lengthPx(host: HTMLElement, value: string): number {
  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.height = '0';
  probe.style.width = value;
  host.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

function insetPx(side: 'top' | 'right' | 'bottom' | 'left'): number {
  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  const prop = side === 'top' ? 'paddingTop' : side === 'right' ? 'paddingRight' : side === 'bottom' ? 'paddingBottom' : 'paddingLeft';
  probe.style[prop] = `env(safe-area-inset-${side}, 0px)`;
  document.body.appendChild(probe);
  const value = Number.parseFloat(getComputedStyle(probe)[prop]) || 0;
  probe.remove();
  return value;
}

function gutterPx(dock: HTMLElement | null): number {
  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.left = '0';
  probe.style.top = '0';
  probe.style.width = '80px';
  probe.style.height = '40px';
  probe.style.overflow = 'scroll';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  const inner = document.createElement('div');
  inner.style.width = '200px';
  inner.style.height = '80px';
  probe.appendChild(inner);
  document.body.appendChild(probe);
  const bar = probe.offsetHeight - probe.clientHeight;
  probe.remove();
  const controls = dock?.querySelector(':scope > .map-controls');
  if (!(controls instanceof HTMLElement)) return Math.max(0, bar);
  const style = getComputedStyle(controls);
  const pad = (Number.parseFloat(style.paddingTop) || 0)
    + (Number.parseFloat(style.paddingBottom) || 0)
    + (Number.parseFloat(style.borderTopWidth) || 0)
    + (Number.parseFloat(style.borderBottomWidth) || 0);
  return Math.max(0, bar) + pad;
}

function launchBox(): Box | null {
  const node = document.getElementById('map-launch-coverage');
  if (!(node instanceof HTMLElement) || node.hidden) return null;
  if (getComputedStyle(node).display === 'none') return null;
  const box = boxOf(node);
  return box.h >= 1 ? box : null;
}

function visiblePip(): Box | null {
  const pip = document.querySelector('[data-pip="horizon"]');
  if (!(pip instanceof HTMLElement) || pip.hidden) return null;
  if (getComputedStyle(pip).display === 'none') return null;
  const box = boxOf(pip);
  return box.h >= 1 ? box : null;
}

function naturalDockCorridor(view: HTMLElement, pane: HTMLElement): number {
  const style = getComputedStyle(view);
  const read = (name: string) => lengthPx(view, style.getPropertyValue(name).trim() || '0px');
  const paneH = pane.getBoundingClientRect().height;
  const clear = read('--map-dock-clear');
  if (visiblePip()) {
    return paneH - read('--horizon-top') - read('--horizon-height') - read('--horizon-gap') - clear - 16;
  }
  return paneH - read('--topbar-height') - clear - 16;
}

function naturalLegendBottom(view: HTMLElement): number {
  const legend = document.querySelector('.map-legend');
  if (!(legend instanceof HTMLElement)) return 0;
  const style = getComputedStyle(view);
  const offset = lengthPx(view, style.getPropertyValue('--map-legend-panel-bottom').trim() || '0px');
  return legend.getBoundingClientRect().bottom - offset;
}

function measureChrome(view: HTMLElement, pane: HTMLElement): ChromeMeasure {
  const shotList = document.body.classList.contains('shotlist-bar-visible')
    ? boxOf(document.getElementById('shotlist-bar'))
    : emptyBox();
  const dock = document.querySelector('.map-control-dock');
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    insets: { top: insetPx('top'), right: insetPx('right'), bottom: insetPx('bottom'), left: insetPx('left') },
    zoom: unionBox([...document.querySelectorAll('.maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out')]),
    compass: boxOf(document.querySelector('.maplibregl-ctrl-compass')),
    show: boxOf(document.querySelector('.map-toolbar')),
    showButtons: [...document.querySelectorAll('#filter-all-map, #filter-mine-map, #filter-launches-map')].map(boxOf),
    sliderChip: boxOf(document.querySelector('.map-command .map-controls-time')),
    slider: boxOf(document.getElementById('time-slider')),
    timeButtons: [...document.querySelectorAll('.map-command .time-step-btn')].map(boxOf),
    topbar: lengthPx(view, getComputedStyle(document.documentElement).getPropertyValue('--topbar-height').trim() || '48px'),
    footer: boxOf(document.getElementById('status-banner')),
    shotList,
    launch: launchBox(),
    scrollbar: gutterPx(dock instanceof HTMLElement ? dock : null),
    pip: visiblePip(),
    hide: boxOf(document.getElementById('map-chrome-toggle')),
    legendButton: boxOf(document.getElementById('map-legend-toggle')),
    legendPanel: boxOf(document.getElementById('map-legend-panel')),
    legendOpen: document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true',
    legendNaturalBottom: naturalLegendBottom(view),
    dockCorridor: naturalDockCorridor(view, pane),
    chromeHidden: document.body.classList.contains('map-chrome-hidden'),
    timeNeed: timeNeedPx(),
  };
}

function timeNeedPx(): number {
  const chip = document.querySelector('.map-command .map-controls-time');
  if (!(chip instanceof HTMLElement)) return 0;
  const top = chip.getBoundingClientRect().top;
  let low = top;
  for (const el of chip.querySelectorAll('button, input, .time-slider-end, .time-slider-readout')) {
    const rect = el.getBoundingClientRect();
    if (rect.height < 1) continue;
    low = Math.max(low, rect.bottom);
  }
  return Math.max(0, low - top);
}

let lastSlots = '';
let mute = false;
let syncQueued = false;

function writeSlot(name: string, value: number): void {
  document.body.style.setProperty(name, `${value}px`);
}

function placeInPane(name: string, box: { x: number; y: number; w: number; h: number }, origin: { left: number; top: number }): void {
  writeSlot(`--slot-${name}-x`, box.x - origin.left);
  writeSlot(`--slot-${name}-y`, box.y - origin.top);
  writeSlot(`--slot-${name}-w`, box.w);
  writeSlot(`--slot-${name}-h`, box.h);
}

function placeInView(name: string, box: { x: number; y: number; w: number; h: number }): void {
  writeSlot(`--slot-${name}-x`, box.x);
  writeSlot(`--slot-${name}-y`, box.y);
  writeSlot(`--slot-${name}-w`, box.w);
  writeSlot(`--slot-${name}-h`, box.h);
}

function applySlots(slots: ChromeSlots, pane: HTMLElement): void {
  const key = JSON.stringify(slots);
  if (key === lastSlots) return;
  lastSlots = key;
  const origin = pane.getBoundingClientRect();
  mute = true;
  const owned = slots.zoom !== null || slots.time !== null || slots.hide !== null;
  document.body.classList.toggle('map-slot-owned', owned);
  document.body.classList.toggle('map-slot-time', slots.time !== null);
  document.body.classList.toggle('map-slot-time-line', slots.time !== null && slots.time.h <= timeLinePx);
  document.body.classList.toggle('map-slot-dock', slots.dock !== null);
  document.body.classList.toggle('map-slot-dock-row', slots.dock?.axis === 'row');
  document.body.classList.toggle('map-slot-legend', slots.legend !== null);
  document.body.classList.toggle('map-slot-launch', slots.launch !== null);
  if (slots.zoom) placeInPane('zoom', slots.zoom, origin);
  if (slots.compass) placeInPane('compass', slots.compass, origin);
  if (slots.show) placeInPane('show', slots.show, origin);
  if (slots.time) placeInPane('time', slots.time, origin);
  if (slots.dock) placeInPane('dock', slots.dock, origin);
  if (slots.legendButton) placeInPane('legend-button', slots.legendButton, origin);
  if (slots.hide) placeInPane('hide', slots.hide, origin);
  if (slots.launch) placeInPane('launch', slots.launch, origin);
  if (slots.legend) placeInView('legend', slots.legend);
  if (slots.footer) placeInView('footer', slots.footer);
  queueMicrotask(() => {
    mute = false;
  });
}

function scheduleSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    syncMapChrome();
  });
}

function syncMapChrome(): void {
  if (mute) return;
  const view = document.querySelector('.view-map');
  const pane = document.getElementById('map-pane');
  if (!(view instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
    lastSlots = '';
    document.body.classList.remove('map-slot-owned', 'map-slot-time', 'map-slot-time-line', 'map-slot-dock', 'map-slot-dock-row', 'map-slot-legend', 'map-slot-launch');
    return;
  }
  applySlots(solveChromeSlots(measureChrome(view, pane)), pane);
}

function ensureInsetProbes(): HTMLElement[] {
  return (['top', 'right', 'bottom', 'left'] as const).map((side) => {
    const existing = document.querySelector(`[data-map-chrome-inset="${side}"]`);
    if (existing instanceof HTMLElement) return existing;
    const probe = document.createElement('div');
    probe.setAttribute('data-map-chrome-inset', side);
    probe.setAttribute('data-inset-env', `env(safe-area-inset-${side}, 0px)`);
    probe.setAttribute('aria-hidden', 'true');
    probe.style.position = 'fixed';
    probe.style.left = '0';
    probe.style.top = '0';
    probe.style.pointerEvents = 'none';
    probe.style.visibility = 'hidden';
    if (side === 'left' || side === 'right') {
      probe.style.width = `env(safe-area-inset-${side}, 0px)`;
      probe.style.height = '1px';
    } else {
      probe.style.height = `env(safe-area-inset-${side}, 0px)`;
      probe.style.width = '1px';
    }
    document.body.appendChild(probe);
    return probe;
  });
}

export function bindMapChrome(): void {
  applyMapChrome(readMapChromeShown());
  document.getElementById('map-chrome-toggle')?.addEventListener('click', () => {
    const shown = document.body.classList.contains('map-chrome-hidden');
    try {
      localStorage.setItem(STORAGE_KEY, shown ? 'shown' : 'hidden');
    } catch {
    }
    applyMapChrome(shown);
    syncMapChrome();
  });
  const observer = new ResizeObserver(() => scheduleSync());
  observer.observe(document.documentElement);
  for (const probe of ensureInsetProbes()) observer.observe(probe);
  const mutations = new MutationObserver(() => scheduleSync());
  mutations.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const banner = document.getElementById('status-banner');
  if (banner) mutations.observe(banner, { childList: true, subtree: true });
  const legend = document.getElementById('map-legend-toggle');
  if (legend) mutations.observe(legend, { attributes: true, attributeFilter: ['aria-expanded'] });
  const map = document.getElementById('map');
  if (map) {
    let controlsWatched = false;
    const watchMap = new MutationObserver(() => {
      scheduleSync();
      if (controlsWatched) return;
      const controls = map.querySelector('.maplibregl-control-container');
      if (!controls) return;
      controlsWatched = true;
      watchMap.observe(controls, { childList: true, subtree: true });
    });
    watchMap.observe(map, { childList: true });
    const controls = map.querySelector('.maplibregl-control-container');
    if (controls) {
      controlsWatched = true;
      watchMap.observe(controls, { childList: true, subtree: true });
    }
  }
  window.addEventListener('resize', scheduleSync);
  window.visualViewport?.addEventListener('resize', scheduleSync);
  (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome = syncMapChrome;
  syncMapChrome();
}
