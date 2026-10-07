import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { issPositionWithAltSGP4 } from '../src/iss-sgp4';
import { mountIssScene, type IssScene } from '../src/iss-view';
import { sceneFrame, sensorField } from '../src/iss-view/model';
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

function clockLines(host: HTMLElement): string[] {
  return ['[data-iss-houston]', '[data-iss-gmt-day]', '[data-iss-day-month]', '[data-iss-weekday]'].map((selector) => {
    return host.querySelector(selector)?.textContent ?? '';
  });
}

function clockOrder(host: HTMLElement): string[] {
  return [...(host.querySelector('[data-iss-clock]')?.children ?? [])].map((el) => {
    if (el.hasAttribute('data-iss-utc')) return 'utc';
    if (el.hasAttribute('data-iss-gmt-day')) return 'gmt-day';
    if (el.hasAttribute('data-iss-houston')) return 'houston';
    if (el.hasAttribute('data-iss-day-month')) return 'day-month';
    if (el.hasAttribute('data-iss-weekday')) return 'weekday';
    return el.tagName;
  });
}

function clockSizes(host: HTMLElement): Record<string, string> {
  const size = (selector: string): string => {
    const el = host.querySelector(selector);
    return el ? getComputedStyle(el).fontSize : 'missing';
  };
  return {
    utc: size('[data-iss-utc]'),
    gmtDay: size('[data-iss-gmt-day]'),
    edition: size('[data-iss-edition]'),
    houston: size('[data-iss-houston]'),
    dayMonth: size('[data-iss-day-month]'),
    weekday: size('[data-iss-weekday]'),
  };
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

  it('shows Expedition 75 Beta Edition off the earth window', async () => {
    const host = document.createElement('div');
    const fake = fakeRenderer();
    const scene = mount(host, fake.factory);
    await ready(scene);
    const edition = host.querySelector('[data-iss-edition]');
    expect(edition).toBeInstanceOf(HTMLParagraphElement);
    expect(edition?.textContent).toBe('Expedition 75 Beta Edition');
    expect(edition?.closest('[data-iss-toolbar]')).toBe(host.querySelector('[data-iss-toolbar]'));
    expect(host.querySelector('[data-iss-frame]')?.contains(edition ?? null)).toBe(false);
    const page = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    expect(page).not.toContain('Expedition 75 Beta Edition');
    scene.dispose();
  });

  it('keeps the expedition line out of the wide toolbar flow', () => {
    const css = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const toolbar = document.createElement('div');
    toolbar.dataset.issToolbar = '';
    const edition = document.createElement('p');
    edition.dataset.issEdition = '';
    edition.textContent = 'Expedition 75 Beta Edition';
    toolbar.append(edition);
    document.body.append(toolbar);
    const placed = getComputedStyle(edition);
    expect(placed.position).toBe('absolute');
    expect(placed.pointerEvents).toBe('none');
    expect(placed.minHeight).toBe('0');
    toolbar.remove();
    style.remove();
  });

  it('keeps Houston, GMT day, day and month, and weekday on the UTC instant after a scrub and an aim', async () => {
    const host = document.createElement('div');
    const fake = fakeRenderer();
    const clock = { now: Date.parse('2024-10-17T12:01:00Z') };
    const scene = mountIssScene(host, {
      nowMs: () => clock.now,
      createRenderer: fake.factory,
      drive: 'manual',
      session: { mode: 'horizon' },
    });
    await ready(scene);
    scene.update(shot('clock'));
    await ready(scene);
    expect(clockOrder(host)).toEqual(['utc', 'gmt-day', 'houston', 'day-month', 'weekday']);
    expect(host.querySelector('[data-iss-utc]')?.textContent).toBe('12:01:00 UTC');
    expect(clockLines(host)).toEqual(['07:01:00 CDT', 'GMT291', '17 oct', 'Thursday']);

    clock.now = Date.parse('2026-01-01T06:00:00Z');
    (host.querySelector('[data-iss-preset="nadir"]') as HTMLElement).click();
    await ready(scene);
    expect(host.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-iss-utc]')?.textContent).toBe('06:00:00 UTC');
    expect(clockLines(host)).toEqual(['00:00:00 CST', 'GMT001', '1 jan', 'Thursday']);
    scene.dispose();
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
    const failed = host2.querySelector('[data-iss-status]')?.textContent ?? '';
    expect(failed).toContain('Orbit unavailable · no element set');
    expect(failed).not.toMatch(/\d+\.\d+°/);
    expect(host2.querySelector('[data-iss-utc]')?.textContent).toBe('');
    expect(host2.querySelector('[data-iss-houston]')?.textContent).toBe('');
    expect(host2.querySelector('[data-iss-gmt-day]')?.textContent).toBe('');
    expect(host2.querySelector('[data-iss-day-month]')?.textContent).toBe('');
    expect(host2.querySelector('[data-iss-weekday]')?.textContent).toBe('');
    expect(host2.querySelector('[data-iss-fov]')?.textContent).toBe('');
    expect(host2.querySelector('[data-iss-fov]')?.getAttribute('data-iss-fov-state')).toBe('pending');
    const generation = again.generation();
    again.retry();
    await again.paint();
    expect(again.generation()).toBeGreaterThan(generation);
    expect(again.phase()).toBe('error');
    expect(host2.querySelector('[data-iss-status]')?.textContent).toContain('Orbit unavailable · no element set');
    again.update(shot('recovered'));
    await again.paint();
    expect(again.phase()).toBe('running');
    expect(host2.querySelector('[data-iss-status]')?.textContent).toContain('ISS perspective');
    expect(host2.querySelector('[data-iss-status]')?.textContent).toMatch(/\d+\.\d+°/);
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

  it('Horizon keeps a pinch and Cupola windows restore the lens', async () => {
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
    expect((host.querySelector('[data-iss-preset="horizon"]') as HTMLButtonElement).title).toBe('Horizon aim');
    expect((host.querySelector('[data-iss-preset="nadir"]') as HTMLButtonElement).title).toBe('Aim straight down');
    expect((host.querySelector('[data-iss-cupola]') as HTMLSelectElement).title).toBe('Window field of view');
    expect(host.querySelector('[data-iss-hint]')?.textContent).toBe('Pinch or scroll the field');

    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    const narrow = lastAim(aims).verticalFovDeg;
    expect(narrow).toBeLessThan(lens - 1);
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
    frame.dispatchEvent(new MouseEvent('dblclick', { clientX: 120, clientY: 80, bubbles: true, cancelable: true }));
    await scene.paint();
    expect(scene.mode()).toBe('horizon');
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(narrow, 5);
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

  it('keeps the field readout pending until the first camera application', async () => {
    const readyGate = deferred();
    const aimGate = deferred();
    let applied: number | null = null;
    const host = document.createElement('div');
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      drive: 'manual',
      session: { mode: 'horizon' },
      createRenderer: () => ({
        ready: () => readyGate.promise,
        aim: (aim) => {
          applied = aim.verticalFovDeg;
          return aimGate.promise;
        },
        resize: () => {},
        destroy: () => {},
      }),
    });
    const readout = host.querySelector('[data-iss-fov]') as HTMLElement;
    expect(readout.dataset.issFovState).toBe('pending');
    expect(readout.textContent).toBe('');

    scene.update(shot('fov-held'));
    expect(readout.dataset.issFovState).toBe('pending');
    expect(readout.textContent).toBe('');

    readyGate.resolve();
    for (let i = 0; i < 20 && applied === null; i += 1) await Promise.resolve();
    expect(applied).toBeCloseTo(sensorField().vertical, 5);
    expect(scene.phase()).toBe('running');
    expect(readout.dataset.issFovState).toBe('pending');
    expect(readout.textContent).toBe('');

    aimGate.resolve();
    await aimGate.promise;
    expect(readout.dataset.issFovState).toBe('live');
    expect(readout.textContent).toBe(`${sensorField().vertical.toFixed(1)}°`);
    scene.dispose();
  });

  it('shows the optical field on the frame and updates it while wheeling or pinching', async () => {
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
    scene.update(shot('fov-label'));
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    const readout = host.querySelector('[data-iss-fov]') as HTMLElement;
    for (let i = 0; i < 20 && readout.dataset.issFovState !== 'live'; i += 1) {
      await scene.paint();
      await Promise.resolve();
    }
    vi.useFakeTimers();
    try {
      const lens = `${sensorField().vertical.toFixed(1)}°`;
      expect(readout.textContent).toBe(lens);
      expect(readout.dataset.issFovState).toBe('live');
      frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
      expect(readout.textContent).toBe('38.4°');
      expect(readout.dataset.issFovState).toBe('live');
      vi.advanceTimersByTime(1500);
      expect(readout.textContent).toBe('38.4°');
      expect(readout.dataset.issFovState).toBe('live');

      const cupola = host.querySelector('[data-iss-cupola]') as HTMLSelectElement;
      cupola.value = '1';
      cupola.dispatchEvent(new Event('change'));
      expect(readout.textContent).toBe(lens);
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

  it('keeps a pinched optical field when the scene remounts', async () => {
    sessionStorage.clear();
    localStorage.removeItem('opd-iss-aim');
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const params = new URLSearchParams(hash);
    if (params.has('iss')) {
      params.delete('iss');
      const nextHash = params.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`);
    }
    vi.resetModules();
    const view = await import('../src/iss-view');
    const aims: IssAim[] = [];
    const host = document.createElement('div');
    const scene = view.mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      drive: 'manual',
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
    scene.update(shot('fov-hold'));
    await scene.paint();
    const lens = lastAim(aims).verticalFovDeg;
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    if (typeof frame.setPointerCapture !== 'function') frame.setPointerCapture = () => {};
    frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, pointerType: 'touch', clientX: 80, clientY: 80, bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 2, pointerType: 'touch', clientX: 140, clientY: 80, bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 2, pointerType: 'touch', clientX: 260, clientY: 80, bubbles: true,
    }));
    await scene.paint();
    const narrowed = lastAim(aims).verticalFovDeg;
    expect(narrowed).toBeLessThan(lens - 1);
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe(`${narrowed.toFixed(1)}°`);
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(narrowed, 5);
    const stored = JSON.parse(sessionStorage.getItem('opd-iss-aim') ?? 'null') as { opticalFovDeg: number } | null;
    expect(stored?.opticalFovDeg).toBeCloseTo(narrowed, 5);
    scene.dispose();
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(narrowed, 5);

    const host2 = document.createElement('div');
    const aims2: IssAim[] = [];
    const scene2 = view.mountIssScene(host2, {
      nowMs: () => startMs + 60_000,
      drive: 'manual',
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: (aim) => {
          aims2.push(aim);
          return Promise.resolve();
        },
        resize: () => {},
        destroy: () => {},
      }),
    });
    await ready(scene2);
    scene2.update(shot('fov-hold'));
    await scene2.paint();
    expect(lastAim(aims2).verticalFovDeg).toBeCloseTo(narrowed, 5);
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(narrowed, 5);

    (host2.querySelector('[data-iss-preset="nadir"]') as HTMLElement).click();
    await scene2.paint();
    expect(scene2.mode()).toBe('nadir');
    expect(lastAim(aims2).verticalFovDeg).toBeCloseTo(narrowed, 5);

    const cupola = host2.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    cupola.value = '1';
    cupola.dispatchEvent(new Event('change'));
    await scene2.paint();
    expect(lastAim(aims2).verticalFovDeg).toBeCloseTo(lens, 5);
    expect(host2.querySelector('[data-iss-fov]')?.textContent).toBe(`${lens.toFixed(1)}°`);
    scene2.dispose();
    sessionStorage.clear();
    localStorage.removeItem('opd-iss-aim');
    const left = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const leftParams = new URLSearchParams(left);
    if (leftParams.has('iss')) {
      leftParams.delete('iss');
      const nextHash = leftParams.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`);
    }
    vi.resetModules();
  });
});

describe('ISS toolbar text', () => {
  const stacked = ['utc', 'gmt-day', 'houston', 'day-month', 'weekday'];
  const sizes = { utc: '16px', gmtDay: '16px', edition: '16px', houston: '10.88px', dayMonth: '10.88px', weekday: '10.88px' };

  async function mountStyled(): Promise<{ host: HTMLElement; done: () => void }> {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8');
    document.head.append(style);
    const host = document.createElement('div');
    document.body.append(host);
    const scene = mount(host, fakeRenderer().factory);
    await ready(scene);
    scene.update(shot('stack'));
    await ready(scene);
    return {
      host,
      done: () => {
        scene.dispose();
        host.remove();
        style.remove();
      },
    };
  }

  it('puts GMT directly under UTC at the UTC size and keeps Houston, the date, and the weekday small', async () => {
    const { host, done } = await mountStyled();
    try {
      expect(clockOrder(host)).toEqual(stacked);
      expect(host.querySelector('[data-iss-gmt-day]')?.textContent).toBe('GMT291');
      expect(clockSizes(host)).toEqual(sizes);
      expect(getComputedStyle(host.querySelector('[data-iss-gmt-day]') as HTMLElement).minHeight).toBe('0');
    } finally {
      done();
    }
  });

  it('keeps those sizes when the toolbar is a column at 720px and below', async () => {
    const happyDOM = (window as unknown as { happyDOM: { setWindowSize(size: { width: number; height: number }): void } }).happyDOM;
    happyDOM.setWindowSize({ width: 390, height: 844 });
    const { host, done } = await mountStyled();
    try {
      expect(getComputedStyle(host.querySelector('[data-iss-edition]') as HTMLElement).position).toBe('static');
      expect(clockOrder(host)).toEqual(stacked);
      expect(clockSizes(host)).toEqual(sizes);
    } finally {
      done();
      happyDOM.setWindowSize({ width: 1024, height: 768 });
    }
  });

  it('hides the expedition line while the key sheet is open', async () => {
    const editionVisibility = async (open: boolean): Promise<string> => {
      const { host, done } = await mountStyled();
      try {
        if (open) (host.querySelector('[data-iss-aim-help]') as HTMLElement).click();
        expect((host.querySelector('[data-iss-aim-sheet]') as HTMLElement).hidden).toBe(!open);
        return getComputedStyle(host.querySelector('[data-iss-edition]') as HTMLElement).visibility;
      } finally {
        done();
      }
    };
    expect(await editionVisibility(true)).toBe('hidden');
    expect(await editionVisibility(false)).not.toBe('hidden');
  });
});
