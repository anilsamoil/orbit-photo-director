import { describe, expect, it, vi } from 'vitest';

import { mountIssScene, type IssScene } from '../src/iss-view';
import type { SceneSnapshot } from '../src/iss-view/model';
import type { IssAim, IssRendererHooks } from '../src/iss-view/renderer';

import fixture from './fixtures/iss-sgp4-fixture.json';

const start = Date.parse(fixture.start);
const snapshot: SceneSnapshot = {
  manifestVersion: 'retry-recovery',
  generatedAtMs: start,
  track: {
    iss_polynomial: fixture.iss_polynomial,
    tle: fixture.tle,
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 17,
    tle_freshness_factor: 1,
  },
};

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

function last<T>(values: T[]): T {
  const value = values[values.length - 1];
  if (!value) throw new Error('missing captured value');
  return value;
}

describe('ISS renderer recovery', () => {
  it('preserves the lost field only until Retry opens a generation, then requires that camera’s finite field and earth-view roll', async () => {
    const host = document.createElement('div');
    const ready = deferred();
    const applied = deferred();
    const hooks: IssRendererHooks[] = [];
    const aims: IssAim[] = [];
    const scene = mountIssScene(host, {
      nowMs: () => start + 60_000,
      drive: 'manual',
      session: { mode: 'horizon', opticalFovDeg: 56.7 },
      createRenderer: (_frame, next) => {
        hooks.push(next);
        const first = hooks.length === 1;
        return {
          ready: () => first ? Promise.resolve() : ready.promise,
          aim: (aim) => {
            aims.push(aim);
            if (first) aim.onCamera?.(56.7, aim.fovEpoch ?? 0, 180);
            return first ? Promise.resolve() : applied.promise;
          },
          resize() {},
          destroy() {},
        };
      },
    });
    const label = host.querySelector<HTMLElement>('[data-iss-fov]')!;
    const read = () => ({ state: label.dataset.issFovState, text: label.textContent });
    try {
      scene.update(snapshot);
      await settle();
      const retiredAim = last(aims);
      expect(read()).toEqual({ state: 'live', text: '56.7°' });
      last(hooks).onContextLost();
      expect(scene.phase()).toBe('error');
      expect(read()).toEqual({ state: 'live', text: '56.7°' });

      scene.retry();
      scene.retry();
      expect(hooks).toHaveLength(2);
      expect(scene.phase()).toBe('loading');
      expect(read()).toEqual({ state: 'pending', text: '' });
      retiredAim.onCamera?.(56.7, retiredAim.fovEpoch ?? 0, 180);
      expect(read()).toEqual({ state: 'pending', text: '' });

      ready.resolve();
      await settle();
      expect(scene.phase()).toBe('running');
      const currentAim = last(aims);
      const epoch = currentAim.fovEpoch ?? 0;
      expect(currentAim).not.toBe(retiredAim);
      for (const roll of [undefined, 0, 90, Number.NaN, Number.POSITIVE_INFINITY]) {
        currentAim.onCamera?.(47.3, epoch, roll);
        expect(read()).toEqual({ state: 'pending', text: '' });
      }
      currentAim.onCamera?.(Number.NaN, epoch, 180);
      currentAim.onCamera?.(Number.POSITIVE_INFINITY, epoch, 180);
      currentAim.onCamera?.(47.3, epoch - 1, 180);
      retiredAim.onCamera?.(56.7, epoch, 180);
      expect(read()).toEqual({ state: 'pending', text: '' });
      currentAim.onCamera?.(47.3, epoch, 180);
      expect(read()).toEqual({ state: 'live', text: '47.3°' });
      hooks[0]?.onContextLost();
      retiredAim.onCamera?.(56.7, epoch, 180);
      expect(scene.phase()).toBe('running');
      expect(read()).toEqual({ state: 'live', text: '47.3°' });

      void scene.paint();
      expect(read()).toEqual({ state: 'live', text: '47.3°' });
      const laterAim = last(aims);
      laterAim.onCamera?.(45.2, laterAim.fovEpoch ?? 0, 180);
      expect(read()).toEqual({ state: 'live', text: '45.2°' });
    } finally {
      scene.dispose();
      ready.resolve();
      applied.resolve();
      await settle();
    }
  });

  it('runs exactly one automatic orbital loop across repeated Retry, loss during Retry, suspension, and a Map round trip', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 60_000);
    const host = document.createElement('div');
    const hooks: IssRendererHooks[] = [];
    const aims: IssAim[] = [];
    const destroyed: number[] = [];
    let nextReady: Promise<void> | undefined;
    const session = { mode: 'horizon' as const, opticalFovDeg: 56.7 };
    const mount = () => mountIssScene(host, {
      nowMs: () => Date.now(),
      session,
      createRenderer: (_frame, next) => {
        hooks.push(next);
        const ordinal = hooks.length;
        const ready = nextReady ?? Promise.resolve();
        nextReady = undefined;
        return {
          ready: () => ready,
          aim: async (aim: IssAim) => {
            aims.push(aim);
            aim.onCamera?.(aim.verticalFovDeg, aim.fovEpoch ?? 0, 180);
          },
          resize() {},
          destroy() { destroyed.push(ordinal); },
        };
      },
    });
    let scene: IssScene = mount();
    const progress = async () => {
      expect(scene.phase()).toBe('running');
      expect(vi.getTimerCount()).toBe(1);
      const count = aims.length;
      const previous = last(aims);
      const utc = host.querySelector('[data-iss-utc]')?.textContent;
      await vi.advanceTimersByTimeAsync(1500);
      expect(aims.length - count).toBe(3);
      expect(last(aims).lightingUtcMs - previous.lightingUtcMs).toBe(1500);
      expect([last(aims).pose.targetLatDeg, last(aims).pose.targetLonDeg])
        .not.toEqual([previous.pose.targetLatDeg, previous.pose.targetLonDeg]);
      expect(host.querySelector('[data-iss-utc]')?.textContent).not.toBe(utc);
      expect(vi.getTimerCount()).toBe(1);
    };
    const stopped = async () => {
      expect(vi.getTimerCount()).toBe(0);
      const count = aims.length;
      await vi.advanceTimersByTimeAsync(1500);
      expect(aims).toHaveLength(count);
    };
    try {
      scene.update(snapshot);
      await settle();
      await progress();
      for (let retry = 0; retry < 4; retry += 1) {
        const retired = last(hooks);
        retired.onContextLost();
        expect(scene.phase()).toBe('error');
        await stopped();
        const count = hooks.length;
        scene.retry();
        scene.retry();
        expect(hooks).toHaveLength(count + 1);
        await settle();
        retired.onContextLost();
        await progress();
      }

      last(hooks).onContextLost();
      const interrupted = deferred();
      nextReady = interrupted.promise;
      scene.retry();
      expect(scene.phase()).toBe('loading');
      await stopped();
      last(hooks).onContextLost();
      expect(scene.phase()).toBe('error');
      scene.retry();
      await settle();
      interrupted.resolve();
      await settle();
      await progress();

      scene.suspend();
      scene.suspend();
      await stopped();
      scene.resume();
      scene.resume();
      await progress();

      last(hooks).onContextLost();
      const suspendedBoot = deferred();
      nextReady = suspendedBoot.promise;
      scene.retry();
      scene.suspend();
      suspendedBoot.resolve();
      await settle();
      expect(scene.phase()).toBe('suspended');
      await stopped();
      scene.resume();
      await progress();

      last(hooks).onContextLost();
      scene.suspend();
      scene.resume();
      expect(scene.phase()).toBe('error');
      await stopped();
      scene.dispose();
      await stopped();
      expect(new Set(destroyed).size).toBe(hooks.length);
      expect(destroyed).toHaveLength(hooks.length);
      scene = mount();
      scene.update(snapshot);
      await settle();
      expect(last(aims).verticalFovDeg).toBe(56.7);
      await progress();
      scene.dispose();
      await stopped();
    } finally {
      scene.dispose();
      vi.useRealTimers();
    }
  });

  it('restarts automatic paints when fresh orbit data recovers an error without a new renderer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 60_000);
    let count = 0;
    const scene = mountIssScene(document.createElement('div'), {
      nowMs: () => Date.now(),
      session: { mode: 'horizon' },
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: async () => { count += 1; },
        resize() {},
        destroy() {},
      }),
    });
    try {
      scene.update({ ...snapshot, track: { ...snapshot.track, tle: undefined } });
      await settle();
      expect(scene.phase()).toBe('error');
      expect(vi.getTimerCount()).toBe(0);
      scene.update(snapshot);
      await settle();
      expect(scene.phase()).toBe('running');
      expect(vi.getTimerCount()).toBe(1);
      const before = count;
      await vi.advanceTimersByTimeAsync(1500);
      expect(count - before).toBe(3);
    } finally {
      scene.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });
});
