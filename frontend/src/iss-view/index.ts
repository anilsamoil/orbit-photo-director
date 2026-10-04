import { createIssRenderer } from '../map/adapters/maplibre/iss-view';
import { CUPOLA_WINDOWS, cupolaPreset } from './cupola';
import {
  EARTH_VIEW_ROLL_DEG,
  earthFrameSides,
  groundLightAt,
  issClockLines,
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
import {
  launchChoiceLabel,
  launchSiteFromSelection,
  launchTimeFact,
  lookToward,
  type LaunchSite,
  type LaunchVisibility,
} from './launches';
import { launchVerdictBlock, selectLaunches, type LaunchSelection } from '../launch-selectors';
import { launchStore } from '../launch-store';
import { bindAimKeys, type AimAction } from './aim-keys';
import { paintEqualDigits } from '../digits';
import { fitIssPane, type LaunchCardPlace } from './pane-fit';
import type { IssRenderer, IssRendererFactory } from './renderer';

type IssSession = {
  mode: CameraMode;
  azimuthDeg: number;
  windowId: number | null;
  look: LookOffset;
  opticalFovDeg: number;
};

const EXPEDITION_EDITION = 'Expedition 75 Beta Edition';
const AIM_STORAGE_KEY = 'opd-iss-aim';
const AIM_LINK_PARAM = 'iss';
const AIM_LINK_QUIET_MS = 1000;

type StoredAim = {
  read(): IssSession | null;
  save(session: IssSession): void;
  clear(): void;
  flush(): void;
};

const storedAim: StoredAim = createStoredAim();

const sessionPreset: IssSession = storedAim.read() ?? blankAim();

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
  launches?: () => readonly LaunchSelection[];
  session?: {
    mode: CameraMode;
    azimuthDeg?: number;
    windowId?: number | null;
    look?: LookOffset;
    opticalFovDeg?: number;
  };
};

type LaunchPick =
  | { kind: 'open' }
  | { kind: 'held'; eventId: string }
  | { kind: 'cleared' };

type LaunchPickEvent =
  | { type: 'menu'; value: string }
  | { type: 'catalog'; judged: boolean; present: boolean };

function pickValue(pick: LaunchPick): string {
  return pick.kind === 'held' ? pick.eventId : '';
}

function reduceLaunchPick(pick: LaunchPick, event: LaunchPickEvent): LaunchPick {
  if (event.type === 'menu') {
    if (event.value === '' || event.value === pickValue(pick)) return pick;
    if (event.value === 'none') return { kind: 'open' };
    return { kind: 'held', eventId: event.value };
  }
  if (pick.kind !== 'held' || !event.judged || event.present) return pick;
  return { kind: 'cleared' };
}

export function mountIssScene(host: HTMLElement, options: MountIssSceneOptions): IssScene {
  const session = bindSession(options.session ?? sessionPreset);
  const readSelections = options.launches ?? (() => selectLaunches(launchStore.getState(), options.nowMs(), 'map'));
  let pick: LaunchPick = { kind: 'open' };
  let launchVisibility: LaunchVisibility = 'View unavailable';
  let pickerSync = false;
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
  const lensFovDeg = sensorField().vertical;
  let opticalFovDeg = session.opticalFovDeg;
  let framePx = { widthPx: 640, heightPx: 400 };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let panOrigin: { id: number; x: number; y: number } | null = null;
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
  const windowChip = document.createElement('span');
  windowChip.dataset.issWindow = '';
  windowChip.hidden = true;
  presets.append(horizon, nadir, cupola, windowChip);
  const clockBlock = document.createElement('div');
  clockBlock.dataset.issClock = '';
  const utc = document.createElement('p');
  utc.dataset.issUtc = '';
  const houston = clockLine('issHouston');
  const gmtDay = clockLine('issGmtDay');
  const dayMonth = clockLine('issDayMonth');
  const weekday = clockLine('issWeekday');
  clockBlock.append(utc, houston, gmtDay, dayMonth, weekday);
  const edition = document.createElement('p');
  edition.dataset.issEdition = '';
  edition.textContent = EXPEDITION_EDITION;
  const toolbar = document.createElement('div');
  toolbar.dataset.issToolbar = '';
  toolbar.append(presets, clockBlock, edition);
  const frame = document.createElement('div');
  frame.dataset.issFrame = '';
  frame.tabIndex = 0;
  const hint = document.createElement('p');
  hint.dataset.issHint = '';
  hint.textContent = 'Pinch or scroll the field';
  hint.setAttribute('aria-hidden', 'true');
  const fovReadout = document.createElement('p');
  fovReadout.dataset.issFov = '';
  paintFov(opticalFovDeg);
  frame.append(fovReadout, hint);
  const stage = document.createElement('div');
  stage.dataset.issStage = '';
  const port = sideLabel('issPort', 'Port');
  const starboard = sideLabel('issStarboard', 'Starboard');
  const sides = earthFrameSides(EARTH_VIEW_ROLL_DEG);
  const left = sides.left === 'port' ? port : starboard;
  const right = sides.right === 'port' ? port : starboard;
  stage.append(left, frame, right);
  const view = document.createElement('div');
  view.dataset.issView = '';
  const launchCard = document.createElement('article');
  launchCard.dataset.issLaunchCard = '';
  launchCard.hidden = true;
  const factName = document.createElement('h2');
  factName.dataset.issLaunchName = '';
  const factSite = document.createElement('p');
  factSite.dataset.issLaunchSite = '';
  const factTime = document.createElement('p');
  factTime.dataset.issLaunchTime = '';
  const factTimeLabel = document.createElement('span');
  factTimeLabel.dataset.issLaunchTimeLabel = '';
  const factTimeValue = document.createElement('span');
  factTimeValue.dataset.issLaunchTimeValue = '';
  factTime.append(factTimeLabel, factTimeValue);
  const factVisibility = document.createElement('p');
  factVisibility.dataset.issLaunchVisibility = '';
  const factMissing = document.createElement('p');
  factMissing.dataset.issLaunchMissing = '';
  factMissing.textContent = 'Selected launch is no longer available';
  view.append(stage, launchCard);
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
  const controls = document.createElement('div');
  controls.dataset.issControls = '';
  const launchesHost = document.createElement('div');
  launchesHost.dataset.issLaunches = '';
  launchesHost.hidden = true;
  const picker = document.createElement('select');
  picker.dataset.issLaunchPicker = '';
  picker.setAttribute('aria-label', 'Launch');
  const pickerWrap = document.createElement('div');
  pickerWrap.dataset.issLaunchPickerWrap = '';
  pickerWrap.append(picker);
  controls.append(telemetry, pickerWrap, launchesHost);
  card.append(controls, telemetryBody);
  root.append(toolbar, view, card);
  host.append(root);
  syncPreset();
  syncCupola();
  picker.addEventListener('change', () => {
    if (pickerSync) return;
    const next = reduceLaunchPick(pick, { type: 'menu', value: picker.value });
    if (next === pick) {
      if (picker.value !== pickValue(pick)) picker.value = pickValue(pick);
      return;
    }
    pick = next;
    launchVisibility = 'View unavailable';
    if (phase === 'running' && rendererReady) void paint();
    else layout();
  });
  layout();
  writeLook(settleLook(session.look, session.mode, currentRoom()));

  horizon.addEventListener('click', () => choose('horizon', 0, null));
  nadir.addEventListener('click', () => choose('nadir', 0, null));
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
      pinchDistance = pointerDistance();
    } else {
      panOrigin = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
    }
    if (typeof frame.setPointerCapture === 'function') frame.setPointerCapture(event.pointerId);
  });
  frame.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
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
  frame.addEventListener('pointerup', (event) => finishPointer(event));
  frame.addEventListener('pointercancel', (event) => finishPointer(event));
  retry.addEventListener('click', () => scene.retry());
  mapButton.addEventListener('click', () => options.onMap?.());
  document.addEventListener('visibilitychange', onVisibility);
  const aimKeys = bindAimKeys({
    scene: root,
    armed: () => phase === 'running',
    apply: applyAim,
  });

  const stopLaunches = options.launches
    ? () => {}
    : launchStore.subscribe(() => {
      if (phase === 'running' && rendererReady) void paint();
      else layout();
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
      document.removeEventListener('visibilitychange', onVisibility);
      aimKeys.dispose();
      stopLaunches();
      storedAim.flush();
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
        onLaunchLook(eventId) {
          const selection = readSelections().find((entry) => entry.item.event_id === eventId);
          if (selection && pick.kind === 'held' && selection.item.event_id === pick.eventId) {
            aimToward(launchSiteFromSelection(selection));
          }
        },
        onLaunchVisibility(eventId, visibility) {
          if (pick.kind !== 'held' || eventId !== pick.eventId) return;
          launchVisibility = visibility;
          if (launchCard.dataset.issLaunchState === 'selected') factVisibility.textContent = visibility;
        },
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

  function syncLaunchChrome(): void {
    const selections = readSelections();
    const state = launchStore.getState();
    const now = options.nowMs();
    const judged = !!options.launches || launchVerdictBlock(state, now) === null;
    const current = pick;
    const heldId = current.kind === 'held' ? current.eventId : '';
    const present = heldId !== '' && selections.some((entry) => entry.item.event_id === heldId);
    if (current.kind === 'held' && !judged) return;
    pick = reduceLaunchPick(current, { type: 'catalog', judged, present });
    const next = pick;
    const choiceId = next.kind === 'held' ? next.eventId : '';
    const choice = choiceId === '' ? null : selections.find((entry) => entry.item.event_id === choiceId) ?? null;
    syncPicker(selections, state, now);
    const site = choice ? launchSiteFromSelection(choice) : null;
    syncPad(site);
    paintLaunchCard(choice, state, now);
    renderer?.showLaunches?.(site ? [site] : []);
  }

  function syncPicker(selections: readonly LaunchSelection[], state: ReturnType<typeof launchStore.getState>, now: number): void {
    const rows: { value: string; label: string }[] = [
      { value: '', label: 'Choose launch' },
      { value: 'none', label: 'None' },
    ];
    for (const selection of selections) {
      rows.push({
        value: selection.item.event_id,
        label: launchChoiceLabel(selection, state, now),
      });
    }
    const signature = rows.map((row) => `${row.value}\t${row.label}`).join('\n');
    const value = pickValue(pick);
    pickerSync = true;
    try {
      if (picker.dataset.issLaunchOptions !== signature) {
        picker.dataset.issLaunchOptions = signature;
        while (picker.options.length > rows.length) picker.remove(picker.options.length - 1);
        rows.forEach((row, index) => {
          const option = picker.options[index] ?? picker.appendChild(document.createElement('option'));
          if (option.textContent !== row.label) option.textContent = row.label;
          if (option.getAttribute('value') !== row.value) option.setAttribute('value', row.value);
        });
      }
      if (picker.value !== value) picker.value = value;
    } finally {
      pickerSync = false;
    }
  }

  function syncPad(site: LaunchSite | null): void {
    if (!site) {
      launchesHost.hidden = true;
      if (launchesHost.dataset.issLaunchIds) {
        delete launchesHost.dataset.issLaunchIds;
        launchesHost.replaceChildren();
      }
      return;
    }
    const current = launchesHost.querySelector('[data-iss-launch]');
    let button: HTMLButtonElement;
    if (current instanceof HTMLButtonElement && current.dataset.issLaunch === site.eventId) {
      button = current;
    } else {
      launchesHost.replaceChildren();
      button = document.createElement('button');
      button.type = 'button';
      button.dataset.issLaunch = site.eventId;
      const arrow = document.createElement('span');
      arrow.dataset.issLaunchArrow = '';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↑';
      const label = document.createElement('span');
      label.dataset.issLaunchLabel = '';
      button.append(arrow, label);
      button.addEventListener('click', () => {
        const current = pick;
        if (current.kind !== 'held') return;
        const selected = readSelections().find((entry) => entry.item.event_id === current.eventId);
        if (selected) aimToward(launchSiteFromSelection(selected));
      });
      launchesHost.append(button);
      launchesHost.dataset.issLaunchIds = site.eventId;
    }
    const lookLabel = `Look toward ${site.siteName}`;
    const label = button.querySelector('[data-iss-launch-label]');
    if (label) label.textContent = lookLabel;
    button.title = lookLabel;
    button.setAttribute('aria-label', lookLabel);
    launchesHost.hidden = false;
    const pose = frameState?.ok ? frameState.pose : null;
    if (!pose) return;
    const arrow = button.querySelector('[data-iss-launch-arrow]');
    if (!(arrow instanceof HTMLElement)) return;
    const look = lookToward(pose.bearingDeg, pose.camera.latDeg, pose.camera.lonDeg, site.lat, site.lon);
    arrow.style.setProperty('--iss-launch-aim', `${look.arrowDeg.toFixed(1)}deg`);
  }

  function paintLaunchCard(
    choice: LaunchSelection | null,
    state: ReturnType<typeof launchStore.getState>,
    now: number,
  ): void {
    if (pick.kind === 'cleared') {
      launchCard.hidden = false;
      if (launchCard.dataset.issLaunchState !== 'missing') {
        launchCard.dataset.issLaunchState = 'missing';
        launchCard.replaceChildren(factMissing);
      }
      return;
    }
    if (pick.kind !== 'held' || !choice) {
      launchCard.hidden = true;
      launchCard.dataset.issLaunchState = '';
      return;
    }
    launchCard.hidden = false;
    if (launchCard.dataset.issLaunchState !== 'selected') {
      launchCard.dataset.issLaunchState = 'selected';
      launchCard.replaceChildren(factName, factSite, factTime, factVisibility);
    }
    const fact = launchTimeFact(choice, state, now);
    factName.textContent = choice.item.name;
    factSite.textContent = choice.item.site.name;
    factTimeLabel.textContent = fact.label;
    factTimeValue.textContent = fact.text;
    factVisibility.textContent = launchVisibility;
  }

  function aimToward(site: LaunchSite): void {
    if (!frameState?.ok) return;
    const pose = frameState.pose;
    const look = lookToward(pose.bearingDeg, pose.camera.latDeg, pose.camera.lonDeg, site.lat, site.lon);
    const step = 18;
    writeLook(nudgeLook(session.look, {
      rightDeg: look.right * step,
      upDeg: look.up * step,
    }, session.mode, currentRoom()));
    persistAim();
    if (phase === 'running' && rendererReady) void paint();
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
    if (windowId !== null) opticalFovDeg = lensFovDeg;
    session.opticalFovDeg = opticalFovDeg;
    paintFov(opticalFovDeg);
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
    opticalFovDeg = lensFovDeg;
    session.opticalFovDeg = lensFovDeg;
    paintFov(opticalFovDeg);
    syncPreset();
    syncCupola();
    storedAim.clear();
    if (phase === 'running' && rendererReady) void paint();
  }

  function persistAim(): void {
    if (session !== sessionPreset) return;
    storedAim.save(session);
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
    const clock = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC/.exec(card.position);
    paintEqualDigits(utc, clock ? `${clock[2]} UTC` : '');
    const when = clock ? Date.parse(`${clock[1]}T${clock[2]}Z`) : Number.NaN;
    const readout = Number.isFinite(when) ? issClockLines(when) : null;
    paintEqualDigits(houston, readout?.houston ?? '');
    paintEqualDigits(gmtDay, readout?.dayOfYear ?? '');
    paintEqualDigits(dayMonth, readout?.dayMonth ?? '');
    paintEqualDigits(weekday, readout?.weekday ?? '');
  }

  function layout(): { widthPx: number; heightPx: number } {
    syncLaunchChrome();
    const width = root.clientWidth || host.clientWidth || 640;
    const height = root.clientHeight || host.clientHeight || 400;
    const fit = width < 10 || height < 10
      ? { ...sceneFit(640, 400), bodyMaxPx: null, launchCardPlace: 'off' as const }
      : fitInPane(width, height);
    root.dataset.issLaunchPlace = fit.launchCardPlace;
    const widthPx = Math.max(1, Math.floor(fit.widthPx));
    const heightPx = Math.max(1, Math.floor(fit.heightPx));
    frame.style.width = `${widthPx}px`;
    frame.style.height = `${heightPx}px`;
    framePx = { widthPx, heightPx };
    telemetryBody.style.maxHeight = fit.bodyMaxPx === null ? '' : `${fit.bodyMaxPx}px`;
    return { widthPx, heightPx };
  }

  function fitInPane(width: number, height: number): {
    widthPx: number;
    heightPx: number;
    bodyMaxPx: number | null;
    launchCardPlace: LaunchCardPlace;
  } {
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
    const viewStyle = getComputedStyle(view);
    const cardGap = px(viewStyle.gap || viewStyle.columnGap || viewStyle.rowGap);
    const cardShown = !launchCard.hidden;
    return fitIssPane({
      paneWidthPx: width,
      paneHeightPx: height,
      padXPx: padX,
      padYPx: padY,
      gapPx: gap,
      toolbarPx: toolbar.offsetHeight,
      buttonPx: Math.max(controls.offsetHeight, telemetry.offsetHeight),
      bodyPx: open ? telemetryBody.scrollHeight + bodyBorder + bodyMargin : 0,
      bodyMarginPx: open ? bodyMargin : 0,
      sideWidthPx: port.offsetWidth + starboard.offsetWidth + stageGap * 2,
      labelPx: Math.max(port.offsetHeight, starboard.offsetHeight),
      launchCardWidthPx: cardShown ? launchCard.offsetWidth : 0,
      launchCardHeightPx: cardShown ? launchCard.offsetHeight : 0,
      launchCardGapPx: cardShown ? cardGap : 0,
    });
  }

  function setOpticalFov(value: number): void {
    const next = clampFov(value);
    paintFov(next);
    if (next === opticalFovDeg) return;
    opticalFovDeg = next;
    session.opticalFovDeg = next;
    writeLook(settleLook(session.look, session.mode, currentRoom()));
    persistAim();
    if (phase === 'running' && rendererReady) void paint();
  }

  function paintFov(degrees: number): void {
    fovReadout.textContent = formatOpticalFov(degrees);
    fovReadout.dataset.issFovState = 'live';
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

  function finishPointer(event: PointerEvent): void {
    pointers.delete(event.pointerId);
    pinchDistance = pointers.size >= 2 ? pointerDistance() : 0;
    if (pointers.size < 2) panOrigin = null;
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

function clockLine(name: 'issHouston' | 'issGmtDay' | 'issDayMonth' | 'issWeekday'): HTMLParagraphElement {
  const line = document.createElement('p');
  line.dataset[name] = '';
  return line;
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

export function formatOpticalFov(degrees: number): string {
  return `${degrees.toFixed(1)}°`;
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

type AimShelf = 'sessionStorage' | 'localStorage';

function createStoredAim(): StoredAim {
  let pending: string | null = null;
  let timer = 0;

  function flush(): void {
    window.clearTimeout(timer);
    timer = 0;
    if (pending === null) return;
    const json = pending;
    pending = null;
    writeLink(json);
  }

  return {
    read(): IssSession | null {
      return parseAimJson(readShelf('sessionStorage'))
        ?? parseAimJson(readLink())
        ?? parseAimJson(readShelf('localStorage'));
    },
    save(session: IssSession): void {
      const json = aimJson(session);
      writeShelf('sessionStorage', json);
      writeShelf('localStorage', json);
      pending = json;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, AIM_LINK_QUIET_MS);
    },
    clear(): void {
      writeShelf('sessionStorage', null);
      writeShelf('localStorage', null);
      pending = null;
      window.clearTimeout(timer);
      timer = 0;
      writeLink(null);
    },
    flush,
  };
}

function aimJson(session: IssSession): string {
  return JSON.stringify({
    mode: session.mode,
    azimuthDeg: session.azimuthDeg,
    windowId: session.windowId,
    look: { rightDeg: session.look.rightDeg, upDeg: session.look.upDeg },
    opticalFovDeg: session.opticalFovDeg,
  });
}

function parseAimJson(text: string | null): IssSession | null {
  if (!text) return null;
  try {
    return parseStoredAim(JSON.parse(text));
  } catch {
    return null;
  }
}

function readShelf(shelf: AimShelf): string | null {
  try {
    return window[shelf].getItem(AIM_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeShelf(shelf: AimShelf, json: string | null): void {
  try {
    const storage = window[shelf];
    if (json === null) storage.removeItem(AIM_STORAGE_KEY);
    else storage.setItem(AIM_STORAGE_KEY, json);
  } catch {
    return;
  }
}

function readLink(): string | null {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  return new URLSearchParams(hash).get(AIM_LINK_PARAM);
}

function writeLink(json: string | null): void {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const current = params.has(AIM_LINK_PARAM) ? params.get(AIM_LINK_PARAM) : null;
  if (current === json) return;
  if (json === null) params.delete(AIM_LINK_PARAM);
  else params.set(AIM_LINK_PARAM, json);
  const nextHash = params.toString();
  const next = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`;
  try {
    window.history.replaceState(window.history.state, '', next);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') return;
    if (error instanceof Error && error.name === 'SecurityError') return;
    throw error;
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


