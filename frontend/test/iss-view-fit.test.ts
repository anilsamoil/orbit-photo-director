import { describe, expect, it } from 'vitest';

import { mountIssScene, type IssScene } from '../src/iss-view';
import { placeLaunchMarks, type LaunchSite } from '../src/iss-view/launches';
import { fitIssPane, SHORT_ISS_WINDOW_PX, sideDockActive, type PaneMeasure } from '../src/iss-view/pane-fit';
import { sceneFit } from '../src/iss-view/model';
import type { LaunchSelection } from '../src/launch-selectors';
import { sensorField, type SceneSnapshot } from '../src/iss-view/model';
import type { IssAim, IssRenderer, IssRendererFactory, IssRendererHooks } from '../src/iss-view/renderer';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };
import { assessment, supported } from './launch-fixtures';

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const startMs = Date.parse(fixture.start);

function shot(): SceneSnapshot {
  return {
    manifestVersion: 'fit',
    generatedAtMs: startMs,
    track: {
      iss_polynomial: fixture.iss_polynomial,
      tle: fixture.tle,
      tle_epoch: '2024-10-16T18:58:11.999Z',
      tle_age_hours: 17,
      tle_freshness_factor: 1,
    },
  };
}

function renderer(frame: HTMLElement): {
  factory: IssRendererFactory;
  sizes: { widthPx: number; heightPx: number }[];
  aims: IssAim[];
} {
  const sizes: { widthPx: number; heightPx: number }[] = [];
  const aims: IssAim[] = [];
  const factory: IssRendererFactory = (target, hooks: IssRendererHooks): IssRenderer => {
    void hooks;
    return {
      ready: () => Promise.resolve(),
      aim: (aim) => {
        aims.push(aim);
        return Promise.resolve();
      },
      resize(widthPx, heightPx) {
        sizes.push({ widthPx, heightPx });
        target.style.width = `${widthPx}px`;
        target.style.height = `${heightPx}px`;
      },
      destroy: () => {},
    };
  };
  void frame;
  return { factory, sizes, aims };
}

function box(element: Element, width: number, height: number): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => height });
}

async function paint(scene: IssScene): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  await scene.paint();
  await scene.paint();
}

describe('ISS frame fit', () => {
  it('uses one contained fit for the frame, the resize, and the aim', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const fake = renderer(host);
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: fake.factory,
      drive: 'manual',
      session: { mode: 'horizon' },
    });
    const root = host.querySelector('[data-iss-scene]');
    const stage = host.querySelector('[data-iss-stage]');
    const toolbar = host.querySelector('[data-iss-toolbar]');
    const card = host.querySelector('[data-iss-card]');
    const port = host.querySelector('[data-iss-port]');
    const starboard = host.querySelector('[data-iss-starboard]');
    const frame = host.querySelector('[data-iss-frame]');
    const body = host.querySelector('[data-iss-telemetry-body]');
    expect(root).toBeInstanceOf(HTMLElement);
    expect(stage).toBeInstanceOf(HTMLElement);
    expect(toolbar).toBeInstanceOf(HTMLElement);
    expect(card).toBeInstanceOf(HTMLElement);
    expect(port).toBeInstanceOf(HTMLElement);
    expect(starboard).toBeInstanceOf(HTMLElement);
    expect(frame).toBeInstanceOf(HTMLElement);
    expect(body).toBeInstanceOf(HTMLElement);
    if (!(root instanceof HTMLElement) || !(stage instanceof HTMLElement) || !(toolbar instanceof HTMLElement)) return;
    if (!(card instanceof HTMLElement) || !(port instanceof HTMLElement) || !(starboard instanceof HTMLElement)) return;
    if (!(frame instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
    root.style.padding = '12px';
    root.style.gap = '8px';
    stage.style.gap = '8px';
    box(host, 1400, 769);
    box(root, 1400, 769);
    const button = host.querySelector('[data-iss-telemetry]') as HTMLElement;
    Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => 44 });
    Object.defineProperty(button, 'offsetHeight', { configurable: true, get: () => 44 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 136 });
    Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => (body.hidden ? 44 : 180) });
    Object.defineProperty(port, 'offsetWidth', { configurable: true, get: () => 11 });
    Object.defineProperty(starboard, 'offsetWidth', { configurable: true, get: () => 11 });
    scene.update(shot());
    await paint(scene);
    expect(fake.sizes.at(-1)).toEqual({ widthPx: 961, heightPx: 641 });
    expect(fake.aims.at(-1)?.widthPx).toBe(961);
    expect(fake.aims.at(-1)?.heightPx).toBe(641);
    expect(frame.style.width).toBe('961px');
    expect(frame.style.height).toBe('641px');
    expect(stage.style.height).toBe('641px');
    const toggle = host.querySelector('[data-iss-telemetry]');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    if (toggle instanceof HTMLButtonElement) toggle.click();
    await paint(scene);
    expect(fake.sizes.at(-1)).toEqual({ widthPx: 757, heightPx: 505 });
    expect(fake.aims.at(-1)?.widthPx).toBe(757);
    expect(fake.aims.at(-1)?.heightPx).toBe(505);
    expect(frame.style.width).toBe('757px');
    expect(frame.style.height).toBe('505px');
    expect(stage.style.height).toBe('505px');
    scene.dispose();
    host.remove();
  });

  it('keeps the stage as tall as a side label that outgrows the frame', async () => {
    const fitted = await mountFitted(220, 420, { width: 0, height: 0 }, { toolbar: 44, select: false, labelHeight: 250 });
    const stage = fitted.host.querySelector('[data-iss-stage]') as HTMLElement;
    expect(Number.parseFloat(fitted.frame.style.height)).toBeLessThan(250);
    expect(stage.style.height).toBe('250px');
    fitted.scene.dispose();
    fitted.host.remove();
  });

  it('keeps port and starboard inside a 402px pane', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const fake = renderer(host);
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: fake.factory,
      drive: 'manual',
      session: { mode: 'horizon' },
    });
    const root = host.querySelector('[data-iss-scene]') as HTMLElement;
    const stage = host.querySelector('[data-iss-stage]') as HTMLElement;
    const toolbar = host.querySelector('[data-iss-toolbar]') as HTMLElement;
    const card = host.querySelector('[data-iss-card]') as HTMLElement;
    const port = host.querySelector('[data-iss-port]') as HTMLElement;
    const starboard = host.querySelector('[data-iss-starboard]') as HTMLElement;
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    root.style.padding = '12px';
    root.style.gap = '8px';
    stage.style.gap = '8px';
    box(host, 402, 743);
    box(root, 402, 743);
    Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => 160 });
    Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => 44 });
    Object.defineProperty(port, 'offsetWidth', { configurable: true, get: () => 11 });
    Object.defineProperty(starboard, 'offsetWidth', { configurable: true, get: () => 11 });
    scene.update(shot());
    await paint(scene);
    expect(fake.sizes.at(-1)).toEqual({ widthPx: 340, heightPx: 226 });
    expect(fake.aims.at(-1)?.widthPx).toBe(340);
    expect(fake.aims.at(-1)?.heightPx).toBe(226);
    expect(frame.style.width).toBe('340px');
    const pane = 402 - 12 * 2;
    const sides = 11 + 11 + 8 * 2;
    expect(Number.parseFloat(frame.style.width)).toBeLessThanOrEqual(pane - sides);
    scene.dispose();
    host.remove();
  });

  it('keeps a real Earth frame when short landscape telemetry is open or closed', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const fake = renderer(host);
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: fake.factory,
      drive: 'manual',
      session: { mode: 'nadir' },
    });
    const root = host.querySelector('[data-iss-scene]') as HTMLElement;
    const stage = host.querySelector('[data-iss-stage]') as HTMLElement;
    const toolbar = host.querySelector('[data-iss-toolbar]') as HTMLElement;
    const card = host.querySelector('[data-iss-card]') as HTMLElement;
    const port = host.querySelector('[data-iss-port]') as HTMLElement;
    const starboard = host.querySelector('[data-iss-starboard]') as HTMLElement;
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    const body = host.querySelector('[data-iss-telemetry-body]') as HTMLElement;
    const button = host.querySelector('[data-iss-telemetry]') as HTMLElement;
    root.style.padding = '12px';
    root.style.gap = '8px';
    stage.style.gap = '8px';
    body.style.margin = '0';
    box(host, 874, 271);
    box(root, 874, 271);
    Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => 52 });
    Object.defineProperty(button, 'offsetHeight', { configurable: true, get: () => 44 });
    Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => (body.hidden ? 44 : 227) });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => (body.hidden ? 0 : 183) });
    Object.defineProperty(port, 'offsetWidth', { configurable: true, get: () => 11 });
    Object.defineProperty(starboard, 'offsetWidth', { configurable: true, get: () => 11 });
    Object.defineProperty(port, 'offsetHeight', { configurable: true, get: () => 38 });
    Object.defineProperty(starboard, 'offsetHeight', { configurable: true, get: () => 84 });
    scene.update(shot());
    await paint(scene);
    expect(frame.style.width).toBe('202px');
    expect(frame.style.height).toBe('135px');
    expect(body.style.maxHeight).toBe('');
    button.click();
    await paint(scene);
    for (let tick = 0; tick < 4; tick += 1) await scene.paint();
    expect(frame.style.width).toBe('126px');
    expect(frame.style.height).toBe('84px');
    expect(body.style.maxHeight).toBe('51px');
    expect(fake.sizes.at(-1)).toEqual({ widthPx: 126, heightPx: 84 });
    expect(fake.aims.at(-1)?.widthPx).toBe(126);
    expect(fake.aims.at(-1)?.heightPx).toBe(84);
    button.click();
    await paint(scene);
    expect(frame.style.width).toBe('202px');
    expect(frame.style.height).toBe('135px');
    expect(body.style.maxHeight).toBe('');
    scene.dispose();
    host.remove();
  });

  it('keeps a pinched field of view through later aims', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const fake = renderer(host);
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: fake.factory,
      drive: 'manual',
      session: { mode: 'horizon' },
    });
    const root = host.querySelector('[data-iss-scene]') as HTMLElement;
    const stage = host.querySelector('[data-iss-stage]') as HTMLElement;
    const toolbar = host.querySelector('[data-iss-toolbar]') as HTMLElement;
    const card = host.querySelector('[data-iss-card]') as HTMLElement;
    const port = host.querySelector('[data-iss-port]') as HTMLElement;
    const starboard = host.querySelector('[data-iss-starboard]') as HTMLElement;
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    const button = host.querySelector('[data-iss-telemetry]') as HTMLElement;
    root.style.padding = '12px';
    root.style.gap = '8px';
    stage.style.gap = '8px';
    box(host, 1400, 769);
    box(root, 1400, 769);
    Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => 44 });
    Object.defineProperty(button, 'offsetHeight', { configurable: true, get: () => 44 });
    Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => 44 });
    Object.defineProperty(port, 'offsetWidth', { configurable: true, get: () => 11 });
    Object.defineProperty(starboard, 'offsetWidth', { configurable: true, get: () => 11 });
    scene.update(shot());
    await paint(scene);
    const lens = sensorField().vertical;
    const first = fake.aims.at(-1);
    expect(first?.verticalFovDeg).toBeCloseTo(lens, 5);
    const altitude = first?.pose.altitudeM;
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
    await paint(scene);
    const zoomed = fake.aims.at(-1);
    expect(zoomed?.verticalFovDeg).toBeLessThan(lens - 5);
    expect(zoomed?.pose.altitudeM).toBe(altitude);
    const chosen = zoomed?.verticalFovDeg;
    button.click();
    await paint(scene);
    await scene.paint();
    expect(fake.aims.at(-1)?.verticalFovDeg).toBe(chosen);
    expect(fake.aims.at(-1)?.pose.altitudeM).toBe(altitude);
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: 4000, bubbles: true, cancelable: true }));
    await paint(scene);
    expect(fake.aims.at(-1)?.verticalFovDeg).toBeCloseTo(lens, 5);
    const wide = fake.aims.at(-1)?.verticalFovDeg ?? lens;
    if (typeof frame.setPointerCapture !== 'function') frame.setPointerCapture = () => {};
    frame.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 80, clientY: 80, bubbles: true }));
    frame.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 140, clientY: 80, bubbles: true }));
    frame.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 260, clientY: 80, bubbles: true }));
    await paint(scene);
    const pinched = fake.aims.at(-1)?.verticalFovDeg;
    expect(pinched).toBeLessThan(wide - 5);
    expect(fake.aims.at(-1)?.pose.altitudeM).toBe(altitude);
    await scene.paint();
    expect(fake.aims.at(-1)?.verticalFovDeg).toBe(pinched);
    scene.dispose();
    host.remove();
  });

  it('reserves a long launch card beside a wide pane and under a narrow phone', async () => {
    const wide = await mountFitted(1400, 628, { width: 640, height: 96 });
    expect(wide.root.dataset.issLaunchPlace).toBe('side');
    expect(wide.frame.style.width).toBe('690px');
    expect(wide.frame.style.height).toBe('460px');
    wide.button.click();
    await paint(wide.scene);
    expect(wide.root.dataset.issLaunchPlace).toBe('side');
    expect(wide.frame.style.width).toBe('570px');
    expect(wide.frame.style.height).toBe('380px');
    expect(wide.body.style.maxHeight).toBe('');
    wide.scene.dispose();
    wide.host.remove();

    const phone = await mountFitted(402, 520, { width: 280, height: 160 }, { toolbar: 52, body: 80 });
    expect(phone.root.dataset.issLaunchPlace).toBe('below');
    expect(phone.frame.style.width).toBe('324px');
    expect(phone.frame.style.height).toBe('216px');
    phone.button.click();
    await paint(phone.scene);
    expect(phone.root.dataset.issLaunchPlace).toBe('below');
    expect(phone.frame.style.width).toBe('204px');
    expect(phone.frame.style.height).toBe('136px');
    phone.scene.dispose();
    phone.host.remove();
  });

  it('keeps a short landscape frame when a long launch card is open with telemetry', async () => {
    const fitted = await mountFitted(874, 271, { width: 640, height: 88 }, { toolbar: 52, body: 183 });
    const port = fitted.host.querySelector('[data-iss-port]') as HTMLElement;
    const starboard = fitted.host.querySelector('[data-iss-starboard]') as HTMLElement;
    Object.defineProperty(port, 'offsetHeight', { configurable: true, get: () => 38 });
    Object.defineProperty(starboard, 'offsetHeight', { configurable: true, get: () => 84 });
    await paint(fitted.scene);
    expect(fitted.root.dataset.issLaunchPlace).toBe('side');
    expect(fitted.frame.style.width).toBe('164px');
    expect(fitted.frame.style.height).toBe('109px');
    expect(fitted.body.style.maxHeight).toBe('');
    fitted.button.click();
    await paint(fitted.scene);
    for (let tick = 0; tick < 4; tick += 1) await fitted.scene.paint();
    expect(fitted.root.dataset.issLaunchPlace).toBe('side');
    expect(fitted.frame.style.width).toBe('132px');
    expect(fitted.frame.style.height).toBe('88px');
    expect(fitted.body.style.maxHeight).toBe('47px');
    fitted.button.click();
    await paint(fitted.scene);
    expect(fitted.frame.style.width).toBe('164px');
    expect(fitted.frame.style.height).toBe('109px');
    fitted.scene.dispose();
    fitted.host.remove();
  });

  it('keeps the card-closed earth when a below card would shrink a 390x664 iPhone 13 under a mark', async () => {
    const fitted = await mountFitted(390, 503, { width: 352, height: 96 }, { toolbar: 252, select: false });
    const closed = framePx(fitted.frame);
    await chooseLaunch(fitted.host);
    await paint(fitted.scene);
    const open = framePx(fitted.frame);
    expect(fitted.root.dataset.issLaunchPlace).toBe('over');
    expect(open).toEqual(closed);
    expect(Math.min(open.width, open.height)).toBeGreaterThanOrEqual(80);
    expectMarks(open.width, open.height);
    fitted.scene.dispose();
    fitted.host.remove();
  });

  it('keeps a markable earth with the launch card open at 390x844 and 844x390', async () => {
    const portrait = await mountFitted(390, 683, { width: 352, height: 96 }, { toolbar: 252 });
    const portraitPx = framePx(portrait.frame);
    expect(portrait.root.dataset.issLaunchPlace).toBe('below');
    expect(Math.min(portraitPx.width, portraitPx.height)).toBeGreaterThanOrEqual(160);
    expectMarks(portraitPx.width, portraitPx.height);
    portrait.scene.dispose();
    portrait.host.remove();

    const landscape = await mountFitted(844, 270, { width: 338, height: 96 }, { toolbar: 80 });
    const landscapePx = framePx(landscape.frame);
    expect(landscape.root.dataset.issLaunchPlace).toBe('side');
    expect(Math.min(landscapePx.width, landscapePx.height)).toBeGreaterThanOrEqual(80);
    expectMarks(landscapePx.width, landscapePx.height);
    landscape.scene.dispose();
    landscape.host.remove();
  });

  it('holds a below card from 120 through 131 and enters over under 120', () => {
    for (const short of [119, 120, 121]) {
      const measure = measureWithShort(short);
      expect(reservedShort(measure)).toBe(short);
      const fromBelow = fitIssPane(measure, 'below').launchCardPlace;
      const fromOver = fitIssPane(measure, 'over').launchCardPlace;
      expect(fromBelow).toBe(short < 120 ? 'over' : 'below');
      expect(fromOver).toBe('over');
    }
    expect(fitIssPane(measureWithShort(131), 'over').launchCardPlace).toBe('over');
    expect(fitIssPane(measureWithShort(132), 'over').launchCardPlace).toBe('below');
    expect(fitIssPane(measureWithShort(132), 'below').launchCardPlace).toBe('below');
  });

  it('keeps one placement across repeated layouts for a two-line name at 390x565', async () => {
    const fitted = await mountFitted(390, 565, { width: 352, height: 116 }, {
      toolbar: 244,
      select: false,
      cardBox: (place) => (place === 'over' ? { width: 152, height: 104 } : { width: 352, height: 116 }),
    });
    await chooseLaunch(fitted.host);
    const places: string[] = [];
    for (let tick = 0; tick < 8; tick += 1) {
      await paint(fitted.scene);
      places.push(fitted.root.dataset.issLaunchPlace || '');
    }
    expect(fitted.host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Northrop Grumman Cygnus NG-21 visiting the long wall');
    expect(new Set(places)).toEqual(new Set(['over']));
    expect(Math.min(framePx(fitted.frame).width, framePx(fitted.frame).height)).toBeGreaterThanOrEqual(80);
    fitted.scene.dispose();
    fitted.host.remove();
  });

  it('parks a reclaimed 844x390 side dock beside an earth at least 240 by 160', async () => {
    const reclaimed: PaneMeasure = {
      paneWidthPx: 844,
      paneHeightPx: 309,
      padXPx: 24,
      padYPx: 21,
      gapPx: 7,
      toolbarPx: 44,
      buttonPx: 44,
      bodyPx: 0,
      bodyMarginPx: 0,
      sideWidthPx: 36,
      labelPx: 40,
      launchCardWidthPx: 338,
      launchCardHeightPx: 96,
      launchCardGapPx: 7,
    };
    const closed = fitIssPane(reclaimed, 'side');
    const open = fitIssPane(reclaimed, 'side');
    const stacked = fitIssPane({ ...reclaimed, bodyPx: 180, bodyMarginPx: 6 }, 'side');
    const inset = fitIssPane({ ...reclaimed, padYPx: 30 }, 'side');
    expect(closed.launchCardPlace).toBe('side');
    expect(closed.bodyMaxPx).toBeNull();
    expect(closed.widthPx).toBeGreaterThanOrEqual(240);
    expect(closed.heightPx).toBeGreaterThanOrEqual(160);
    expect(open.widthPx).toBe(closed.widthPx);
    expect(open.heightPx).toBe(closed.heightPx);
    expect(inset.widthPx).toBeGreaterThanOrEqual(240);
    expect(inset.heightPx).toBeGreaterThanOrEqual(160);
    expect(stacked.heightPx).toBeLessThan(160);

    const previous = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 390 });
    try {
      const host = document.createElement('div');
      document.body.append(host);
      const scene = mountIssScene(host, {
        nowMs: () => startMs + 60_000,
        createRenderer: renderer(host).factory,
        drive: 'manual',
        session: { mode: 'horizon' },
      });
      const root = host.querySelector('[data-iss-scene]') as HTMLElement;
      const stage = host.querySelector('[data-iss-stage]') as HTMLElement;
      const view = host.querySelector('[data-iss-view]') as HTMLElement;
      const toolbar = host.querySelector('[data-iss-toolbar]') as HTMLElement;
      const clock = host.querySelector('[data-iss-clock]') as HTMLElement;
      const side = host.querySelector('[data-iss-side]') as HTMLElement;
      const port = host.querySelector('[data-iss-port]') as HTMLElement;
      const starboard = host.querySelector('[data-iss-starboard]') as HTMLElement;
      const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
      const body = host.querySelector('[data-iss-telemetry-body]') as HTMLElement;
      const button = host.querySelector('[data-iss-telemetry]') as HTMLButtonElement;
      const controls = host.querySelector('[data-iss-controls]') as HTMLElement;
      root.style.padding = '12px';
      root.style.gap = '8px';
      stage.style.gap = '8px';
      view.style.gap = '8px';
      body.style.margin = '0';
      box(host, 844, 309);
      box(root, 844, 309);
      Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => 44 });
      Object.defineProperty(button, 'offsetHeight', { configurable: true, get: () => 44 });
      Object.defineProperty(controls, 'offsetHeight', { configurable: true, get: () => 44 });
      Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => (body.hidden ? 0 : 183) });
      Object.defineProperty(side, 'offsetWidth', { configurable: true, get: () => 338 });
      Object.defineProperty(port, 'offsetWidth', { configurable: true, get: () => 11 });
      Object.defineProperty(starboard, 'offsetWidth', { configurable: true, get: () => 11 });
      Object.defineProperty(port, 'offsetHeight', { configurable: true, get: () => 40 });
      Object.defineProperty(starboard, 'offsetHeight', { configurable: true, get: () => 40 });
      scene.update(shot());
      await paint(scene);
      expect(root.dataset.issSideDock).toBe('on');
      expect(side.contains(host.querySelector('[data-iss-houston]'))).toBe(true);
      expect(side.contains(host.querySelector('[data-iss-day-month]'))).toBe(true);
      expect(side.contains(host.querySelector('[data-iss-weekday]'))).toBe(true);
      expect(side.contains(host.querySelector('[data-iss-edition]'))).toBe(true);
      expect(side.contains(body)).toBe(true);
      expect(clock.contains(host.querySelector('[data-iss-utc]'))).toBe(true);
      expect(clock.contains(host.querySelector('[data-iss-gmt-day]'))).toBe(true);
      expect(clock.contains(host.querySelector('[data-iss-houston]'))).toBe(false);
      const parked = framePx(frame);
      expect(parked.width).toBeGreaterThanOrEqual(240);
      expect(parked.height).toBeGreaterThanOrEqual(160);
      button.click();
      await paint(scene);
      expect(framePx(frame)).toEqual(parked);
      expect(body.style.maxHeight).toBe('');
      box(host, 390, 526);
      box(root, 390, 526);
      window.dispatchEvent(new Event('resize'));
      expect(root.dataset.issSideDock).toBeUndefined();
      expect(clock.contains(host.querySelector('[data-iss-houston]'))).toBe(true);
      box(host, 844, 309);
      box(root, 844, 309);
      window.dispatchEvent(new Event('resize'));
      expect(root.dataset.issSideDock).toBe('on');
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: SHORT_ISS_WINDOW_PX + 1 });
      await paint(scene);
      expect(root.dataset.issSideDock).toBeUndefined();
      expect(clock.contains(host.querySelector('[data-iss-houston]'))).toBe(true);
      expect(clock.contains(host.querySelector('[data-iss-day-month]'))).toBe(true);
      expect(clock.contains(host.querySelector('[data-iss-weekday]'))).toBe(true);
      expect(toolbar.contains(host.querySelector('[data-iss-edition]'))).toBe(true);
      expect(host.querySelector('[data-iss-card]')?.contains(body)).toBe(true);
      expect(view.contains(host.querySelector('[data-iss-launch-card]'))).toBe(true);
      expect(side.contains(host.querySelector('[data-iss-launch-card]'))).toBe(false);
      root.setAttribute('data-iss-fullscreen-active', '');
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 390 });
      await paint(scene);
      expect(root.dataset.issSideDock).toBeUndefined();
      expect(clock.contains(host.querySelector('[data-iss-gmt-day]'))).toBe(true);
      scene.dispose();
      host.remove();
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: previous });
    }
  });

  it('turns the side dock on only for a short wide window', () => {
    expect(sideDockActive(844, 390, false, false)).toBe(true);
    expect(sideDockActive(874, 402, false, false)).toBe(true);
    expect(sideDockActive(844, SHORT_ISS_WINDOW_PX, false, false)).toBe(true);
    expect(sideDockActive(721, 390, false, false)).toBe(true);
    expect(sideDockActive(720, 390, false, false)).toBe(false);
    expect(sideDockActive(844, SHORT_ISS_WINDOW_PX + 1, false, false)).toBe(false);
    expect(sideDockActive(844, 0, false, false)).toBe(false);
    expect(sideDockActive(844, 390, true, false)).toBe(false);
    expect(sideDockActive(844, 390, false, true)).toBe(false);
  });

  it('overlays a side card when the reserved short side is under 80px', () => {
    const tight = sideMeasure(800, 760);
    expect(Math.min(sceneFit(40, 500).widthPx, sceneFit(40, 500).heightPx)).toBeLessThan(80);
    expect(fitIssPane(tight, 'side').launchCardPlace).toBe('over');
    const again = fitIssPane(tight, 'over').launchCardPlace;
    expect(again).toBe('over');
    expect(fitIssPane(sideMeasure(1400, 400), 'side').launchCardPlace).toBe('side');
  });
});

const verifyPad: LaunchSite = {
  eventId: 'verify-ascent',
  name: 'Verify Ascent',
  siteName: 'Verify Pad',
  lat: 28.5,
  lon: -80.6,
  corridor: null,
};

function measureWithShort(short: number): PaneMeasure {
  return {
    paneWidthPx: 390,
    paneHeightPx: 400,
    padXPx: 0,
    padYPx: 0,
    gapPx: 0,
    toolbarPx: 0,
    buttonPx: 0,
    bodyPx: 0,
    bodyMarginPx: 0,
    sideWidthPx: 0,
    labelPx: 1,
    launchCardWidthPx: 300,
    launchCardHeightPx: 400 - short,
    launchCardGapPx: 0,
  };
}

function reservedShort(measure: PaneMeasure): number {
  const fitted = sceneFit(measure.paneWidthPx, measure.paneHeightPx - measure.launchCardHeightPx);
  return Math.min(fitted.widthPx, fitted.heightPx);
}

function sideMeasure(paneWidthPx: number, cardWidthPx: number): PaneMeasure {
  return {
    ...measureWithShort(120),
    paneWidthPx,
    paneHeightPx: 500,
    launchCardWidthPx: cardWidthPx,
    launchCardHeightPx: 40,
  };
}

function framePx(frame: HTMLElement): { width: number; height: number } {
  return {
    width: Number.parseFloat(frame.style.width),
    height: Number.parseFloat(frame.style.height),
  };
}

function expectMarks(width: number, height: number): void {
  const pin = placeLaunchMarks([verifyPad], () => ({ x: width / 2, y: height / 2 }), width, height);
  const arrow = placeLaunchMarks([verifyPad], () => ({ x: -1000, y: height / 2 }), width, height);
  expect(pin.pins.map((mark) => mark.eventId)).toEqual(['verify-ascent']);
  expect(pin.arrows).toEqual([]);
  expect(arrow.pins).toEqual([]);
  expect(arrow.arrows.map((mark) => mark.eventId)).toEqual(['verify-ascent']);
}

async function chooseLaunch(host: HTMLElement): Promise<void> {
  const picker = host.querySelector('[data-iss-launch-picker]');
  if (!(picker instanceof HTMLSelectElement)) throw new Error('missing launch picker');
  const option = [...picker.options].find((entry) => entry.value && entry.value !== 'none');
  if (!option) throw new Error('missing launch option');
  picker.value = option.value;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}

async function mountFitted(
  width: number,
  height: number,
  card: { width: number; height: number },
  chrome: { toolbar?: number; body?: number; select?: boolean; labelHeight?: number; cardBox?: (place: string) => { width: number; height: number } } = {},
): Promise<{
  host: HTMLElement;
  root: HTMLElement;
  frame: HTMLElement;
  body: HTMLElement;
  button: HTMLButtonElement;
  scene: IssScene;
}> {
  const host = document.createElement('div');
  document.body.append(host);
  const item = supported({
    name: 'Northrop Grumman Cygnus NG-21 visiting the long wall',
    assessment: assessment(),
    site: { name: 'Mid-Atlantic Regional Spaceport Pad 0A', lat: 37.8, lon: -75.5 },
  });
  const choice: LaunchSelection = { item, interval: item.capture_intervals[0] ?? null, expired: false };
  const fake = renderer(host);
  const scene = mountIssScene(host, {
    nowMs: () => startMs + 60_000,
    createRenderer: fake.factory,
    drive: 'manual',
    session: { mode: 'horizon' },
    launches: () => [choice],
  });
  const root = host.querySelector('[data-iss-scene]') as HTMLElement;
  const stage = host.querySelector('[data-iss-stage]') as HTMLElement;
  const view = host.querySelector('[data-iss-view]') as HTMLElement;
  const toolbar = host.querySelector('[data-iss-toolbar]') as HTMLElement;
  const port = host.querySelector('[data-iss-port]') as HTMLElement;
  const starboard = host.querySelector('[data-iss-starboard]') as HTMLElement;
  const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
  const body = host.querySelector('[data-iss-telemetry-body]') as HTMLElement;
  const button = host.querySelector('[data-iss-telemetry]') as HTMLButtonElement;
  const controls = host.querySelector('[data-iss-controls]') as HTMLElement;
  const launchCard = host.querySelector('[data-iss-launch-card]') as HTMLElement;
  root.style.padding = '12px';
  root.style.gap = '8px';
  stage.style.gap = '8px';
  view.style.gap = '8px';
  body.style.margin = '0';
  box(host, width, height);
  box(root, width, height);
  Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => chrome.toolbar ?? 44 });
  Object.defineProperty(button, 'offsetHeight', { configurable: true, get: () => 44 });
  Object.defineProperty(controls, 'offsetHeight', { configurable: true, get: () => 44 });
  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => (body.hidden ? 0 : chrome.body ?? 120) });
  Object.defineProperty(port, 'offsetWidth', { configurable: true, get: () => 11 });
  Object.defineProperty(starboard, 'offsetWidth', { configurable: true, get: () => 11 });
  if (chrome.labelHeight !== undefined) {
    const labelHeight = chrome.labelHeight;
    Object.defineProperty(port, 'offsetHeight', { configurable: true, get: () => labelHeight });
    Object.defineProperty(starboard, 'offsetHeight', { configurable: true, get: () => labelHeight });
  }
  Object.defineProperty(launchCard, 'offsetWidth', {
    configurable: true,
    get: () => (chrome.cardBox ? chrome.cardBox(root.dataset.issLaunchPlace || '').width : card.width),
  });
  Object.defineProperty(launchCard, 'offsetHeight', {
    configurable: true,
    get: () => (chrome.cardBox ? chrome.cardBox(root.dataset.issLaunchPlace || '').height : card.height),
  });
  scene.update(shot());
  await paint(scene);
  if (chrome.select !== false) {
    const picker = host.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) throw new Error('missing launch picker');
    picker.value = item.event_id;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await paint(scene);
  }
  return { host, root, frame, body, button, scene };
}
