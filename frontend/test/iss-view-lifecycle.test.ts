import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { issPositionWithAltSGP4 } from '../src/iss-sgp4';
import { mountIssScene, type IssScene } from '../src/iss-view';
import { sceneFrame } from '../src/iss-view/model';
import type { IssAim, IssRenderer, IssRendererFactory, IssRendererHooks } from '../src/iss-view/renderer';
import type { SceneSnapshot } from '../src/iss-view/model';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const startMs = Date.parse(fixture.start);

function track(overrides: Partial<Track> = {}): Track {
  return {
    iss_polynomial: fixture.iss_polynomial,
    tle: fixture.tle,
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 17,
    tle_freshness_factor: 1,
    ...overrides,
  };
}

function shot(version: string, overrides: Partial<Track> = {}): SceneSnapshot {
  return { manifestVersion: version, generatedAtMs: startMs, track: track(overrides) };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeRenderer(options: { ready?: Promise<void>; aim?: () => Promise<void> } = {}): {
  factory: IssRendererFactory;
  destroyed: { n: number };
  aims: number[];
  hooks: { current: IssRendererHooks | null };
} {
  const destroyed = { n: 0 };
  const aims: number[] = [];
  const hooks: { current: IssRendererHooks | null } = { current: null };
  const factory: IssRendererFactory = (_frame, next): IssRenderer => {
    hooks.current = next;
    return {
      ready: () => options.ready ?? Promise.resolve(),
      aim: () => {
        aims.push(aims.length + 1);
        return options.aim ? options.aim() : Promise.resolve();
      },
      resize: () => {},
      destroy: () => {
        destroyed.n += 1;
      },
    };
  };
  return { factory, destroyed, aims, hooks };
}

function mount(host: HTMLElement, factory: IssRendererFactory, now = startMs + 60_000): IssScene {
  return mountIssScene(host, {
    nowMs: () => now,
    createRenderer: factory,
    drive: 'manual',
    session: { mode: 'horizon' },
    onMap: () => {
      host.dataset.map = 'opened';
    },
  });
}

function lastAim(aims: IssAim[]): IssAim {
  const aim = aims[aims.length - 1];
  if (!aim) throw new Error('missing aim');
  return aim;
}

async function ready(scene: IssScene): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
  await scene.paint();
}

describe('ISS scene lifecycle', () => {
  it('stays loading until a snapshot arrives and then paints one pose', async () => {
    const host = document.createElement('div');
    const fake = fakeRenderer();
    const scene = mount(host, fake.factory);
    await ready(scene);
    expect(scene.phase()).toBe('loading');
    expect(host.querySelector('[data-iss-status]')?.textContent).toBe('Loading ISS view');
    expect(host.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('true');
    scene.update(shot('m1'));
    await ready(scene);
    expect(scene.phase()).toBe('running');
    expect(fake.aims.length).toBeGreaterThan(0);
    const published = issPositionWithAltSGP4(track(), startMs + 60_000);
    expect(host.querySelector('[data-iss-status]')?.textContent).toContain('ISS perspective');
    expect(host.querySelector('[data-iss-status]')?.textContent).toContain('Horizon locked · ground-track forward');
    expect(host.querySelector('[data-iss-detail]')?.textContent).toContain('manifest m1');
    expect(published).not.toBeNull();
    if (published) expect(host.textContent).toContain(published.alt_km.toFixed(1));
  });

  it('drops a renderer that becomes ready after dispose', async () => {
    const host = document.createElement('div');
    const gate = deferred();
    const fake = fakeRenderer({ ready: gate.promise });
    const scene = mount(host, fake.factory);
    const generation = scene.generation();
    scene.dispose();
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(scene.phase()).toBe('dormant');
    expect(scene.generation()).toBeGreaterThan(generation);
    expect(host.querySelector('[data-iss-scene]')).toBeNull();
    expect(fake.destroyed.n).toBe(1);
  });

  it('replaces the snapshot in one card and ignores the stale aim', async () => {
    const host = document.createElement('div');
    const gate = deferred();
    let aims = 0;
    const fake = fakeRenderer({
      aim: () => {
        aims += 1;
        return aims === 1 ? gate.promise : Promise.resolve();
      },
    });
    const scene = mount(host, fake.factory);
    await ready(scene);
    scene.update(shot('m1'));
    await Promise.resolve();
    scene.update(shot('m2'));
    gate.resolve();
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
    const detail = host.querySelector('[data-iss-detail]')?.textContent ?? '';
    expect(detail).toContain('manifest m2');
    expect(detail).not.toContain('manifest m1');
  });

  it('suspends, resumes, switches preset, and releases ten entries', async () => {
    const host = document.createElement('div');
    let destroys = 0;
    for (let entry = 0; entry < 10; entry += 1) {
      const fake = fakeRenderer();
      const scene = mount(host, (frame, hooks) => {
        const renderer = fake.factory(frame, hooks);
        const destroy = renderer.destroy;
        renderer.destroy = () => {
          destroys += 1;
          destroy();
        };
        return renderer;
      });
      await ready(scene);
      scene.update(shot('loop'));
      await scene.paint();
      scene.suspend();
      expect(scene.phase()).toBe('suspended');
      const aims = fake.aims.length;
      await scene.paint();
      expect(fake.aims.length).toBe(aims);
      scene.resume();
      expect(scene.phase()).toBe('running');
      const straight = host.querySelector('[data-iss-preset="nadir"]');
      expect(straight).toBeInstanceOf(HTMLButtonElement);
      if (straight instanceof HTMLButtonElement) straight.click();
      expect(scene.mode()).toBe('nadir');
      await scene.paint();
      expect(host.querySelector('[data-iss-status]')?.textContent).toContain('Nadir locked · ground-track forward');
      scene.dispose();
    }
    expect(destroys).toBe(10);
    expect(host.querySelector('[data-iss-scene]')).toBeNull();
  });

  it('shows retry and map when the renderer or the element set fails', async () => {
    const host = document.createElement('div');
    const broken: IssRendererFactory = () => {
      throw new Error('WebGL2 is unavailable');
    };
    const scene = mount(host, broken);
    await ready(scene);
    expect(scene.phase()).toBe('error');
    expect(host.querySelector('[data-iss-status]')?.textContent).toBe('WebGL2 is unavailable');
    expect(host.querySelector('[data-iss-retry]')?.hasAttribute('hidden')).toBe(false);
    const map = host.querySelector('[data-iss-map]');
    expect(map).toBeInstanceOf(HTMLButtonElement);
    if (map instanceof HTMLButtonElement) map.click();
    expect(host.dataset.map).toBe('opened');
    scene.dispose();

    const host2 = document.createElement('div');
    const fake = fakeRenderer();
    const again = mount(host2, fake.factory);
    await ready(again);
    again.update(shot('bad', { tle: undefined }));
    await again.paint();
    expect(again.phase()).toBe('error');
    expect(host2.textContent).toContain('Orbit unavailable · no element set');
    expect(host2.textContent).not.toMatch(/\d+\.\d+°/);
    const generation = again.generation();
    again.retry();
    await again.paint();
    expect(again.generation()).toBeGreaterThan(generation);
    expect(again.phase()).toBe('error');
    expect(host2.textContent).toContain('Orbit unavailable · no element set');
    again.update(shot('recovered'));
    await again.paint();
    expect(again.phase()).toBe('running');
    expect(host2.textContent).toContain('ISS perspective');
    expect(host2.textContent).toMatch(/\d+\.\d+°/);
  });
});

describe('ISS renderer pitch stays off the product map', () => {
  it('keeps maxPitch out of the product adapter', () => {
    const product = readFileSync(resolve(__dirname, '../src/map/adapters/maplibre/index.ts'), 'utf8');
    const scene = readFileSync(resolve(__dirname, '../src/map/adapters/maplibre/iss-view.ts'), 'utf8');
    expect(product).not.toContain('maxPitch');
    expect(scene).toContain('maxPitch: ISS_VIEW_MAX_PITCH_DEG');
    expect(scene).toContain('roll: EARTH_VIEW_ROLL_DEG');
    expect(scene).toContain("type: 'vertical-perspective'");
    expect(scene).toContain('syncPlaceMarkers');
    expect(scene).toContain('iss-place-');
    expect(scene).toContain('collapseAttribution');
  });
});

describe('ISS chrome starts out of the way', () => {
  it('opens with telemetry collapsed and every cupola window aimed', async () => {
    const host = document.createElement('div');
    const fake = fakeRenderer();
    const scene = mount(host, fake.factory);
    await ready(scene);
    const toggle = host.querySelector('[data-iss-telemetry]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-iss-telemetry-body]')?.hasAttribute('hidden')).toBe(true);
    const cupola = host.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    const disabled = [...cupola.options].filter((option) => option.disabled).map((option) => option.value);
    expect(disabled).toEqual([]);
    expect(cupola.querySelector('option[value="1"]')?.textContent).toBe('Window 1 · Port');
    expect(cupola.querySelector('option[value="2"]')?.textContent).toBe('Window 2 · Forward port');
    expect(cupola.querySelector('option[value="3"]')?.textContent).toBe('Window 3 · Forward starboard');
    expect(cupola.querySelector('option[value="4"]')?.textContent).toBe('Window 4 · Starboard');
    expect(cupola.querySelector('option[value="5"]')?.textContent).toBe('Window 5 · Aft starboard');
    expect(cupola.querySelector('option[value="6"]')?.textContent).toBe('Window 6 · Aft port');
    expect(cupola.querySelector('option[value="7"]')?.textContent).toBe('Window 7 · Nadir');
    expect(cupola.querySelector('option[value="7"]')?.hasAttribute('disabled')).toBe(false);
    expect(host.querySelector('[data-iss-port]')?.textContent).toBe('Port');
    expect(host.querySelector('[data-iss-starboard]')?.textContent).toBe('Starboard');
    const stage = host.querySelector('[data-iss-stage]');
    expect(stage?.children[0]).toBe(host.querySelector('[data-iss-starboard]'));
    expect(stage?.children[1]).toBe(host.querySelector('[data-iss-frame]'));
    expect(stage?.children[2]).toBe(host.querySelector('[data-iss-port]'));
    scene.update(shot('m1'));
    await ready(scene);
    cupola.value = '7';
    cupola.dispatchEvent(new Event('change'));
    expect(scene.mode()).toBe('nadir');
    expect(host.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(stage?.children[0]).toBe(host.querySelector('[data-iss-starboard]'));
    expect(stage?.children[2]).toBe(host.querySelector('[data-iss-port]'));
    (host.querySelector('[data-iss-preset="horizon"]') as HTMLElement).click();
    expect(scene.mode()).toBe('horizon');
    expect(cupola.value).toBe('');
  });

  it('pans inside the view, keeps the field of view, and a window restores the lens', async () => {
    const aims: IssAim[] = [];
    let now = startMs + 60_000;
    const host = document.createElement('div');
    const scene = mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      session: { mode: 'horizon' },
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: (aim) => {
          aims.push(aim);
          return Promise.resolve();
        },
        resize: () => {},
        destroy: () => {},
      }),
    });
    await ready(scene);
    scene.update(shot('pan'));
    await scene.paint();
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    const before = lastAim(aims);
    frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, clientX: 200, clientY: 120, pointerType: 'mouse', button: 0, bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 80, clientY: 120, pointerType: 'mouse', bubbles: true,
    }));
    await scene.paint();
    const panned = lastAim(aims);
    expect(panned.pose.altitudeM).toBeCloseTo(before.pose.altitudeM, 3);
    expect(panned.pose.camera.latDeg).toBeCloseTo(before.pose.camera.latDeg, 3);
    expect(panned.pose.camera.lonDeg).toBeCloseTo(before.pose.camera.lonDeg, 3);
    expect(panned.verticalFovDeg).toBeCloseTo(before.verticalFovDeg, 5);
    const aimShift = Math.abs(panned.pose.targetLatDeg - before.pose.targetLatDeg) + Math.abs(panned.pose.targetLonDeg - before.pose.targetLonDeg);
    expect(aimShift).toBeGreaterThan(0.5);
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    const zoomed = lastAim(aims);
    expect(zoomed.verticalFovDeg).toBeLessThan(panned.verticalFovDeg - 1);
    expect(zoomed.pose.targetLatDeg).toBeCloseTo(panned.pose.targetLatDeg, 3);
    expect(zoomed.pose.targetLonDeg).toBeCloseTo(panned.pose.targetLonDeg, 3);
    now += 120_000;
    await scene.paint();
    const later = lastAim(aims);
    const cameraShift = Math.abs(later.pose.camera.latDeg - panned.pose.camera.latDeg) + Math.abs(later.pose.camera.lonDeg - panned.pose.camera.lonDeg);
    const targetShift = Math.abs(later.pose.targetLatDeg - panned.pose.targetLatDeg) + Math.abs(later.pose.targetLonDeg - panned.pose.targetLonDeg);
    expect(cameraShift).toBeGreaterThan(0.05);
    expect(targetShift).toBeGreaterThan(0.05);
    const forwardLater = sceneFrame(track(), now, 'horizon', 0);
    expect(forwardLater.ok).toBe(true);
    if (forwardLater.ok) {
      const yanked = Math.abs(later.pose.targetLatDeg - forwardLater.pose.targetLatDeg) + Math.abs(later.pose.targetLonDeg - forwardLater.pose.targetLonDeg);
      expect(yanked).toBeGreaterThan(0.5);
    }
    if (forwardLater.ok) expect(later.pose.altitudeM).toBeCloseTo(forwardLater.pose.altitudeM, 3);
    expect(later.verticalFovDeg).toBeCloseTo(zoomed.verticalFovDeg, 5);
    const cupola = host.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    cupola.value = '1';
    cupola.dispatchEvent(new Event('change'));
    await scene.paint();
    const port = lastAim(aims);
    expect(host.querySelector('[data-iss-status]')?.textContent).toContain('Window 1 · Port');
    expect(host.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(port.pose.altitudeM).toBeCloseTo(later.pose.altitudeM, 3);
    expect(port.pose.camera.latDeg).toBeCloseTo(later.pose.camera.latDeg, 3);
    const portAim = sceneFrame(track(), now, 'horizon', 0, { azimuthDeg: -90 });
    expect(portAim.ok).toBe(true);
    if (portAim.ok) {
      expect(port.pose.targetLatDeg).toBeCloseTo(portAim.pose.targetLatDeg, 3);
      expect(port.pose.targetLonDeg).toBeCloseTo(portAim.pose.targetLonDeg, 3);
    }
    expect(port.verticalFovDeg).toBeCloseTo(before.verticalFovDeg, 5);
    expect(port.verticalFovDeg).toBeGreaterThan(zoomed.verticalFovDeg + 5);
    frame.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, clientX: 80, clientY: 120, pointerType: 'mouse', bubbles: true,
    }));
    scene.dispose();
  });

  it('Reset and a double tap clear pan and restore the lens field', async () => {
    const aims: IssAim[] = [];
    const now = startMs + 60_000;
    const host = document.createElement('div');
    const scene = mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      session: { mode: 'horizon' },
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: (aim) => {
          aims.push(aim);
          return Promise.resolve();
        },
        resize: () => {},
        destroy: () => {},
      }),
    });
    await ready(scene);
    scene.update(shot('reset'));
    await scene.paint();
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    const lens = lastAim(aims).verticalFovDeg;
    const reset = host.querySelector('[data-iss-reset]') as HTMLButtonElement;
    expect(reset.textContent).toBe('Reset');
    expect(reset.getAttribute('aria-label')).toBe('Reset pan and the 14 mm field. Double-tap the view to do the same.');
    expect(reset.title).toContain('Double-tap');
    expect((host.querySelector('[data-iss-preset="horizon"]') as HTMLButtonElement).title).toBe('Horizon aim');
    expect((host.querySelector('[data-iss-preset="nadir"]') as HTMLButtonElement).title).toBe('Aim straight down');
    expect((host.querySelector('[data-iss-cupola]') as HTMLSelectElement).title).toBe('Window field of view');
    expect(host.querySelector('[data-iss-hint]')?.textContent).toBe('Pinch or scroll the field · double-tap to reset');

    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    const narrow = lastAim(aims).verticalFovDeg;
    expect(narrow).toBeLessThan(lens - 1);
    (host.querySelector('[data-iss-preset="horizon"]') as HTMLElement).click();
    await scene.paint();
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(narrow, 5);

    const cupola = host.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    cupola.value = '1';
    cupola.dispatchEvent(new Event('change'));
    await scene.paint();
    const port = sceneFrame(track(), now, 'horizon', 0, { azimuthDeg: -90 });
    expect(port.ok).toBe(true);
    if (port.ok) {
      expect(lastAim(aims).pose.targetLatDeg).toBeCloseTo(port.pose.targetLatDeg, 3);
      expect(lastAim(aims).pose.targetLonDeg).toBeCloseTo(port.pose.targetLonDeg, 3);
    }
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(lens, 5);

    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    cupola.value = '7';
    cupola.dispatchEvent(new Event('change'));
    await scene.paint();
    expect(scene.mode()).toBe('nadir');
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(lens, 5);
    const nadir = sceneFrame(track(), now, 'nadir', 0);
    expect(nadir.ok).toBe(true);

    frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, clientX: 200, clientY: 120, pointerType: 'touch', button: 0, bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 40, clientY: 40, pointerType: 'touch', bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, clientX: 40, clientY: 40, pointerType: 'touch', bubbles: true,
    }));
    await scene.paint();
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    const dragged = lastAim(aims);
    expect(dragged.verticalFovDeg).toBeLessThan(lens - 1);
    if (nadir.ok) {
      const held = Math.abs(dragged.pose.targetLatDeg - nadir.pose.targetLatDeg) + Math.abs(dragged.pose.targetLonDeg - nadir.pose.targetLonDeg);
      expect(held).toBeGreaterThan(0.5);
    }
    reset.click();
    await scene.paint();
    expect(cupola.value).toBe('7');
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(lens, 5);
    if (nadir.ok) {
      expect(lastAim(aims).pose.targetLatDeg).toBeCloseTo(nadir.pose.targetLatDeg, 3);
      expect(lastAim(aims).pose.targetLonDeg).toBeCloseTo(nadir.pose.targetLonDeg, 3);
    }

    frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, clientX: 200, clientY: 120, pointerType: 'touch', button: 0, bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 40, clientY: 40, pointerType: 'touch', bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, clientX: 40, clientY: 40, pointerType: 'touch', bubbles: true,
    }));
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    expect(lastAim(aims).verticalFovDeg).toBeLessThan(lens - 1);
    if (nadir.ok) {
      const still = Math.abs(lastAim(aims).pose.targetLatDeg - nadir.pose.targetLatDeg) + Math.abs(lastAim(aims).pose.targetLonDeg - nadir.pose.targetLonDeg);
      expect(still).toBeGreaterThan(0.5);
    }
    const tap = (x: number, y: number) => {
      frame.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 1, clientX: x, clientY: y, pointerType: 'touch', button: 0, bubbles: true,
      }));
      frame.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, clientX: x, clientY: y, pointerType: 'touch', bubbles: true,
      }));
    };
    tap(120, 80);
    tap(124, 84);
    await scene.paint();
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(lens, 5);
    if (nadir.ok) {
      expect(lastAim(aims).pose.targetLatDeg).toBeCloseTo(nadir.pose.targetLatDeg, 3);
      expect(lastAim(aims).pose.targetLonDeg).toBeCloseTo(nadir.pose.targetLonDeg, 3);
    }

    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    frame.dispatchEvent(new MouseEvent('dblclick', { clientX: 120, clientY: 80, bubbles: true, cancelable: true }));
    await scene.paint();
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(lens, 5);
    if (nadir.ok) {
      expect(lastAim(aims).pose.targetLatDeg).toBeCloseTo(nadir.pose.targetLatDeg, 3);
    }
    scene.dispose();
  });

  it('shows the active Cupola pane and keeps a hard pan on Earth', async () => {
    const aims: IssAim[] = [];
    const now = startMs + 60_000;
    const host = document.createElement('div');
    const scene = mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      session: { mode: 'nadir' },
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: (aim) => {
          aims.push(aim);
          return Promise.resolve();
        },
        resize: () => {},
        destroy: () => {},
      }),
    });
    await ready(scene);
    scene.update(shot('clamp'));
    await scene.paint();
    const chip = () => host.querySelector('[data-iss-window]') as HTMLElement;
    expect(chip().hidden).toBe(true);

    const cupola = host.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    cupola.value = '3';
    cupola.dispatchEvent(new Event('change'));
    await scene.paint();
    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toBe('W3');
    expect(chip().getAttribute('aria-label')).toBe('Window 3 · Forward starboard');

    (host.querySelector('[data-iss-preset="horizon"]') as HTMLElement).click();
    await scene.paint();
    expect(chip().hidden).toBe(true);

    cupola.value = '1';
    cupola.dispatchEvent(new Event('change'));
    await scene.paint();
    expect(chip().textContent).toBe('W1');
    (host.querySelector('[data-iss-reset]') as HTMLButtonElement).click();
    await scene.paint();
    expect(chip().textContent).toBe('W1');
    expect(cupola.value).toBe('1');

    (host.querySelector('[data-iss-preset="nadir"]') as HTMLElement).click();
    await scene.paint();
    expect(chip().hidden).toBe(true);
    const nadirPitch = lastAim(aims).pose.analyticPitchDeg;
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, clientX: 200, clientY: 200, pointerType: 'mouse', button: 0, bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 2600, clientY: 200, pointerType: 'mouse', bubbles: true,
    }));
    await scene.paint();
    const slammed = lastAim(aims).pose.analyticPitchDeg;
    expect(slammed).toBeGreaterThan(nadirPitch + 20);
    expect(slammed).toBeLessThan(78);
    frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 2520, clientY: 200, pointerType: 'mouse', bubbles: true,
    }));
    await scene.paint();
    expect(lastAim(aims).pose.analyticPitchDeg).toBeLessThan(slammed - 2);
    frame.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, clientX: 2520, clientY: 200, pointerType: 'mouse', bubbles: true,
    }));
    scene.dispose();
  });

  it('shows the optical field while wheeling or pinching and clears it when idle', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    const scene = mountIssScene(host, {
      nowMs: () => startMs,
      drive: 'manual',
      session: { mode: 'horizon' },
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: () => Promise.resolve(),
        resize: () => {},
        destroy: () => {},
      }),
    });
    try {
      const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
      const readout = host.querySelector('[data-iss-fov]') as HTMLElement;
      expect(readout.textContent).toBe('');
      expect(readout.dataset.issFovState).toBe('idle');
      frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
      expect(readout.textContent).toBe('38.4°');
      expect(readout.dataset.issFovState).toBe('live');
      vi.advanceTimersByTime(1000);
      expect(readout.dataset.issFovState).toBe('idle');
      expect(readout.textContent).toBe('38.4°');
      vi.advanceTimersByTime(220);
      expect(readout.textContent).toBe('');
      expect(readout.dataset.issFovState).toBe('idle');

      (host.querySelector('[data-iss-reset]') as HTMLButtonElement).click();
      if (typeof frame.setPointerCapture !== 'function') frame.setPointerCapture = () => {};
      frame.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 80, clientY: 80, bubbles: true }));
      frame.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 140, clientY: 80, bubbles: true }));
      frame.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 260, clientY: 80, bubbles: true }));
      expect(readout.textContent).toBe('27.1°');
      expect(readout.dataset.issFovState).toBe('live');
    } finally {
      scene.dispose();
      vi.useRealTimers();
    }
  });
});
