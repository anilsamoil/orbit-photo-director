export type Box = { x: number; y: number; w: number; h: number };

export type ChromeMeasure = {
  viewport: { w: number; h: number };
  insets: { top: number; right: number; bottom: number; left: number };
  zoom: Box;
  compass: Box;
  show: Box;
  showButtons: Box[];
  sliderChip: Box;
  slider: Box;
  timeButtons: Box[];
  footer: Box;
  shotList: Box;
  scrollbar: number;
  pip: Box | null;
  hide: Box;
  legendButton: Box;
  legendPanel: Box;
  legendOpen: boolean;
  legendNaturalBottom: number;
  dockCorridor: number;
  chromeHidden: boolean;
};

export type Slot = { x: number; y: number; w: number; h: number };

export type DockSlot = Slot & { axis: 'row' | 'column' };

export type ChromeSlots = {
  time: Slot | null;
  dock: DockSlot | null;
  legend: Slot | null;
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
  return TARGET + Math.max(0, scrollbar);
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

function floorY(measure: ChromeMeasure): number {
  return nearestTop(
    [measure.footer, measure.shotList],
    measure.viewport.h - measure.insets.bottom,
  );
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
  const rightEdge = measure.viewport.w - measure.insets.right - RIGHT_MARGIN;
  const width = Math.max(0, rightEdge - x);
  const raisedY = showBottom(measure) + SEPARATION;
  const cornerTop = nearestTop([measure.hide, measure.legendButton], floorY(measure));
  const blockers = [measure.show, ...measure.showButtons, measure.footer, measure.shotList].filter(present);
  const candidate = (height: number): Box => ({ x, y: cornerTop - GAP - height, w: width, h: height });
  const fits = (box: Box) => box.y >= raisedY - 0.5 && !blockers.some((obstacle) => meets(box, obstacle));
  const bandAfter = (box: Box) => box.y - GAP - raisedY;
  const tall = candidate(TIME_STACK);
  const line = candidate(TARGET);
  const stackedOk = fits(tall) && (!measure.legendOpen || bandAfter(tall) >= MIN_LEGEND);
  const chosen = stackedOk ? tall : fits(line) ? line : { x, y: raisedY, w: width, h: TARGET };
  const side = [measure.hide, measure.legendButton, measure.footer, measure.shotList].filter(present);
  const cleared = shrinkClear(chosen, side);
  return slot(cleared.x, cleared.y, Math.max(TARGET, cleared.w), TARGET);
}

function placeNarrowDock(measure: ChromeMeasure, lane: Box | null, time: Slot): DockSlot {
  const gutter = cross(measure.scrollbar);
  const minX = (lane ? rightOf(lane) : measure.insets.left) + GAP;
  const columnBottom = nearestTop([time, measure.hide, measure.legendButton, measure.footer, measure.shotList], floorY(measure)) - GAP;
  const columnTop = Math.max(measure.insets.top, present(measure.show) ? measure.show.y : measure.insets.top);
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

function placeNarrowLegend(measure: ChromeMeasure, lane: Box | null, time: Slot, dock: DockSlot): Slot | null {
  if (!measure.legendOpen) return null;
  const minX = (lane ? rightOf(lane) : measure.insets.left) + GAP;
  const bandTop = showBottom(measure) + SEPARATION;
  const bandH = time.y - GAP - bandTop;
  const stackedTop = Math.max(bottomOf(time), bottomOf(dock)) + GAP;
  const stackedH = floorY(measure) - GAP - stackedTop;
  const useBand = bandH >= MIN_LEGEND;
  const y = useBand ? bandTop : stackedTop;
  const h = useBand ? bandH : stackedH;
  if (h < 1) return null;
  const buttonRight = present(measure.legendButton)
    ? rightOf(measure.legendButton)
    : measure.viewport.w - measure.insets.right - EDGE;
  let panelRight = buttonRight;
  if (!useBand && y < bottomOf(dock) - 0.5 && y + h > dock.y + 0.5) {
    panelRight = Math.min(panelRight, dock.x - GAP);
  }
  const cap = Math.min(panelRight, measure.viewport.w - measure.insets.right - EDGE);
  const width = Math.min(LEGEND_W, Math.max(0, cap - minX));
  const x = Math.max(minX, cap - width);
  const top = snap(y);
  const low = Math.floor(Math.min(y + h, floorY(measure) - GAP) * 100) / 100;
  return { x: snap(Math.max(minX, x)), y: top, w: snap(width), h: Math.max(0, Math.floor((low - top) * 100) / 100) };
}

function placeWideDock(measure: ChromeMeasure, lane: Box | null): DockSlot | null {
  if (!(measure.dockCorridor > 0 && measure.dockCorridor < TARGET)) return null;
  const gutter = cross(measure.scrollbar);
  const x = (lane ? rightOf(lane) : measure.insets.left) + GAP;
  const anchors = [measure.show, measure.zoom, measure.compass].filter(present).map(bottomOf);
  let y = (anchors.length ? Math.max(...anchors) : measure.insets.top) + GAP;
  const obstacles = [
    measure.pip,
    measure.hide,
    measure.legendButton,
    measure.footer,
    measure.shotList,
    measure.zoom,
    measure.compass,
    ...measure.timeButtons,
  ].filter(present);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const span = measure.viewport.w - measure.insets.right - RIGHT_MARGIN - x;
    const cleared = shrinkClear({ x, y, w: span, h: gutter }, obstacles);
    if (cleared.w >= TARGET && !obstacles.some((box) => meets(cleared, box))) {
      return { ...slot(x, y, cleared.w, gutter), axis: 'row' };
    }
    const hits = obstacles.filter((box) => meets({ x, y, w: Math.max(span, TARGET), h: gutter }, box));
    if (!hits.length) break;
    y = Math.max(...hits.map(bottomOf)) + GAP;
  }
  const span = measure.viewport.w - measure.insets.right - RIGHT_MARGIN - x;
  return { ...slot(x, y, Math.max(TARGET, span), gutter), axis: 'row' };
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
  return slot(x, top - SEPARATION - height, LEGEND_W, height);
}

export function solveChromeSlots(measure: ChromeMeasure): ChromeSlots {
  if (measure.chromeHidden || !(measure.viewport.w > 0) || !(measure.viewport.h > 0)) {
    return { time: null, dock: null, legend: null };
  }
  const lane = laneOf(measure.zoom, measure.compass);
  if (measure.viewport.w > NARROW_MAX) {
    return { time: null, dock: placeWideDock(measure, lane), legend: placeWideLegend(measure) };
  }
  const time = placeNarrowTime(measure, lane);
  const dock = placeNarrowDock(measure, lane, time);
  return { time, dock, legend: placeNarrowLegend(measure, lane, time, dock) };
}
