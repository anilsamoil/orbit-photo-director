import { createIssRenderer } from '../map/adapters/maplibre/iss-view';
import { CUPOLA_WINDOWS, cupolaPreset } from './cupola';
import {
  groundLightAt,
  sceneCard,
  sceneFit,
  sceneFrame,
  type CameraMode,
  type ImageryState,
  type SceneCard,
  type SceneFrame,
  type SceneSnapshot,
} from './model';
import type { IssRenderer, IssRendererFactory } from './renderer';

const sessionPreset: { mode: CameraMode } = { mode: 'horizon' };

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
  session?: { mode: CameraMode };
};

export function mountIssScene(host: HTMLElement, options: MountIssSceneOptions): IssScene {
  const session = options.session ?? sessionPreset;
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
  let paintSerial = 0;
  const bootGeneration = generation;

  const root = document.createElement('section');
  root.dataset.issScene = '';
  root.dataset.issPhase = phase;
  const presets = document.createElement('div');
  presets.dataset.issPresets = '';
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', 'Camera');
  const horizon = presetButton('horizon', 'Horizon');
  const nadir = presetButton('nadir', 'Straight down');
  const cupola = document.createElement('select');
  cupola.dataset.issCupola = '';
  cupola.setAttribute('aria-label', 'Cupola window');
  const cupolaPlaceholder = document.createElement('option');
  cupolaPlaceholder.value = '';
  cupolaPlaceholder.textContent = 'Cupola window';
  cupola.append(cupolaPlaceholder);
  for (const entry of CUPOLA_WINDOWS) {
    const option = document.createElement('option');
    option.value = String(entry.id);
    option.textContent = entry.label;
    option.disabled = entry.preset === null;
    cupola.append(option);
  }
  presets.append(horizon, nadir, cupola);
  const utc = document.createElement('p');
  utc.dataset.issUtc = '';
  const toolbar = document.createElement('div');
  toolbar.dataset.issToolbar = '';
  toolbar.append(presets, utc);
  const frame = document.createElement('div');
  frame.dataset.issFrame = '';
  const stage = document.createElement('div');
  stage.dataset.issStage = '';
  const port = sideLabel('issPort', 'Port');
  const starboard = sideLabel('issStarboard', 'Starboard');
  stage.append(port, frame, starboard);
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

  horizon.addEventListener('click', () => choose('horizon'));
  nadir.addEventListener('click', () => choose('nadir'));
  cupola.addEventListener('change', () => {
    const preset = cupolaPreset(Number(cupola.value));
    if (preset === null) {
      syncCupola();
      return;
    }
    choose(preset);
  });
  telemetry.addEventListener('click', () => {
    setTelemetryOpen(telemetryBody.hidden);
  });
  retry.addEventListener('click', () => scene.retry());
  mapButton.addEventListener('click', () => options.onMap?.());
  document.addEventListener('visibilitychange', onVisibility);

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
      document.removeEventListener('visibilitychange', onVisibility);
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
    const posed = sceneFrame(current.track, when, session.mode, 0);
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
    }));
    if (!posed.ok) {
      fail(status.textContent ?? 'Orbit unavailable');
      return;
    }
    layout();
    const fit = sceneFit(host.clientWidth || 640, host.clientHeight || 400);
    renderer.resize(fit.widthPx, fit.heightPx);
    try {
      await renderer.aim({
        pose: posed.pose,
        verticalFovDeg: fit.verticalFovDeg,
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

  function choose(mode: CameraMode): void {
    session.mode = mode;
    syncPreset();
    syncCupola();
    if (phase === 'running') void paint();
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
    layout();
  }

  function writeCard(card: SceneCard): void {
    const lines = [card.title, card.lens, card.position, card.lock, card.lighting, card.imagery].filter((line) => line.length > 0);
    status.textContent = lines.join('\n');
    detail.textContent = card.detail;
    details.hidden = card.detail.length === 0;
    const clock = /^(\d{4}-\d{2}-\d{2} )(\d{2}:\d{2}:\d{2} UTC)/.exec(card.position);
    utc.textContent = clock?.[2] ?? '';
  }

  function layout(): void {
    const width = root.clientWidth || host.clientWidth || 640;
    const height = root.clientHeight || host.clientHeight || 400;
    if (width < 10 || height < 10) {
      const fit = sceneFit(640, 400);
      frame.style.width = `${fit.widthPx}px`;
      frame.style.height = `${fit.heightPx}px`;
      return;
    }
    const style = getComputedStyle(root);
    const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    const chrome = toolbar.offsetHeight + card.offsetHeight + gap * 2;
    const stageStyle = getComputedStyle(stage);
    const stageGap = Number.parseFloat(stageStyle.columnGap || stageStyle.gap) || 0;
    const sides = port.offsetWidth + starboard.offsetWidth + stageGap * 2;
    const fit = sceneFit(Math.max(160, width - padX - sides), Math.max(160, height - padY - chrome));
    frame.style.width = `${fit.widthPx}px`;
    frame.style.height = `${fit.heightPx}px`;
  }

  function syncPreset(): void {
    horizon.setAttribute('aria-pressed', session.mode === 'horizon' ? 'true' : 'false');
    nadir.setAttribute('aria-pressed', session.mode === 'nadir' ? 'true' : 'false');
  }

  function syncCupola(): void {
    cupola.value = session.mode === 'nadir' ? '7' : '';
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

function explainBoot(error: unknown): string {
  const message = error instanceof Error ? error.message : 'ISS view failed to start';
  if (/WebGL2/i.test(message)) return 'WebGL2 is unavailable';
  if (/fetch|import|worker|network|offline/i.test(message)) return 'ISS view needs one online load';
  if (message.startsWith('Orbit unavailable')) return message;
  return message;
}

export function issPresetSession(): { mode: CameraMode } {
  return sessionPreset;
}
