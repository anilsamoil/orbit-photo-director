import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sceneFrame, sensorField, type SceneSnapshot } from '../src/iss-view/model';
import type { IssAim, IssRendererFactory } from '../src/iss-view/renderer';
import type { IssScene } from '../src/iss-view';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

const AIM_KEY = 'opd-iss-aim';

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const startMs = Date.parse(fixture.start);
const now = startMs + 60_000;

type StoredAim = {
  mode: string;
  azimuthDeg: number;
  windowId: number | null;
  look: { rightDeg: number; upDeg: number };
  opticalFovDeg: number;
};

function track(): Track {
  return {
    iss_polynomial: fixture.iss_polynomial,
    tle: fixture.tle,
    tle_epoch: '2024-10-16T18:58:11.999Z',
    tle_age_hours: 17,
    tle_freshness_factor: 1,
  };
}

function shot(): SceneSnapshot {
  return { manifestVersion: 'aim', generatedAtMs: startMs, track: track() };
}

function stored(): StoredAim | null {
  const raw = sessionStorage.getItem(AIM_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as StoredAim;
}

function renderer(aims: IssAim[]): IssRendererFactory {
  return () => ({
    ready: () => Promise.resolve(),
    aim: (aim) => {
      aims.push(aim);
      return Promise.resolve();
    },
    resize: () => {},
    destroy: () => {},
  });
}

function lastAim(aims: IssAim[]): IssAim {
  const aim = aims[aims.length - 1];
  if (!aim) throw new Error('missing aim');
  return aim;
}

async function paint(scene: IssScene): Promise<void> {
  scene.update(shot());
  await scene.paint();
}

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

describe('ISS aim session storage', () => {
  it('restores window 3, the pan, and a narrowed field after a reload', async () => {
    const view = await import('../src/iss-view');
    const aims: IssAim[] = [];
    const host = document.createElement('div');
    const scene = view.mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims),
    });
    await paint(scene);
    const lens = lastAim(aims).verticalFovDeg;
    expect(lens).toBeCloseTo(sensorField().vertical, 5);

    const cupola = host.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    cupola.value = '3';
    cupola.dispatchEvent(new Event('change'));
    await scene.paint();
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, clientX: 200, clientY: 120, pointerType: 'mouse', button: 0, bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 80, clientY: 120, pointerType: 'mouse', bubbles: true,
    }));
    frame.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, clientX: 80, clientY: 120, pointerType: 'mouse', bubbles: true,
    }));
    await scene.paint();
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    const aimed = lastAim(aims);
    expect(aimed.verticalFovDeg).toBeLessThan(lens - 1);
    const bare = sceneFrame(track(), now, 'horizon', 0, { azimuthDeg: 30 });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      const shift = Math.abs(aimed.pose.targetLatDeg - bare.pose.targetLatDeg) + Math.abs(aimed.pose.targetLonDeg - bare.pose.targetLonDeg);
      expect(shift).toBeGreaterThan(0.2);
    }
    const saved = stored();
    expect(saved?.mode).toBe('horizon');
    expect(saved?.windowId).toBe(3);
    expect(saved?.azimuthDeg).toBe(30);
    expect(saved?.opticalFovDeg).toBeCloseTo(aimed.verticalFovDeg, 5);
    expect(Math.abs(saved?.look.rightDeg ?? 0) + Math.abs(saved?.look.upDeg ?? 0)).toBeGreaterThan(0);

    scene.dispose();
    expect(stored()?.opticalFovDeg).toBeCloseTo(aimed.verticalFovDeg, 5);

    vi.resetModules();
    const again = await import('../src/iss-view');
    const host2 = document.createElement('div');
    const aims2: IssAim[] = [];
    const scene2 = again.mountIssScene(host2, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims2),
    });
    expect((host2.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('3');
    expect(host2.querySelector('[data-iss-window]')?.textContent).toBe('W3');
    expect(host2.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('false');
    await paint(scene2);
    const restored = lastAim(aims2);
    expect(restored.verticalFovDeg).toBeCloseTo(aimed.verticalFovDeg, 5);
    expect(restored.pose.targetLatDeg).toBeCloseTo(aimed.pose.targetLatDeg, 2);
    expect(restored.pose.targetLonDeg).toBeCloseTo(aimed.pose.targetLonDeg, 2);
    scene2.dispose();
  });

  it('keeps the window across a tab return and leaves the stored field for reload', async () => {
    const view = await import('../src/iss-view');
    const aims: IssAim[] = [];
    const host = document.createElement('div');
    const scene = view.mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims),
    });
    await paint(scene);
    const lens = lastAim(aims).verticalFovDeg;
    const cupola = host.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    cupola.value = '3';
    cupola.dispatchEvent(new Event('change'));
    await scene.paint();
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    const narrowed = lastAim(aims).verticalFovDeg;
    expect(narrowed).toBeLessThan(lens - 1);
    scene.dispose();

    const host2 = document.createElement('div');
    const aims2: IssAim[] = [];
    const scene2 = view.mountIssScene(host2, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims2),
    });
    expect((host2.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('3');
    await paint(scene2);
    expect(lastAim(aims2).verticalFovDeg).toBeCloseTo(lens, 5);
    expect(stored()?.windowId).toBe(3);
    expect(stored()?.opticalFovDeg).toBeCloseTo(narrowed, 5);
    scene2.dispose();
  });

  it('Reset and a double-tap clear storage so a reload starts on Horizon', async () => {
    const view = await import('../src/iss-view');
    const aims: IssAim[] = [];
    const host = document.createElement('div');
    const scene = view.mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims),
    });
    await paint(scene);
    const lens = lastAim(aims).verticalFovDeg;
    const cupola = host.querySelector('[data-iss-cupola]') as HTMLSelectElement;
    const frame = host.querySelector('[data-iss-frame]') as HTMLElement;
    cupola.value = '3';
    cupola.dispatchEvent(new Event('change'));
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    expect(stored()?.windowId).toBe(3);
    expect(stored()?.opticalFovDeg).toBeLessThan(lens - 1);

    (host.querySelector('[data-iss-reset]') as HTMLButtonElement).click();
    await scene.paint();
    expect(scene.mode()).toBe('horizon');
    expect(cupola.value).toBe('');
    expect(host.querySelector('[data-iss-window]')?.hasAttribute('hidden')).toBe(true);
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(lens, 5);
    expect(sessionStorage.getItem(AIM_KEY)).toBeNull();
    const horizon = sceneFrame(track(), now, 'horizon', 0);
    expect(horizon.ok).toBe(true);
    if (horizon.ok) {
      expect(lastAim(aims).pose.targetLatDeg).toBeCloseTo(horizon.pose.targetLatDeg, 3);
      expect(lastAim(aims).pose.targetLonDeg).toBeCloseTo(horizon.pose.targetLonDeg, 3);
    }

    cupola.value = '3';
    cupola.dispatchEvent(new Event('change'));
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    await scene.paint();
    expect(stored()?.windowId).toBe(3);
    frame.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await scene.paint();
    expect(scene.mode()).toBe('horizon');
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(lens, 5);
    expect(sessionStorage.getItem(AIM_KEY)).toBeNull();
    scene.dispose();

    vi.resetModules();
    const again = await import('../src/iss-view');
    const host2 = document.createElement('div');
    const aims2: IssAim[] = [];
    const scene2 = again.mountIssScene(host2, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims2),
    });
    expect(host2.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((host2.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('');
    await paint(scene2);
    expect(scene2.mode()).toBe('horizon');
    expect(lastAim(aims2).verticalFovDeg).toBeCloseTo(sensorField().vertical, 5);
    expect(sessionStorage.getItem(AIM_KEY)).toBeNull();
    scene2.dispose();
  });

  it('starts on Horizon with the lens field when the session has no aim', async () => {
    expect(sessionStorage.getItem(AIM_KEY)).toBeNull();
    const view = await import('../src/iss-view');
    const aims: IssAim[] = [];
    const host = document.createElement('div');
    const scene = view.mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims),
    });
    expect(host.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((host.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('');
    expect(host.querySelector('[data-iss-window]')?.hasAttribute('hidden')).toBe(true);
    await paint(scene);
    expect(scene.mode()).toBe('horizon');
    expect(lastAim(aims).verticalFovDeg).toBeCloseTo(sensorField().vertical, 5);
    expect(sessionStorage.getItem(AIM_KEY)).toBeNull();
    scene.dispose();
  });
});
