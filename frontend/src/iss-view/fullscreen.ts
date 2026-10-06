type IssFullscreenMode = 'off' | 'overlay' | 'element';

type FullscreenSignal = 'press' | 'dismiss' | 'granted' | 'released';

type FullscreenEffect = 'none' | 'request' | 'exit';

type FullscreenStep = { readonly mode: IssFullscreenMode; readonly effect: FullscreenEffect };

/**
 * The whole state machine. A missing cell does not compile. 'overlay' is the
 * CSS overlay, which also covers the wait for the browser's grant. 'element'
 * means the browser holds the scene. A repeated signal lands on the cell it
 * already took, so a doubled change event, a second exit press, and a grant
 * that arrives after a cancel all converge.
 */
const STEPS: Readonly<Record<IssFullscreenMode, Readonly<Record<FullscreenSignal, FullscreenStep>>>> = {
  off: {
    press: { mode: 'overlay', effect: 'request' },
    dismiss: { mode: 'off', effect: 'none' },
    granted: { mode: 'off', effect: 'exit' },
    released: { mode: 'off', effect: 'none' },
  },
  overlay: {
    press: { mode: 'off', effect: 'none' },
    dismiss: { mode: 'off', effect: 'none' },
    granted: { mode: 'element', effect: 'none' },
    released: { mode: 'overlay', effect: 'none' },
  },
  element: {
    press: { mode: 'element', effect: 'exit' },
    dismiss: { mode: 'element', effect: 'exit' },
    granted: { mode: 'element', effect: 'none' },
    released: { mode: 'off', effect: 'none' },
  },
};

const FACES = {
  idle: { label: 'Full screen', icon: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' },
  active: { label: 'Exit full screen', icon: 'M4 9h5V4M15 4v5h5M20 15h-5v5M9 20v-5H4' },
} as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function bindIssFullscreen(options: { scene: HTMLElement; relayout: () => void }): { dispose(): void } {
  const { scene, relayout } = options;
  const toolbar = scene.querySelector('[data-iss-toolbar]');
  if (!(toolbar instanceof HTMLElement)) throw new Error('iss toolbar missing');
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.issFullscreen = '';
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  icon.append(path);
  button.append(icon);
  const anchor = toolbar.querySelector('[data-iss-aim-anchor]');
  if (anchor) anchor.after(button);
  else toolbar.prepend(button);

  let mode: IssFullscreenMode = 'off';
  let escapeExitHeld = false;
  let seen = clientBox(scene);
  paintMode();

  function dispatch(signal: FullscreenSignal): void {
    const step = STEPS[mode][signal];
    if (mode !== 'off' && step.mode === 'off') escapeExitHeld = true;
    mode = step.mode;
    paintMode();
    if (step.effect === 'request') requestFullscreen(scene);
    if (step.effect === 'exit') exitFullscreen();
    relayout();
  }

  function paintMode(): void {
    const face = mode === 'off' ? FACES.idle : FACES.active;
    scene.toggleAttribute('data-iss-fullscreen-active', mode !== 'off');
    button.setAttribute('aria-label', face.label);
    button.title = face.label;
    path.setAttribute('d', face.icon);
  }

  function onPress(): void {
    if (mode === 'off') closeOpenAimSheet(scene);
    dispatch('press');
  }

  function onChange(): void {
    dispatch(holdsFullscreen(scene) ? 'granted' : 'released');
  }

  /**
   * Escape reaches an open modal first, then ends fullscreen. After any exit,
   * the auto-repeat of the key that ended it stops here until keyup, a fresh
   * press, or blur, so it never reaches aim-keys as a reset.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || document.querySelector('.modal-backdrop')) return;
    if (mode !== 'off') {
      event.stopPropagation();
      event.preventDefault();
      dispatch('dismiss');
    } else if (!event.repeat) {
      escapeExitHeld = false;
    } else if (escapeExitHeld) {
      event.stopPropagation();
      event.preventDefault();
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Escape') escapeExitHeld = false;
  }

  function onBlur(): void {
    escapeExitHeld = false;
  }

  function onFocusIn(event: FocusEvent): void {
    if (mode === 'off' || !(event.target instanceof Element) || scene.contains(event.target)) return;
    dispatch('dismiss');
  }

  function onResize(): void {
    const next = clientBox(scene);
    const changed = next.width !== seen.width || next.height !== seen.height;
    seen = next;
    if (changed && next.width > 0 && next.height > 0) relayout();
  }

  const observer = new ResizeObserver(onResize);
  observer.observe(scene, { box: 'border-box' });
  button.addEventListener('click', onPress);
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('focusin', onFocusIn);

  return {
    dispose() {
      observer.disconnect();
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('focusin', onFocusIn);
      if (holdsFullscreen(scene)) exitFullscreen();
      scene.removeAttribute('data-iss-fullscreen-active');
      button.remove();
    },
  };
}

function closeOpenAimSheet(scene: HTMLElement): void {
  if (!scene.hasAttribute('data-iss-aim-open')) return;
  const scrim = scene.querySelector('[data-iss-aim-scrim]');
  if (scrim instanceof HTMLElement) scrim.click();
}

function clientBox(element: HTMLElement): { width: number; height: number } {
  return { width: element.clientWidth, height: element.clientHeight };
}

function holdsFullscreen(element: Element): boolean {
  const prefixed = 'webkitFullscreenElement' in document ? document.webkitFullscreenElement : null;
  return (document.fullscreenElement ?? prefixed) === element;
}

function requestFullscreen(element: Element): void {
  try {
    if (typeof element.requestFullscreen === 'function') element.requestFullscreen().catch(() => undefined);
    else if ('webkitRequestFullscreen' in element && typeof element.webkitRequestFullscreen === 'function') element.webkitRequestFullscreen();
  } catch {
    return;
  }
}

function exitFullscreen(): void {
  try {
    if (typeof document.exitFullscreen === 'function') document.exitFullscreen().catch(() => undefined);
    else if ('webkitExitFullscreen' in document && typeof document.webkitExitFullscreen === 'function') document.webkitExitFullscreen();
  } catch {
    return;
  }
}
