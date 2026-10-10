export function layoutMapNavigation(pane: HTMLElement): void {
  const map = pane.querySelector<HTMLElement>('#map');
  const toolbar = pane.querySelector<HTMLElement>('.map-toolbar');
  const navigation = map?.querySelector<HTMLElement>('.maplibregl-ctrl-top-left .maplibregl-ctrl-group');
  const time = pane.querySelector<HTMLElement>('.map-command .map-controls-time');
  if (!map || !toolbar || !navigation || !time) return;
  const mapBox = map.getBoundingClientRect();
  const toolbarBox = toolbar.getBoundingClientRect();
  const navigationBox = navigation.getBoundingClientRect();
  if (!mapBox.height || !toolbarBox.height || !navigationBox.height) return;
  const gap = Number.parseFloat(getComputedStyle(pane).getPropertyValue('--map-nav-toolbar-gap')) || 14;
  const top = toolbarBox.bottom + gap;
  const previousShift = Number.parseFloat(pane.style.getPropertyValue('--map-nav-shift')) || 0;
  const left = navigationBox.left - previousShift;
  const buttons = [...navigation.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
  if (buttons.length === 0) return;
  const column = { width: Math.max(...buttons.map((box) => box.width)), height: buttons.reduce((sum, box) => sum + box.height, 0), row: false };
  const row = { width: buttons.reduce((sum, box) => sum + box.width, 0), height: Math.max(...buttons.map((box) => box.height)), row: true };
  const obstacles = [...pane.querySelectorAll<HTMLElement>('.map-toolbar, .map-control-dock, .map-controls-time, .map-controls-time *, .map-legend-toggle, .map-legend-panel, .map-chrome-toggle, #map-inspector, .maplibregl-popup')]
    .map((element) => element.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0);
  type Place = { x: number; y: number; width: number; height: number; row: boolean };
  const clear = (place: Place): boolean => place.x >= mapBox.left && place.y >= mapBox.top
    && place.x + place.width <= mapBox.right && place.y + place.height <= mapBox.bottom
    && obstacles.every((box) => place.x >= box.right || place.x + place.width <= box.left
      || place.y >= box.bottom || place.y + place.height <= box.top);
  let place = [column, row].map((size) => ({ ...size, x: left, y: top })).find(clear);
  for (const clearance of [8, 0]) {
    if (place) break;
    const candidates: Place[] = [];
    for (const size of [column, row]) {
      const xs = new Set([left, ...obstacles.flatMap((box) => [box.right + clearance, box.left - size.width - clearance])]);
      const ys = new Set([top, mapBox.top + clearance, ...obstacles.flatMap((box) => [box.bottom + clearance, box.top - size.height - clearance])]);
      for (const x of xs) for (const y of ys) {
        const candidate = { ...size, x, y };
        if (clear(candidate)) candidates.push(candidate);
      }
    }
    candidates.sort((a, b) => Math.hypot(a.x - left, a.y - top) - Math.hypot(b.x - left, b.y - top));
    place = candidates[0];
  }
  if (!place) return;
  pane.dataset.mapNavigation = place.row ? 'row' : 'column';
  pane.style.setProperty('--map-nav-top', `${place.y - mapBox.top}px`);
  pane.style.setProperty('--map-nav-shift', `${place.x - left}px`);
}

export function bindMapNavigationLayout(pane: HTMLElement): () => void {
  const update = () => layoutMapNavigation(pane);
  const resize = new ResizeObserver(update);
  for (const element of [pane, ...pane.querySelectorAll('#map, .map-toolbar, .map-controls-time, .map-controls-time *, .map-control-dock, .map-legend-panel, .map-legend-toggle, .map-chrome-toggle')]) resize.observe(element);
  const state = new MutationObserver(update);
  state.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  state.observe(pane, { attributes: true, attributeFilter: ['class'] });
  if (pane.parentElement) state.observe(pane.parentElement, { attributes: true, attributeFilter: ['class'] });
  const ready = new MutationObserver(() => {
    const navigation = pane.querySelector('.maplibregl-ctrl-top-left .maplibregl-ctrl-group');
    if (!navigation) return;
    resize.observe(navigation);
    ready.disconnect();
    update();
  });
  ready.observe(pane, { childList: true, subtree: true });
  const navigation = pane.querySelector('.maplibregl-ctrl-top-left .maplibregl-ctrl-group');
  if (navigation) {
    resize.observe(navigation);
    ready.disconnect();
  }
  update();
  return () => {
    resize.disconnect();
    state.disconnect();
    ready.disconnect();
  };
}
