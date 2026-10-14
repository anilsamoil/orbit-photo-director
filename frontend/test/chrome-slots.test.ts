import { describe, expect, it } from 'vitest';
import { solveChromeSlots, type Box, type ChromeMeasure, type Slot } from '../src/chrome-slots';

const empty: Box = { x: 0, y: 0, w: 0, h: 0 };

function measure(over: Partial<ChromeMeasure>): ChromeMeasure {
  return {
    viewport: { w: 800, h: 600 },
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    zoom: empty,
    compass: empty,
    show: empty,
    showButtons: [],
    sliderChip: empty,
    slider: empty,
    timeButtons: [],
    footer: empty,
    shotList: empty,
    scrollbar: 0,
    pip: null,
    hide: empty,
    legendButton: empty,
    legendPanel: empty,
    legendOpen: false,
    legendNaturalBottom: 0,
    dockCorridor: 0,
    chromeHidden: false,
    ...over,
  };
}

function rightOf(box: Slot | Box): number {
  return box.x + box.w;
}

function bottomOf(box: Slot | Box): number {
  return box.y + box.h;
}

function meets(a: Slot | Box, b: Slot | Box): boolean {
  return a.w >= 1 && b.w >= 1 && a.h >= 1 && b.h >= 1
    && a.x < rightOf(b) - 0.5 && rightOf(a) > b.x + 0.5
    && a.y < bottomOf(b) - 0.5 && bottomOf(a) > b.y + 0.5;
}

describe('chrome slots', () => {
  it('returns the same slots for the same painted boxes', () => {
    const input = measure({
      viewport: { w: 430, h: 400 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      zoom: { x: 55, y: 134, w: 44, h: 88 },
      compass: { x: 55, y: 222, w: 44, h: 44 },
      show: { x: 55, y: 77, w: 180, h: 52 },
      hide: { x: 330, y: 250, w: 88, h: 44 },
      legendButton: { x: 234, y: 250, w: 88, h: 44 },
      scrollbar: 6,
    });
    expect(solveChromeSlots(input)).toEqual(solveChromeSlots(input));
  });

  it('keeps the 430x400 dock out of the zoom lane', () => {
    const zoomOut: Box = { x: 55, y: 178, w: 44, h: 44 };
    const compass: Box = { x: 55, y: 222, w: 44, h: 44 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 430, h: 400 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      zoom: { x: 55, y: 134, w: 44, h: 88 },
      compass,
      show: { x: 55, y: 77, w: 180, h: 52 },
      showButtons: [{ x: 143.8, y: 81, w: 63.61, h: 44 }],
      hide: { x: 330, y: 198, w: 88, h: 44 },
      legendButton: { x: 234, y: 198, w: 88, h: 44 },
      footer: { x: 0, y: 293.4, w: 430, h: 72.6 },
      scrollbar: 6,
      legendOpen: false,
    }));
    expect(slots.dock).not.toBeNull();
    expect(slots.time).not.toBeNull();
    if (!slots.dock || !slots.time) return;
    expect(slots.dock.x).toBeGreaterThanOrEqual(55 + 44 + 8);
    expect(slots.dock.axis === 'row' ? slots.dock.h : slots.dock.w).toBeGreaterThanOrEqual(44 + 6);
    expect(meets(slots.dock, zoomOut)).toBe(false);
    expect(meets(slots.dock, compass)).toBe(false);
    expect(meets(slots.time, { x: 143.8, y: 81, w: 63.61, h: 44 })).toBe(false);
    expect(slots.time.y).toBeGreaterThanOrEqual(81 + 44 + 4);
    expect(slots.time.h).toBe(44);
  });

  it('places the 719 time slot below Show', () => {
    for (const height of [400, 521]) {
      const launches: Box = { x: 143.8, y: 81, w: 63.61, h: 44 };
      const slots = solveChromeSlots(measure({
        viewport: { w: 719, h: height },
        insets: { top: 24, right: 0, bottom: 34, left: 47 },
        zoom: { x: 55, y: 134, w: 44, h: 44 },
        compass: { x: 55, y: 178, w: 44, h: 44 },
        show: { x: 8, y: 77, w: 203.41, h: 52 },
        showButtons: [launches],
        sliderChip: { x: 115, y: 108.41, w: 588, h: 81.59 },
        slider: { x: 153.67, y: 102.41, w: 416.66, h: 44 },
        hide: { x: 619, y: height - 80, w: 88, h: 44 },
        legendButton: { x: 523, y: height - 80, w: 88, h: 44 },
        scrollbar: 6,
      }));
      expect(slots.time).not.toBeNull();
      if (!slots.time) continue;
      expect(slots.time.y).toBeGreaterThanOrEqual(bottomOf(launches) + 4);
      expect(meets(slots.time, launches)).toBe(false);
      expect(slots.time.h).toBeGreaterThanOrEqual(44);
      expect(slots.time.x).toBeGreaterThanOrEqual(55 + 44 + 8);
    }
  });

  it.each([
    { top: 0, bottom: 0, left: 0, mapTop: 60, cornerTop: 441 },
    { top: 24, bottom: 34, left: 47, mapTop: 84, cornerTop: 407 },
  ])('uses a compact 719px time row when stacking covers the drop core: bottom=$bottom', ({ top, bottom, left, mapTop, cornerTop }) => {
    const input = measure({
      viewport: { w: 719, h: 521 },
      map: { x: 0, y: mapTop, w: 719, h: 521 - mapTop },
      insets: { top, right: 0, bottom, left },
      zoom: { x: left + 8, y: mapTop + 70, w: 44, h: 88 },
      compass: { x: left + 8, y: mapTop + 158, w: 44, h: 44 },
      show: { x: left + 8, y: mapTop + 8, w: 203, h: 52 },
      hide: { x: 619, y: cornerTop, w: 88, h: 44 },
      legendButton: { x: 523, y: cornerTop, w: 88, h: 44 },
    });
    const time = solveChromeSlots(input).time!;
    expect(time.h).toBe(44);
    expect(time.y).toBe(cornerTop - 8 - 44);
    expect(time.y).toBeGreaterThan(mapTop + (521 - mapTop) / 2 + (bottom ? 5 : 91));
  });

  it('retains the tall portrait time stack when its footer brings it near the map center', () => {
    const time = solveChromeSlots(measure({
      viewport: { w: 402, h: 874 },
      map: { x: 0, y: 84, w: 402, h: 790 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      zoom: { x: 55, y: 154, w: 44, h: 88 },
      compass: { x: 55, y: 242, w: 44, h: 44 },
      show: { x: 55, y: 92, w: 203, h: 52 },
      hide: { x: 302, y: 672, w: 88, h: 44 },
      legendButton: { x: 206, y: 672, w: 88, h: 44 },
    })).time;
    expect(time).toEqual({ x: 107, y: 568, w: 275, h: 96 });
  });

  it('leaves the wide time strip alone and lifts a legend panel off T+90', () => {
    const t90: Box = { x: 440.609, y: 378.422, w: 59.36, h: 49.578 };
    const hide: Box = { x: 620, y: 388, w: 88, h: 44 };
    const legendButton: Box = { x: 524, y: 388, w: 88, h: 44 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 720, h: 500 },
      hide,
      legendButton,
      legendOpen: true,
      legendPanel: { x: 436, y: 314.422, w: 176, h: 69.578 },
      legendNaturalBottom: 384,
      timeButtons: [t90],
      dockCorridor: 120,
      scrollbar: 6,
    }));
    expect(slots.time).toBeNull();
    expect(slots.dock).toBeNull();
    expect(slots.legend).not.toBeNull();
    if (!slots.legend) return;
    expect(bottomOf(slots.legend)).toBeLessThanOrEqual(t90.y - 4);
    expect(meets(slots.legend, t90)).toBe(false);
    expect(slots.legend.w).toBe(176);
    expect(rightOf(slots.legend)).toBeCloseTo(rightOf(legendButton), 1);
    expect(hide).toEqual({ x: 620, y: 388, w: 88, h: 44 });
  });

  it('gives an 800x600 dock a 44px cross axis clear of the preview and the time strip', () => {
    const pip: Box = { x: 566, y: 89, w: 222, h: 144 };
    const hide: Box = { x: 700, y: 312, w: 88, h: 44 };
    const zoom: Box = { x: 8, y: 239, w: 44, h: 88 };
    const slider: Box = { x: 46.66, y: 403.2, w: 175.92, h: 32 };
    const t90: Box = { x: 537.02, y: 398, w: 50.98, h: 44 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 800, h: 600 },
      insets: { top: 24, right: 0, bottom: 20, left: 47 },
      zoom,
      compass: { x: 8, y: 327, w: 44, h: 44 },
      show: { x: 8, y: 89, w: 203.38, h: 52 },
      pip,
      hide,
      legendButton: { x: 604, y: 312, w: 88, h: 44 },
      slider,
      sliderChip: { x: 8, y: 384, w: 588, h: 116 },
      timeButtons: [t90],
      dockCorridor: 43,
      scrollbar: 6,
    }));
    expect(slots.time).toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.dock) return;
    expect(slots.dock.axis).toBe('row');
    expect(slots.dock.h).toBeGreaterThanOrEqual(44 + 6);
    expect(slots.dock.x).toBeGreaterThanOrEqual(rightOf(zoom) + 8);
    expect(bottomOf(slots.dock)).toBeLessThanOrEqual(hide.y - 8);
    expect(meets(slots.dock, pip)).toBe(false);
    expect(meets(slots.dock, hide)).toBe(false);
    expect(meets(slots.dock, zoom)).toBe(false);
    expect(meets(slots.dock, slider)).toBe(false);
    expect(meets(slots.dock, t90)).toBe(false);
  });

  it.each([
    { bottom: 20, bannerHeight: 72.5625 },
    { bottom: 34, bannerHeight: 72.5625 },
    { bottom: 20, bannerHeight: 88.15625 },
    { bottom: 34, bannerHeight: 88.15625 },
  ])('keeps the inset-shifted dock clear of open Legend at bottom $bottom with banner height $bannerHeight', ({ bottom, bannerHeight }) => {
    const cornerTop = 352 - bottom * 2;
    const panel: Box = { x: 516, y: 241, w: 176, h: cornerTop - 245 };
    const hide: Box = { x: 700, y: cornerTop, w: 88, h: 44 };
    const slots = solveChromeSlots(measure({
      insets: { top: 24, right: 0, bottom, left: 47 },
      zoom: { x: 55, y: 239, w: 44, h: 88 },
      compass: { x: 55, y: 327, w: 44, h: 44 },
      show: { x: 8, y: 89, w: 203.40625, h: 52 },
      pip: { x: 566, y: 89, w: 222, h: 144 },
      hide,
      legendButton: { x: 604, y: cornerTop, w: 88, h: 44 },
      legendPanel: panel,
      legendOpen: true,
      legendNaturalBottom: cornerTop - 4,
      sliderChip: { x: 63, y: 438 - bottom * 2, w: 525, h: 44 },
      footer: { x: 0, y: 600 - bottom - bannerHeight, w: 800, h: bannerHeight },
      shotList: { x: 0, y: 535.8125 - bottom, w: 800, h: 64.1875 + bottom },
      dockCorridor: 43,
      scrollbar: 8,
    }));
    expect(slots.legend).toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.dock) return;
    expect(slots.dock.x).toBe(107);
    expect(slots.dock.w).toBeGreaterThanOrEqual(44);
    expect(slots.dock.h).toBe(52);
    expect(bottomOf(slots.dock)).toBeLessThanOrEqual(hide.y - 8);
    expect(meets(slots.dock, panel)).toBe(false);
  });

  it('allocates the wide dock against the resolved Legend position, not its previous paint', () => {
    const panel: Box = { x: 516, y: 241, w: 176, h: 67 };
    const input = measure({
      insets: { top: 24, right: 0, bottom: 20, left: 47 },
      zoom: { x: 55, y: 239, w: 44, h: 88 },
      compass: { x: 55, y: 327, w: 44, h: 44 },
      show: { x: 8, y: 89, w: 203.40625, h: 52 },
      hide: { x: 700, y: 312, w: 88, h: 44 },
      legendButton: { x: 604, y: 312, w: 88, h: 44 },
      legendPanel: panel,
      legendOpen: true,
      legendNaturalBottom: 308,
      timeButtons: [{ x: 544, y: 230, w: 44, h: 44 }],
      dockCorridor: 43,
      scrollbar: 8,
    });
    const slots = solveChromeSlots(input);
    expect(slots.legend).not.toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.legend || !slots.dock) return;
    expect(bottomOf(slots.legend)).toBe(226);
    expect(meets(slots.dock, slots.legend)).toBe(false);
    expect(solveChromeSlots({ ...input, legendPanel: slots.legend })).toEqual(slots);
  });

  it('keeps a short wide dock at 874x402 clear of zoom and the footer', () => {
    const zoom: Box = { x: 8, y: 70, w: 44, h: 88 };
    const footer: Box = { x: 0, y: 360, w: 874, h: 42 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 874, h: 402 },
      zoom,
      compass: { x: 8, y: 158, w: 44, h: 44 },
      show: { x: 8, y: 53, w: 220, h: 52 },
      footer,
      hide: { x: 774, y: 310, w: 88, h: 44 },
      legendButton: { x: 678, y: 310, w: 88, h: 44 },
      dockCorridor: 30,
      scrollbar: 6,
    }));
    expect(slots.time).not.toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.dock || !slots.time) return;
    expect(slots.time.h).toBe(44);
    expect(meets(slots.time, zoom)).toBe(false);
    expect(meets(slots.time, footer)).toBe(false);
    expect(meets(slots.time, slots.dock)).toBe(false);
    expect(slots.dock.h).toBeGreaterThanOrEqual(50);
    expect(slots.dock.x).toBeGreaterThanOrEqual(rightOf(zoom) + 8);
    expect(meets(slots.dock, zoom)).toBe(false);
    expect(meets(slots.dock, footer)).toBe(false);
  });

  it('stops an open narrow legend at the footer', () => {
    const footer: Box = { x: 0, y: 293.4375, w: 430, h: 72 };
    const zoom: Box = { x: 55, y: 134, w: 44, h: 88 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 430, h: 400 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      zoom,
      compass: { x: 55, y: 222, w: 44, h: 44 },
      show: { x: 55, y: 77, w: 180, h: 52 },
      hide: { x: 330, y: 198, w: 88, h: 44 },
      legendButton: { x: 234, y: 198, w: 88, h: 44 },
      footer,
      legendOpen: true,
      scrollbar: 6,
    }));
    expect(slots.legend).not.toBeNull();
    if (!slots.legend || !slots.time) return;
    const legendButton: Box = { x: 234, y: 198, w: 88, h: 44 };
    const hide: Box = { x: 330, y: 198, w: 88, h: 44 };
    expect(bottomOf(slots.legend)).toBeLessThanOrEqual(footer.y - 8);
    expect(meets(slots.legend, footer)).toBe(false);
    expect(meets(slots.legend, zoom)).toBe(false);
    expect(meets(slots.legend, legendButton)).toBe(false);
    expect(meets(slots.legend, hide)).toBe(false);
    expect(slots.legend.x).toBeGreaterThanOrEqual(rightOf(zoom) + 8);
    expect(slots.legend.w).toBeGreaterThan(88);
    expect(meets(slots.legend, slots.time)).toBe(false);
  });

  it('keeps a 390x520 time stack tall enough for a full-width slider', () => {
    const hide: Box = { x: 290, y: 440, w: 88, h: 44 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 390, h: 520 },
      zoom: { x: 8, y: 110, w: 44, h: 88 },
      compass: { x: 8, y: 198, w: 44, h: 44 },
      show: { x: 8, y: 53, w: 203, h: 52 },
      hide,
      legendButton: { x: 194, y: 440, w: 88, h: 44 },
      footer: { x: 0, y: 497, w: 390, h: 23 },
      legendOpen: false,
      scrollbar: 6,
    }));
    expect(slots.time).not.toBeNull();
    if (!slots.time) return;
    expect(slots.time.h).toBe(96);
    expect(bottomOf(slots.time)).toBeLessThanOrEqual(hide.y);
    expect(slots.time.w).toBeGreaterThanOrEqual(100);
    expect(meets(slots.time, hide)).toBe(false);
  });

  it('allocates the painted launch brief clear of the inset zoom lane and numeric time strip', () => {
    const zoom: Box = { x: 55, y: 134, w: 44, h: 88 };
    const compass: Box = { x: 55, y: 222, w: 44, h: 44 };
    const sliderChip: Box = { x: 63, y: 395, w: 445, h: 44 };
    const dock: Box = { x: 645.84375, y: 77, w: 66.15625, h: 290 };
    const input = measure({
      viewport: { w: 720, h: 500 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      zoom,
      compass,
      show: { x: 8, y: 77, w: 203.40625, h: 52 },
      sliderChip,
      dock,
      hide: { x: 620, y: 386, w: 88, h: 44 },
      legendButton: { x: 524, y: 386, w: 88, h: 44 },
      footer: { x: 0, y: 443.03125, w: 720, h: 22.96875 },
      launchBrief: { x: 8, y: 143, w: 512, h: 250 },
    });
    const slots = solveChromeSlots(input);
    expect(slots.launch).toBeTruthy();
    if (!slots.launch) return;
    expect(slots.launch.x).toBeGreaterThanOrEqual(107);
    expect(slots.launch.y).toBeGreaterThanOrEqual(133);
    expect(slots.launch.w).toBeGreaterThanOrEqual(180);
    expect(slots.launch.h).toBeGreaterThanOrEqual(64);
    for (const obstacle of [zoom, compass, sliderChip, dock, input.hide, input.legendButton]) {
      expect(meets(slots.launch, obstacle)).toBe(false);
    }
    expect(bottomOf(slots.launch)).toBeLessThanOrEqual(sliderChip.y - 8);
    expect(solveChromeSlots({ ...input, launchBrief: slots.launch })).toEqual(slots);
  });

  it('reserves a full launch action row before an open portrait Legend without moving time or dock', () => {
    const input = measure({
      viewport: { w: 402, h: 874 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      zoom: { x: 55, y: 175, w: 44, h: 88 },
      compass: { x: 55, y: 263, w: 44, h: 44 },
      show: { x: 55, y: 118, w: 203.40625, h: 52 },
      hide: { x: 302, y: 760, w: 88, h: 44 },
      legendButton: { x: 206, y: 760, w: 88, h: 44 },
      legendPanel: { x: 118, y: 174, w: 176, h: 474 },
      legendOpen: true,
      footer: { x: 0, y: 817.03125, w: 402, h: 22.96875 },
      scrollbar: 8,
    });
    const withoutLaunch = solveChromeSlots(input);
    const slots = solveChromeSlots({ ...input, launchBrief: { x: 8, y: 184, w: 330, h: 352 } });
    expect(slots.launch).toBeTruthy();
    expect(slots.legend).not.toBeNull();
    expect(slots.time).toEqual(withoutLaunch.time);
    expect(slots.dock).toEqual(withoutLaunch.dock);
    if (!slots.launch || !slots.legend || !slots.time || !slots.dock) return;
    expect(slots.launch.w).toBeGreaterThanOrEqual(180);
    expect(slots.launch.h).toBeGreaterThanOrEqual(64);
    for (const obstacle of [slots.legend, slots.time, slots.dock, input.zoom, input.compass]) {
      expect(meets(slots.launch, obstacle)).toBe(false);
    }
    expect(slots.legend.h).toBeGreaterThanOrEqual(32);
  });

  it('leaves unused narrow Legend space available to the pin inspector', () => {
    const input = measure({
      viewport: { w: 402, h: 874 },
      zoom: { x: 8, y: 151, w: 44, h: 88 },
      compass: { x: 8, y: 239, w: 44, h: 44 },
      show: { x: 8, y: 94, w: 203.40625, h: 52 },
      hide: { x: 302, y: 794, w: 88, h: 44 },
      legendButton: { x: 206, y: 794, w: 88, h: 44 },
      legendPanel: { x: 118, y: 150, w: 176, h: 532 },
      legendOpen: true,
      footer: { x: 0, y: 851.03125, w: 402, h: 22.96875 },
      scrollbar: 8,
    });
    const stretched = solveChromeSlots(input);
    const slots = solveChromeSlots({ ...input, legendContentHeight: 71.25 });
    expect(slots.legend).not.toBeNull();
    if (!slots.legend) return;
    expect(bottomOf(slots.legend)).toBe(bottomOf(stretched.legend!));
    expect(slots.legend.h).toBe(71.25);
    expect(slots.time).toEqual(stretched.time);
    expect(slots.dock).toEqual(stretched.dock);
  });

  it.each([200, 179.25, 163.65625])('shares the Show row with time while clearing a raised Legend button at %s', (cornerY) => {
    const input = measure({
      viewport: { w: 874, h: 402 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      zoom: { x: 55, y: 134, w: 44, h: 88 },
      compass: { x: 55, y: 222, w: 44, h: 44 },
      show: { x: 55, y: 77, w: 203.640625, h: 52 },
      sliderChip: { x: 110.625, y: 163.640625, w: 503.75, h: 44 },
      dock: { x: 799.84375, y: 77, w: 66.15625, h: 71.625 },
      dockCorridor: 71.640625,
      hide: { x: 774, y: cornerY, w: 88, h: 44 },
      legendButton: { x: 678, y: cornerY, w: 88, h: 44 },
      legendPanel: { x: 590, y: 88.375, w: 176, h: 71.265625 },
      legendContentHeight: 71.265625,
      legendNaturalBottom: cornerY - 4,
      legendOpen: true,
      footer: { x: 0, y: 215.65625, w: 874, h: 88.15625 },
      shotList: { x: 0, y: 303.8125, w: 874, h: 98.1875 },
      launchBrief: { x: 8, y: 143, w: 512, h: 201 },
    });
    const slots = solveChromeSlots(input);
    expect(slots.time).not.toBeNull();
    expect(slots.launch).toBeTruthy();
    if (!slots.time || !slots.launch) return;
    expect(slots.time.x).toBeGreaterThanOrEqual(rightOf(input.show) + 8 - 0.01);
    expect(slots.time.y).toBe(81);
    expect(slots.time.h).toBe(44);
    expect(slots.time.w).toBeGreaterThanOrEqual(300);
    expect(slots.legend).not.toBeNull();
    if (slots.legend) {
      expect(meets(slots.legend, input.legendButton)).toBe(false);
      expect(bottomOf(slots.legend)).toBeLessThanOrEqual(input.legendButton.y - 4 + 0.01);
      expect(slots.legend.h).toBeGreaterThan(0);
      expect(solveChromeSlots({ ...input, legendPanel: slots.legend })).toEqual(slots);
    }
    expect(slots.launch.w).toBeGreaterThanOrEqual(180);
    expect(slots.launch.h).toBeGreaterThanOrEqual(64);
    for (const obstacle of [slots.time, slots.legend, input.dock, input.zoom, input.compass, input.footer].filter((box): box is Box => !!box)) {
      expect(meets(slots.launch, obstacle)).toBe(false);
    }
  });

  it.each([
    { bottom: 0, legendOpen: false },
    { bottom: 0, legendOpen: true },
    { bottom: 34, legendOpen: false },
    { bottom: 34, legendOpen: true },
  ])('uses the clear launch region below narrow time with bottom $bottom and Legend=$legendOpen', ({ bottom, legendOpen }) => {
    const inset = bottom > 0;
    const input = measure({
      viewport: { w: 719, h: 521 },
      insets: { top: inset ? 24 : 0, right: 0, bottom, left: inset ? 47 : 0 },
      zoom: inset ? { x: 55, y: 155, w: 44, h: 88 } : { x: 8, y: 131, w: 88, h: 44 },
      compass: inset ? { x: 55, y: 243, w: 44, h: 44 } : { x: 96, y: 131, w: 44, h: 44 },
      show: { x: inset ? 55 : 8, y: inset ? 89 : 65, w: 203.640625, h: 52 },
      hide: { x: 619, y: inset ? 205 : 273, w: 88, h: 44 },
      legendButton: { x: 523, y: inset ? 205 : 273, w: 88, h: 44 },
      legendPanel: inset ? { x: 339, y: 257.828125, w: 176, h: 70 } : { x: 435, y: 121, w: 176, h: 40 },
      legendContentHeight: 70,
      legendOpen,
      footer: { x: 0, y: inset ? 335.84375 : 384.84375, w: 719, h: inset ? 86.96875 : 71.96875 },
      shotList: { x: 0, y: inset ? 422.8125 : 456.8125, w: 719, h: inset ? 98.1875 : 64.1875 },
      launchBrief: { x: 8, y: inset ? 155 : 131, w: 512, h: inset ? 203.5 : 220.5 },
      scrollbar: 8,
    });
    const slots = solveChromeSlots(input);
    const launch = slots.launch ?? input.launchBrief!;
    for (const obstacle of [slots.time, slots.dock, slots.legend, input.zoom, input.compass, input.show, input.hide, input.legendButton, input.footer, input.shotList].filter((box): box is Box => !!box)) {
      expect(meets(launch, obstacle)).toBe(false);
    }
    expect(slots.launch).toBeTruthy();
    expect(launch.w).toBeGreaterThanOrEqual(180);
    expect(launch.h).toBeGreaterThanOrEqual(64);
    expect(launch.y).toBeGreaterThanOrEqual(bottomOf(slots.time!) + 8);
    expect(bottomOf(launch)).toBeLessThanOrEqual(input.footer.y - 8 + 0.01);
    expect(solveChromeSlots({ ...input, launchBrief: launch })).toEqual(slots);
  });

  it('hides every slot when the chrome is hidden', () => {
    expect(solveChromeSlots(measure({
      viewport: { w: 390, h: 520 },
      chromeHidden: true,
      legendOpen: true,
      dockCorridor: 10,
    }))).toEqual({ time: null, dock: null, legend: null });
  });

  it('fits the open picker clear of the lifted time strip and relocated Legend', () => {
    const input = measure({
      map: { x: 0, y: 84, w: 800, h: 416 },
      insets: { top: 24, right: 0, bottom: 20, left: 47 },
      show: { x: 55, y: 89, w: 203.40625, h: 52 },
      zoom: { x: 55, y: 155, w: 44, h: 88 },
      compass: { x: 55, y: 243, w: 44, h: 44 },
      dock: { x: 725.84375, y: 89, w: 66.15625, h: 204 },
      sliderChip: { x: 63, y: 391, w: 525, h: 44 },
      legendPanel: { x: 516, y: 241, w: 176, h: 67 },
      legendButton: { x: 604, y: 312, w: 88, h: 44 },
      hide: { x: 700, y: 312, w: 88, h: 44 },
      legendOpen: true,
      legendNaturalBottom: 308,
      footer: { x: 0, y: 443.25, w: 800, h: 72.5625 },
      shotList: { x: 0, y: 515.8125, w: 800, h: 84.1875 },
      picker: { x: 424, y: 155, w: 288, h: 250 },
    });
    const slots = solveChromeSlots(input);
    expect(slots.picker).toBeTruthy();
    if (!slots.picker) return;
    expect(slots.picker.h).toBeGreaterThanOrEqual(290);
    expect(slots.picker.w).toBeGreaterThanOrEqual(180);
    for (const obstacle of [input.show, input.zoom, input.compass, input.dock!, input.sliderChip, input.legendPanel, input.legendButton, input.hide, input.footer]) {
      expect(meets(slots.picker, obstacle)).toBe(false);
    }
    expect(solveChromeSlots({ ...input, picker: slots.picker })).toEqual(slots);
    expect(solveChromeSlots({ ...input, picker: { ...slots.picker, h: 400 } })).toEqual(slots);
    const closed = solveChromeSlots({ ...input, picker: empty });
    expect(closed.picker).toBeUndefined();
    expect({ ...slots, picker: undefined }).toEqual(closed);
  });
});
