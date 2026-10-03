import { describe, expect, it } from 'vitest';

import { mountIssScene, type IssScene } from '../src/iss-view';
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
    const toggle = host.querySelector('[data-iss-telemetry]');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    if (toggle instanceof HTMLButtonElement) toggle.click();
    await paint(scene);
    expect(fake.sizes.at(-1)).toEqual({ widthPx: 757, heightPx: 505 });
    expect(fake.aims.at(-1)?.widthPx).toBe(757);
    expect(fake.aims.at(-1)?.heightPx).toBe(505);
    expect(frame.style.width).toBe('757px');
    expect(frame.style.height).toBe('505px');
    scene.dispose();
    host.remove();
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
});

async function mountFitted(
  width: number,
  height: number,
  card: { width: number; height: number },
  chrome: { toolbar?: number; body?: number } = {},
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
  Object.defineProperty(launchCard, 'offsetWidth', { configurable: true, get: () => card.width });
  Object.defineProperty(launchCard, 'offsetHeight', { configurable: true, get: () => card.height });
  scene.update(shot());
  await paint(scene);
  const picker = host.querySelector('[data-iss-launch-picker]');
  if (!(picker instanceof HTMLSelectElement)) throw new Error('missing launch picker');
  picker.value = item.event_id;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  await paint(scene);
  return { host, root, frame, body, button, scene };
}
