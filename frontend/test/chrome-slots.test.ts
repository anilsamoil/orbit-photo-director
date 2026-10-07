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
    expect(slots.time).toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.dock) return;
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

  it('hides every slot when the chrome is hidden', () => {
    expect(solveChromeSlots(measure({
      viewport: { w: 390, h: 520 },
      chromeHidden: true,
      legendOpen: true,
      dockCorridor: 10,
    }))).toEqual({ time: null, dock: null, legend: null });
  });
});
