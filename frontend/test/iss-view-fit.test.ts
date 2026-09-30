import { describe, expect, it } from 'vitest';

import { mountIssScene, type IssScene } from '../src/iss-view';
import { sensorField, type SceneSnapshot } from '../src/iss-view/model';
import type { IssAim, IssRenderer, IssRendererFactory, IssRendererHooks } from '../src/iss-view/renderer';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

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
    Object.defineProperty(toolbar, 'offsetHeight', { configurable: true, get: () => 44 });
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
    scene.dispose();
    host.remove();
  });
});
