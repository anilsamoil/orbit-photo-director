export type Box = { x: number; y: number; w: number; h: number };

export type ChromeMeasure = {
  viewport: { w: number; h: number };
  map?: Box;
  insets: { top: number; right: number; bottom: number; left: number };
  zoom: Box;
  compass: Box;
  show: Box;
  showButtons: Box[];
  sliderChip: Box;
  timeStrip?: Box;
  slider: Box;
  timeButtons: Box[];
  footer: Box;
  shotList: Box;
  scrollbar: number;
  pip: Box | null;
  hide: Box;
  legendButton: Box;
  legendPanel: Box;
  legendContentHeight?: number;
  legendRowHeight?: number;
  legendOpen: boolean;
  legendNaturalBottom: number;
  dockCorridor: number;
  dock?: Box;
  launchBrief?: Box;
  picker?: Box;
  chromeHidden: boolean;
};

export type Slot = { x: number; y: number; w: number; h: number };

export type DockSlot = Slot & { axis: 'row' | 'column' };

export type ChromeSlots = {
  time: Slot | null;
  dock: DockSlot | null;
  legend: Slot | null;
  launch?: Slot | null;
  picker?: Slot | null;
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
export const TIME_LINE_WIDTH = 480;
const TIME_COMPACT_WIDTH = TARGET * 6 + 2 * 5 + 4;
const TIME_STACK_WIDTH = TARGET * 5 + 4 * 4 + 4;
const DROP_CORE_WIDTH = 182;
const DROP_CORE_HEIGHT = 232;
const SHORT_MAP_HEIGHT = 560;
const LAUNCH_MIN = 64;
const LAUNCH_W = 512;
const PICKER_W = 288;
const PICKER_MIN_W = 180;
const PICKER_MIN_H = 64;

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
  const candidate = (height: number): Box => {
    const y = cornerTop - GAP - height;
    const minWidth = height === TARGET ? TIME_COMPACT_WIDTH : TIME_STACK_WIDTH;
    const left = width < minWidth && lane && y >= bottomOf(lane) + GAP ? measure.insets.left + EDGE : x;
    return { x: left, y, w: rightEdge - left, h: height };
  };
  const fits = (box: Box) => box.y >= raisedY - 0.5 && !blockers.some((obstacle) => meets(box, obstacle));
  const bandAfter = (box: Box) => box.y - GAP - raisedY;
  const tall = candidate(TIME_STACK);
  const line = candidate(TARGET);
  const map = measure.map;
  const dropCore = present(map) && map.h <= SHORT_MAP_HEIGHT ? {
    x: map.x + (map.w - Math.min(DROP_CORE_WIDTH, map.w)) / 2,
    y: map.y + (map.h - Math.min(DROP_CORE_HEIGHT, map.h)) / 2,
    w: Math.min(DROP_CORE_WIDTH, map.w),
    h: Math.min(DROP_CORE_HEIGHT, map.h),
  } : null;
  const needsStack = width < TIME_LINE_WIDTH;
  const stackedOk = tall.w >= TIME_STACK_WIDTH && fits(tall) && (needsStack || !meets(tall, dropCore)) && (!measure.legendOpen || bandAfter(tall) >= Math.max(MIN_LEGEND, measure.legendRowHeight ?? 0));
  let chosen = stackedOk ? tall : fits(line) ? line : { x, y: raisedY, w: width, h: TARGET };
  const side = [measure.hide, measure.legendButton, measure.footer, measure.shotList].filter(present);
  if (chosen.h === TARGET && shrinkClear(chosen, side).w < TIME_COMPACT_WIDTH) {
    const afterShow = Math.max(measure.insets.left + EDGE, ...[measure.show, ...measure.showButtons].filter(present).map(rightOf)) + GAP;
    const options = [
      { x: afterShow, y: measure.map?.y ?? measure.show.y, w: rightEdge - afterShow, h: TARGET },
      { x: measure.insets.left + EDGE, y: Math.max(raisedY, lane ? bottomOf(lane) + GAP : raisedY), w: rightEdge - measure.insets.left - EDGE, h: TARGET },
      { x: measure.insets.left + EDGE, y: Math.max(raisedY, ...side.filter((box) => box !== measure.footer && box !== measure.shotList).map(bottomOf)) + SEPARATION, w: rightEdge - measure.insets.left - EDGE, h: TARGET },
    ];
    const obstacles = [...blockers, ...side, measure.zoom, measure.compass].filter(present);
    for (const option of options) {
      const clear = shrinkClear(option, obstacles);
      if (clear.w >= TIME_COMPACT_WIDTH && clear.y >= measure.insets.top && bottomOf(clear) <= floorY(measure) - 2 && !obstacles.some((box) => meets(clear, box))) {
        chosen = clear;
        break;
      }
    }
  }
  const cleared = shrinkClear(chosen, side);
  return slot(cleared.x, cleared.y, Math.max(TARGET, cleared.w), chosen.h);
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

function legendSlot(measure: ChromeMeasure, lane: Box | null, y: number, h: number, panelRight: number): Slot | null {
  const minX = (lane && y < bottomOf(lane) + GAP ? rightOf(lane) : measure.insets.left) + GAP;
  const cap = Math.min(panelRight, measure.viewport.w - measure.insets.right - EDGE);
  const width = Math.min(LEGEND_W, Math.max(0, cap - minX));
  if (width < TARGET * 2 || h < 1) return null;
  const x = Math.max(minX, cap - width);
  const low = Math.floor(Math.min(y + h, floorY(measure) - GAP) * 100) / 100;
  const contentHeight = measure.legendContentHeight && measure.legendContentHeight > 0 ? measure.legendContentHeight : h;
  const top = Math.max(snap(y), snap(low - contentHeight));
  const height = Math.max(0, Math.floor((low - top) * 100) / 100);
  if (height < 1) return null;
  return { x: snap(x), y: top, w: snap(width), h: height };
}

function placeNarrowLegend(measure: ChromeMeasure, lane: Box | null, time: Slot, dock: DockSlot): Slot | null {
  if (!measure.legendOpen) return null;
  const minimum = Math.max(TARGET, measure.legendRowHeight ?? 0);
  const naturalTop = showBottom(measure) + SEPARATION;
  const reserveLaunch = present(measure.launchBrief) && time.y - GAP - naturalTop >= LAUNCH_MIN + GAP + MIN_LEGEND;
  const bandTop = naturalTop + (reserveLaunch ? LAUNCH_MIN + GAP : 0);
  const bandH = Math.min(time.y - GAP, nearestTop([measure.legendButton, measure.hide], floorY(measure)) - SEPARATION) - bandTop;
  const buttonRight = present(measure.legendButton)
    ? rightOf(measure.legendButton)
    : measure.viewport.w - measure.insets.right - EDGE;
  const clearOfDock = (y: number, h: number, panelRight: number) => (
    y < bottomOf(dock) - 0.5 && y + h > dock.y + 0.5 ? Math.min(panelRight, dock.x - GAP) : panelRight
  );
  if (bandH >= minimum) {
    const above = legendSlot(measure, lane, bandTop, bandH, clearOfDock(bandTop, bandH, buttonRight));
    if (above) return above;
  }
  const controlTop = nearestTop([measure.legendButton, measure.hide], floorY(measure));
  const belowTop = Math.max(bottomOf(time), bottomOf(dock)) + GAP;
  const aboveH = controlTop - GAP - belowTop;
  if (aboveH >= minimum) {
    const between = legendSlot(measure, lane, belowTop, aboveH, clearOfDock(belowTop, aboveH, buttonRight));
    if (between) return between;
  }
  const belowCorners = [measure.hide, measure.legendButton].filter(present).every((box) => belowTop >= bottomOf(box) + GAP);
  let panelRight = !belowCorners && present(measure.legendButton) ? measure.legendButton.x - GAP : buttonRight;
  if (!belowCorners && present(measure.hide)) panelRight = Math.min(panelRight, measure.hide.x - GAP);
  const room = Math.max(0, floorY(measure) - GAP - belowTop);
  return legendSlot(measure, lane, belowTop, room, clearOfDock(belowTop, room, panelRight));
}

function placeWideDock(measure: ChromeMeasure, lane: Box | null, legend: Slot | null): DockSlot | null {
  if (!(measure.dockCorridor > 0 && measure.dockCorridor < TARGET)) return null;
  const gutter = cross(measure.scrollbar);
  const x = (lane ? rightOf(lane) : measure.insets.left) + GAP;
  const span = measure.viewport.w - measure.insets.right - RIGHT_MARGIN - x;
  const obstacles = [
    measure.pip,
    measure.hide,
    measure.legendButton,
    measure.legendOpen ? legend ?? measure.legendPanel : null,
    measure.footer,
    measure.shotList,
    measure.zoom,
    measure.compass,
    measure.show,
    measure.slider,
    measure.sliderChip,
    ...measure.showButtons,
    ...measure.timeButtons,
  ].filter(present);
  const clusterTop = nearestTop(
    [measure.hide, measure.legendButton, measure.footer, measure.shotList, measure.slider, measure.sliderChip, ...measure.timeButtons],
    measure.viewport.h - measure.insets.bottom,
  );
  const candidates = [clusterTop - GAP - gutter, ...obstacles.map((box) => bottomOf(box) + GAP)];
  const seen = new Set<number>();
  for (const raw of candidates) {
    const y = snap(raw);
    if (seen.has(y)) continue;
    seen.add(y);
    if (y < measure.insets.top - 0.5) continue;
    if (y + gutter > measure.viewport.h - measure.insets.bottom + 0.5) continue;
    const cleared = shrinkClear({ x, y, w: span, h: gutter }, obstacles);
    const row = { x, y, w: cleared.w, h: gutter };
    if (row.w >= TARGET && !obstacles.some((box) => meets(row, box))) {
      return { ...slot(x, y, row.w, gutter), axis: 'row' };
    }
  }
  return null;
}

function placeShortWideTime(measure: ChromeMeasure): Slot | null {
  if (measure.viewport.h > 520 || !present(measure.show)) return null;
  const x = Math.max(...[measure.show, ...measure.showButtons].filter(present).map(rightOf)) + GAP;
  const row = shrinkClear({
    x,
    y: measure.show.y + SEPARATION,
    w: measure.viewport.w - measure.insets.right - RIGHT_MARGIN - x,
    h: TARGET,
  }, [measure.dock, measure.pip].filter(present));
  return row.w >= 300 ? slot(row.x, row.y, row.w, row.h) : null;
}

function placeWideLegend(measure: ChromeMeasure, time: Slot | null = null): Slot | null {
  if (!measure.legendOpen || !present(measure.legendButton)) return null;
  const x = rightOf(measure.legendButton) - LEGEND_W;
  if (time) {
    const height = measure.legendContentHeight ?? (present(measure.legendPanel) ? measure.legendPanel.h : 88);
    const natural = { x, y: measure.legendNaturalBottom - height, w: LEGEND_W, h: height };
    if (!meets(natural, { ...time, y: time.y - SEPARATION, h: time.h + SEPARATION * 2 })) return null;
    const y = bottomOf(time) + SEPARATION;
    return slot(x, y, LEGEND_W, Math.min(height, floorY(measure) - GAP - y, measure.legendButton.y - SEPARATION - y));
  }
  if (present(measure.timeStrip)) {
    const height = measure.legendContentHeight ?? measure.legendPanel.h;
    const pip = measure.pip;
    const top = Math.max(measure.map?.y ?? measure.insets.top, present(pip) && pip.x < x + LEGEND_W && rightOf(pip) > x ? bottomOf(pip) + GAP : measure.insets.top);
    const natural = { x, y: Math.max(top, measure.legendNaturalBottom - height), w: LEGEND_W, h: Math.min(height, measure.legendNaturalBottom - top) };
    if (meets(natural, measure.timeStrip)) {
      const bottom = Math.min(measure.legendNaturalBottom, measure.timeStrip.y - SEPARATION);
      const y = Math.max(top, bottom - height);
      if (bottom > y) return slot(x, y, LEGEND_W, bottom - y);
    }
  }
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

function placeLaunch(measure: ChromeMeasure, lane: Box | null, slots: ChromeSlots): Slot | null {
  const left = (lane ? rightOf(lane) : measure.insets.left) + GAP;
  const right = measure.viewport.w - measure.insets.right - EDGE;
  const top = Math.max(measure.insets.top, showBottom(measure) + SEPARATION);
  const time = (slots.time ? [slots.time] : [measure.sliderChip, measure.slider, ...measure.timeButtons])
    .filter((box) => present(box) && bottomOf(box) > top);
  const bottom = nearestTop([measure.footer, measure.shotList], measure.viewport.h - measure.insets.bottom) - GAP;
  const obstacles = [
    ...time,
    slots.dock ?? measure.dock,
    measure.legendOpen ? slots.legend ?? measure.legendPanel : null,
    measure.pip,
    measure.hide,
    measure.legendButton,
  ].filter(present);
  const tops = [top, ...obstacles.map((box) => bottomOf(box) + GAP)].filter((y) => y >= top && y <= bottom - LAUNCH_MIN);
  const bottoms = [bottom, ...obstacles.map((box) => box.y - GAP)].filter((y) => y <= bottom && y >= top + LAUNCH_MIN);
  let best: Slot | null = null;
  const consider = (x: number, y: number, far: number, low: number) => {
    const width = Math.min(LAUNCH_W, far - x);
    if (width < LAUNCH_MIN || low - y < LAUNCH_MIN) return;
    const candidate = slot(x, y, width, low - y);
    const useful = candidate.w >= 180;
    const bestUseful = best !== null && best.w >= 180;
    if (!best || (useful && !bestUseful) || (useful === bestUseful && candidate.w * candidate.h > best.w * best.h)) best = candidate;
  };
  for (const y of tops) for (const low of bottoms) {
    if (low - y < LAUNCH_MIN) continue;
    const blocked = obstacles.filter((box) => y < bottomOf(box) + GAP && low > box.y - GAP)
      .sort((a, b) => a.x - b.x);
    let x = left;
    for (const box of blocked) {
      consider(x, y, Math.min(right, box.x - GAP), low);
      x = Math.max(x, rightOf(box) + GAP);
    }
    consider(x, y, right, low);
  }
  return best;
}

function placePicker(measure: ChromeMeasure, slots: ChromeSlots): Slot | null {
  if (!present(measure.picker)) return null;
  const left = measure.insets.left + EDGE;
  const right = measure.viewport.w - measure.insets.right - EDGE;
  const top = Math.max(measure.insets.top, measure.map?.y ?? showBottom(measure));
  const bottom = floorY(measure) - GAP;
  const obstacles = [
    measure.show, ...measure.showButtons, measure.zoom, measure.compass,
    ...(slots.time ? [slots.time] : [measure.sliderChip, measure.slider, ...measure.timeButtons]),
    slots.dock ?? measure.dock,
    measure.legendOpen ? slots.legend ?? measure.legendPanel : null,
    slots.launch ?? measure.launchBrief, measure.pip, measure.hide, measure.legendButton,
  ].filter(present);
  const tops = [top, ...obstacles.map((box) => bottomOf(box) + GAP)].filter((y) => y >= top && y < bottom);
  const bottoms = [bottom, ...obstacles.map((box) => box.y - GAP)].filter((y) => y <= bottom && y > top);
  let best: Slot | null = null;
  const consider = (x: number, y: number, far: number, low: number) => {
    const width = Math.min(PICKER_W, far - x);
    const height = low - y;
    if (width < PICKER_MIN_W || height < PICKER_MIN_H) return;
    const candidate = slot(far - width, y, width, height);
    if (!best || candidate.w * candidate.h > best.w * best.h) best = candidate;
  };
  for (const y of tops) for (const low of bottoms) {
    if (low - y < PICKER_MIN_H) continue;
    const blocked = obstacles.filter((box) => y < bottomOf(box) + GAP && low > box.y - GAP)
      .sort((a, b) => a.x - b.x);
    let x = left;
    for (const box of blocked) {
      consider(x, y, Math.min(right, box.x - GAP), low);
      x = Math.max(x, rightOf(box) + GAP);
    }
    consider(x, y, right, low);
  }
  return best;
}

function withPanels(measure: ChromeMeasure, lane: Box | null, slots: ChromeSlots): ChromeSlots {
  const launch = present(measure.launchBrief) ? { ...slots, launch: placeLaunch(measure, lane, slots) } : slots;
  return present(measure.picker) ? { ...launch, picker: placePicker(measure, launch) } : launch;
}

export function solveChromeSlots(measure: ChromeMeasure): ChromeSlots {
  if (measure.chromeHidden || !(measure.viewport.w > 0) || !(measure.viewport.h > 0)) {
    return { time: null, dock: null, legend: null };
  }
  const lane = laneOf(measure.zoom, measure.compass);
  if (measure.viewport.w > NARROW_MAX) {
    const time = placeShortWideTime(measure);
    const legendHeight = measure.legendContentHeight ?? measure.legendPanel.h;
    const effective = time ? {
      ...measure,
      sliderChip: time,
      slider: time,
      timeButtons: [time],
      legendPanel: { ...measure.legendPanel, y: measure.legendNaturalBottom - legendHeight, h: legendHeight },
    } : measure;
    const legend = placeWideLegend(effective, time);
    return withPanels(effective, lane, { time, dock: placeWideDock(effective, lane, legend), legend });
  }
  const time = placeNarrowTime(measure, lane);
  const dock = placeNarrowDock(measure, lane, time);
  return withPanels(measure, lane, { time, dock, legend: placeNarrowLegend(measure, lane, time, dock) });
}
