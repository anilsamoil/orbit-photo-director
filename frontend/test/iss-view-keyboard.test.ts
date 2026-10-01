import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sensorField, type SceneSnapshot } from '../src/iss-view/model';
import { horizontalFovDeg, lookRoom } from '../src/iss-view/look';
import { mountIssScene, type IssScene } from '../src/iss-view';
import type { IssAim, IssRendererFactory } from '../src/iss-view/renderer';
import type { CameraMode } from '../src/iss-view/model';
import type { LookOffset } from '../src/iss-g1/model';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const startMs = Date.parse(fixture.start);
const now = startMs + 60_000;

type AimSession = {
  mode: CameraMode;
  azimuthDeg: number;
  windowId: number | null;
  look: LookOffset;
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
  return { manifestVersion: 'keys', generatedAtMs: startMs, track: track() };
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

function session(): AimSession {
  return {
    mode: 'horizon',
    azimuthDeg: 0,
    windowId: null,
    look: { rightDeg: 0, upDeg: 0 },
    opticalFovDeg: sensorField().vertical,
  };
}

async function running(host: HTMLElement, aims: IssAim[], aim = session()): Promise<{ scene: IssScene; aim: AimSession; frame: HTMLElement }> {
  const scene = mountIssScene(host, {
    nowMs: () => now,
    drive: 'manual',
    session: aim,
    createRenderer: renderer(aims),
  });
  scene.update(shot());
  await scene.paint();
  const frame = host.querySelector('[data-iss-frame]');
  if (!(frame instanceof HTMLElement)) throw new Error('missing frame');
  return { scene, aim, frame };
}

function key(target: EventTarget, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function frameSize(frame: HTMLElement): { width: number; height: number } {
  const width = Number.parseFloat(frame.style.width);
  const height = Number.parseFloat(frame.style.height);
  if (!(width > 1) || !(height > 1)) throw new Error('frame has no size');
  return { width, height };
}

describe('ISS keyboard aim', () => {
  const extra: HTMLElement[] = [];

  beforeEach(() => {
    sessionStorage.clear();
  });

  function mountHost(): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    extra.push(host);
    return host;
  }

  function add(node: HTMLElement): HTMLElement {
    document.body.append(node);
    extra.push(node);
    return node;
  }

  async function finish(scene: IssScene): Promise<void> {
    scene.dispose();
    for (const node of extra) node.remove();
    extra.length = 0;
  }

  it('nudges pan by 4% of the field, eases at the ceiling, and still accepts a drag', async () => {
    const host = mountHost();
    const aims: IssAim[] = [];
    const view = await running(host, aims);
    const size = frameSize(view.frame);
    const horizontal = horizontalFovDeg(view.aim.opticalFovDeg, size.width, size.height);
    const before = aims[aims.length - 1];
    if (!before) throw new Error('missing aim');
    view.frame.focus();
    const right = key(view.frame, 'ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(view.aim.look.rightDeg).toBeCloseTo(0.04 * horizontal, 5);
    expect(view.aim.look.upDeg).toBe(0);
    await view.scene.paint();
    const panned = aims[aims.length - 1];
    if (!panned) throw new Error('missing panned aim');
    const shift = Math.abs(panned.pose.targetLatDeg - before.pose.targetLatDeg) + Math.abs(panned.pose.targetLonDeg - before.pose.targetLonDeg);
    expect(shift).toBeGreaterThan(0.05);
    expect(panned.verticalFovDeg).toBeCloseTo(before.verticalFovDeg, 5);
    key(view.frame, 'ArrowUp');
    expect(view.aim.look.upDeg).toBeCloseTo(0.04 * view.aim.opticalFovDeg, 5);
    key(view.frame, 'ArrowLeft');
    expect(view.aim.look.rightDeg).toBeCloseTo(0, 5);
    key(view.frame, 'ArrowDown');
    expect(view.aim.look.upDeg).toBeLessThan(0.04 * view.aim.opticalFovDeg);
    const room = lookRoom(view.aim.opticalFovDeg, size.width, size.height, panned.pose.limbFromNadirDeg);
    view.aim.look.rightDeg = 0;
    view.aim.look.upDeg = 0;
    for (let step = 0; step < 80; step += 1) key(view.frame, 'ArrowRight');
    expect(view.aim.look.rightDeg).toBeGreaterThan(room.radiusDeg * 0.65);
    expect(view.aim.look.rightDeg).toBeLessThan(room.radiusDeg);
    const eased = view.aim.look.rightDeg;
    key(view.frame, 'ArrowLeft');
    expect(view.aim.look.rightDeg).toBeCloseTo(eased - 0.04 * horizontal, 5);
    const dragged = view.aim.look.rightDeg;
    view.frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, clientX: 200, clientY: 120, pointerType: 'mouse', button: 0, bubbles: true,
    }));
    view.frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 80, clientY: 120, pointerType: 'mouse', bubbles: true,
    }));
    expect(view.aim.look.rightDeg).toBeGreaterThan(dragged);
    view.frame.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, clientX: 80, clientY: 120, pointerType: 'mouse', bubbles: true,
    }));
    await finish(view.scene);
  });

  it('narrows on + and =, widens on - and _, and clamps between 12° and the lens', async () => {
    const host = mountHost();
    const view = await running(host, []);
    const lens = sensorField().vertical;
    view.frame.focus();
    const narrowed = key(view.frame, '=');
    expect(narrowed.defaultPrevented).toBe(true);
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens * 0.96, 5);
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe(`${(lens * 0.96).toFixed(1)}°`);
    expect(host.querySelector('[data-iss-fov]')?.getAttribute('data-iss-fov-state')).toBe('live');
    key(view.frame, '-');
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    key(view.frame, '+');
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens * 0.96, 5);
    key(view.frame, '_');
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    for (let step = 0; step < 80; step += 1) key(view.frame, '=');
    expect(view.aim.opticalFovDeg).toBe(12);
    for (let step = 0; step < 80; step += 1) key(view.frame, '-');
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    await finish(view.scene);
  });

  it('resets on r, R, and Escape, and leaves Escape to an open dialog', async () => {
    const host = mountHost();
    const view = await running(host, []);
    const lens = sensorField().vertical;
    view.frame.focus();
    key(view.frame, '=');
    key(view.frame, 'ArrowRight');
    expect(view.aim.look.rightDeg).not.toBe(0);
    key(view.frame, 'r');
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.windowId).toBeNull();
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    expect(host.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-iss-window]')?.hasAttribute('hidden')).toBe(true);
    key(view.frame, '=');
    key(view.frame, 'R');
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    key(view.frame, 'ArrowUp');
    key(view.frame, 'Escape');
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    key(view.frame, 'ArrowUp');
    const dialog = add(document.createElement('div'));
    dialog.className = 'modal-backdrop';
    const escape = key(document.body, 'Escape');
    expect(escape.defaultPrevented).toBe(false);
    expect(view.aim.look.upDeg).toBeGreaterThan(0);
    dialog.remove();
    await finish(view.scene);
  });

  it('ignores editable fields, command chords, outside focus, and a phase that is not running', async () => {
    const host = mountHost();
    const aims: IssAim[] = [];
    const aim = session();
    const scene = mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      session: aim,
      createRenderer: renderer(aims),
    });
    const frame = host.querySelector('[data-iss-frame]');
    if (!(frame instanceof HTMLElement)) throw new Error('missing frame');
    frame.focus();
    key(frame, 'ArrowRight');
    expect(aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    scene.update(shot());
    await scene.paint();
    const input = add(document.createElement('input'));
    input.focus();
    const typed = key(input, 'ArrowRight');
    expect(typed.defaultPrevented).toBe(false);
    expect(aim.look.rightDeg).toBe(0);
    const area = add(document.createElement('textarea'));
    area.focus();
    key(area, 'ArrowUp');
    expect(aim.look.upDeg).toBe(0);
    const editable = add(document.createElement('div'));
    editable.contentEditable = 'true';
    editable.focus();
    key(editable, 'ArrowRight');
    expect(aim.look.rightDeg).toBe(0);
    const cupola = host.querySelector('[data-iss-cupola]');
    if (!(cupola instanceof HTMLSelectElement)) throw new Error('missing cupola');
    expect(frame.tabIndex).toBe(0);
    cupola.focus();
    const selectKey = key(cupola, 'ArrowDown');
    expect(selectKey.defaultPrevented).toBe(false);
    expect(aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    frame.focus();
    key(frame, 'ArrowLeft');
    expect(aim.look.rightDeg).toBeLessThan(0);
    aim.look.rightDeg = 0;
    frame.focus();
    const chord = key(frame, 'ArrowRight', { ctrlKey: true });
    const command = key(frame, '=', { metaKey: true });
    expect(chord.defaultPrevented).toBe(false);
    expect(command.defaultPrevented).toBe(false);
    expect(aim.look.rightDeg).toBe(0);
    expect(aim.opticalFovDeg).toBeCloseTo(sensorField().vertical, 5);
    const outside = add(document.createElement('button'));
    outside.focus();
    key(outside, 'ArrowRight');
    expect(aim.look.rightDeg).toBe(0);
    const tab = add(document.createElement('button'));
    tab.id = 'tab-iss';
    tab.focus();
    key(tab, 'ArrowRight');
    expect(aim.look.rightDeg).toBeGreaterThan(0);
    aim.look.rightDeg = 0;
    (document.activeElement as HTMLElement).blur();
    key(document.body, 'ArrowRight');
    expect(aim.look.rightDeg).toBeGreaterThan(0);
    const held = aim.look.rightDeg;
    scene.suspend();
    key(document.body, 'ArrowRight');
    expect(aim.look.rightDeg).toBe(held);
    scene.dispose();
    key(document.body, 'ArrowRight');
    expect(aim.look.rightDeg).toBe(held);
    for (const node of extra) node.remove();
    extra.length = 0;
  });
});

describe('ISS keyboard aim persistence', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
  });

  it('writes opd-iss-aim for a key pan and a key field change, and r removes it', async () => {
    const view = await import('../src/iss-view');
    const host = document.createElement('div');
    document.body.append(host);
    const aims: IssAim[] = [];
    const scene = view.mountIssScene(host, {
      nowMs: () => now,
      drive: 'manual',
      createRenderer: renderer(aims),
    });
    scene.update(shot());
    await scene.paint();
    const frame = host.querySelector('[data-iss-frame]');
    if (!(frame instanceof HTMLElement)) throw new Error('missing frame');
    frame.focus();
    key(frame, 'ArrowRight');
    key(frame, '=');
    const stored = JSON.parse(sessionStorage.getItem('opd-iss-aim') ?? 'null') as {
      look: LookOffset;
      opticalFovDeg: number;
    };
    expect(stored.look.rightDeg).toBeGreaterThan(0);
    expect(stored.look.upDeg).toBe(0);
    expect(stored.opticalFovDeg).toBeCloseTo(sensorField().vertical * 0.96, 5);
    expect(view.issPresetSession().look.rightDeg).toBeCloseTo(stored.look.rightDeg, 5);
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(stored.opticalFovDeg, 5);
    key(frame, 'r');
    expect(sessionStorage.getItem('opd-iss-aim')).toBeNull();
    expect(view.issPresetSession().look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(sensorField().vertical, 5);
    scene.dispose();
    host.remove();
  });
});
