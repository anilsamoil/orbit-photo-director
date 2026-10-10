import { describe, expect, it } from 'vitest';
import { solveChromeSlots, type Box, type ChromeMeasure, type Slot } from '../src/chrome-slots';

const empty: Box = { x: 0, y: 0, w: 0, h: 0 };

function measure(over: Partial<ChromeMeasure>): ChromeMeasure {
  return {
    viewport: { w: 800, h: 600 },
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    topbar: 48,
    launch: null,
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
    timeNeed: 0,
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
    expect(slots.time.h === 44 || slots.time.h === 96).toBe(true);
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
    expect(slots.time).not.toBeNull();
    expect(slots.dock).not.toBeNull();
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
      footer: { x: 0, y: 364, w: 800, h: 216 },
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
    expect(slots.time).not.toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.dock || !slots.time) return;
    expect(slots.dock.axis).toBe('row');
    expect(meets(slots.time, t90)).toBe(false);
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
    expect(slots.time).not.toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.dock || !slots.footer) return;
    expect(slots.dock.h).toBeGreaterThanOrEqual(50);
    expect(meets(slots.dock, slots.footer)).toBe(false);
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
    const input = measure({
      viewport: { w: 390, h: 520 },
      legendOpen: true,
      dockCorridor: 10,
      footer: { x: 0, y: 480, w: 390, h: 40 },
      show: { x: 0, y: 0, w: 160, h: 52 },
    });
    const shown = solveChromeSlots(input);
    const hidden = solveChromeSlots({ ...input, chromeHidden: true });
    expect(hidden.time).toBeNull();
    expect(hidden.dock).toBeNull();
    expect(hidden.legend).toBeNull();
    expect(hidden.zoom).toBeNull();
    expect(hidden.hide).toEqual(shown.hide);
    expect(hidden.footer).toEqual(shown.footer);
  });

  it('places zoom and the time strip to the right of a left inset', () => {
    const slots = solveChromeSlots(measure({
      viewport: { w: 390, h: 521 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      topbar: 72,
      footer: { x: 0, y: 450, w: 390, h: 37 },
      show: { x: 0, y: 0, w: 180, h: 52 },
    }));
    expect(slots.zoom).toEqual({ x: 55, y: 143, w: 44, h: 88 });
    expect(slots.time).not.toBeNull();
    expect(slots.footer).not.toBeNull();
    if (!slots.time || !slots.footer || !slots.hide) return;
    expect(slots.time.x).toBeGreaterThanOrEqual(47);
    expect(slots.footer.y + slots.footer.h).toBe(521 - 34);
    expect(slots.hide.y + slots.hide.h).toBeLessThanOrEqual(slots.footer.y);
  });

  it('keeps Hide, the compass, and the time strip above the measured footer', () => {
    const footer = { x: 0, y: 280, w: 320, h: 86 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 320, h: 400 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      footer,
      show: { x: 0, y: 0, w: 160, h: 52 },
    }));
    expect(slots.footer).toEqual({ x: 47, y: 280, w: 273, h: 86 });
    expect(slots.hide).not.toBeNull();
    expect(slots.compass).not.toBeNull();
    expect(slots.time).not.toBeNull();
    if (!slots.hide || !slots.compass || !slots.time || !slots.footer) return;
    expect(slots.hide.y + slots.hide.h).toBeLessThanOrEqual(slots.footer.y);
    expect(slots.compass.y + slots.compass.h).toBeLessThanOrEqual(slots.footer.y);
    expect(slots.time.y + slots.time.h).toBeLessThanOrEqual(slots.footer.y + 0.5);
  });

  it('moves a wide dock off a slider that sits on the first candidate row', () => {
    const slider = { x: 60, y: 244, w: 400, h: 44 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 800, h: 600 },
      insets: { top: 24, right: 0, bottom: 20, left: 47 },
      footer: { x: 0, y: 364, w: 800, h: 216 },
      slider,
      sliderChip: slider,
      dockCorridor: 43,
      scrollbar: 6,
      show: { x: 0, y: 0, w: 180, h: 52 },
    }));
    expect(slots.dock).not.toBeNull();
    if (!slots.dock) return;
    expect(meets(slots.dock, slider)).toBe(false);
  });

  it('keeps the dock to the right of zoom', () => {
    const slots = solveChromeSlots(measure({
      viewport: { w: 430, h: 400 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      footer: { x: 0, y: 293.4, w: 430, h: 72.6 },
      show: { x: 0, y: 0, w: 180, h: 52 },
      scrollbar: 6,
    }));
    expect(slots.zoom).not.toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.zoom || !slots.dock) return;
    expect(slots.zoom.x).toBe(55);
    expect(slots.dock.x).toBeGreaterThanOrEqual(slots.zoom.x + slots.zoom.w + 8);
    expect(meets(slots.dock, slots.zoom)).toBe(false);
  });

  it('allocates an open legend and the wide dock without a shared box', () => {
    const slots = solveChromeSlots(measure({
      viewport: { w: 800, h: 600 },
      insets: { top: 24, right: 0, bottom: 20, left: 47 },
      footer: { x: 0, y: 364, w: 800, h: 216 },
      legendOpen: true,
      legendPanel: { x: 400, y: 200, w: 176, h: 120 },
      legendNaturalBottom: 420,
      timeButtons: [{ x: 500, y: 390, w: 50, h: 44 }],
      dockCorridor: 43,
      scrollbar: 6,
      show: { x: 0, y: 0, w: 180, h: 52 },
    }));
    expect(slots.legend).not.toBeNull();
    expect(slots.dock).not.toBeNull();
    if (!slots.legend || !slots.dock) return;
    expect(meets(slots.dock, slots.legend)).toBe(false);
  });

  it('caps an open launch panel above the time strip', () => {
    const slots = solveChromeSlots(measure({
      viewport: { w: 720, h: 500 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      topbar: 72,
      launch: { x: 55, y: 143, w: 400, h: 280 },
      show: { x: 0, y: 0, w: 200, h: 52 },
      footer: { x: 0, y: 440, w: 720, h: 26 },
    }));
    expect(slots.time).not.toBeNull();
    expect(slots.launch).not.toBeNull();
    if (!slots.time || !slots.launch) return;
    expect(slots.launch.y + slots.launch.h).toBeLessThanOrEqual(slots.time.y - 4);
    expect(meets(slots.launch, slots.time)).toBe(false);
  });

  it('re-solves when the same inset sum is split differently', () => {
    const shared = {
      viewport: { w: 390, h: 521 },
      topbar: 72,
      footer: { x: 0, y: 450, w: 390, h: 37 },
      show: { x: 0, y: 0, w: 180, h: 52 },
    };
    const first = solveChromeSlots(measure({ ...shared, insets: { top: 24, right: 34, bottom: 47, left: 0 } }));
    const second = solveChromeSlots(measure({ ...shared, insets: { top: 48, right: 10, bottom: 0, left: 47 } }));
    expect(first.zoom).toEqual({ x: 8, y: 143, w: 44, h: 88 });
    expect(second.zoom).toEqual({ x: 55, y: 143, w: 44, h: 88 });
    expect(first.footer?.y).not.toBe(second.footer?.y);
  });

  it('scrolls the full navigation stack below Show and above the footer at 320x360', () => {
    const slots = solveChromeSlots(measure({
      viewport: { w: 320, h: 360 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      topbar: 72,
      footer: { x: 0, y: 240, w: 320, h: 86 },
      show: { x: 0, y: 0, w: 160, h: 52 },
    }));
    expect(slots.zoom).toEqual({ x: 55, y: 134, w: 44, h: 98 });
    expect(slots.zoomScroll).toBe(true);
    expect(slots.compass).toBeNull();
    expect(meets(slots.zoom!, slots.show!)).toBe(false);
    expect(slots.footer).toEqual({ x: 47, y: 240, w: 273, h: 86 });
    expect(slots.hide).not.toBeNull();
    if (!slots.zoom || !slots.footer || !slots.hide) return;
    expect(bottomOf(slots.zoom)).toBeLessThanOrEqual(slots.footer.y - 8);
    expect(bottomOf(slots.hide)).toBeLessThanOrEqual(slots.footer.y);
  });

  it('keeps the wide time strip above the footer at 1320x440', () => {
    const footer = { x: 0, y: 360, w: 1320, h: 80 };
    const slots = solveChromeSlots(measure({
      viewport: { w: 1320, h: 440 },
      insets: { top: 0, right: 0, bottom: 34, left: 0 },
      footer,
      show: { x: 0, y: 0, w: 180, h: 52 },
    }));
    expect(slots.time).not.toBeNull();
    expect(slots.footer).not.toBeNull();
    if (!slots.time || !slots.footer) return;
    expect(slots.time.h).toBe(52);
    expect(bottomOf(slots.time)).toBeLessThanOrEqual(slots.footer.y);
    expect(meets(slots.time, slots.footer)).toBe(false);
  });

  it('reserves growing and shrinking intrinsic footer content before its neighbours', () => {
    for (const [w, h] of [[320, 360], [320, 400], [1320, 440]] as const) {
      for (const inset of [0, 34]) {
        const base = measure({
          viewport: { w, h },
          insets: { top: inset ? 24 : 0, right: 0, bottom: inset, left: inset ? 47 : 0 },
          topbar: inset ? 72 : 48,
          show: { x: 0, y: 0, w: 160, h: 52 },
          timeNeed: 140,
        });
        const plain = solveChromeSlots({ ...base, footer: { x: 0, y: h - 23, w, h: 23 } });
        const actions = solveChromeSlots({ ...base, footer: { ...plain.footer!, h: 86 } });
        const removed = solveChromeSlots({ ...base, footer: { ...actions.footer!, h: 23 } });
        expect(actions.footer?.h).toBe(86);
        expect(bottomOf(actions.footer!)).toBe(h - inset);
        expect(plain.footer!.y - actions.footer!.y).toBe(63);
        for (const neighbour of [actions.hide, actions.legendButton, actions.compass ?? actions.zoom, actions.time, actions.dock]) {
          expect(neighbour).not.toBeNull();
          expect(bottomOf(neighbour!)).toBeLessThanOrEqual(actions.footer!.y);
          expect(meets(neighbour!, actions.footer!)).toBe(false);
        }
        expect(removed).toEqual(plain);
      }
    }
  });

  it('allocates launch coverage independently of its unplaced origin and width', () => {
    for (const [w, h, bottom] of [[720, 500, 34], [800, 600, 20]] as const) {
      const base = measure({
        viewport: { w, h },
        insets: { top: 24, right: 0, bottom, left: 47 },
        topbar: 72,
        show: { x: 0, y: 0, w: 204, h: 52 },
        pip: w === 800 ? { x: 566, y: 77, w: 222, h: 144 } : null,
        launch: { x: 9, y: 9, w: 494, h: 44 },
      });
      const first = solveChromeSlots(base);
      const stale = solveChromeSlots({ ...base, launch: { x: -100, y: -50, w: 17, h: 44 } });
      expect(stale.launch).toEqual(first.launch);
      expect(first.launch).not.toBeNull();
      const launch = first.launch!;
      expect(launch.y).toBeGreaterThanOrEqual(bottomOf(first.show!) + 8);
      expect(launch.x).toBeGreaterThanOrEqual(rightOf(first.zoom!) + 8);
      expect(rightOf(launch)).toBeLessThanOrEqual(w - 8);
      expect(bottomOf(launch)).toBeLessThanOrEqual(first.time!.y - 8);
      for (const neighbour of [first.show, first.zoom, first.compass, first.dock, base.pip].filter(Boolean) as Box[]) {
        expect(meets(launch, neighbour)).toBe(false);
      }
    }
  });

  it('reserves the first-open Legend intrinsic height rather than the toggle shell', () => {
    for (const [w, h] of [[800, 600], [1400, 900]] as const) {
      const base = measure({
        viewport: { w, h },
        legendOpen: true,
        legendButton: { x: w - 196, y: h - 88, w: 88, h: 44 },
        legendPanel: { x: 0, y: 0, w: 176, h: 206 },
      });
      const first = solveChromeSlots(base);
      expect(first.legend?.h).toBe(206);
      expect(first.legend?.w).toBe(176);
      expect(bottomOf(first.legend!)).toBe(first.time!.y - 4);
      expect(meets(first.legend!, first.dock!)).toBe(false);
      expect(solveChromeSlots({ ...base, legendOpen: false }).legend).toBeNull();
      expect(solveChromeSlots(base).legend).toEqual(first.legend);
      const changed = solveChromeSlots({ ...base, legendPanel: { ...base.legendPanel, h: 238 } });
      expect(changed.legend?.h).toBe(238);
    }
  });

  it('declines an obstructed launch slot and recovers when its unchanged intent has room', () => {
    const input = measure({
      viewport: { w: 320, h: 360 },
      insets: { top: 24, right: 0, bottom: 34, left: 47 },
      topbar: 72,
      timeNeed: 140,
      footer: { x: 0, y: 0, w: 273, h: 23 },
      launch: { x: 0, y: 0, w: 176, h: 44 },
      legendPanel: { x: 0, y: 0, w: 176, h: 206 },
      legendOpen: true,
    });
    const obstructed = solveChromeSlots(input);
    expect(obstructed.legend?.x).toBe(107);
    expect(obstructed.launch).toBeNull();
    const closed = solveChromeSlots({ ...input, legendOpen: false });
    expect(closed.launch).not.toBeNull();
    const noRoom = solveChromeSlots({ ...input, viewport: { w: 320, h: 400 }, legendOpen: false });
    expect(noRoom.launch).toBeNull();
    const expanded = solveChromeSlots({ ...input, viewport: { w: 720, h: 500 } });
    expect(expanded.launch).not.toBeNull();
    expect(expanded.launch!.y).toBeGreaterThanOrEqual(bottomOf(expanded.show!) + 8);
    for (const box of [expanded.dock, expanded.legend, expanded.time].filter(Boolean) as Box[]) {
      expect(meets(expanded.launch!, box)).toBe(false);
    }
  });

  it('caps an intrinsically tall Legend between the pane top and the whole time strip', () => {
    const slots = solveChromeSlots(measure({
      viewport: { w: 800, h: 600 },
      pane: { x: 0, y: 84, w: 800, h: 436 },
      topbar: 84,
      legendOpen: true,
      legendPanel: { x: 0, y: 0, w: 176, h: 800 },
    }));
    expect(slots.legend?.y).toBe(92);
    expect(bottomOf(slots.legend!)).toBe(slots.time!.y - 4);
    expect(slots.legend!.h).toBeGreaterThan(200);
    expect(slots.legend!.h).toBeLessThan(800);
  });

  it('does not treat the intrinsic closed Legend probe as a placed dock obstacle', () => {
    for (const dockCorridor of [0, 43, 180]) {
      const input = measure({
        viewport: { w: 800, h: 600 },
        legendOpen: false,
        pip: { x: 566, y: 65, w: 222, h: 144 },
        dockCorridor,
      });
      const closed = solveChromeSlots(input);
      const measured = solveChromeSlots({ ...input, legendPanel: { x: 0, y: 0, w: 176, h: 206 } });
      expect(measured).toEqual(closed);
      expect(measured.dock!.h).toBeGreaterThan(44);
    }
  });

  it('keeps desktop strip, corner and PiP clearances across bottom insets', () => {
    for (const [w, h] of [[1024, 700], [1280, 700], [1400, 900]] as const) {
      for (const bottom of [0, 20, 34]) {
        for (const busy of [false, true]) {
          const input = measure({
            viewport: { w, h },
            insets: { top: 24, right: 0, bottom, left: 47 },
            topbar: 84,
            footer: { x: 0, y: 0, w, h: busy ? 86 : 23 },
            shotList: busy ? { x: 0, y: h - 90 - bottom, w, h: 90 + bottom } : empty,
            pip: { x: w - 234, y: 89, w: 222, h: 144 },
            legendOpen: busy,
            legendPanel: { x: 0, y: 0, w: 176, h: 206 },
          });
          const slots = solveChromeSlots(input);
          expect(slots.time?.h).toBe(96 + bottom);
          expect(rightOf(slots.time!)).toBe(w - 204);
          expect(slots.hide?.w).toBe(88);
          expect(slots.hide?.h).toBe(44);
          expect(rightOf(slots.hide!)).toBe(w - 12);
          expect(slots.hide!.x - rightOf(slots.legendButton!)).toBe(8);
          expect(slots.dock!.y - bottomOf(input.pip!)).toBe(12);
          const floor = busy ? input.shotList.y : slots.footer!.y;
          expect(bottomOf(slots.time!)).toBe(floor);
          expect(floor).toBe(h - bottom - (busy ? 90 : 23));
          expect(slots.hide!.y + 44 + 8).toBe(floor);
          expect(meets(slots.dock!, input.pip!)).toBe(false);
          if (slots.legend) expect(meets(slots.dock!, slots.legend)).toBe(false);
        }
      }
    }
    expect(solveChromeSlots(measure({ viewport: { w: 1320, h: 440 }, insets: { top: 24, right: 0, bottom: 34, left: 47 } })).time?.h).toBe(52);
  });

  it('keeps every pane-owned slot above the real shot-list pane clip', () => {
    for (const [w, h] of [[1024, 700], [1400, 900]] as const) {
      for (const bottom of [0, 20, 34]) {
        const pane = { x: 0, y: 0, w, h: h - 80 - bottom };
        const input = measure({
          viewport: { w, h }, pane,
          insets: { top: 0, right: 0, bottom, left: 0 },
          topbar: 60,
          footer: { x: 0, y: 0, w, h: 23 },
          shotList: { x: 0, y: h - 64.19 - bottom, w, h: 64.19 + bottom },
          pip: { x: w - 234, y: 65, w: 222, h: 144 },
          launch: { x: 9, y: 9, w: 494, h: 44 },
          legendOpen: true,
          legendPanel: { x: 0, y: 0, w: 176, h: 206 },
        });
        const slots = solveChromeSlots(input);
        for (const [name, box] of Object.entries(slots)) {
          if (!box || typeof box === 'boolean' || name === 'footer') continue;
          expect(box.y, name).toBeGreaterThanOrEqual(pane.y);
          expect(bottomOf(box), name).toBeLessThanOrEqual(bottomOf(pane));
          expect(rightOf(box), name).toBeLessThanOrEqual(rightOf(pane));
        }
        expect(bottomOf(slots.time!)).toBe(bottomOf(pane));
        expect(bottomOf(slots.hide!) + 8).toBe(bottomOf(pane));
        expect(bottomOf(slots.legendButton!) + 8).toBe(bottomOf(pane));
      }
    }
  });

  it('uses the independent intrinsic stacked time requirement without overcounting', () => {
    for (const timeNeed of [118, 140, 184]) {
      const slots = solveChromeSlots(measure({
        viewport: { w: 390, h: 900 },
        insets: { top: 24, right: 0, bottom: 34, left: 47 },
        topbar: 84,
        timeNeed,
      }));
      expect(slots.time?.h).toBe(timeNeed);
    }
  });

  it('reaches a fixed point with nonzero timeNeed even when the painted chip uses line fallback', () => {
    for (const h of [360, 400]) {
      for (const legendOpen of [false, true]) {
        let input = measure({
          viewport: { w: 320, h },
          insets: { top: 24, right: 0, bottom: 34, left: 47 },
          topbar: 72,
          timeNeed: 140,
          legendOpen,
          legendPanel: { x: 0, y: 0, w: 176, h: 206 },
          footer: { x: 0, y: 0, w: 273, h: 23 },
        });
        const first = solveChromeSlots(input);
        expect(first.time?.h).toBe(h === 400 && !legendOpen ? 140 : 44);
        for (let frame = 0; frame < 12; frame++) {
          input = { ...input, zoom: first.zoom!, compass: first.compass!, show: first.show!, hide: first.hide!, legendButton: first.legendButton!, sliderChip: first.time!, slider: { ...first.time!, h: 44 } };
          expect(solveChromeSlots(input)).toEqual(first);
          expect(input.timeNeed).toBe(140);
        }
      }
    }
  });
  it.each([[800, 600], [874, 402], [820, 1180], [834, 1194], [1180, 820], [1194, 834], [1400, 900]])(
    'caps long Legend content in the largest readable free rectangle at %dx%d', (w, h) => {
      const input = measure({
        viewport: { w, h }, topbar: 84,
        insets: { top: 24, right: 0, bottom: 20, left: 47 },
        pane: { x: 0, y: 0, w, h: h - 80 },
        legendOpen: true, legendPanel: { x: 0, y: 0, w: 176, h: 1200 },
        pip: { x: w - 234, y: 89, w: 222, h: 144 },
        footer: { x: 0, y: 0, w, h: 86 },
        shotList: { x: 0, y: h - 84, w, h: 64 },
      });
      const slots = solveChromeSlots(input);
      const panel = slots.legend!;
      expect(panel).not.toBeNull();
      expect(panel.w).toBe(176);
      expect(panel.h).toBeGreaterThanOrEqual(32);
      expect(panel.h).toBeLessThan(input.legendPanel.h);
      expect(panel.y).toBeGreaterThanOrEqual(92);
      for (const box of [input.pip, slots.time, slots.footer, slots.hide, slots.legendButton, slots.dock, slots.show, slots.zoom, slots.compass].filter(Boolean) as Box[]) {
        expect(meets(panel, box), JSON.stringify(box)).toBe(false);
      }
      const painted = { ...input, timeStrip: slots.time!, sliderChip: slots.time!, timeReadout: { x: rightOf(slots.time!) - 90, y: bottomOf(slots.time!) - 16, w: 90, h: 12 } };
      expect(solveChromeSlots(painted).legend).toEqual(panel);
      expect(meets(panel, painted.timeReadout)).toBe(false);
      const longer = solveChromeSlots({ ...painted, legendPanel: { ...input.legendPanel, h: 2400 } });
      expect(longer.legend).toEqual(panel);
    },
  );

  it.each([false, true])('reserves overflowing readout paint with a measured time strip=%s', (measuredStrip) => {
    const input = measure({ viewport: { w: 800, h: 600 }, legendOpen: true,
      legendPanel: { x: 0, y: 0, w: 176, h: 52.86 } });
    const natural = solveChromeSlots(input).legend!;
    const timeReadout = { x: natural.x, y: natural.y, w: natural.w, h: natural.h };
    const slots = solveChromeSlots({ ...input, timeReadout, timeStrip: measuredStrip ? solveChromeSlots(input).time! : undefined });
    expect(slots.legend).not.toBeNull();
    expect(meets(slots.legend!, timeReadout)).toBe(false);
    expect(slots.legend!.h).toBe(52.86);
  });

  it('rejects narrow slivers and gives a busy 320x360 disclosure an unobstructed close target', () => {
    for (const bottom of [20, 34]) {
      const input = measure({ viewport: { w: 320, h: 360 }, topbar: 84,
        insets: { top: 24, right: 0, bottom, left: 47 },
        footer: { x: 0, y: 0, w: 273, h: 86 },
        show: { x: 55, y: 89, w: 203, h: 52 },
        legendOpen: true, legendPanel: { x: 0, y: 0, w: 176, h: 935 }, timeNeed: 140,
      });
      const slots = solveChromeSlots(input);
      expect(slots.legend?.w).toBeGreaterThanOrEqual(120);
      expect(slots.legend?.h).toBeGreaterThanOrEqual(32);
      expect(slots.legendButton?.w).toBeGreaterThanOrEqual(44);
      expect(slots.legendButton?.h).toBe(44);
      for (const box of [slots.legendButton, slots.hide, slots.time, slots.footer]) {
        expect(meets(slots.legend!, box!)).toBe(false);
      }
      expect(solveChromeSlots({ ...input, legendOpen: false }).show).not.toBeNull();
    }
  });

  it('scrolls a short-busy 430x360 zoom lane without moving Zoom In through Show', () => {
    const slots = solveChromeSlots(measure({ viewport: { w: 430, h: 360 }, topbar: 84,
      insets: { top: 24, right: 0, bottom: 20, left: 47 },
      footer: { x: 0, y: 0, w: 383, h: 86 },
      show: { x: 55, y: 89, w: 203, h: 52 },
      legendOpen: true, legendPanel: { x: 0, y: 0, w: 176, h: 53 }, timeNeed: 140,
    }));
    expect(slots.zoomScroll).toBe(true);
    expect(slots.zoom?.h).toBeGreaterThanOrEqual(44);
    expect(slots.zoom?.y).toBeGreaterThanOrEqual(bottomOf(slots.show!) + 4);
    expect(meets(slots.zoom!, slots.show!)).toBe(false);
    expect(bottomOf(slots.zoom!)).toBeLessThanOrEqual(slots.footer!.y - 8);
  });

  it('declines an impossible sub-target navigation corridor and restores it after footer shrink', () => {
    const input = measure({ viewport: { w: 430, h: 360 }, topbar: 84,
      insets: { top: 24, right: 0, bottom: 20, left: 47 },
      footer: { x: 0, y: 0, w: 383, h: 190 },
      show: { x: 55, y: 89, w: 203, h: 52 },
    });
    const noRoom = solveChromeSlots(input);
    expect(noRoom.zoom).toBeNull();
    expect(noRoom.compass).toBeNull();
    const restored = solveChromeSlots({ ...input, footer: { ...input.footer, h: 86 } });
    expect(restored.zoom!.h).toBeGreaterThanOrEqual(44);
    expect(meets(restored.zoom!, restored.show!)).toBe(false);
    expect(meets(restored.zoom!, restored.footer!)).toBe(false);
  });

});
