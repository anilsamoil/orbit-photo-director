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
  timeReadout?: Box;
  timeStrip?: Box;
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
  legendFocus?: boolean;
  zoomScroll?: boolean;
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
const MIN_LEGEND_W = 120;
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

function ownShell(measure: ChromeMeasure): ChromeMeasure & { zoomScroll: boolean } {
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
  const show = slot(
    paneLeft(measure) + EDGE,
    topbar + 5,
    Math.min(paneRight(measure) - paneLeft(measure) - EDGE * 2, present(measure.show) && measure.show.w >= TARGET ? measure.show.w : 180),
    present(measure.show) && measure.show.h >= 32 ? measure.show.h : 52,
  );
  const zoomY = Math.max(topbar + (measure.viewport.h <= 520 ? 62 : 71), bottomOf(show) + SEPARATION);
  const corridor = floor - GAP - zoomY;
  const zoomScroll = corridor >= TARGET && corridor < TARGET * 3;
  const zoom = slot(paneLeft(measure) + EDGE, zoomY, TARGET, corridor < TARGET ? 0 : zoomScroll ? corridor : TARGET * 2);
  const compass = corridor < TARGET * 3 ? slot(0, 0, 0, 0) : slot(zoom.x, bottomOf(zoom), TARGET, TARGET);
  return { ...measure, topbar, footer, hide, legendButton, zoom, compass, show, zoomScroll };
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

function fitLegend(measure: ChromeMeasure, obstacles: Array<Box | null | undefined>, top = paneTop(measure) + GAP, bottom = floorY(measure) - GAP): Slot | null {
  const left = paneLeft(measure) + EDGE;
  const right = paneRight(measure) - EDGE;
  const preferredX = Math.max(left, rightOf(measure.legendButton) - LEGEND_W);
  const preferredBottom = measure.legendButton.y - SEPARATION;
  const intrinsic = present(measure.legendPanel) ? measure.legendPanel.h : 88;
  const blocks = obstacles.filter(present);
  const starts = [preferredX, left, ...blocks.map((box) => rightOf(box) + GAP)];
  const ends = [right, rightOf(measure.legendButton), ...blocks.map((box) => box.x - GAP)];
  let best: Slot | null = null;
  let bestDistance = Infinity;
  for (const start of starts) {
    for (const end of ends) {
      const far = Math.min(right, end);
      const x = Math.max(left, start, far - LEGEND_W);
      const width = far - x;
      if (width < MIN_LEGEND_W) continue;
      const intervals = blocks.filter((box) => box.x < far && rightOf(box) > x)
        .map((box): [number, number] => [Math.max(top, box.y - SEPARATION), Math.min(bottom, bottomOf(box) + SEPARATION)])
        .filter(([lo, hi]) => hi > lo).sort((a, b) => a[0] - b[0]);
      let low = top;
      for (const [lo, hi] of [...intervals, [bottom, bottom] as const]) {
        const height = Math.min(intrinsic, lo - low);
        if (height >= MIN_LEGEND) {
          const y = Math.max(low, Math.min(lo - height, preferredBottom - height));
          const candidate = slot(x, y, width, Math.floor(height * 100) / 100);
          const distance = Math.abs(x - preferredX) + Math.abs(bottomOf(candidate) - preferredBottom);
          const area = candidate.w * candidate.h;
          if (!best || area > best.w * best.h + 0.5 || (Math.abs(area - best.w * best.h) <= 0.5 && distance < bestDistance)) {
            best = candidate;
            bestDistance = distance;
          }
        }
        low = Math.max(low, hi);
      }
    }
  }
  return best;
}

function timePaint(measure: ChromeMeasure, time: Slot): Box[] {
  const parts = [measure.timeReadout, measure.sliderChip, measure.slider, ...measure.timeButtons].filter(present);
  const old = measure.timeStrip;
  if (!present(old)) return parts;
  return parts.map((box) => {
    if (time.h > 52) return slot(time.x + box.x - old.x, time.y + box.y - old.y, box.w, box.h);
    const x = Math.max(box.x, old.x);
    const y = Math.max(box.y, old.y);
    const right = Math.min(rightOf(box), rightOf(old));
    const bottom = Math.min(bottomOf(box), bottomOf(old));
    return slot(time.x + x - old.x, time.y + y - old.y,
      Math.min(right - x, time.w - (x - old.x)), Math.min(bottom - y, time.h - (y - old.y)));
  }).filter(present);
}

function legendObstacles(measure: ChromeMeasure, time: Slot, dock: DockSlot): Array<Box | null | undefined> {
  return [
    measure.pip,
    time, ...timePaint(measure, time),
    measure.footer, measure.shotList, measure.hide, measure.legendButton,
    measure.show, measure.zoom, measure.compass, dock,
  ];
}

function focusedLegend(measure: ChromeMeasure): ChromeSlots {
  const y = paneTop(measure) + GAP;
  const hide = { ...measure.hide, y };
  const legendButton = { ...measure.legendButton, y };
  const time = slot(paneLeft(measure) + EDGE, floorY(measure) - SEPARATION - TARGET,
    paneRight(measure) - paneLeft(measure) - EDGE * 2, TARGET);
  const legend = fitLegend({ ...measure, hide, legendButton }, [measure.pip, time, hide, legendButton, measure.footer, measure.shotList],
    bottomOf(legendButton) + SEPARATION, time.y - SEPARATION);
  return { ...emptySlots(), legendFocus: true, hide, legendButton, legend, time, footer: measure.footer };
}

export function solveChromeSlots(measure: ChromeMeasure): ChromeSlots {
  if (!(measure.viewport.w > 0) || !(measure.viewport.h > 0)) return emptySlots();
  const owned = ownShell(measure);
  if (measure.chromeHidden) return { ...emptySlots(), hide: owned.hide, footer: owned.footer };
  const lane = laneOf(owned.zoom, owned.compass);
  const wide = owned.viewport.w > NARROW_MAX;
  let time = wide ? placeWideTime(owned) : placeNarrowTime(owned, lane);
  const withLegend = { ...owned, launch: null, legendPanel: { x: 0, y: 0, w: 0, h: 0 } };
  let dock = wide
    ? (placeWideDock(withLegend, lane) ?? placeWideColumn(withLegend))
    : placeNarrowDock(owned, lane, time);
  let legend = owned.legendOpen ? fitLegend(owned, legendObstacles(owned, time, dock)) : null;
  if (!wide && owned.legendOpen && !legend) {
    const left = (lane ? rightOf(lane) : paneLeft(owned)) + GAP;
    const right = paneRight(owned) - EDGE;
    const panelWidth = Math.min(LEGEND_W, right - left - GAP - TARGET);
    if (panelWidth >= MIN_LEGEND_W) {
      const x = left + panelWidth + GAP;
      const sideTime = slot(x, time.y, right - x, TARGET);
      const sideDock = placeNarrowDock(owned, lane, sideTime);
      const sideLegend = fitLegend(owned, legendObstacles(owned, sideTime, sideDock));
      if (sideLegend) {
        time = sideTime;
        dock = sideDock;
        legend = sideLegend;
      }
    }
  }
  if (owned.legendOpen && !legend) return focusedLegend(owned);
  return {
    zoom: present(owned.zoom) ? owned.zoom : null,
    compass: present(owned.compass) ? owned.compass : null,
    zoomScroll: owned.zoomScroll,
    show: owned.show,
    time,
    dock,
    legendButton: owned.legendButton,
    legend,
    hide: owned.hide,
    footer: owned.footer,
    launch: placeLaunch(owned, time, dock, legend),
  };
}
