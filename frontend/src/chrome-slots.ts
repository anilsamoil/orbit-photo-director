export type Box = { x: number; y: number; w: number; h: number };

export type ChromeMeasure = {
  viewport: { w: number; h: number };
  pane?: Box;
  insets: { top: number; right: number; bottom: number; left: number };
  topbar: number;
  zoom: Box;
  compass: Box;
  show: Box;
  showButtons: Box[];
  sliderChip: Box;
  slider: Box;
  timeButtons: Box[];
  footer: Box;
  shotList: Box;
  launch: Box | null;
  scrollbar: number;
  pip: Box | null;
  hide: Box;
  legendButton: Box;
  legendPanel: Box;
  legendOpen: boolean;
  legendNaturalBottom: number;
  dockCorridor: number;
  chromeHidden: boolean;
  timeNeed: number;
};

export type Slot = { x: number; y: number; w: number; h: number };

export type DockSlot = Slot & { axis: 'row' | 'column' };

export type ChromeSlots = {
  zoom: Slot | null;
  compass: Slot | null;
  show: Slot | null;
  time: Slot | null;
  dock: DockSlot | null;
  legendButton: Slot | null;
  legend: Slot | null;
  hide: Slot | null;
  footer: Slot | null;
  launch: Slot | null;
};

const TARGET = 44;
const GAP = 8;
const SEPARATION = 4;
const NARROW_MAX = 719;
const LEGEND_W = 176;
const RIGHT_MARGIN = 20;
const EDGE = 8;
const MIN_LEGEND = 32;
const TIME_STACK = 96;

function present(box: Box | null | undefined): box is Box {
  return !!box && box.w >= 1 && box.h >= 1;
}

function rightOf(box: Box): number {
  return box.x + box.w;
}

function bottomOf(box: Box): number {
  return box.y + box.h;
}

function meets(a: Box, b: Box | null | undefined): boolean {
  if (!present(a) || !present(b)) return false;
  return a.x < rightOf(b) - 0.5 && rightOf(a) > b.x + 0.5 && a.y < bottomOf(b) - 0.5 && bottomOf(a) > b.y + 0.5;
}

function snap(n: number): number {
  return Math.round(n * 100) / 100;
}

function slot(x: number, y: number, w: number, h: number): Slot {
  return { x: snap(x), y: snap(y), w: snap(Math.max(0, w)), h: snap(Math.max(0, h)) };
}

function cross(scrollbar: number): number {
  return TARGET + Math.max(16, scrollbar);
}

function laneOf(zoom: Box, compass: Box): Box | null {
  const parts = [zoom, compass].filter(present);
  if (!parts.length) return null;
  const x = Math.min(...parts.map((box) => box.x));
  const y = Math.min(...parts.map((box) => box.y));
  const far = Math.max(...parts.map(rightOf));
  const low = Math.max(...parts.map(bottomOf));
  return { x, y, w: far - x, h: low - y };
}

function nearestTop(boxes: Array<Box | null | undefined>, fallback: number): number {
  const tops = boxes.filter(present).map((box) => box.y);
  return tops.length ? Math.min(...tops) : fallback;
}

function showBottom(measure: ChromeMeasure): number {
  const lows = [measure.show, ...measure.showButtons].filter(present).map(bottomOf);
  return lows.length ? Math.max(...lows) : measure.insets.top;
}

function paneBottom(measure: ChromeMeasure): number {
  return Math.min(measure.viewport.h - measure.insets.bottom, present(measure.pane) ? bottomOf(measure.pane) : measure.viewport.h);
}

function paneLeft(measure: ChromeMeasure): number {
  return Math.max(measure.insets.left, present(measure.pane) ? measure.pane.x : 0);
}

function paneRight(measure: ChromeMeasure): number {
  return Math.min(measure.viewport.w - measure.insets.right, present(measure.pane) ? rightOf(measure.pane) : measure.viewport.w);
}

function paneTop(measure: ChromeMeasure): number {
  return Math.max(measure.insets.top, measure.topbar, present(measure.pane) ? measure.pane.y : 0);
}

function floorY(measure: ChromeMeasure): number {
  return Math.min(paneBottom(measure), nearestTop(
    [measure.footer, measure.shotList],
    paneBottom(measure),
  ));
}

function shrinkClear(draft: Box, obstacles: Box[]): Box {
  let limit = rightOf(draft);
  const x = draft.x;
  for (const obstacle of obstacles) {
    if (!meets({ ...draft, w: limit - x }, obstacle)) continue;
    if (obstacle.x > x + 1) limit = Math.min(limit, obstacle.x - GAP);
  }
  return { ...draft, w: Math.max(0, limit - x) };
}

function placeNarrowTime(measure: ChromeMeasure, lane: Box | null): Slot {
  const laneRight = lane ? rightOf(lane) : measure.insets.left + EDGE;
  const x = laneRight + GAP;
  const rightEdge = paneRight(measure) - RIGHT_MARGIN;
  const width = Math.max(0, rightEdge - x);
  const raisedY = showBottom(measure) + SEPARATION;
  const cornerTop = nearestTop([measure.hide, measure.legendButton], floorY(measure));
  const blockers = [measure.show, ...measure.showButtons, measure.footer, measure.shotList].filter(present);
  const candidate = (height: number): Box => ({ x, y: cornerTop - GAP - height, w: width, h: height });
  const fits = (box: Box) => box.y >= raisedY - 0.5 && !blockers.some((obstacle) => meets(box, obstacle));
  const bandAfter = (box: Box) => box.y - GAP - raisedY;
  const stack = measure.timeNeed > TIME_STACK ? measure.timeNeed : TIME_STACK;
  const tall = candidate(stack);
  const line = candidate(TARGET);
  const stackedOk = fits(tall) && (!measure.legendOpen || bandAfter(tall) >= MIN_LEGEND);
  const chosen = stackedOk ? tall : fits(line) ? line : { x, y: raisedY, w: width, h: TARGET };
  const side = [measure.hide, measure.legendButton, measure.footer, measure.shotList].filter(present);
  const cleared = shrinkClear(chosen, side);
  return slot(cleared.x, cleared.y, Math.max(TARGET, cleared.w), chosen.h);
}

function placeNarrowDock(measure: ChromeMeasure, lane: Box | null, time: Slot): DockSlot {
  const gutter = cross(measure.scrollbar);
  const minX = (lane ? rightOf(lane) : measure.insets.left) + GAP;
  const columnBottom = nearestTop([time, measure.hide, measure.legendButton, measure.footer, measure.shotList], floorY(measure)) - GAP;
  const columnTop = Math.max(paneTop(measure), present(measure.show) ? measure.show.y : paneTop(measure));
  const columnH = columnBottom - columnTop;
  const columnX = measure.viewport.w - measure.insets.right - EDGE - gutter;
  if (columnH >= TARGET && columnX >= minX - 0.5) {
    return { ...slot(columnX, columnTop, gutter, columnH), axis: 'column' };
  }
  const y = bottomOf(time) + GAP;
  const draft = shrinkClear(
    { x: minX, y, w: measure.viewport.w - measure.insets.right - RIGHT_MARGIN - minX, h: gutter },
    [measure.hide, measure.legendButton, measure.footer, measure.shotList, measure.zoom, measure.compass, ...(measure.pip ? [measure.pip] : [])].filter(present),
  );
  return { ...slot(minX, y, Math.max(TARGET, draft.w), gutter), axis: 'row' };
}

function legendSlot(measure: ChromeMeasure, lane: Box | null, y: number, h: number, panelRight: number): Slot | null {
  const minX = (lane ? rightOf(lane) : measure.insets.left) + GAP;
  const cap = Math.min(panelRight, paneRight(measure) - EDGE);
  const width = Math.min(LEGEND_W, Math.max(0, cap - minX));
  if (width < 1 || h < 1) return null;
  const x = Math.max(minX, cap - width);
  const top = snap(y);
  const intrinsicH = present(measure.legendPanel) ? measure.legendPanel.h : h;
  const low = Math.floor(Math.min(y + h, y + intrinsicH, floorY(measure) - GAP) * 100) / 100;
  const height = Math.max(0, Math.floor((low - top) * 100) / 100);
  if (height < 1) return null;
  return { x: snap(x), y: top, w: snap(width), h: height };
}

function placeNarrowLegend(measure: ChromeMeasure, lane: Box | null, time: Slot, dock: DockSlot): Slot | null {
  if (!measure.legendOpen) return null;
  const bandTop = showBottom(measure) + SEPARATION;
  const bandH = time.y - GAP - bandTop;
  const buttonRight = present(measure.legendButton)
    ? rightOf(measure.legendButton)
    : measure.viewport.w - measure.insets.right - EDGE;
  const clearOfDock = (y: number, h: number, panelRight: number) => (
    y < bottomOf(dock) - 0.5 && y + h > dock.y + 0.5 ? Math.min(panelRight, dock.x - GAP) : panelRight
  );
  if (bandH >= MIN_LEGEND) {
    return legendSlot(measure, lane, bandTop, bandH, clearOfDock(bandTop, bandH, buttonRight));
  }
  const controlTop = nearestTop([measure.legendButton, measure.hide], floorY(measure));
  const belowTop = Math.max(bottomOf(time), bottomOf(dock)) + GAP;
  const aboveH = controlTop - GAP - belowTop;
  if (aboveH >= MIN_LEGEND) {
    return legendSlot(measure, lane, belowTop, aboveH, clearOfDock(belowTop, aboveH, buttonRight));
  }
  let panelRight = present(measure.legendButton) ? measure.legendButton.x - GAP : buttonRight;
  if (present(measure.hide)) panelRight = Math.min(panelRight, measure.hide.x - GAP);
  const room = Math.max(0, floorY(measure) - GAP - belowTop);
  return legendSlot(measure, lane, belowTop, room, clearOfDock(belowTop, room, panelRight));
}

function placeWideDock(measure: ChromeMeasure, lane: Box | null): DockSlot | null {
  if (!(measure.dockCorridor > 0 && measure.dockCorridor < TARGET)) return null;
  const gutter = cross(measure.scrollbar);
  const x = (lane ? rightOf(lane) : measure.insets.left) + GAP;
  const span = measure.viewport.w - measure.insets.right - RIGHT_MARGIN - x;
  const obstacles = [
    measure.pip,
    measure.hide,
    measure.legendButton,
    measure.legendPanel,
    measure.footer,
    measure.shotList,
    measure.launch,
    measure.zoom,
    measure.compass,
    measure.show,
    measure.slider,
    measure.sliderChip,
    ...measure.showButtons,
    ...measure.timeButtons,
  ].filter(present);
  const clusterTop = nearestTop(
    [measure.hide, measure.legendButton, measure.legendPanel, measure.footer, measure.shotList, measure.launch, measure.slider, measure.sliderChip, ...measure.timeButtons],
    measure.viewport.h - measure.insets.bottom,
  );
  const candidates = [clusterTop - GAP - gutter, ...obstacles.map((box) => bottomOf(box) + GAP)];
  const seen = new Set<number>();
  for (const raw of candidates) {
    const y = snap(raw);
    if (seen.has(y)) continue;
    seen.add(y);
    if (y < paneTop(measure) - 0.5) continue;
    if (y + gutter > paneBottom(measure) + 0.5) continue;
    const cleared = shrinkClear({ x, y, w: span, h: gutter }, obstacles);
    const row = { x, y, w: cleared.w, h: gutter };
    if (row.w >= TARGET && !obstacles.some((box) => meets(row, box))) {
      return { ...slot(x, y, row.w, gutter), axis: 'row' };
    }
  }
  return null;
}

function placeWideLegend(measure: ChromeMeasure): Slot | null {
  if (!measure.legendOpen || !present(measure.legendButton)) return null;
  const x = rightOf(measure.legendButton) - LEGEND_W;
  const offenders = measure.timeButtons.filter((box) => (
    present(box)
    && box.x < x + LEGEND_W - 0.5
    && rightOf(box) > x + 0.5
    && measure.legendNaturalBottom > box.y + 0.5
  ));
  if (!offenders.length) return null;
  const top = Math.min(...offenders.map((box) => box.y));
  const height = present(measure.legendPanel) ? measure.legendPanel.h : 88;
  return boundedWidePanel(measure, x, top - SEPARATION, height);
}

const HIDE_W = 88;
const LEGEND_BTN_W = 88;

function emptySlots(): ChromeSlots {
  return {
    zoom: null,
    compass: null,
    show: null,
    time: null,
    dock: null,
    legendButton: null,
    legend: null,
    hide: null,
    footer: null,
    launch: null,
  };
}

function wideCommandHeight(measure: ChromeMeasure): number {
  if (measure.viewport.w >= 800 && measure.viewport.h >= 600) return 96 + measure.insets.bottom;
  if (measure.viewport.h <= 520 && measure.viewport.w >= 720) return 52;
  if (measure.viewport.w <= 800) return 140;
  return 64;
}

function ownShell(measure: ChromeMeasure): ChromeMeasure {
  const topbar = Math.max(measure.topbar > 0 ? measure.topbar : 48, present(measure.pane) ? measure.pane.y : 0);
  const footerH = present(measure.footer) ? measure.footer.h : 36;
  const footer = slot(
    measure.insets.left,
    measure.viewport.h - measure.insets.bottom - footerH,
    Math.max(0, measure.viewport.w - measure.insets.left - measure.insets.right),
    footerH,
  );
  const floor = Math.min(paneBottom(measure), present(measure.shotList) ? Math.min(footer.y, measure.shotList.y) : footer.y);
  const hide = slot(paneRight(measure) - 12 - HIDE_W, floor - GAP - TARGET, HIDE_W, TARGET);
  const legendButton = slot(hide.x - GAP - LEGEND_BTN_W, hide.y, LEGEND_BTN_W, TARGET);
  const zoomY = topbar + (measure.viewport.h <= 520 ? 62 : 71);
  let zoom = slot(paneLeft(measure) + EDGE, zoomY, TARGET, 88);
  let compass = slot(zoom.x, bottomOf(zoom), TARGET, TARGET);
  const compassLimit = floor - GAP;
  if (bottomOf(compass) > compassLimit) {
    const shift = bottomOf(compass) - compassLimit;
    zoom = slot(zoom.x, zoom.y - shift, zoom.w, zoom.h);
    compass = slot(compass.x, compass.y - shift, compass.w, compass.h);
  }
  const show = slot(
    paneLeft(measure) + EDGE,
    topbar + 5,
    Math.min(paneRight(measure) - paneLeft(measure) - EDGE * 2, present(measure.show) && measure.show.w >= TARGET ? measure.show.w : 180),
    present(measure.show) && measure.show.h >= 32 ? measure.show.h : 52,
  );
  return { ...measure, topbar, footer, hide, legendButton, zoom, compass, show };
}

function placeWideTime(measure: ChromeMeasure): Slot {
  const x = paneLeft(measure) + EDGE;
  const right = present(measure.legendButton)
    ? measure.legendButton.x - GAP
    : measure.viewport.w - measure.insets.right - 204;
  const height = wideCommandHeight(measure);
  const floor = floorY(measure);
  let y = Math.min(measure.viewport.h - height, floor - height);
  const raised = showBottom(measure) + SEPARATION;
  if (y < raised) y = raised;
  return slot(x, y, Math.max(TARGET, right - x), height);
}

function placeWideColumn(measure: ChromeMeasure): DockSlot {
  const gutter = cross(measure.scrollbar);
  const x = paneRight(measure) - EDGE - gutter;
  const y = measure.pip ? bottomOf(measure.pip) + 12 : (present(measure.show) ? measure.show.y : measure.insets.top + EDGE);
  const stops = [measure.hide, measure.legendButton, measure.legendPanel, measure.footer, measure.shotList].filter(present);
  const limit = Math.min(floorY(measure), stops.length ? Math.min(...stops.map((box) => box.y)) : floorY(measure));
  const height = Math.max(TARGET, Math.min(measure.dockCorridor >= TARGET ? measure.dockCorridor : limit - y - GAP, limit - y - GAP));
  return { ...slot(x, y, gutter, height), axis: 'column' };
}

function placeLaunch(measure: ChromeMeasure, time: Slot | null, dock: DockSlot | null, legend: Slot | null): Slot | null {
  if (!present(measure.launch) || !time) return null;
  const x = Math.max(paneLeft(measure) + EDGE, rightOf(measure.zoom) + GAP);
  const y = Math.max(paneTop(measure) + GAP, showBottom(measure) + GAP);
  const height = Math.max(0, Math.min(time.y - GAP, floorY(measure) - GAP) - y);
  if (height < TARGET) return null;
  const obstacles = [dock, legend, measure.pip].filter(present);
  const draft = shrinkClear({ x, y, w: Math.min(512, paneRight(measure) - EDGE - x), h: height }, obstacles);
  if (draft.w < TARGET || obstacles.some((obstacle) => meets(draft, obstacle))) return null;
  return slot(draft.x, draft.y, draft.w, draft.h);
}

function boundedWidePanel(measure: ChromeMeasure, x: number, bottom: number, intrinsicH: number): Slot | null {
  const top = paneTop(measure) + GAP;
  const low = Math.min(bottom, floorY(measure) - GAP);
  const h = Math.min(intrinsicH, Math.max(0, low - top));
  if (h < 1) return null;
  const left = Math.max(paneLeft(measure) + EDGE, x);
  return slot(left, low - h, Math.min(LEGEND_W, paneRight(measure) - EDGE - left), h);
}

function widePanel(measure: ChromeMeasure): Slot | null {
  const lifted = placeWideLegend(measure);
  if (lifted) return lifted;
  if (!measure.legendOpen || !present(measure.legendButton)) return null;
  const height = present(measure.legendPanel) ? measure.legendPanel.h : 88;
  return boundedWidePanel(measure, rightOf(measure.legendButton) - LEGEND_W, measure.legendButton.y - SEPARATION, height);
}

function missLegend(dock: DockSlot, legend: Slot | null): DockSlot {
  if (!legend || !meets(dock, legend)) return dock;
  if (dock.axis === 'column' && legend.y > dock.y + TARGET) {
    return { ...dock, h: snap(legend.y - GAP - dock.y) };
  }
  const cleared = shrinkClear(dock, [legend]);
  if (cleared.w >= TARGET && !meets({ ...dock, w: cleared.w }, legend)) {
    return { ...dock, w: snap(cleared.w) };
  }
  return dock;
}

export function solveChromeSlots(measure: ChromeMeasure): ChromeSlots {
  if (!(measure.viewport.w > 0) || !(measure.viewport.h > 0)) return emptySlots();
  const owned = ownShell(measure);
  if (measure.chromeHidden) return { ...emptySlots(), hide: owned.hide, footer: owned.footer };
  const lane = laneOf(owned.zoom, owned.compass);
  const wide = owned.viewport.w > NARROW_MAX;
  const time = wide ? placeWideTime(owned) : placeNarrowTime(owned, lane);
  const legend = wide ? widePanel(owned) : null;
  const launch = placeLaunch(owned, time, null, legend);
  const withLegend = { ...owned, launch, legendPanel: legend ?? { x: 0, y: 0, w: 0, h: 0 } };
  const dock = wide
    ? (placeWideDock(withLegend, lane) ?? placeWideColumn(withLegend))
    : placeNarrowDock(owned, lane, time);
  const narrowLegend = wide ? legend : placeNarrowLegend(owned, lane, time, dock);
  return {
    zoom: owned.zoom,
    compass: owned.compass,
    show: owned.show,
    time,
    dock: missLegend(dock, narrowLegend),
    legendButton: owned.legendButton,
    legend: narrowLegend,
    hide: owned.hide,
    footer: owned.footer,
    launch: placeLaunch(owned, time, dock, narrowLegend),
  };
}
