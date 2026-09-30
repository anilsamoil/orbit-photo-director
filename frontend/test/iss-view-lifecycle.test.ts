import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { issPositionWithAltSGP4 } from '../src/iss-sgp4';
import { mountIssScene, type IssScene } from '../src/iss-view';
import type { IssRenderer, IssRendererFactory, IssRendererHooks } from '../src/iss-view/renderer';
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
    expect(scene).toContain("type: 'vertical-perspective'");
  });
});
