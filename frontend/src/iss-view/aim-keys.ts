import { CUPOLA_WINDOWS, type CupolaWindow } from './cupola';
import type { CameraMode } from './model';

export const AIM_KEY_FRACTION = 0.04;
const AIM_KEY_FINE_FRACTION = AIM_KEY_FRACTION / 4;

const AIM_NARROW = 1 - AIM_KEY_FRACTION;
const AIM_WIDEN = 1 / AIM_NARROW;

export type AimAction =
  | { kind: 'pan'; right: -1 | 0 | 1; up: -1 | 0 | 1; fraction: number }
  | { kind: 'fov'; factor: number }
  | { kind: 'reset' }
  | { kind: 'window'; id: CupolaWindow['id'] }
  | { kind: 'preset'; mode: CameraMode };

type AimRow = 'pan' | 'letters' | 'fine' | 'fine-letters' | 'narrow' | 'widen' | 'reset' | 'cupola' | 'horizon' | 'nadir';

export type AimChord = {
  readonly keys: readonly string[];
  readonly action: AimAction;
  readonly row: AimRow;
};

const AIM_CHORDS: readonly AimChord[] = [
  { keys: ['ArrowLeft'], action: { kind: 'pan', right: -1, up: 0, fraction: AIM_KEY_FRACTION }, row: 'pan' },
  { keys: ['ArrowRight'], action: { kind: 'pan', right: 1, up: 0, fraction: AIM_KEY_FRACTION }, row: 'pan' },
  { keys: ['ArrowUp'], action: { kind: 'pan', right: 0, up: 1, fraction: AIM_KEY_FRACTION }, row: 'pan' },
  { keys: ['ArrowDown'], action: { kind: 'pan', right: 0, up: -1, fraction: AIM_KEY_FRACTION }, row: 'pan' },
  { keys: ['w', 'W'], action: { kind: 'pan', right: 0, up: 1, fraction: AIM_KEY_FRACTION }, row: 'letters' },
  { keys: ['a', 'A'], action: { kind: 'pan', right: -1, up: 0, fraction: AIM_KEY_FRACTION }, row: 'letters' },
  { keys: ['d', 'D'], action: { kind: 'pan', right: 1, up: 0, fraction: AIM_KEY_FRACTION }, row: 'letters' },
  { keys: ['Shift+ArrowLeft'], action: { kind: 'pan', right: -1, up: 0, fraction: AIM_KEY_FINE_FRACTION }, row: 'fine' },
  { keys: ['Shift+ArrowRight'], action: { kind: 'pan', right: 1, up: 0, fraction: AIM_KEY_FINE_FRACTION }, row: 'fine' },
  { keys: ['Shift+ArrowUp'], action: { kind: 'pan', right: 0, up: 1, fraction: AIM_KEY_FINE_FRACTION }, row: 'fine' },
  { keys: ['Shift+ArrowDown'], action: { kind: 'pan', right: 0, up: -1, fraction: AIM_KEY_FINE_FRACTION }, row: 'fine' },
  { keys: ['Shift+w', 'Shift+W'], action: { kind: 'pan', right: 0, up: 1, fraction: AIM_KEY_FINE_FRACTION }, row: 'fine-letters' },
  { keys: ['Shift+a', 'Shift+A'], action: { kind: 'pan', right: -1, up: 0, fraction: AIM_KEY_FINE_FRACTION }, row: 'fine-letters' },
  { keys: ['Shift+d', 'Shift+D'], action: { kind: 'pan', right: 1, up: 0, fraction: AIM_KEY_FINE_FRACTION }, row: 'fine-letters' },
  { keys: ['+', '='], action: { kind: 'fov', factor: AIM_NARROW }, row: 'narrow' },
  { keys: ['-', '_'], action: { kind: 'fov', factor: AIM_WIDEN }, row: 'widen' },
  { keys: ['r', 'R', 'Escape'], action: { kind: 'reset' }, row: 'reset' },
  ...CUPOLA_WINDOWS.map((entry): AimChord => ({
    keys: [String(entry.id)],
    action: { kind: 'window', id: entry.id },
    row: 'cupola',
  })),
  { keys: ['h', 'H'], action: { kind: 'preset', mode: 'horizon' }, row: 'horizon' },
  { keys: ['s', 'S'], action: { kind: 'preset', mode: 'nadir' }, row: 'nadir' },
];

const EFFECT: Record<AimRow, string> = {
  pan: 'Pan',
  letters: 'Pan',
  fine: 'Fine pan',
  'fine-letters': 'Fine pan',
  narrow: 'Narrow FOV',
  widen: 'Widen',
  reset: 'Reset',
  cupola: 'Cupola',
  horizon: 'Horizon',
  nadir: 'Straight down',
};

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const SHIFT_ARROWS = ARROWS.map((arrow) => `Shift+${arrow}`);
const LETTERS = ['w', 'a', 'd'];
const SHIFT_LETTERS = LETTERS.map((letter) => `Shift+${letter}`);

export const AIM_KEYS: Readonly<Record<string, AimAction>> = indexAimKeys(AIM_CHORDS);

export type AimHelpRow = {
  readonly keys: readonly string[];
  readonly label: string;
  readonly effect: string;
};

export type AimKeys = {
  dispose(): void;
};

export function indexAimKeys(chords: readonly AimChord[]): Readonly<Record<string, AimAction>> {
  const map: Record<string, AimAction> = {};
  for (const chord of chords) {
    if (chord.keys.length === 0) throw new Error(`aim row ${chord.row} has an empty chord`);
    for (const key of chord.keys) {
      if (Object.hasOwn(map, key)) throw new Error(`duplicate aim key: ${key}`);
      map[key] = chord.action;
    }
  }
  return Object.freeze(map);
}

export function aimHelpRows(chords: readonly AimChord[] = AIM_CHORDS): readonly AimHelpRow[] {
  const grouped = new Map<AimRow, string[]>();
  const order: AimRow[] = [];
  for (const chord of chords) {
    const keys = grouped.get(chord.row);
    if (!keys) {
      grouped.set(chord.row, [...chord.keys]);
      order.push(chord.row);
      continue;
    }
    keys.push(...chord.keys);
  }
  return order.map((row) => {
    const keys = grouped.get(row) ?? [];
    return { keys, label: labelFor(row, keys), effect: EFFECT[row] };
  });
}

export function bindAimKeys(options: {
  scene: HTMLElement;
  armed: () => boolean;
  apply: (action: AimAction) => void;
}): AimKeys {
  const toolbar = options.scene.querySelector('[data-iss-toolbar]');
  if (!(toolbar instanceof HTMLElement)) throw new Error('iss toolbar missing');
  const sheetId = nextSheetId();
  const anchor = document.createElement('div');
  anchor.dataset.issAimAnchor = '';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.issAimHelp = '';
  button.textContent = '?';
  button.title = 'Keyboard shortcuts';
  button.setAttribute('aria-label', 'Keyboard shortcuts');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', sheetId);
  const sheet = document.createElement('div');
  sheet.id = sheetId;
  sheet.dataset.issAimSheet = '';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Keyboard shortcuts');
  const list = document.createElement('ul');
  for (const row of aimHelpRows()) {
    const item = document.createElement('li');
    const keys = document.createElement('span');
    keys.dataset.issAimKeys = '';
    keys.textContent = row.label;
    const effect = document.createElement('span');
    effect.dataset.issAimEffect = '';
    effect.textContent = row.effect;
    item.append(keys, effect);
    list.append(item);
  }
  sheet.append(list);
  anchor.append(button, sheet);
  toolbar.prepend(anchor);
  const scrim = document.createElement('button');
  scrim.type = 'button';
  scrim.dataset.issAimScrim = '';
  scrim.tabIndex = -1;
  scrim.hidden = true;
  scrim.setAttribute('aria-hidden', 'true');
  options.scene.append(scrim);

  let escapeCloseHeld = false;
  let disposed = false;

  function setOpen(open: boolean): void {
    if (options.scene.hasAttribute('data-iss-aim-open') === open) return;
    if (open) options.scene.setAttribute('data-iss-aim-open', '');
    else options.scene.removeAttribute('data-iss-aim-open');
    sheet.hidden = !open;
    scrim.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function onHelpClick(): void {
    setOpen(sheet.hidden);
  }

  function onScrimClick(): void {
    setOpen(false);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey) return;
    if (!sceneFocused(options.scene)) return;
    if (typingTarget(event.target) || document.querySelector('.modal-backdrop')) return;
    if (escapeCloseHeld && event.key === 'Escape') {
      event.preventDefault();
      return;
    }
    if (options.scene.hasAttribute('data-iss-aim-open')) {
      if (event.key === 'Escape' || Object.hasOwn(AIM_KEYS, event.key)) event.preventDefault();
      if (event.key === 'Escape') {
        setOpen(false);
        escapeCloseHeld = true;
      }
      return;
    }
    if (!options.armed()) return;
    const shifted = event.shiftKey ? AIM_KEYS[`Shift+${event.key}`] : undefined;
    const action = shifted ?? AIM_KEYS[event.key];
    if (!action) return;
    event.preventDefault();
    options.apply(action);
  }

  function onEscapeUp(event: KeyboardEvent): void {
    if (event.key === 'Escape') escapeCloseHeld = false;
  }

  function onBlur(): void {
    escapeCloseHeld = false;
  }

  button.addEventListener('click', onHelpClick);
  scrim.addEventListener('click', onScrimClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onEscapeUp);
  window.addEventListener('blur', onBlur);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onEscapeUp);
      window.removeEventListener('blur', onBlur);
      anchor.remove();
      scrim.remove();
      options.scene.removeAttribute('data-iss-aim-open');
    },
  };
}

function labelFor(row: AimRow, keys: readonly string[]): string {
  const shown = keys.filter((key) => !keys.some((other) => shiftedAlias(key, other)));
  if (row === 'pan' && sameKeys(shown, ARROWS)) return 'Arrows';
  if (row === 'letters' && sameKeys(shown, LETTERS)) return 'W/A/D';
  if (row === 'fine' && sameKeys(shown, SHIFT_ARROWS)) return 'Shift+arrows';
  if (row === 'fine-letters' && sameKeys(shown, SHIFT_LETTERS)) return 'Shift+W/A/D';
  if (row === 'nadir' && keys.includes('s') && keys.includes('S') && sameKeys(shown, ['s'])) return 's / S';
  if (row === 'cupola') {
    const parsed = shown.map((key) => Number.parseInt(key, 10));
    if (parsed.every((id) => Number.isInteger(id))) {
      const ids = [...parsed].sort((left, right) => left - right);
      const first = ids[0];
      const last = ids[ids.length - 1];
      if (first !== undefined && last !== undefined && ids.length >= 2 && ids.every((id, index) => id === first + index)) {
        return `${first}\u2013${last}`;
      }
    }
  }
  return shown.map((key) => (key === 'Escape' ? 'Esc' : key)).join(' / ');
}

function sameKeys(shown: readonly string[], expected: readonly string[]): boolean {
  return shown.length === expected.length && expected.every((key) => shown.includes(key));
}

function shiftedAlias(key: string, base: string): boolean {
  if (key === '_' && base === '-') return true;
  const head = (value: string) => (value.startsWith('Shift+') ? 'Shift+' : '');
  if (head(key) !== head(base)) return false;
  const bare = (value: string) => (value.startsWith('Shift+') ? value.slice('Shift+'.length) : value);
  const left = bare(key);
  const right = bare(base);
  return left.length === 1 && right.length === 1 && left !== right && left.toLowerCase() === right;
}

function sceneFocused(scene: HTMLElement): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active === document.documentElement) return true;
  if (scene.contains(active)) return true;
  return active.id === 'tab-iss';
}

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const node = target.closest('input, textarea, select, [contenteditable]');
  if (!node) return false;
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
  return node instanceof HTMLElement && node.isContentEditable;
}

function nextSheetId(): string {
  let n = 1;
  while (document.getElementById(`iss-aim-sheet-${n}`)) n += 1;
  return `iss-aim-sheet-${n}`;
}
