import { needsZoomRow, solveChromeSlots, TIME_LINE_WIDTH, type Box, type ChromeMeasure, type ChromeSlots } from './chrome-slots';

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

function legendContentSize(): { height: number; rowHeight: number } {
  const panel = document.getElementById('map-legend-panel');
  if (!(panel instanceof HTMLElement) || !panel.getClientRects().length) return { height: 0, rowHeight: 0 };
  // The allocated width and height can wrap or flex-shrink the live content.
  // Measure its natural 11rem demand independently of the previous slot.
  const host = document.createElement('div');
  host.className = 'view-map';
  host.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  const intrinsic = panel.cloneNode(true) as HTMLElement;
  intrinsic.removeAttribute('id');
  for (const child of intrinsic.querySelectorAll('[id]')) child.removeAttribute('id');
  intrinsic.style.cssText = 'position:static;width:11rem;height:auto;min-width:0;max-width:none;max-height:none;overflow:visible';
  legend.appendChild(intrinsic);
  host.appendChild(legend);
  document.body.appendChild(host);
  const height = Math.ceil(intrinsic.getBoundingClientRect().height);
  const rowHeight = Math.max(0, ...[...intrinsic.children].map(boxOf).map((box) => box.h)) + 2;
  host.remove();
  return { height, rowHeight };
}

function measureChrome(view: HTMLElement, pane: HTMLElement): ChromeMeasure {
  const shotList = document.body.classList.contains('shotlist-bar-visible')
    ? boxOf(document.getElementById('shotlist-bar'))
    : emptyBox();
  const dock = document.querySelector('.map-control-dock');
  const legend = legendContentSize();
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    map: boxOf(document.getElementById('map')),
    insets: { top: insetPx('top'), right: insetPx('right'), bottom: insetPx('bottom'), left: insetPx('left') },
    zoom: unionBox([...document.querySelectorAll('.maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out')]),
    compass: boxOf(document.querySelector('.maplibregl-ctrl-compass')),
    show: boxOf(document.querySelector('.map-toolbar')),
    showButtons: [...document.querySelectorAll('#filter-all-map, #filter-mine-map, #filter-launches-map')].map(boxOf),
    launchBrief: boxOf(document.getElementById('map-launch-coverage')),
    picker: boxOf(document.getElementById('satellite-picker-panel')),
    inspectorOpen: pane.classList.contains('map-inspector-open'),
    dock: boxOf(dock),
    sliderChip: boxOf(document.querySelector('.map-command .map-controls-time')),
    timeStrip: boxOf(document.querySelector('.map-command')),
    slider: boxOf(document.getElementById('time-slider')),
    timeButtons: [...document.querySelectorAll('.map-command .time-step-btn')].map(boxOf),
    footer: boxOf(document.getElementById('status-banner')),
    shotList,
    scrollbar: gutterPx(dock instanceof HTMLElement ? dock : null),
    pip: visiblePip(),
    hide: boxOf(document.getElementById('map-chrome-toggle')),
    legendButton: boxOf(document.getElementById('map-legend-toggle')),
    legendPanel: boxOf(document.getElementById('map-legend-panel')),
    legendContentHeight: legend.height,
    legendRowHeight: legend.rowHeight,
    legendOpen: document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true',
    legendNaturalBottom: naturalLegendBottom(view),
    dockCorridor: naturalDockCorridor(view, pane),
    chromeHidden: document.body.classList.contains('map-chrome-hidden'),
  };
}

let lastSlots = '';
let mute = false;
let syncing = false;
let staleSkips = 0;
let syncQueued = false;
let chromeLive = false;
const writtenPx = new Map<string, number>();

function wholePx(value: number): number {
  return Math.round(value);
}

function writePx(name: string, value: number): void {
  const px = wholePx(value);
  if (writtenPx.get(name) === px) return;
  writtenPx.set(name, px);
  document.body.style.setProperty(name, `${px}px`);
}

function setBodyClass(name: string, on: boolean): void {
  if (document.body.classList.contains(name) === on) return;
  document.body.classList.toggle(name, on);
}

function quantizeSlots(slots: ChromeSlots): ChromeSlots {
  const slot = <T extends { x: number; y: number; w: number; h: number }>(value: T | null | undefined): T | null | undefined => {
    if (!value) return value;
    return { ...value, x: wholePx(value.x), y: wholePx(value.y), w: wholePx(value.w), h: wholePx(value.h) };
  };
  return {
    time: slot(slots.time) ?? null,
    dock: slot(slots.dock) ?? null,
    legend: slot(slots.legend) ?? null,
    launch: slot(slots.launch),
    picker: slot(slots.picker),
  };
}

function writeSlot(name: string, value: number): void {
  writePx(name, value);
}

function applySlots(slots: ChromeSlots, pane: HTMLElement): void {
  const placed = quantizeSlots(slots);
  const key = JSON.stringify(placed);
  if (key === lastSlots) return;
  lastSlots = key;
  const origin = pane.getBoundingClientRect();
  mute = true;
  setBodyClass('map-slot-time', placed.time !== null);
  setBodyClass('map-slot-time-line', placed.time !== null && placed.time.h <= timeLinePx);
  setBodyClass('map-slot-time-compact', placed.time !== null && placed.time.h <= timeLinePx && placed.time.w < TIME_LINE_WIDTH);
  setBodyClass('map-slot-dock', placed.dock !== null);
  setBodyClass('map-slot-dock-row', placed.dock?.axis === 'row');
  setBodyClass('map-slot-legend', placed.legend !== null);
  setBodyClass('map-slot-launch', !!placed.launch);
  setBodyClass('map-slot-picker', !!placed.picker);
  if (placed.time) {
    writeSlot('--slot-time-x', placed.time.x - origin.left);
    writeSlot('--slot-time-y', placed.time.y - origin.top);
    writeSlot('--slot-time-w', placed.time.w);
    writeSlot('--slot-time-h', placed.time.h);
  }
  if (placed.dock) {
    writeSlot('--slot-dock-x', placed.dock.x - origin.left);
    writeSlot('--slot-dock-y', placed.dock.y - origin.top);
    writeSlot('--slot-dock-w', placed.dock.w);
    writeSlot('--slot-dock-h', placed.dock.h);
  }
  if (placed.launch) {
    writeSlot('--slot-launch-x', placed.launch.x - origin.left);
    writeSlot('--slot-launch-y', placed.launch.y - origin.top);
    writeSlot('--slot-launch-w', placed.launch.w);
    writeSlot('--slot-launch-h', placed.launch.h);
  }
  if (placed.picker) {
    writeSlot('--slot-picker-x', placed.picker.x - origin.left);
    writeSlot('--slot-picker-y', placed.picker.y - origin.top);
    writeSlot('--slot-picker-w', placed.picker.w);
    writeSlot('--slot-picker-h', placed.picker.h);
  }
  if (placed.legend) {
    writeSlot('--slot-legend-x', placed.legend.x);
    writeSlot('--slot-legend-y', placed.legend.y);
    writeSlot('--slot-legend-w', placed.legend.w);
    writeSlot('--slot-legend-h', placed.legend.h);
  }
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

function syncFooterClearance(pane: HTMLElement): void {
  const set = (name: string, value: number): void => {
    writePx(name, value);
  };
  const applied = (name: string): number => writtenPx.get(name) ?? wholePx(Number.parseFloat(document.body.style.getPropertyValue(name)) || 0);
  const banner = document.getElementById('status-banner');
  const toggle = document.getElementById('map-chrome-toggle');
  const bannerBox = boxOf(banner);
  if (banner && bannerBox.h) {
    const used = Number.parseFloat(getComputedStyle(banner).bottom) || 0;
    if (Math.abs(bannerBox.y + bannerBox.h - (window.innerHeight - used)) > 1 && staleSkips < 4) {
      staleSkips += 1;
      scheduleSync();
      return;
    }
  }
  staleSkips = 0;
  const bottomInset = insetPx('bottom');
  const shotList = document.body.classList.contains('shotlist-bar-visible')
    ? boxOf(document.getElementById('shotlist-bar')) : emptyBox();
  set('--map-banner-bottom', Math.max(bottomInset, shotList.h));
  const footer = boxOf(banner);
  const floor = Math.min(footer.h ? footer.y : window.innerHeight - bottomInset, shotList.h ? shotList.y : window.innerHeight);
  const demand = (name: string, node: Element | null): number => {
    const box = boxOf(node);
    if (!box.h) return 0;
    return Math.max(0, wholePx(box.y) + wholePx(box.h) + applied(name) - wholePx(floor) + 8);
  };
  set('--map-corner-lift', demand('--map-corner-lift', toggle));
  const chip = boxOf(pane.querySelector('.map-controls-time'));
  const zoom = boxOf(pane.querySelector('.maplibregl-ctrl-zoom-in'));
  const naturalOverflow = !document.body.classList.contains('map-slot-time')
    && chip.y < zoom.y && chip.y + chip.h > zoom.y;
  const zoomRow = needsZoomRow(zoom, naturalOverflow ? { ...chip, y: zoom.y } : chip, floor);
  setBodyClass('map-zoom-row', zoomRow);
  if (window.innerWidth <= 719 || document.body.classList.contains('map-chrome-hidden') || document.body.classList.contains('map-slot-time')) {
    set('--map-time-lift', 0);
    return;
  }
  set('--map-time-lift', demand('--map-time-lift', pane.querySelector('.map-command')));
}

export function syncMapChrome(): void {
  if (!chromeLive || mute) return;
  if (syncing) {
    scheduleSync();
    return;
  }
  syncing = true;
  try {
    syncMapChromeBody();
  } finally {
    syncing = false;
  }
}

function syncMapChromeBody(): void {
  const view = document.querySelector('.view-map');
  const pane = document.getElementById('map-pane');
  if (!(view instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
    lastSlots = '';
    const staleSlots = ['map-slot-time', 'map-slot-time-line', 'map-slot-time-compact', 'map-slot-dock', 'map-slot-dock-row', 'map-slot-legend', 'map-slot-launch', 'map-slot-picker']
      .filter((name) => document.body.classList.contains(name));
    if (staleSlots.length) document.body.classList.remove(...staleSlots);
    return;
  }
  syncFooterClearance(pane);
  const hadTimeSlot = document.body.classList.contains('map-slot-time');
  const slots = solveChromeSlots(measureChrome(view, pane));
  applySlots(slots, pane);
  if (hadTimeSlot && !slots.time) {
    // Clearing the slot exposes natural CSS; lift that strip before it paints.
    syncFooterClearance(pane);
    applySlots(solveChromeSlots(measureChrome(view, pane)), pane);
  }
}

function ensureInsetProbe(): HTMLElement {
  const existing = document.querySelector('[data-map-chrome-insets]');
  if (existing instanceof HTMLElement) return existing;
  const probe = document.createElement('div');
  probe.setAttribute('data-map-chrome-insets', '');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'fixed';
  probe.style.left = '0';
  probe.style.top = '0';
  probe.style.width = 'calc(env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px))';
  probe.style.height = 'calc(env(safe-area-inset-top, 0px) + env(safe-area-inset-bottom, 0px))';
  probe.style.pointerEvents = 'none';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  return probe;
}

export function bindMapChrome(): () => void {
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
  const observer = new ResizeObserver(() => {
    if (mute) scheduleSync();
    else syncMapChrome();
  });
  const probe = ensureInsetProbe();
  const cornerSelectors = ['#status-banner', '#shotlist-bar', '.map-controls-time', '#satellite-picker-panel'];
  const observeCorners = (): void => {
    for (const selector of cornerSelectors) {
      const node = document.querySelector(selector);
      if (node) observer.observe(node);
    }
  };
  const syncNow = (): void => {
    queueMicrotask(() => {
      if (mute) {
        queueMicrotask(syncMapChrome);
        scheduleSync();
        return;
      }
      syncMapChrome();
    });
  };
  const footerContent = new MutationObserver(syncNow);
  const footerStyle = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target === document.body || record.target === document.documentElement) continue;
      if (!(record.target instanceof HTMLElement) || record.target.id !== 'status-banner') continue;
      syncNow();
      return;
    }
  });
  const watchFooter = (node: Element): void => {
    footerContent.observe(node, { childList: true, subtree: true, characterData: true });
    footerStyle.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
  };
  const footerIn = (node: Element): Element | null => node.matches('#status-banner') ? node : node.querySelector('#status-banner');
  const cornerArrivals = new MutationObserver((records) => {
    let footer: Element | null = null;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (cornerSelectors.some((selector) => node.matches(selector) || node.querySelector(selector) !== null)) {
          observeCorners();
          footer = footerIn(node) ?? footer;
        }
      }
    }
    if (footer) {
      watchFooter(footer);
      syncNow();
    }
  });
  const mutations = new MutationObserver(() => {
    // Let slot writes release mute, then settle derived classes before another input.
    queueMicrotask(syncMapChrome);
    scheduleSync();
  });
  const map = document.getElementById('map');
  let controlsWatched = false;
  let watchMap: MutationObserver | null = null;
  if (map) {
    watchMap = new MutationObserver(() => {
      scheduleSync();
      if (controlsWatched) return;
      const controls = map.querySelector('.maplibregl-control-container');
      if (!controls) return;
      controlsWatched = true;
      watchMap?.observe(controls, { childList: true, subtree: true });
    });
  }
  const owned: { disconnect(): void }[] = [observer, footerContent, footerStyle, cornerArrivals, mutations];
  if (watchMap) owned.push(watchMap);
  const publish = (count: number): void => {
    (window as Window & { __opdCornerObservers?: number }).__opdCornerObservers = count;
  };
  let connected = false;
  const connect = (): void => {
    if (connected) return;
    connected = true;
    chromeLive = true;
    observer.observe(document.documentElement);
    observer.observe(probe);
    observeCorners();
    cornerArrivals.observe(document.body, { childList: true, subtree: true });
    mutations.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const banner = document.getElementById('status-banner');
    if (banner) {
      mutations.observe(banner, { childList: true, subtree: true });
      watchFooter(banner);
    }
    const legend = document.getElementById('map-legend-toggle');
    if (legend) mutations.observe(legend, { attributes: true, attributeFilter: ['aria-expanded'] });
    const pane = document.getElementById('map-pane');
    if (pane) mutations.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    if (map && watchMap) {
      controlsWatched = false;
      watchMap.observe(map, { childList: true });
      const controls = map.querySelector('.maplibregl-control-container');
      if (controls) {
        controlsWatched = true;
        watchMap.observe(controls, { childList: true, subtree: true });
      }
    }
    window.addEventListener('resize', syncMapChrome);
    window.addEventListener('orientationchange', syncMapChrome);
    screen.orientation?.addEventListener('change', syncMapChrome);
    window.visualViewport?.addEventListener('resize', syncMapChrome);
    publish(owned.length);
    syncMapChrome();
  };
  const release = (): void => {
    if (!connected) return;
    connected = false;
    chromeLive = false;
    for (const item of owned) item.disconnect();
    window.removeEventListener('resize', syncMapChrome);
    window.removeEventListener('orientationchange', syncMapChrome);
    screen.orientation?.removeEventListener('change', syncMapChrome);
    window.visualViewport?.removeEventListener('resize', syncMapChrome);
    publish(0);
  };
  const onShow = (event: PageTransitionEvent): void => {
    if (event.persisted) connect();
  };
  window.addEventListener('pagehide', release);
  window.addEventListener('pageshow', onShow);
  (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome = syncMapChrome;
  connect();
  return () => {
    release();
    window.removeEventListener('pagehide', release);
    window.removeEventListener('pageshow', onShow);
  };
}
