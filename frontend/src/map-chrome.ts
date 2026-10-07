const STORAGE_KEY = 'opd-map-chrome';
const toolbarPaintSlackPx = 8;
const rowSeparationPx = 4;
const minTargetPx = 44;
const minLegendBandPx = 32;

export function mapChromeReflowChoice(input: {
  narrow: boolean;
  chromeHidden: boolean;
  pane: number;
  toolbarClear: number;
  stripAnchor: number;
  topbar: number;
  legendOpen: boolean;
  reflowCorner: number;
  centersStolen: boolean;
}): { reflow: boolean; dockRow: boolean } {
  if (!input.narrow || input.chromeHidden || !(input.pane > 0) || !(input.toolbarClear > 0)) {
    return { reflow: false, dockRow: false };
  }
  const stackRoom = input.pane - input.toolbarClear - input.stripAnchor;
  const timeBlock = Math.min(120, Math.max(minTargetPx, stackRoom - 60));
  const legendBand = stackRoom - timeBlock - 12;
  const dockWindow = input.pane - input.topbar - input.stripAnchor - timeBlock - 16;
  const stripTop = input.pane - input.stripAnchor - timeBlock;
  const toolbarBottom = input.toolbarClear - toolbarPaintSlackPx;
  const reflow = input.centersStolen
    || stripTop < toolbarBottom + rowSeparationPx
    || dockWindow < minTargetPx
    || (input.legendOpen && legendBand < minLegendBandPx);
  if (!reflow) return { reflow: false, dockRow: false };
  const dockTop = input.toolbarClear + rowSeparationPx + minTargetPx + 8;
  const hideTop = input.pane - input.reflowCorner - minTargetPx;
  const dockMax = hideTop - 8 - dockTop;
  return { reflow: true, dockRow: dockMax < minTargetPx };
}

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

function timeCentersStolen(): boolean {
  for (const node of document.querySelectorAll('.map-command .time-step-btn')) {
    if (!(node instanceof HTMLElement)) continue;
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || (hit !== node && !node.contains(hit))) return true;
  }
  return false;
}

let ignoreChromeMutation = false;

function syncMapChromeReflow(): void {
  if (ignoreChromeMutation) return;
  ignoreChromeMutation = true;
  try {
    syncMapChromeReflowNow();
  } finally {
    queueMicrotask(() => {
      ignoreChromeMutation = false;
    });
  }
}

function syncMapChromeReflowNow(): void {
  const view = document.querySelector('.view-map');
  if (!(view instanceof HTMLElement)) {
    document.body.classList.remove('map-chrome-reflow', 'map-dock-row');
    return;
  }
  const style = getComputedStyle(view);
  const read = (name: string) => lengthPx(view, style.getPropertyValue(name).trim() || '0px');
  const banner = document.querySelector('#status-banner .banner-actions');
  const reflowCorner = banner
    ? lengthPx(view, 'max(36px, calc(7.75rem + env(safe-area-inset-bottom, 0px) - var(--map-shotlist-block) + 4px))')
    : read('--map-corner-bottom');
  const narrow = window.matchMedia('(max-width: 719px)').matches;
  const chromeHidden = document.body.classList.contains('map-chrome-hidden');
  const legendOpen = document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true';
  document.body.classList.remove('map-chrome-reflow', 'map-dock-row');
  const centersStolen = narrow && !chromeHidden && timeCentersStolen();
  const choice = mapChromeReflowChoice({
    narrow,
    chromeHidden,
    pane: read('--map-pane-budget'),
    toolbarClear: read('--map-toolbar-clear'),
    stripAnchor: read('--map-strip-anchor'),
    topbar: read('--topbar-height'),
    legendOpen,
    reflowCorner,
    centersStolen,
  });
  document.body.classList.toggle('map-chrome-reflow', choice.reflow);
  document.body.classList.toggle('map-dock-row', choice.dockRow);
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
    syncMapChromeReflow();
  });
  document.getElementById('map-legend-toggle')?.addEventListener('click', () => {
    queueMicrotask(syncMapChromeReflow);
  });
  const observer = new ResizeObserver(() => syncMapChromeReflow());
  observer.observe(document.documentElement);
  const mutations = new MutationObserver(() => syncMapChromeReflow());
  mutations.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const banner = document.getElementById('status-banner');
  if (banner) mutations.observe(banner, { childList: true, subtree: true });
  const legend = document.getElementById('map-legend-toggle');
  if (legend) mutations.observe(legend, { attributes: true, attributeFilter: ['aria-expanded'] });
  window.addEventListener('resize', syncMapChromeReflow);
  (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome = syncMapChromeReflow;
  syncMapChromeReflow();
}
