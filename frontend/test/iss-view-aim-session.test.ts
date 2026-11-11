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
      aim.onCamera?.(aim.verticalFovDeg, aim.fovEpoch ?? 0, 180);
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

function issParam(): string | null {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  return new URLSearchParams(hash).get('iss');
}

function setIssParam(json: string | null): void {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  if (json === null) params.delete('iss');
  else params.set('iss', json);
  const nextHash = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`);
}

function forgetAimPlaces(): void {
  sessionStorage.clear();
  localStorage.removeItem(AIM_KEY);
  setIssParam(null);
}

function aimText(aim: StoredAim): string {
  return JSON.stringify({
    mode: aim.mode,
    azimuthDeg: aim.azimuthDeg,
    windowId: aim.windowId,
    look: { rightDeg: aim.look.rightDeg, upDeg: aim.look.upDeg },
    opticalFovDeg: aim.opticalFovDeg,
  });
}

function press(target: EventTarget, name: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
}

const LINK_AIM: StoredAim = {
  mode: 'horizon',
  azimuthDeg: 30,
  windowId: 3,
  look: { rightDeg: -1.25, upDeg: 0.5 },
  opticalFovDeg: 60,
};

const TAB_AIM: StoredAim = {
  mode: 'horizon',
  azimuthDeg: -30,
  windowId: 1,
  look: { rightDeg: 2, upDeg: 0 },
  opticalFovDeg: 40,
};

function expectSession(session: StoredAim, aim: StoredAim): void {
  expect(session.mode).toBe(aim.mode);
  expect(session.azimuthDeg).toBe(aim.azimuthDeg);
  expect(session.windowId).toBe(aim.windowId);
  expect(session.look.rightDeg).toBe(aim.look.rightDeg);
  expect(session.look.upDeg).toBe(aim.look.upDeg);
  expect(session.opticalFovDeg).toBe(aim.opticalFovDeg);
}

async function mountStored(): Promise<{ view: typeof import('../src/iss-view'); scene: IssScene; host: HTMLElement; aims: IssAim[] }> {
  const view = await import('../src/iss-view');
  const host = document.createElement('div');
  document.body.append(host);
  const aims: IssAim[] = [];
  const scene = view.mountIssScene(host, {
    nowMs: () => now,
    drive: 'manual',
    createRenderer: renderer(aims),
  });
  await paint(scene);
  return { view, scene, host, aims };
}

beforeEach(() => {
  forgetAimPlaces();
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

  it('keeps the window and the pinched field across a tab return', async () => {
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
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(narrowed, 5);
    scene.dispose();
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(narrowed, 5);

    const host2 = document.createElement('div');
    const aims2: IssAim[] = [];
    const scene2 = view.mountIssScene(host2, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims2),
    });
    expect((host2.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('3');
    await paint(scene2);
    expect(lastAim(aims2).verticalFovDeg).toBeCloseTo(narrowed, 5);
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(narrowed, 5);
    expect(stored()?.windowId).toBe(3);
    expect(stored()?.opticalFovDeg).toBeCloseTo(narrowed, 5);
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

describe('ISS aim lives in the tab, the link, and the device', () => {
  it('writes both shelves at once and the hash after 1000ms', async () => {
    const view = await import('../src/iss-view');
    const host = document.createElement('div');
    document.body.append(host);
    const scene = view.mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer([]),
    });
    await paint(scene);
    const frame = host.querySelector('[data-iss-frame]');
    if (!(frame instanceof HTMLElement)) throw new Error('missing frame');
    frame.focus();
    vi.useFakeTimers();
    try {
      press(frame, 'ArrowRight');
      const tab = sessionStorage.getItem(AIM_KEY);
      const device = localStorage.getItem(AIM_KEY);
      expect(tab).toBe(device);
      expect(tab).not.toBeNull();
      const parsed = JSON.parse(tab ?? '') as StoredAim;
      expect(parsed.mode).toBe('horizon');
      expect(parsed.look.rightDeg).toBeGreaterThan(0);
      expect(parsed.look.upDeg).toBe(0);
      expect(issParam()).toBeNull();
      vi.advanceTimersByTime(1000);
      expect(issParam()).toBe(tab);
    } finally {
      scene.dispose();
      vi.useRealTimers();
      host.remove();
    }
  });

  it('reset clears both shelves and the hash, and a pending link stays gone', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const view = await import('../src/iss-view');
    const scene = view.mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer([]),
    });
    await paint(scene);
    const frame = host.querySelector('[data-iss-frame]');
    if (!(frame instanceof HTMLElement)) throw new Error('missing frame');
    frame.focus();
    press(frame, 'ArrowRight');
    expect(sessionStorage.getItem(AIM_KEY)).not.toBeNull();
    expect(localStorage.getItem(AIM_KEY)).toBe(sessionStorage.getItem(AIM_KEY));
    expect(issParam()).toBeNull();
    press(frame, 'r');
    expect(sessionStorage.getItem(AIM_KEY)).toBeNull();
    expect(localStorage.getItem(AIM_KEY)).toBeNull();
    expect(issParam()).toBeNull();
    await new Promise((resolve) => {
      setTimeout(resolve, 1200);
    });
    expect(sessionStorage.getItem(AIM_KEY)).toBeNull();
    expect(localStorage.getItem(AIM_KEY)).toBeNull();
    expect(issParam()).toBeNull();
    scene.dispose();
    host.remove();
  });

  it('restores a share link when the tab and the device have no aim', async () => {
    sessionStorage.removeItem(AIM_KEY);
    localStorage.removeItem(AIM_KEY);
    setIssParam(aimText(LINK_AIM));
    vi.resetModules();
    const { view, scene, host, aims } = await mountStored();
    expectSession(view.issPresetSession(), LINK_AIM);
    expect(scene.mode()).toBe('horizon');
    expect((host.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('3');
    expect(host.querySelector('[data-iss-window]')?.textContent).toBe('W3');
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe('60.0°');
    const aimed = lastAim(aims);
    const expected = sceneFrame(track(), now, 'horizon', 0, {
      azimuthDeg: 30,
      offset: { rightDeg: -1.25, upDeg: 0.5 },
    });
    expect(expected.ok).toBe(true);
    if (expected.ok) {
      expect(aimed.pose.targetLatDeg).toBeCloseTo(expected.pose.targetLatDeg, 3);
      expect(aimed.pose.targetLonDeg).toBeCloseTo(expected.pose.targetLonDeg, 3);
    }
    expect(aimed.verticalFovDeg).toBe(60);
    scene.dispose();
    host.remove();
  });

  it('restores localStorage when the tab and the hash are empty', async () => {
    sessionStorage.removeItem(AIM_KEY);
    localStorage.setItem(AIM_KEY, aimText(LINK_AIM));
    setIssParam(null);
    vi.resetModules();
    const { view, scene, host, aims } = await mountStored();
    expectSession(view.issPresetSession(), LINK_AIM);
    expect(scene.mode()).toBe('horizon');
    expect((host.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('3');
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe('60.0°');
    expect(lastAim(aims).verticalFovDeg).toBe(60);
    scene.dispose();
    host.remove();
  });

  it('prefers sessionStorage over the hash', async () => {
    sessionStorage.setItem(AIM_KEY, aimText(TAB_AIM));
    localStorage.removeItem(AIM_KEY);
    setIssParam(aimText(LINK_AIM));
    vi.resetModules();
    const { view, scene, host } = await mountStored();
    expectSession(view.issPresetSession(), TAB_AIM);
    expect(scene.mode()).toBe('horizon');
    expect((host.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('1');
    expect(host.querySelector('[data-iss-window]')?.textContent).toBe('W1');
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe('40.0°');
    scene.dispose();
    host.remove();
  });

  it('prefers a share link over localStorage when the tab is empty', async () => {
    sessionStorage.removeItem(AIM_KEY);
    localStorage.setItem(AIM_KEY, aimText(TAB_AIM));
    setIssParam(aimText(LINK_AIM));
    vi.resetModules();
    const { view, scene, host } = await mountStored();
    expectSession(view.issPresetSession(), LINK_AIM);
    expect(scene.mode()).toBe('horizon');
    expect((host.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('3');
    expect(host.querySelector('[data-iss-window]')?.textContent).toBe('W3');
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe('60.0°');
    scene.dispose();
    host.remove();
  });
});
