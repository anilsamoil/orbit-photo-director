import { createIssRenderer } from '../map/adapters/maplibre/iss-view';
import { CUPOLA_WINDOWS, cupolaPreset } from './cupola';
import {
  EARTH_VIEW_ROLL_DEG,
  earthFrameSides,
  groundLightAt,
  sceneCard,
  sceneFit,
  sceneFrame,
  sensorField,
  type CameraMode,
  type ImageryState,
  type SceneCard,
  type SceneFrame,
  type SceneSnapshot,
} from './model';
import type { LookOffset } from '../iss-g1/model';
import { horizontalFovDeg, lookRoom, nudgeLook, settleLook } from './look';
import { bindAimKeys, type AimAction } from './aim-keys';
import { fitIssPane } from './pane-fit';
import type { IssRenderer, IssRendererFactory } from './renderer';

type IssSession = {
  mode: CameraMode;
  azimuthDeg: number;
  windowId: number | null;
  look: LookOffset;
  opticalFovDeg: number;
};

const AIM_STORAGE_KEY = 'opd-iss-aim';

const sessionPreset: IssSession = readStoredAim() ?? blankAim();

export type IssScenePhase = 'dormant' | 'loading' | 'running' | 'error' | 'suspended';

export type IssScene = {
  generation(): number;
  phase(): IssScenePhase;
  mode(): CameraMode;
  update(snapshot: SceneSnapshot): void;
  paint(): Promise<void>;
  suspend(): void;
  resume(): void;
  retry(): void;
  dispose(): void;
  element(): HTMLElement;
};

export type MountIssSceneOptions = {
  nowMs: () => number;
  createRenderer?: IssRendererFactory;
  visible?: () => boolean;
  onMap?: () => void;
  drive?: 'manual' | 'live';
  session?: {
    mode: CameraMode;
    azimuthDeg?: number;
    windowId?: number | null;
    look?: LookOffset;
    opticalFovDeg?: number;
  };
};

export function mountIssScene(host: HTMLElement, options: MountIssSceneOptions): IssScene {
  const session = bindSession(options.session ?? sessionPreset);
  const visible = options.visible ?? (() => document.visibilityState !== 'hidden');
  const factory = options.createRenderer ?? createIssRenderer;
  let generation = 1;
  let snapshotEpoch = 0;
  let phase: IssScenePhase = 'loading';
  let snapshot: SceneSnapshot | null = null;
  let renderer: IssRenderer | null = null;
  let rendererReady = false;
  let frameState: SceneFrame | null = null;
  let imagery: ImageryState = { kind: 'ready' };
  let held: IssScenePhase = 'running';
  let timer = 0;
  let fovHold = 0;
  let paintSerial = 0;
  const lensFovDeg = sensorField().vertical;
  let opticalFovDeg = session.opticalFovDeg;
  let framePx = { widthPx: 640, heightPx: 400 };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let panOrigin: { id: number; x: number; y: number } | null = null;
  let tap: { x: number; y: number; moved: number } | null = null;
  let priorTap: { x: number; y: number; at: number } | null = null;
  const bootGeneration = generation;

  const root = document.createElement('section');
  root.dataset.issScene = '';
  root.dataset.issPhase = phase;
  const presets = document.createElement('div');
  presets.dataset.issPresets = '';
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', 'Camera');
  const horizon = presetButton('horizon', 'Horizon');
  horizon.title = 'Horizon aim';
  const nadir = presetButton('nadir', 'Straight down');
  nadir.title = 'Aim straight down';
  const cupola = document.createElement('select');
  cupola.dataset.issCupola = '';
  cupola.title = 'Window field of view';
  cupola.setAttribute('aria-label', 'Cupola window');
  const cupolaPlaceholder = document.createElement('option');
  cupolaPlaceholder.value = '';
  cupolaPlaceholder.textContent = 'Cupola window';
  cupola.append(cupolaPlaceholder);
  for (const entry of CUPOLA_WINDOWS) {
    const option = document.createElement('option');
    option.value = String(entry.id);
    option.textContent = entry.label;
    cupola.append(option);
  }
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.dataset.issReset = '';
  reset.textContent = 'Reset';
  reset.title = 'Reset pan and the 14 mm field. Double-tap the view to do the same.';
  reset.setAttribute('aria-label', 'Reset pan and the 14 mm field. Double-tap the view to do the same.');
  const windowChip = document.createElement('span');
  windowChip.dataset.issWindow = '';
  windowChip.hidden = true;
  presets.append(horizon, nadir, cupola, windowChip, reset);
  const utc = document.createElement('p');
  utc.dataset.issUtc = '';
  const toolbar = document.createElement('div');
  toolbar.dataset.issToolbar = '';
  toolbar.append(presets, utc);
  const frame = document.createElement('div');
  frame.dataset.issFrame = '';
  frame.tabIndex = 0;
  const hint = document.createElement('p');
  hint.dataset.issHint = '';
  hint.textContent = 'Pinch or scroll the field · double-tap to reset';
  hint.setAttribute('aria-hidden', 'true');
  const fovReadout = document.createElement('p');
  fovReadout.dataset.issFov = '';
  fovReadout.dataset.issFovState = 'idle';
  fovReadout.setAttribute('aria-hidden', 'true');
  frame.append(fovReadout, hint);
  const stage = document.createElement('div');
  stage.dataset.issStage = '';
  const port = sideLabel('issPort', 'Port');
  const starboard = sideLabel('issStarboard', 'Starboard');
  const sides = earthFrameSides(EARTH_VIEW_ROLL_DEG);
  const left = sides.left === 'port' ? port : starboard;
  const right = sides.right === 'port' ? port : starboard;
  stage.append(left, frame, right);
  const card = document.createElement('article');
  card.dataset.issCard = '';
  const telemetry = document.createElement('button');
  telemetry.type = 'button';
  telemetry.dataset.issTelemetry = '';
  telemetry.textContent = 'Telemetry';
  telemetry.setAttribute('aria-expanded', 'false');
  telemetry.setAttribute('aria-controls', 'iss-telemetry-body');
  const telemetryBody = document.createElement('div');
  telemetryBody.id = 'iss-telemetry-body';
  telemetryBody.dataset.issTelemetryBody = '';
  telemetryBody.hidden = true;
  const status = document.createElement('p');
  status.dataset.issStatus = '';
  status.textContent = 'Loading ISS view';
  const actions = document.createElement('div');
  actions.dataset.issActions = '';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.dataset.issRetry = '';
  retry.textContent = 'Retry';
  retry.hidden = true;
  const mapButton = document.createElement('button');
  mapButton.type = 'button';
  mapButton.dataset.issMap = '';
  mapButton.textContent = 'Map';
  mapButton.hidden = true;
  actions.append(retry, mapButton);
  const detail = document.createElement('p');
  detail.dataset.issDetail = '';
  const details = document.createElement('details');
  details.dataset.issDetails = '';
  details.hidden = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Details';
  details.append(summary, detail);
  telemetryBody.append(status, actions, details);
  card.append(telemetry, telemetryBody);
  root.append(toolbar, stage, card);
  host.append(root);
  syncPreset();
  syncCupola();
  layout();
  writeLook(settleLook(session.look, session.mode, currentRoom()));

  horizon.addEventListener('click', () => choose('horizon', 0, null));
  nadir.addEventListener('click', () => choose('nadir', 0, null));
  reset.addEventListener('click', () => restoreAim());
  cupola.addEventListener('change', () => {
    aimCupola(Number(cupola.value));
  });
  telemetry.addEventListener('click', () => {
    setTelemetryOpen(telemetryBody.hidden);
  });
  frame.addEventListener('wheel', (event) => {
    event.preventDefault();
    setOpticalFov(opticalFovDeg * Math.exp(event.deltaY * 0.0015));
  }, { passive: false });
  frame.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      panOrigin = null;
      tap = null;
      priorTap = null;
      pinchDistance = pointerDistance();
    } else {
      panOrigin = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      tap = { x: event.clientX, y: event.clientY, moved: 0 };
    }
    if (typeof frame.setPointerCapture === 'function') frame.setPointerCapture(event.pointerId);
  });
  frame.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (tap && pointers.size < 2) {
      tap.moved = Math.max(tap.moved, Math.hypot(event.clientX - tap.x, event.clientY - tap.y));
    }
    if (pointers.size >= 2) {
      if (pinchDistance <= 0) return;
      const next = pointerDistance();
      if (next <= 0) return;
      setOpticalFov(opticalFovDeg * (pinchDistance / next));
      pinchDistance = next;
      return;
    }
    if (!panOrigin || panOrigin.id !== event.pointerId) return;
    const width = framePx.widthPx;
    const height = framePx.heightPx;
    if (width < 1 || height < 1) return;
    const dx = event.clientX - panOrigin.x;
    const dy = event.clientY - panOrigin.y;
    panOrigin.x = event.clientX;
    panOrigin.y = event.clientY;
    writeLook(nudgeLook(session.look, {
      rightDeg: -(dx / width) * horizontalFovDeg(opticalFovDeg, width, height),
      upDeg: (dy / height) * opticalFovDeg,
    }, session.mode, currentRoom()));
    persistAim();
    if (phase === 'running' && rendererReady) void paint();
  });
  frame.addEventListener('pointerup', (event) => finishPointer(event, true));
  frame.addEventListener('pointercancel', (event) => finishPointer(event, false));
  frame.addEventListener('dblclick', (event) => {
    event.preventDefault();
    restoreAim();
  });
  retry.addEventListener('click', () => scene.retry());
  mapButton.addEventListener('click', () => options.onMap?.());
  document.addEventListener('visibilitychange', onVisibility);
  const aimKeys = bindAimKeys({
    scene: root,
    armed: () => phase === 'running',
    apply: applyAim,
  });

  void boot(bootGeneration);
  if (options.drive !== 'manual') startTimer();

  const scene: IssScene = {
    generation: () => generation,
    phase: () => phase,
    mode: () => session.mode,
    update(next) {
      snapshot = next;
      snapshotEpoch += 1;
      imagery = { kind: 'ready' };
      if (phase === 'dormant' || phase === 'suspended') return;
      if (phase === 'error' && rendererReady) setPhase('running');
      if (rendererReady && phase === 'loading') setPhase('running');
      if (phase === 'running') void paint();
    },
    paint,
    suspend() {
      if (phase === 'dormant' || phase === 'suspended') return;
      held = phase;
      setPhase('suspended');
      stopTimer();
      paintSerial += 1;
    },
    resume() {
      if (phase !== 'suspended') return;
      const next = held === 'error' || held === 'loading' || held === 'running' ? held : 'running';
      setPhase(next);
      if (options.drive !== 'manual' && next === 'running') startTimer();
      if (next === 'running') void paint();
    },
    retry() {
      if (phase !== 'error') return;
      generation += 1;
      imagery = { kind: 'ready' };
      setPhase(rendererReady ? 'running' : 'loading');
      hideActions();
      if (!rendererReady) void boot(generation);
      else void paint();
    },
    dispose() {
      generation += 1;
      paintSerial += 1;
      setPhase('dormant');
      stopTimer();
      stopFovHold();
      document.removeEventListener('visibilitychange', onVisibility);
      aimKeys.dispose();
      renderer?.destroy();
      renderer = null;
      rendererReady = false;
      root.remove();
    },
    element: () => root,
  };

  return scene;

  async function boot(token: number): Promise<void> {
    try {
      renderer = factory(frame, {
        onImagery(note) {
          if (token !== generation || !snapshot || !frameState) return;
          imagery = note;
          const when = options.nowMs();
          const light = frameState.ok ? groundLightAt(when, frameState.pose.camera.latDeg, frameState.pose.camera.lonDeg) : null;
          writeCard(sceneCard({
            snapshot,
            whenMs: when,
            frame: frameState,
            light,
            imagery,
            lightingUtcMs: when,
          }));
        },
        onContextLost() {
          if (token !== generation) return;
          fail('WebGL context lost');
        },
      });
      await renderer.ready();
    } catch (error) {
      if (token !== generation) return;
      fail(explainBoot(error));
      return;
    }
    if (token !== generation) {
      renderer?.destroy();
      renderer = null;
      return;
    }
    rendererReady = true;
    if (snapshot && phase === 'loading') {
      setPhase('running');
      await paint();
    }
  }

  async function paint(): Promise<void> {
    if (phase !== 'running' || !snapshot || !renderer || !rendererReady) return;
    const token = generation;
    const epoch = snapshotEpoch;
    const serial = ++paintSerial;
    const when = options.nowMs();
    const current = snapshot;
    const posed = sceneFrame(current.track, when, session.mode, 0, {
      azimuthDeg: session.azimuthDeg,
      offset: session.look,
    });
    if (token !== generation || epoch !== snapshotEpoch || serial !== paintSerial) return;
    frameState = posed;
    const light = posed.ok ? groundLightAt(when, posed.pose.camera.latDeg, posed.pose.camera.lonDeg) : null;
    writeCard(sceneCard({
      snapshot: current,
      whenMs: when,
      frame: posed,
      light,
      imagery,
      lightingUtcMs: when,
      windowLabel: sideWindowLabel(),
    }));
    if (!posed.ok) {
      fail(status.textContent ?? 'Orbit unavailable');
      return;
    }
    const fit = layout();
    renderer.resize(fit.widthPx, fit.heightPx);
    try {
      await renderer.aim({
        pose: posed.pose,
        verticalFovDeg: opticalFovDeg,
        widthPx: fit.widthPx,
        heightPx: fit.heightPx,
        lightingUtcMs: when,
      });
    } catch (error) {
      if (token !== generation) return;
      fail(explainBoot(error));
      return;
    }
    if (token !== generation || epoch !== snapshotEpoch) return;
  }

  function aimCupola(id: number): void {
    const preset = cupolaPreset(id);
    if (preset === null) {
      syncCupola();
      return;
    }
    choose(preset.mode, preset.azimuthDeg, id);
  }

  function choose(mode: CameraMode, azimuthDeg: number, windowId: number | null): void {
    session.mode = mode;
    session.azimuthDeg = azimuthDeg;
    session.windowId = windowId;
    session.look.rightDeg = 0;
    session.look.upDeg = 0;
    panOrigin = null;
    priorTap = null;
    if (windowId !== null) opticalFovDeg = lensFovDeg;
    session.opticalFovDeg = opticalFovDeg;
    syncPreset();
    syncCupola();
    persistAim();
    if (phase === 'running') void paint();
  }

  function restoreAim(): void {
    session.mode = 'horizon';
    session.azimuthDeg = 0;
    session.windowId = null;
    session.look.rightDeg = 0;
    session.look.upDeg = 0;
    panOrigin = null;
    priorTap = null;
    opticalFovDeg = lensFovDeg;
    session.opticalFovDeg = lensFovDeg;
    syncPreset();
    syncCupola();
    clearStoredAim();
    if (phase === 'running' && rendererReady) void paint();
  }

  function persistAim(): void {
    if (session !== sessionPreset) return;
    writeStoredAim(session);
  }

  function fail(reason: string): void {
    if (phase === 'dormant') return;
    setPhase('error');
    status.textContent = reason;
    retry.hidden = false;
    mapButton.hidden = false;
    setTelemetryOpen(true);
    stopTimer();
  }

  function setTelemetryOpen(open: boolean): void {
    telemetryBody.hidden = !open;
    telemetry.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (phase === 'running' && rendererReady) void paint();
    else layout();
  }

  function writeCard(card: SceneCard): void {
    const lines = [card.title, card.lens, card.position, card.lock, card.lighting, card.imagery].filter((line) => line.length > 0);
    status.textContent = lines.join('\n');
    detail.textContent = card.detail;
    details.hidden = card.detail.length === 0;
    const clock = /^(\d{4}-\d{2}-\d{2} )(\d{2}:\d{2}:\d{2} UTC)/.exec(card.position);
    utc.textContent = clock?.[2] ?? '';
  }

  function layout(): { widthPx: number; heightPx: number } {
    const width = root.clientWidth || host.clientWidth || 640;
    const height = root.clientHeight || host.clientHeight || 400;
    const fit = width < 10 || height < 10 ? { ...sceneFit(640, 400), bodyMaxPx: null } : fitInPane(width, height);
    const widthPx = Math.max(1, Math.floor(fit.widthPx));
    const heightPx = Math.max(1, Math.floor(fit.heightPx));
    frame.style.width = `${widthPx}px`;
    frame.style.height = `${heightPx}px`;
    framePx = { widthPx, heightPx };
    telemetryBody.style.maxHeight = fit.bodyMaxPx === null ? '' : `${fit.bodyMaxPx}px`;
    return { widthPx, heightPx };
  }

  function fitInPane(width: number, height: number): { widthPx: number; heightPx: number; bodyMaxPx: number | null } {
    const style = getComputedStyle(root);
    const padX = px(style.paddingLeft) + px(style.paddingRight);
    const padY = px(style.paddingTop) + px(style.paddingBottom);
    const gap = px(style.rowGap || style.gap);
    const stageStyle = getComputedStyle(stage);
    const stageGap = px(stageStyle.columnGap || stageStyle.gap);
    const bodyStyle = getComputedStyle(telemetryBody);
    const bodyMargin = px(bodyStyle.marginTop) + px(bodyStyle.marginBottom);
    const bodyBorder = px(bodyStyle.borderTopWidth) + px(bodyStyle.borderBottomWidth);
    const open = !telemetryBody.hidden;
    return fitIssPane({
      paneWidthPx: width,
      paneHeightPx: height,
      padXPx: padX,
      padYPx: padY,
      gapPx: gap,
      toolbarPx: toolbar.offsetHeight,
      buttonPx: telemetry.offsetHeight,
      bodyPx: open ? telemetryBody.scrollHeight + bodyBorder + bodyMargin : 0,
      bodyMarginPx: open ? bodyMargin : 0,
      sideWidthPx: port.offsetWidth + starboard.offsetWidth + stageGap * 2,
      labelPx: Math.max(port.offsetHeight, starboard.offsetHeight),
    });
  }

  function setOpticalFov(value: number): void {
    const next = clampFov(value);
    showOpticalFov(next);
    if (next === opticalFovDeg) return;
    opticalFovDeg = next;
    session.opticalFovDeg = next;
    writeLook(settleLook(session.look, session.mode, currentRoom()));
    persistAim();
    if (phase === 'running' && rendererReady) void paint();
  }

  function showOpticalFov(degrees: number): void {
    fovReadout.textContent = `${degrees.toFixed(1)}°`;
    fovReadout.dataset.issFovState = 'live';
    window.clearTimeout(fovHold);
    fovHold = window.setTimeout(() => {
      fovReadout.dataset.issFovState = 'idle';
      fovHold = window.setTimeout(() => {
        fovReadout.textContent = '';
        fovHold = 0;
      }, 220);
    }, 1000);
  }

  function stopFovHold(): void {
    window.clearTimeout(fovHold);
    fovHold = 0;
  }

  function clampFov(value: number): number {
    if (!Number.isFinite(value)) return opticalFovDeg;
    return Math.min(lensFovDeg, Math.max(12, value));
  }

  function pointerDistance(): number {
    const points = [...pointers.values()];
    const first = points[0];
    const second = points[1];
    if (!first || !second) return 0;
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  function finishPointer(event: PointerEvent, tapAllowed: boolean): void {
    const watch = tap;
    const pinching = pointers.size >= 2;
    pointers.delete(event.pointerId);
    pinchDistance = pointers.size >= 2 ? pointerDistance() : 0;
    if (pointers.size < 2) panOrigin = null;
    tap = null;
    if (!tapAllowed || pinching || pointers.size > 0 || !watch || watch.moved > 18) {
      priorTap = null;
      return;
    }
    const at = event.timeStamp;
    const prev = priorTap;
    priorTap = { x: event.clientX, y: event.clientY, at };
    if (!prev) return;
    const gap = at - prev.at;
    const apart = Math.hypot(event.clientX - prev.x, event.clientY - prev.y);
    if (gap >= 0 && gap <= 450 && apart <= 36) {
      priorTap = null;
      restoreAim();
    }
  }

  function sideWindowLabel(): string | null {
    if (session.windowId === null || session.mode !== 'horizon') return null;
    const entry = CUPOLA_WINDOWS.find((item) => item.id === session.windowId);
    return entry ? entry.label : null;
  }

  function syncPreset(): void {
    horizon.setAttribute('aria-pressed', session.mode === 'horizon' && session.windowId === null ? 'true' : 'false');
    nadir.setAttribute('aria-pressed', session.mode === 'nadir' ? 'true' : 'false');
  }

  function syncCupola(): void {
    cupola.value = session.windowId === null ? '' : String(session.windowId);
    syncWindow();
  }

  function syncWindow(): void {
    if (session.windowId === null) {
      windowChip.hidden = true;
      windowChip.textContent = '';
      windowChip.removeAttribute('title');
      windowChip.removeAttribute('aria-label');
      return;
    }
    const entry = CUPOLA_WINDOWS.find((item) => item.id === session.windowId);
    const name = entry ? entry.label : `Window ${session.windowId}`;
    windowChip.hidden = false;
    windowChip.textContent = `W${session.windowId}`;
    windowChip.title = name;
    windowChip.setAttribute('aria-label', name);
  }

  function writeLook(next: LookOffset): void {
    session.look.rightDeg = next.rightDeg;
    session.look.upDeg = next.upDeg;
  }

  function currentRoom() {
    const limb = frameState?.ok ? frameState.pose.limbFromNadirDeg : undefined;
    return lookRoom(opticalFovDeg, framePx.widthPx, framePx.heightPx, limb);
  }

  function setPhase(next: IssScenePhase): void {
    phase = next;
    root.dataset.issPhase = next;
  }

  function hideActions(): void {
    retry.hidden = true;
    mapButton.hidden = true;
  }

  function onVisibility(): void {
    if (!visible()) scene.suspend();
    else scene.resume();
  }

  function applyAim(action: AimAction): void {
    if (action.kind === 'reset') {
      restoreAim();
      return;
    }
    if (action.kind === 'fov') {
      setOpticalFov(opticalFovDeg * action.factor);
      return;
    }
    if (action.kind === 'window') {
      aimCupola(action.id);
      return;
    }
    if (action.kind === 'preset') {
      choose(action.mode, 0, null);
      return;
    }
    const width = framePx.widthPx;
    const height = framePx.heightPx;
    if (width < 1 || height < 1) return;
    writeLook(nudgeLook(session.look, {
      rightDeg: action.right * action.fraction * horizontalFovDeg(opticalFovDeg, width, height),
      upDeg: action.up * action.fraction * opticalFovDeg,
    }, session.mode, currentRoom()));
    persistAim();
    if (rendererReady) void paint();
  }

  function startTimer(): void {
    stopTimer();
    timer = window.setInterval(() => {
      void paint();
    }, 500);
  }

  function stopTimer(): void {
    if (timer === 0) return;
    window.clearInterval(timer);
    timer = 0;
  }
}

function sideLabel(name: 'issPort' | 'issStarboard', text: string): HTMLParagraphElement {
  const label = document.createElement('p');
  label.dataset[name] = '';
  label.textContent = text;
  return label;
}

function presetButton(mode: CameraMode, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.issPreset = mode;
  button.textContent = label;
  return button;
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function explainBoot(error: unknown): string {
  const message = error instanceof Error ? error.message : 'ISS view failed to start';
  if (/WebGL2/i.test(message)) return 'WebGL2 is unavailable';
  if (/fetch|import|worker|network|offline/i.test(message)) return 'ISS view needs one online load';
  if (message.startsWith('Orbit unavailable')) return message;
  return message;
}

export function issPresetSession(): IssSession {
  return sessionPreset;
}

function bindSession(seed: NonNullable<MountIssSceneOptions['session']>): IssSession {
  const session = seed as IssSession;
  if (!Number.isFinite(session.azimuthDeg)) session.azimuthDeg = 0;
  if (session.windowId === undefined) session.windowId = null;
  if (!session.look) session.look = { rightDeg: 0, upDeg: 0 };
  if (!Number.isFinite(session.opticalFovDeg)) session.opticalFovDeg = sensorField().vertical;
  return session;
}

function blankAim(): IssSession {
  return {
    mode: 'horizon',
    azimuthDeg: 0,
    windowId: null,
    look: { rightDeg: 0, upDeg: 0 },
    opticalFovDeg: sensorField().vertical,
  };
}

function readStoredAim(): IssSession | null {
  try {
    const raw = sessionStorage.getItem(AIM_STORAGE_KEY);
    if (!raw) return null;
    return parseStoredAim(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseStoredAim(value: unknown): IssSession | null {
  if (!value || typeof value !== 'object') return null;
  const aim = value as {
    mode?: unknown;
    azimuthDeg?: unknown;
    windowId?: unknown;
    look?: unknown;
    opticalFovDeg?: unknown;
  };
  const mode = aim.mode === 'horizon' || aim.mode === 'nadir' ? aim.mode : null;
  if (!mode) return null;
  if (typeof aim.azimuthDeg !== 'number' || !Number.isFinite(aim.azimuthDeg)) return null;
  const windowId = storedWindowId(aim.windowId);
  if (windowId === undefined) return null;
  if (!aim.look || typeof aim.look !== 'object') return null;
  const look = aim.look as { rightDeg?: unknown; upDeg?: unknown };
  if (typeof look.rightDeg !== 'number' || typeof look.upDeg !== 'number') return null;
  if (!Number.isFinite(look.rightDeg) || !Number.isFinite(look.upDeg)) return null;
  if (typeof aim.opticalFovDeg !== 'number' || !Number.isFinite(aim.opticalFovDeg)) return null;
  const lens = sensorField().vertical;
  return {
    mode,
    azimuthDeg: aim.azimuthDeg,
    windowId,
    look: { rightDeg: look.rightDeg, upDeg: look.upDeg },
    opticalFovDeg: Math.min(lens, Math.max(12, aim.opticalFovDeg)),
  };
}

function storedWindowId(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7) return value;
  return undefined;
}

function writeStoredAim(session: IssSession): void {
  try {
    sessionStorage.setItem(AIM_STORAGE_KEY, JSON.stringify({
      mode: session.mode,
      azimuthDeg: session.azimuthDeg,
      windowId: session.windowId,
      look: { rightDeg: session.look.rightDeg, upDeg: session.look.upDeg },
      opticalFovDeg: session.opticalFovDeg,
    }));
  } catch {
    /* storage disabled */
  }
}

function clearStoredAim(): void {
  try {
    sessionStorage.removeItem(AIM_STORAGE_KEY);
  } catch {
    /* storage disabled */
  }
}

