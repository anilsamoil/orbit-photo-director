import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUPOLA_WINDOWS } from '../src/iss-view/cupola';
import { sceneFrame, sensorField, type SceneSnapshot } from '../src/iss-view/model';
import { horizontalFovDeg, lookRoom } from '../src/iss-view/look';
import { formatOpticalFov, mountIssScene, type IssScene } from '../src/iss-view';
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

function stripIssHash(): void {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  if (!params.has('iss')) return;
  params.delete('iss');
  const nextHash = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`);
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

describe('optical field label', () => {
  it('formats degrees with one decimal', () => {
    expect(formatOpticalFov(72)).toBe('72.0°');
    expect(formatOpticalFov(81.20258929000894)).toBe('81.2°');
    expect(formatOpticalFov(12)).toBe('12.0°');
  });
});

describe('ISS keyboard aim', () => {
  const extra: HTMLElement[] = [];

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.removeItem('opd-iss-aim');
    stripIssHash();
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

  it('pans a quarter of the arrow step when Shift is held', async () => {
    const host = mountHost();
    const aims: IssAim[] = [];
    const view = await running(host, aims);
    view.frame.focus();
    key(view.frame, 'ArrowRight');
    const plainRight = view.aim.look.rightDeg;
    expect(plainRight).toBeGreaterThan(0);
    key(view.frame, 'ArrowUp');
    const plainUp = view.aim.look.upDeg;
    expect(plainUp).toBeGreaterThan(0);
    view.aim.look.rightDeg = 0;
    view.aim.look.upDeg = 0;
    await view.scene.paint();
    const origin = aims[aims.length - 1];
    if (!origin) throw new Error('missing origin aim');
    const fine = key(view.frame, 'ArrowRight', { shiftKey: true });
    expect(fine.defaultPrevented).toBe(true);
    expect(view.aim.look.rightDeg).toBeCloseTo(plainRight / 4, 5);
    expect(view.aim.look.rightDeg).toBeLessThan(plainRight);
    expect(view.aim.look.upDeg).toBe(0);
    await view.scene.paint();
    const panned = aims[aims.length - 1];
    if (!panned) throw new Error('missing fine aim');
    const moved = Math.abs(panned.pose.targetLatDeg - origin.pose.targetLatDeg) + Math.abs(panned.pose.targetLonDeg - origin.pose.targetLonDeg);
    expect(moved).toBeGreaterThan(0);
    expect(panned.verticalFovDeg).toBeCloseTo(origin.verticalFovDeg, 5);
    view.aim.look.rightDeg = 0;
    key(view.frame, 'ArrowLeft', { shiftKey: true });
    expect(view.aim.look.rightDeg).toBeCloseTo(-(plainRight / 4), 5);
    view.aim.look.upDeg = 0;
    key(view.frame, 'ArrowUp', { shiftKey: true });
    expect(view.aim.look.upDeg).toBeCloseTo(plainUp / 4, 5);
    const up = view.aim.look.upDeg;
    key(view.frame, 'ArrowDown', { shiftKey: true });
    expect(view.aim.look.upDeg).toBeCloseTo(up - plainUp / 4, 5);
    const held = view.aim.look.rightDeg;
    const input = add(document.createElement('input'));
    input.focus();
    const typed = key(input, 'ArrowRight', { shiftKey: true });
    expect(typed.defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBe(held);
    const area = add(document.createElement('textarea'));
    area.focus();
    expect(key(area, 'ArrowUp', { shiftKey: true }).defaultPrevented).toBe(false);
    const editable = add(document.createElement('div'));
    editable.contentEditable = 'true';
    editable.focus();
    expect(key(editable, 'ArrowLeft', { shiftKey: true }).defaultPrevented).toBe(false);
    const cupola = host.querySelector('[data-iss-cupola]');
    if (!(cupola instanceof HTMLSelectElement)) throw new Error('missing cupola');
    cupola.focus();
    expect(key(cupola, 'ArrowDown', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBe(held);
    expect(view.aim.look.upDeg).toBeCloseTo(0, 5);
    view.frame.focus();
    expect(key(view.frame, 'ArrowRight', { shiftKey: true, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(view.frame, 'ArrowRight', { shiftKey: true, metaKey: true }).defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBe(held);
    const dialog = add(document.createElement('div'));
    dialog.className = 'modal-backdrop';
    expect(key(view.frame, 'ArrowRight', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBe(held);
    dialog.remove();
    const help = host.querySelector('[data-iss-aim-help]');
    if (!(help instanceof HTMLButtonElement)) throw new Error('missing key help');
    help.click();
    const blocked = key(view.frame, 'ArrowRight', { shiftKey: true });
    expect(blocked.defaultPrevented).toBe(true);
    expect(view.aim.look.rightDeg).toBe(held);
    help.click();
    view.scene.suspend();
    expect(key(view.frame, 'ArrowRight', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBe(held);
    await finish(view.scene);
  });

  it('pans with w a s d on the arrow step and quarters that step with Shift', async () => {
    const host = mountHost();
    const aims: IssAim[] = [];
    const view = await running(host, aims);
    view.frame.focus();
    key(view.frame, 'ArrowRight');
    const plainRight = view.aim.look.rightDeg;
    key(view.frame, 'ArrowUp');
    const plainUp = view.aim.look.upDeg;
    view.aim.look.rightDeg = 0;
    view.aim.look.upDeg = 0;
    key(view.frame, 'ArrowDown');
    const plainDown = view.aim.look.upDeg;
    expect(plainDown).toBeLessThan(0);
    view.aim.look.upDeg = 0;
    const pairs: ReadonlyArray<readonly [string, 'rightDeg' | 'upDeg', number]> = [
      ['d', 'rightDeg', plainRight],
      ['D', 'rightDeg', plainRight],
      ['a', 'rightDeg', -plainRight],
      ['A', 'rightDeg', -plainRight],
      ['w', 'upDeg', plainUp],
      ['W', 'upDeg', plainUp],
      ['s', 'upDeg', plainDown],
      ['S', 'upDeg', plainDown],
    ];
    for (const [name, axis, step] of pairs) {
      view.aim.look.rightDeg = 0;
      view.aim.look.upDeg = 0;
      const pressed = key(view.frame, name);
      expect(pressed.defaultPrevented).toBe(true);
      expect(view.aim.look[axis]).toBeCloseTo(step, 5);
      expect(view.aim.look[axis === 'rightDeg' ? 'upDeg' : 'rightDeg']).toBe(0);
      expect(view.aim.mode).toBe('horizon');
    }
    view.aim.look.rightDeg = 0;
    view.aim.look.upDeg = 0;
    await view.scene.paint();
    const origin = aims[aims.length - 1];
    if (!origin) throw new Error('missing origin aim');
    const fine = key(view.frame, 'D', { shiftKey: true });
    expect(fine.defaultPrevented).toBe(true);
    expect(view.aim.look.rightDeg).toBeCloseTo(plainRight / 4, 5);
    expect(view.aim.look.upDeg).toBe(0);
    await view.scene.paint();
    const panned = aims[aims.length - 1];
    if (!panned) throw new Error('missing letter aim');
    const moved = Math.abs(panned.pose.targetLatDeg - origin.pose.targetLatDeg) + Math.abs(panned.pose.targetLonDeg - origin.pose.targetLonDeg);
    expect(moved).toBeGreaterThan(0);
    expect(panned.verticalFovDeg).toBeCloseTo(origin.verticalFovDeg, 5);
    view.aim.look.rightDeg = 0;
    key(view.frame, 'd', { shiftKey: true });
    expect(view.aim.look.rightDeg).toBeCloseTo(plainRight / 4, 5);
    view.aim.look.rightDeg = 0;
    key(view.frame, 'A', { shiftKey: true });
    expect(view.aim.look.rightDeg).toBeCloseTo(-(plainRight / 4), 5);
    view.aim.look.rightDeg = 0;
    key(view.frame, 'a', { shiftKey: true });
    expect(view.aim.look.rightDeg).toBeCloseTo(-(plainRight / 4), 5);
    view.aim.look.upDeg = 0;
    key(view.frame, 'W', { shiftKey: true });
    expect(view.aim.look.upDeg).toBeCloseTo(plainUp / 4, 5);
    view.aim.look.upDeg = 0;
    key(view.frame, 'w', { shiftKey: true });
    expect(view.aim.look.upDeg).toBeCloseTo(plainUp / 4, 5);
    view.aim.look.rightDeg = 0;
    view.aim.look.upDeg = 0;
    key(view.frame, 'ArrowDown', { shiftKey: true });
    const fineDown = view.aim.look.upDeg;
    expect(fineDown).toBeLessThan(0);
    expect(fineDown).toBeGreaterThan(plainDown);
    view.aim.look.upDeg = 0;
    const fineS = key(view.frame, 's', { shiftKey: true });
    expect(fineS.defaultPrevented).toBe(true);
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.look.upDeg).toBeCloseTo(fineDown, 5);
    expect(view.aim.look.rightDeg).toBe(0);
    view.aim.look.upDeg = 0;
    const fineShiftS = key(view.frame, 'S', { shiftKey: true });
    expect(fineShiftS.defaultPrevented).toBe(true);
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.look.upDeg).toBeCloseTo(fineDown, 5);
    view.aim.look.upDeg = plainDown;
    key(view.frame, 'ArrowDown', { shiftKey: true });
    const further = view.aim.look.upDeg;
    expect(further).toBeLessThan(plainDown);
    view.aim.look.upDeg = plainDown;
    key(view.frame, 's', { shiftKey: true });
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.look.upDeg).toBeCloseTo(further, 5);
    view.aim.look.upDeg = plainDown;
    key(view.frame, 'S', { shiftKey: true });
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.look.upDeg).toBeCloseTo(further, 5);
    view.aim.look.rightDeg = plainRight;
    view.aim.look.upDeg = 0;
    const held = view.aim.look.rightDeg;
    expect(held).toBeCloseTo(plainRight, 5);
    expect(view.aim.mode).toBe('horizon');
    const input = add(document.createElement('input'));
    input.focus();
    expect(key(input, 'd').defaultPrevented).toBe(false);
    expect(key(input, 'D', { shiftKey: true }).defaultPrevented).toBe(false);
    const area = add(document.createElement('textarea'));
    area.focus();
    expect(key(area, 'w', { shiftKey: true }).defaultPrevented).toBe(false);
    const editable = add(document.createElement('div'));
    editable.contentEditable = 'true';
    editable.focus();
    expect(key(editable, 'a', { shiftKey: true }).defaultPrevented).toBe(false);
    const cupola = host.querySelector('[data-iss-cupola]');
    if (!(cupola instanceof HTMLSelectElement)) throw new Error('missing cupola');
    cupola.focus();
    expect(key(cupola, 'd').defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBeCloseTo(held, 5);
    expect(view.aim.mode).toBe('horizon');
    view.frame.focus();
    expect(key(view.frame, 'd', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(view.frame, 'W', { shiftKey: true, metaKey: true }).defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBeCloseTo(held, 5);
    const dialog = add(document.createElement('div'));
    dialog.className = 'modal-backdrop';
    expect(key(view.frame, 'a').defaultPrevented).toBe(false);
    expect(key(view.frame, 's').defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBeCloseTo(held, 5);
    expect(view.aim.look.upDeg).toBe(0);
    expect(view.aim.mode).toBe('horizon');
    dialog.remove();
    const help = host.querySelector('[data-iss-aim-help]');
    if (!(help instanceof HTMLButtonElement)) throw new Error('missing key help');
    help.click();
    const blocked = key(view.frame, 'd');
    expect(blocked.defaultPrevented).toBe(true);
    expect(view.aim.look.rightDeg).toBeCloseTo(held, 5);
    help.click();
    view.scene.suspend();
    expect(key(view.frame, 'd').defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBeCloseTo(held, 5);
    await finish(view.scene);
  });

  it('narrows on + and =, widens on - and _, and clamps between 12° and the lens', async () => {
    const host = mountHost();
    const view = await running(host, []);
    const lens = sensorField().vertical;
    view.frame.focus();
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe(`${lens.toFixed(1)}°`);
    const narrowed = key(view.frame, '=');
    expect(narrowed.defaultPrevented).toBe(true);
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens * 0.96, 5);
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe(`${(lens * 0.96).toFixed(1)}°`);
    expect(host.querySelector('[data-iss-fov]')?.getAttribute('data-iss-fov-state')).toBe('live');
    key(view.frame, '-');
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    expect(host.querySelector('[data-iss-fov]')?.textContent).toBe(`${lens.toFixed(1)}°`);
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
    key(frame, '3');
    key(frame, 'n');
    expect(aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
    scene.update(shot());
    await scene.paint();
    frame.focus();
    key(frame, 'ArrowRight');
    const panned = aim.look.rightDeg;
    expect(panned).toBeGreaterThan(0);
    const input = add(document.createElement('input'));
    input.focus();
    const typed = key(input, 'ArrowRight');
    const typedDigit = key(input, '1');
    const typedStraight = key(input, 'n');
    const typedHorizon = key(input, 'H');
    expect(typed.defaultPrevented).toBe(false);
    expect(typedDigit.defaultPrevented).toBe(false);
    expect(typedStraight.defaultPrevented).toBe(false);
    expect(typedHorizon.defaultPrevented).toBe(false);
    expect(aim.look.rightDeg).toBe(panned);
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
    const area = add(document.createElement('textarea'));
    area.focus();
    key(area, 'ArrowUp');
    key(area, '3');
    key(area, 'N');
    expect(aim.look.rightDeg).toBe(panned);
    expect(aim.look.upDeg).toBe(0);
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
    const editable = add(document.createElement('div'));
    editable.contentEditable = 'true';
    editable.focus();
    key(editable, 'ArrowRight');
    key(editable, '2');
    key(editable, 'h');
    expect(aim.look.rightDeg).toBe(panned);
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
    aim.look.rightDeg = 0;
    const cupola = host.querySelector('[data-iss-cupola]');
    if (!(cupola instanceof HTMLSelectElement)) throw new Error('missing cupola');
    expect(frame.tabIndex).toBe(0);
    cupola.focus();
    const selectKey = key(cupola, 'ArrowDown');
    const selectDigit = key(cupola, '4');
    const selectPreset = key(cupola, 'n');
    expect(selectKey.defaultPrevented).toBe(false);
    expect(selectDigit.defaultPrevented).toBe(false);
    expect(selectPreset.defaultPrevented).toBe(false);
    expect(aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
    expect(cupola.value).toBe('');
    frame.focus();
    key(frame, 'ArrowLeft');
    expect(aim.look.rightDeg).toBeLessThan(0);
    const chordLook = aim.look.rightDeg;
    const presetChord = key(frame, 'n', { ctrlKey: true });
    const presetCommand = key(frame, 'h', { metaKey: true });
    expect(presetChord.defaultPrevented).toBe(false);
    expect(presetCommand.defaultPrevented).toBe(false);
    expect(aim.look.rightDeg).toBe(chordLook);
    expect(aim.mode).toBe('horizon');
    aim.look.rightDeg = 0;
    frame.focus();
    const chord = key(frame, 'ArrowRight', { ctrlKey: true });
    const command = key(frame, '=', { metaKey: true });
    const digitChord = key(frame, '5', { ctrlKey: true });
    const digitCommand = key(frame, '6', { metaKey: true });
    expect(chord.defaultPrevented).toBe(false);
    expect(command.defaultPrevented).toBe(false);
    expect(digitChord.defaultPrevented).toBe(false);
    expect(digitCommand.defaultPrevented).toBe(false);
    expect(aim.look.rightDeg).toBe(0);
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
    expect(aim.opticalFovDeg).toBeCloseTo(sensorField().vertical, 5);
    const outside = add(document.createElement('button'));
    outside.focus();
    key(outside, 'ArrowRight');
    key(outside, '7');
    key(outside, 'n');
    expect(aim.look.rightDeg).toBe(0);
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
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
    key(document.body, '3');
    key(document.body, 'n');
    expect(aim.look.rightDeg).toBe(held);
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
    scene.dispose();
    key(document.body, 'ArrowRight');
    key(document.body, '1');
    key(document.body, 'h');
    expect(aim.look.rightDeg).toBe(held);
    expect(aim.windowId).toBeNull();
    expect(aim.mode).toBe('horizon');
    for (const node of extra) node.remove();
    extra.length = 0;
  });

  it('selects Cupola windows 1 through 7 on the same aim as the select', async () => {
    const host = mountHost();
    const aims: IssAim[] = [];
    const view = await running(host, aims);
    const lens = sensorField().vertical;
    view.frame.focus();
    key(view.frame, '=');
    key(view.frame, 'ArrowRight');
    expect(view.aim.look.rightDeg).toBeGreaterThan(0);
    expect(view.aim.opticalFovDeg).toBeLessThan(lens);
    (document.activeElement as HTMLElement).blur();
    const fromBody = key(document.body, '1');
    expect(fromBody.defaultPrevented).toBe(true);
    expect(view.aim.windowId).toBe(1);
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    view.frame.focus();

    for (const entry of CUPOLA_WINDOWS) {
      const pressed = key(view.frame, String(entry.id));
      expect(pressed.defaultPrevented).toBe(true);
      expect(view.aim.windowId).toBe(entry.id);
      expect(view.aim.mode).toBe(entry.mode);
      expect(view.aim.azimuthDeg).toBe(entry.azimuthDeg);
      expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
      expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
      const cupola = host.querySelector('[data-iss-cupola]');
      if (!(cupola instanceof HTMLSelectElement)) throw new Error('missing cupola');
      expect(cupola.value).toBe(String(entry.id));
      const chip = host.querySelector('[data-iss-window]');
      expect(chip?.textContent).toBe(`W${entry.id}`);
      expect(chip?.getAttribute('aria-label')).toBe(entry.label);
      expect(chip?.hasAttribute('hidden')).toBe(false);
      expect(host.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('false');
      expect(host.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe(entry.mode === 'nadir' ? 'true' : 'false');
      await view.scene.paint();
      const aimed = aims[aims.length - 1];
      if (!aimed) throw new Error('missing aim');
      const expected = sceneFrame(track(), now, entry.mode, 0, { azimuthDeg: entry.azimuthDeg });
      expect(expected.ok).toBe(true);
      if (expected.ok) {
        expect(aimed.pose.targetLatDeg).toBeCloseTo(expected.pose.targetLatDeg, 3);
        expect(aimed.pose.targetLonDeg).toBeCloseTo(expected.pose.targetLonDeg, 3);
      }
      expect(aimed.verticalFovDeg).toBeCloseTo(lens, 5);
      if (entry.mode === 'horizon') {
        expect(host.querySelector('[data-iss-status]')?.textContent).toContain(entry.label);
      }
    }

    const cupola = host.querySelector('[data-iss-cupola]');
    if (!(cupola instanceof HTMLSelectElement)) throw new Error('missing cupola');
    cupola.value = '2';
    cupola.dispatchEvent(new Event('change'));
    expect(view.aim.windowId).toBe(2);
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.azimuthDeg).toBe(-30);
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(cupola.value).toBe('2');
    expect(host.querySelector('[data-iss-window]')?.textContent).toBe('W2');
    view.frame.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, clientX: 200, clientY: 120, pointerType: 'mouse', button: 0, bubbles: true,
    }));
    view.frame.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: 80, clientY: 120, pointerType: 'mouse', bubbles: true,
    }));
    expect(view.aim.look.rightDeg).toBeGreaterThan(0);
    expect(view.aim.windowId).toBe(2);
    view.frame.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, clientX: 80, clientY: 120, pointerType: 'mouse', bubbles: true,
    }));
    await finish(view.scene);
  });

  it('selects Horizon and Straight down on the same path as those buttons', async () => {
    const host = mountHost();
    const aims: IssAim[] = [];
    const view = await running(host, aims);
    const lens = sensorField().vertical;
    view.frame.focus();
    key(view.frame, '=');
    key(view.frame, 'ArrowRight');
    const pinched = view.aim.opticalFovDeg;
    expect(pinched).toBeLessThan(lens);
    expect(view.aim.look.rightDeg).toBeGreaterThan(0);

    const straight = key(view.frame, 'n');
    expect(straight.defaultPrevented).toBe(true);
    expect(view.aim.mode).toBe('nadir');
    expect(view.aim.azimuthDeg).toBe(0);
    expect(view.aim.windowId).toBeNull();
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.aim.opticalFovDeg).toBeCloseTo(pinched, 5);
    expect(host.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('[data-iss-window]')?.hasAttribute('hidden')).toBe(true);
    const cupola = host.querySelector('[data-iss-cupola]');
    if (!(cupola instanceof HTMLSelectElement)) throw new Error('missing cupola');
    expect(cupola.value).toBe('');
    await view.scene.paint();
    const nadirAim = aims[aims.length - 1];
    if (!nadirAim) throw new Error('missing aim');
    const expectedNadir = sceneFrame(track(), now, 'nadir', 0);
    expect(expectedNadir.ok).toBe(true);
    if (expectedNadir.ok) {
      expect(nadirAim.pose.targetLatDeg).toBeCloseTo(expectedNadir.pose.targetLatDeg, 3);
      expect(nadirAim.pose.targetLonDeg).toBeCloseTo(expectedNadir.pose.targetLonDeg, 3);
    }
    expect(nadirAim.verticalFovDeg).toBeCloseTo(pinched, 5);
    expect(host.querySelector('[data-iss-status]')?.textContent).toContain('Nadir locked');

    key(view.frame, 'ArrowRight');
    (host.querySelector('[data-iss-preset="nadir"]') as HTMLElement).click();
    expect(view.aim.mode).toBe('nadir');
    expect(view.aim.windowId).toBeNull();
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.aim.opticalFovDeg).toBeCloseTo(pinched, 5);

    key(view.frame, 'ArrowLeft');
    const horizonKey = key(view.frame, 'H');
    expect(horizonKey.defaultPrevented).toBe(true);
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.azimuthDeg).toBe(0);
    expect(view.aim.windowId).toBeNull();
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.aim.opticalFovDeg).toBeCloseTo(pinched, 5);
    expect(host.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('false');
    await view.scene.paint();
    const horizonAim = aims[aims.length - 1];
    if (!horizonAim) throw new Error('missing aim');
    const expectedHorizon = sceneFrame(track(), now, 'horizon', 0);
    expect(expectedHorizon.ok).toBe(true);
    if (expectedHorizon.ok) {
      expect(horizonAim.pose.targetLatDeg).toBeCloseTo(expectedHorizon.pose.targetLatDeg, 3);
      expect(horizonAim.pose.targetLonDeg).toBeCloseTo(expectedHorizon.pose.targetLonDeg, 3);
    }
    expect(horizonAim.verticalFovDeg).toBeCloseTo(pinched, 5);
    expect(host.querySelector('[data-iss-status]')?.textContent).toContain('Horizon locked');

    key(view.frame, '3');
    expect(view.aim.windowId).toBe(3);
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    key(view.frame, '=');
    const pinchedAgain = view.aim.opticalFovDeg;
    expect(pinchedAgain).toBeLessThan(lens);
    key(view.frame, 'N');
    expect(view.aim.mode).toBe('nadir');
    expect(view.aim.windowId).toBeNull();
    expect(view.aim.azimuthDeg).toBe(0);
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.aim.opticalFovDeg).toBeCloseTo(pinchedAgain, 5);
    expect(host.querySelector('[data-iss-window]')?.hasAttribute('hidden')).toBe(true);
    expect(cupola.value).toBe('');
    key(view.frame, 'h');
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.windowId).toBeNull();
    expect(view.aim.opticalFovDeg).toBeCloseTo(pinchedAgain, 5);
    key(view.frame, 'ArrowUp');
    (host.querySelector('[data-iss-preset="horizon"]') as HTMLElement).click();
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.aim.opticalFovDeg).toBeCloseTo(pinchedAgain, 5);

    key(view.frame, 'ArrowRight');
    const held = view.aim.look.rightDeg;
    expect(held).toBeGreaterThan(0);
    const dialog = add(document.createElement('div'));
    dialog.className = 'modal-backdrop';
    const blockedH = key(view.frame, 'h');
    const blockedS = key(view.frame, 'n');
    expect(blockedH.defaultPrevented).toBe(false);
    expect(blockedS.defaultPrevented).toBe(false);
    expect(view.aim.look.rightDeg).toBe(held);
    expect(view.aim.mode).toBe('horizon');
    expect(view.aim.windowId).toBeNull();
    dialog.remove();

    key(view.frame, '7');
    expect(view.aim.windowId).toBe(7);
    expect(view.aim.mode).toBe('nadir');
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    expect(host.querySelector('[data-iss-window]')?.textContent).toBe('W7');
    await finish(view.scene);
  });

  it('opens a shortcut sheet from the toolbar and leaves aim keys alone while it is open', async () => {
    const host = mountHost();
    const view = await running(host, []);
    const lens = sensorField().vertical;
    const button = host.querySelector('[data-iss-aim-help]');
    const sheet = host.querySelector('[data-iss-aim-sheet]');
    const scrim = host.querySelector('[data-iss-aim-scrim]');
    const toolbar = host.querySelector('[data-iss-toolbar]');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(sheet).toBeInstanceOf(HTMLElement);
    expect(scrim).toBeInstanceOf(HTMLButtonElement);
    expect(toolbar).toBeInstanceOf(HTMLElement);
    if (!(button instanceof HTMLButtonElement) || !(sheet instanceof HTMLElement) || !(scrim instanceof HTMLButtonElement)) return;
    if (!(toolbar instanceof HTMLElement)) return;
    expect(button.closest('[data-iss-toolbar]')).toBe(toolbar);
    expect(toolbar.firstElementChild).toBe(button.parentElement);
    expect(sheet.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Keyboard shortcuts');

    view.frame.focus();
    key(view.frame, '=');
    const narrowed = view.aim.opticalFovDeg;
    expect(narrowed).toBeLessThan(lens);
    expect(sessionStorage.getItem('opd-iss-aim')).toBeNull();
    button.click();
    expect(sheet.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(view.aim.opticalFovDeg).toBe(narrowed);
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(sessionStorage.getItem('opd-iss-aim')).toBeNull();
    expect([...sheet.querySelectorAll('[data-iss-aim-keys]')].map((node) => node.textContent)).toEqual([
      'Arrows', 'W/A/S/D', 'Shift+arrows', 'Shift+W/A/S/D', '+ / =', '-', 'r / Esc', '1–7', 'h', 'n',
    ]);
    expect([...sheet.querySelectorAll('[data-iss-aim-effect]')].map((node) => node.textContent)).toEqual([
      'Pan', 'Pan', 'Fine pan', 'Fine pan', 'Narrow FOV', 'Widen', 'Reset', 'Cupola', 'Horizon', 'Straight down',
    ]);

    const arrow = key(view.frame, 'ArrowRight');
    expect(arrow.defaultPrevented).toBe(true);
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    const narrowAgain = key(view.frame, '=');
    expect(narrowAgain.defaultPrevented).toBe(true);
    expect(view.aim.opticalFovDeg).toBe(narrowed);
    const preset = key(view.frame, 'h');
    expect(preset.defaultPrevented).toBe(true);
    expect(view.aim.mode).toBe('horizon');

    const cupola = host.querySelector('[data-iss-cupola]');
    expect(cupola).toBeInstanceOf(HTMLSelectElement);
    if (!(cupola instanceof HTMLSelectElement)) return;
    cupola.focus();
    const digit = key(cupola, '3');
    expect(digit.defaultPrevented).toBe(false);
    expect(view.aim.windowId).toBeNull();
    expect(sheet.hidden).toBe(false);

    view.frame.focus();
    scrim.click();
    expect(sheet.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(view.aim.opticalFovDeg).toBe(narrowed);
    expect(sessionStorage.getItem('opd-iss-aim')).toBeNull();

    button.click();
    const escape = key(view.frame, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(sheet.hidden).toBe(true);
    expect(view.aim.opticalFovDeg).toBe(narrowed);
    expect(view.aim.mode).toBe('horizon');
    const repeat = key(view.frame, 'Escape', { repeat: true });
    expect(repeat.defaultPrevented).toBe(true);
    expect(view.aim.opticalFovDeg).toBe(narrowed);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    key(view.frame, 'Escape');
    expect(view.aim.opticalFovDeg).toBeCloseTo(lens, 5);
    expect(sessionStorage.getItem('opd-iss-aim')).toBeNull();

    key(view.frame, '=');
    button.click();
    const dialog = add(document.createElement('div'));
    dialog.className = 'modal-backdrop';
    const blocked = key(document.body, 'Escape');
    expect(blocked.defaultPrevented).toBe(false);
    expect(sheet.hidden).toBe(false);
    expect(view.aim.opticalFovDeg).toBeLessThan(lens);
    dialog.remove();
    button.click();
    expect(sheet.hidden).toBe(true);

    view.scene.dispose();
    expect(host.querySelector('[data-iss-aim-help]')).toBeNull();
    expect(host.querySelector('[data-iss-aim-sheet]')).toBeNull();
    const after = key(document.body, 'ArrowRight');
    expect(after.defaultPrevented).toBe(false);
    expect(view.aim.look).toEqual({ rightDeg: 0, upDeg: 0 });
    for (const node of extra) node.remove();
    extra.length = 0;
  });
});

describe('ISS keyboard aim persistence', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.removeItem('opd-iss-aim');
    stripIssHash();
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
    const raw = sessionStorage.getItem('opd-iss-aim');
    const help = host.querySelector('[data-iss-aim-help]');
    if (!(help instanceof HTMLButtonElement)) throw new Error('missing key help');
    help.click();
    expect(sessionStorage.getItem('opd-iss-aim')).toBe(raw);
    const held = key(frame, 'ArrowRight');
    expect(held.defaultPrevented).toBe(true);
    expect(sessionStorage.getItem('opd-iss-aim')).toBe(raw);
    expect(view.issPresetSession().look.rightDeg).toBeCloseTo(stored.look.rightDeg, 5);
    help.click();
    expect(host.querySelector('[data-iss-aim-sheet]')?.hasAttribute('hidden')).toBe(true);
    expect(sessionStorage.getItem('opd-iss-aim')).toBe(raw);
    key(frame, 'a');
    const backed = JSON.parse(sessionStorage.getItem('opd-iss-aim') ?? 'null') as { look: LookOffset };
    expect(backed.look.rightDeg).toBeGreaterThan(0);
    expect(backed.look.rightDeg).toBeLessThan(stored.look.rightDeg);
    key(frame, 'r');
    expect(sessionStorage.getItem('opd-iss-aim')).toBeNull();
    expect(view.issPresetSession().look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(sensorField().vertical, 5);
    scene.dispose();
    host.remove();
  });

  it('writes opd-iss-aim when a digit selects a Cupola window', async () => {
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
    key(frame, '=');
    key(frame, 'ArrowRight');
    key(frame, '3');
    const stored = JSON.parse(sessionStorage.getItem('opd-iss-aim') ?? 'null') as {
      mode: string;
      azimuthDeg: number;
      windowId: number;
      look: LookOffset;
      opticalFovDeg: number;
    };
    expect(stored.mode).toBe('horizon');
    expect(stored.azimuthDeg).toBe(30);
    expect(stored.windowId).toBe(3);
    expect(stored.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(stored.opticalFovDeg).toBeCloseTo(sensorField().vertical, 5);
    expect(view.issPresetSession().windowId).toBe(3);
    expect(view.issPresetSession().mode).toBe('horizon');
    const chip = host.querySelector('[data-iss-window]');
    expect(chip?.textContent).toBe('W3');
    key(frame, '7');
    const nadir = JSON.parse(sessionStorage.getItem('opd-iss-aim') ?? 'null') as {
      mode: string;
      azimuthDeg: number;
      windowId: number;
      look: LookOffset;
    };
    expect(nadir.mode).toBe('nadir');
    expect(nadir.azimuthDeg).toBe(0);
    expect(nadir.windowId).toBe(7);
    expect(nadir.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(host.querySelector('[data-iss-window]')?.textContent).toBe('W7');
    expect(host.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((host.querySelector('[data-iss-cupola]') as HTMLSelectElement).value).toBe('7');
    key(frame, 'r');
    expect(sessionStorage.getItem('opd-iss-aim')).toBeNull();
    expect(view.issPresetSession().windowId).toBeNull();
    expect(view.issPresetSession().mode).toBe('horizon');
    scene.dispose();
    host.remove();
  });

  it('writes opd-iss-aim for Horizon and Straight down and keeps the pinched field', async () => {
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
    key(frame, '=');
    key(frame, 'ArrowRight');
    const pinched = sensorField().vertical * 0.96;
    key(frame, 'n');
    const straight = JSON.parse(sessionStorage.getItem('opd-iss-aim') ?? 'null') as {
      mode: string;
      azimuthDeg: number;
      windowId: number | null;
      look: LookOffset;
      opticalFovDeg: number;
    };
    expect(straight.mode).toBe('nadir');
    expect(straight.azimuthDeg).toBe(0);
    expect(straight.windowId).toBeNull();
    expect(straight.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(straight.opticalFovDeg).toBeCloseTo(pinched, 5);
    expect(view.issPresetSession().mode).toBe('nadir');
    expect(view.issPresetSession().windowId).toBeNull();
    expect(view.issPresetSession().opticalFovDeg).toBeCloseTo(pinched, 5);
    expect(host.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-iss-window]')?.hasAttribute('hidden')).toBe(true);
    key(frame, 'H');
    const horizon = JSON.parse(sessionStorage.getItem('opd-iss-aim') ?? 'null') as {
      mode: string;
      azimuthDeg: number;
      windowId: number | null;
      look: LookOffset;
      opticalFovDeg: number;
    };
    expect(horizon.mode).toBe('horizon');
    expect(horizon.azimuthDeg).toBe(0);
    expect(horizon.windowId).toBeNull();
    expect(horizon.look).toEqual({ rightDeg: 0, upDeg: 0 });
    expect(horizon.opticalFovDeg).toBeCloseTo(pinched, 5);
    expect(view.issPresetSession().mode).toBe('horizon');
    expect(view.issPresetSession().windowId).toBeNull();
    expect(host.querySelector('[data-iss-preset="horizon"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-iss-preset="nadir"]')?.getAttribute('aria-pressed')).toBe('false');
    scene.dispose();
    host.remove();
  });
});
