import { INSET_MIN_HEIGHT_PX, INSET_MIN_WIDTH_PX } from '../insets/gate';
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
import { clampOpticalFov } from './fov';
import { horizontalFovDeg, lookRoom, nudgeLook, settleLook } from './look';
import {
  launchChoiceLabel,
  launchSiteFromSelection,
  launchTimeFact,
  lookToward,
  selectAllLaunches,
  type LaunchSite,
  type LaunchTimeFact,
  type LaunchVisibility,
} from './launches';
import { launchCatalog, subscribeLaunchSlots } from '../launch-catalog';
import { launchVerdictBlock, selectLaunches, utc, type LaunchSelection } from '../launch-selectors';
import { scheduleLabel, tierLabel, tierWindowUtc, type TierCatalog, type TierLaunch } from '../launch-tiers';
import { launchStore } from '../launch-store';
import { bindAimKeys, type AimAction } from './aim-keys';
import { bindIssFullscreen } from './fullscreen';
import { paintEqualDigits } from '../digits';
import { fitIssPane, launchCardCandidate, SHORT_ISS_WINDOW_PX, sideDockActive, storedLaunchPlace, type LaunchCardPlace } from './pane-fit';
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
  allLaunches?: () => readonly LaunchSelection[];
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
  | { kind: 'held'; eventId: string; group: 'chance' | 'all' }
  | { kind: 'cleared' };

type LaunchPickEvent =
  | { type: 'menu'; value: string }
  | { type: 'catalog'; judged: boolean; present: boolean };

function pickValue(pick: LaunchPick): string {
  if (pick.kind !== 'held') return '';
  return pick.group === 'all' ? `all:${pick.eventId}` : pick.eventId;
}

function reduceLaunchPick(pick: LaunchPick, event: LaunchPickEvent): LaunchPick {
  if (event.type === 'menu') {
    if (event.value === '' || event.value === pickValue(pick)) return pick;
    if (event.value === 'none') return { kind: 'open' };
    if (event.value.startsWith('all:')) return { kind: 'held', eventId: event.value.slice(4), group: 'all' };
    return { kind: 'held', eventId: event.value, group: 'chance' };
  }
  if (pick.kind !== 'held' || !event.judged || event.present) return pick;
  return { kind: 'cleared' };
}

type FrameKind = 'chances' | 'tiers';

type TierPick =
  | { kind: 'open' }
  | { kind: 'held'; eventId: string; group: 'shot' | 'likely' | 'watch' | 'all' }
  | { kind: 'cleared' };

type PickerRow = { value: string; label: string; group: string | null };

function tierPickValue(pick: TierPick): string {
  if (pick.kind !== 'held') return '';
  return pick.group === 'all' ? `all:${pick.eventId}` : pick.eventId;
}

function reduceTierPick(pick: TierPick, value: string, tiers: TierCatalog): TierPick {
  if (value === '' || value === tierPickValue(pick)) return pick;
  if (value === 'none') return { kind: 'open' };
  if (value.startsWith('all:')) {
    const eventId = value.slice(4);
    if (!tiers.all.some((launch) => launch.eventId === eventId)) return pick;
    return { kind: 'held', eventId, group: 'all' };
  }
  const launch = tiers.find(value);
  if (!launch || (launch.tier !== 'shot' && launch.tier !== 'likely' && launch.tier !== 'watch')) return pick;
  return { kind: 'held', eventId: launch.eventId, group: launch.tier };
}

function tierGroupFromLabel(label: string): 'shot' | 'likely' | 'watch' | 'all' | null {
  if (label === 'Shot') return 'shot';
  if (label === 'Likely') return 'likely';
  if (label === 'Watch') return 'watch';
  if (label === 'All launches') return 'all';
  return null;
}

function reduceTierIntent(pick: TierPick, value: string, groupLabel: string): TierPick {
  if (value === '' || value === tierPickValue(pick)) return pick;
  if (value === 'none') return { kind: 'open' };
  const group = tierGroupFromLabel(groupLabel);
  if (value.startsWith('all:') || group === 'all') {
    const eventId = value.startsWith('all:') ? value.slice(4) : value;
    return { kind: 'held', eventId, group: 'all' };
  }
  if (group === 'shot' || group === 'likely' || group === 'watch') return { kind: 'held', eventId: value, group };
  return { kind: 'held', eventId: value, group: 'shot' };
}

function tierListed(tiers: TierCatalog, pick: Extract<TierPick, { kind: 'held' }>): boolean {
  if (pick.group === 'all') return tiers.all.some((launch) => launch.eventId === pick.eventId);
  if (pick.group === 'watch') return tiers.groups.watch.some((launch) => launch.eventId === pick.eventId);
  return tiers.pins.some((launch) => launch.eventId === pick.eventId);
}

function tierSite(launch: TierLaunch): LaunchSite {
  return {
    eventId: launch.eventId,
    name: launch.name,
    siteName: launch.site.name,
    lat: launch.site.lat,
    lon: launch.site.lon,
    corridor: launch.corridor ? launch.corridor.points.map((point) => ({ lat: point.lat, lon: point.lon })) : null,
  };
}

function tierTimeFact(launch: TierLaunch): LaunchTimeFact {
  const { windowStartMs, windowEndMs, netMs } = launch.schedule;
  if (windowStartMs !== null && windowEndMs !== null) return { label: 'Launch window', text: tierWindowUtc(windowStartMs, windowEndMs) };
  return { label: 'NET, tentative', text: utc(netMs) };
}

export function mountIssScene(host: HTMLElement, options: MountIssSceneOptions): IssScene {
  const session = bindSession(options.session ?? sessionPreset);
  const readSelections = options.launches ?? (() => selectLaunches(launchStore.getState(), options.nowMs(), 'map'));
  const readAll = options.allLaunches
    ?? (options.launches ? () => [] : () => selectAllLaunches(launchStore.getState(), options.nowMs()));
  let frameKind: FrameKind = 'chances';
  let chancePick: LaunchPick = { kind: 'open' };
  let tierPick: TierPick = { kind: 'open' };
  let tierChoices = false;
  const readTiers = (): TierCatalog | null => (options.launches ? null : launchCatalog.read(options.nowMs()));
  const activePick = (): LaunchPick | TierPick => (frameKind === 'tiers' ? tierPick : chancePick);
  let shownLaunchSites: readonly LaunchSite[] = [];
  let launchDrawingHidden = false;
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
  let appliedFovDeg: number | null = null;
  let fovEpoch = 0;
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
  clockBlock.append(utc, gmtDay, houston, dayMonth, weekday);
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
  paintFov();
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
  const side = document.createElement('div');
  side.dataset.issSide = '';
  side.style.display = 'none';
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
  view.append(stage, side, launchCard);
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
    const tiers = readTiers();
    if (tiers || tierChoices) {
      const selected = picker.selectedOptions[0];
      const parent = selected?.parentElement;
      const groupLabel = parent instanceof HTMLOptGroupElement ? parent.label : '';
      const next = tiers ? reduceTierPick(tierPick, picker.value, tiers) : reduceTierIntent(tierPick, picker.value, groupLabel);
      if (next === tierPick) {
        if (picker.value !== tierPickValue(tierPick)) picker.value = tierPickValue(tierPick);
        return;
      }
      tierPick = next;
    } else {
      const next = reduceLaunchPick(chancePick, { type: 'menu', value: picker.value });
      if (next === chancePick) {
        if (picker.value !== pickValue(chancePick)) picker.value = pickValue(chancePick);
        return;
      }
      chancePick = next;
    }
    launchVisibility = 'View unavailable';
    if (phase === 'running' && rendererReady) void paint();
    else layout();
  });
  const splitMedia = typeof window.matchMedia === 'function'
    ? window.matchMedia(`(min-width: ${INSET_MIN_WIDTH_PX}px) and (min-height: ${INSET_MIN_HEIGHT_PX}px)`)
    : null;
  const onSplitChange = (): void => {
    layout();
  };
  splitMedia?.addEventListener('change', onSplitChange);
  const onResize = (): void => {
    if (phase === 'running' && rendererReady) void paint();
    else layout();
  };
  window.addEventListener('resize', onResize);
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
  const fullscreen = bindIssFullscreen({
    scene: root,
    controls,
    telemetry,
    relayout: () => {
      if (phase === 'running' && rendererReady) void paint();
      else layout();
    },
  });

  const stopLaunches = options.launches
    ? () => {}
    : subscribeLaunchSlots(() => {
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
      splitMedia?.removeEventListener('change', onSplitChange);
      window.removeEventListener('resize', onResize);
      aimKeys.dispose();
      fullscreen.dispose();
      stopLaunches();
      storedAim.flush();
      renderer?.destroy();
      renderer = null;
      rendererReady = false;
      parkSplit();
      root.remove();
    },
    element: () => root,
  };

  return scene;

  async function boot(token: number): Promise<void> {
    try {
      renderer = factory(frame, {
        onLaunchLook(eventId) {
          const active = activePick();
          if (active.kind !== 'held' || eventId !== active.eventId) return;
          const site = siteForEvent(eventId, active.group);
          if (site) aimToward(site);
        },
        onLaunchVisibility(eventId, visibility) {
          const active = activePick();
          if (active.kind !== 'held' || eventId !== active.eventId) return;
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

  async function paint(source: 'timer' | 'resize' = 'resize'): Promise<void> {
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
    const fit = layout(source !== 'timer');
    renderer.resize(fit.widthPx, fit.heightPx);
    const verticalFovDeg = opticalFovDeg;
    const issued = ++fovEpoch;
    try {
      await renderer.aim({
        pose: posed.pose,
        verticalFovDeg,
        widthPx: fit.widthPx,
        heightPx: fit.heightPx,
        lightingUtcMs: when,
        fovEpoch: issued,
        onCamera: confirmAppliedFov,
      });
    } catch (error) {
      if (token !== generation) return;
      fail(explainBoot(error));
    }
  }

  function siteForEvent(eventId: string, group: string): LaunchSite | null {
    const tiers = readTiers();
    if (frameKind === 'tiers' && tiers) {
      const launch = tiers.find(eventId);
      if (!launch) return null;
      const listed = group === 'all'
        ? tiers.all.some((row) => row.eventId === eventId)
        : group === 'watch'
          ? tiers.groups.watch.some((row) => row.eventId === eventId)
          : tiers.pins.some((row) => row.eventId === eventId);
      return listed ? tierSite(launch) : null;
    }
    const rows = group === 'all' ? readAll() : readSelections();
    const selection = rows.find((entry) => entry.item.event_id === eventId);
    return selection ? launchSiteFromSelection(selection) : null;
  }

  function syncLaunchChrome(): void {
    const tiers = readTiers();
    if (tiers) {
      frameKind = 'tiers';
      syncTierChrome(tiers);
      return;
    }
    if (tierChoices) {
      frameKind = 'tiers';
      suspendTierFacts();
      return;
    }
    if (frameKind !== 'chances') {
      chancePick = { kind: 'open' };
      frameKind = 'chances';
    }
    syncChanceChrome();
  }

  function suspendTierFacts(): void {
    const focused = document.activeElement === picker;
    launchCard.hidden = true;
    launchCard.dataset.issLaunchState = '';
    delete launchCard.dataset.issLaunchGroup;
    syncPad(null);
    shownLaunchSites = [];
    const fullscreen = root.hasAttribute('data-iss-fullscreen-active');
    launchDrawingHidden = fullscreen;
    renderer?.showLaunches?.(fullscreen ? [] : shownLaunchSites);
    const value = tierPickValue(tierPick);
    if (picker.value !== value) {
      pickerSync = true;
      try {
        picker.value = value;
      } finally {
        pickerSync = false;
      }
    }
    if (focused) picker.focus();
  }

  function syncChanceChrome(): void {
    const selections = readSelections();
    const all = readAll();
    const state = launchStore.getState();
    const now = options.nowMs();
    const acceptedCatalog = state.artifact?.schema_version === 3 && state.availability === 'ready' && !state.superseded;
    const judged = !!options.launches || acceptedCatalog || launchVerdictBlock(state, now) === null;
    const current = chancePick;
    const heldId = current.kind === 'held' ? current.eventId : '';
    const catalog = current.kind === 'held' && current.group === 'all' ? all : selections;
    const present = heldId !== '' && catalog.some((entry) => entry.item.event_id === heldId);
    const schedulePick = current.kind === 'held' && current.group === 'all';
    const fullscreen = root.hasAttribute('data-iss-fullscreen-active');
    if (current.kind === 'held' && !schedulePick && !judged) {
      if (fullscreen) {
        if (!launchDrawingHidden) {
          renderer?.showLaunches?.([]);
          launchDrawingHidden = true;
        }
      } else if (launchDrawingHidden) {
        renderer?.showLaunches?.(shownLaunchSites);
        launchDrawingHidden = false;
      }
      return;
    }
    chancePick = reduceLaunchPick(current, { type: 'catalog', judged, present });
    const next = chancePick;
    const choiceId = next.kind === 'held' ? next.eventId : '';
    const choiceCatalog = next.kind === 'held' && next.group === 'all' ? all : selections;
    const choice = choiceId === '' ? null : choiceCatalog.find((entry) => entry.item.event_id === choiceId) ?? null;
    const rows: PickerRow[] = [
      { value: '', label: 'Choose launch', group: null },
      { value: 'none', label: 'None', group: null },
    ];
    for (const selection of selections) {
      rows.push({ value: selection.item.event_id, label: launchChoiceLabel(selection, state, now), group: null });
    }
    for (const selection of all) {
      rows.push({
        value: `all:${selection.item.event_id}`,
        label: launchChoiceLabel(selection, state, now),
        group: 'All launches',
      });
    }
    writePicker(rows, pickValue(next));
    const site = choice ? launchSiteFromSelection(choice) : null;
    syncPad(site);
    paintLaunchCard(choice, state, now, next.kind === 'held' ? next.group : null);
    shownLaunchSites = site ? [site] : [];
    launchDrawingHidden = fullscreen;
    renderer?.showLaunches?.(fullscreen ? [] : shownLaunchSites);
  }

  function syncTierChrome(tiers: TierCatalog): void {
    tierChoices = true;
    if (tierPick.kind === 'held' && !tierListed(tiers, tierPick)) tierPick = { kind: 'cleared' };
    else if (tierPick.kind === 'held' && tierPick.group !== 'all') {
      const launch = tiers.find(tierPick.eventId);
      if (launch && (launch.tier === 'shot' || launch.tier === 'likely') && launch.tier !== tierPick.group) {
        tierPick = { kind: 'held', eventId: launch.eventId, group: launch.tier };
      }
    }
    const next = tierPick;
    const launch = next.kind === 'held' ? tiers.find(next.eventId) : null;
    const rows: PickerRow[] = [
      { value: '', label: tiers.closedLabel, group: null },
      { value: 'none', label: 'None', group: null },
    ];
    for (const group of [
      ['Shot', tiers.groups.shot],
      ['Likely', tiers.groups.likely],
      ['Watch', tiers.groups.watch],
    ] as const) {
      if (!group[1].length) continue;
      for (const item of group[1]) rows.push({ value: item.eventId, label: tierLabel(item), group: group[0] });
    }
    if (tiers.all.length) {
      for (const item of tiers.all) rows.push({ value: `all:${item.eventId}`, label: scheduleLabel(item), group: 'All launches' });
    }
    writePicker(rows, tierPickValue(next));
    const site = next.kind === 'held' && launch ? tierSite(launch) : null;
    syncPad(site);
    paintTierCard(next, launch);
    shownLaunchSites = site ? [site] : [];
    const fullscreen = root.hasAttribute('data-iss-fullscreen-active');
    launchDrawingHidden = fullscreen;
    renderer?.showLaunches?.(fullscreen ? [] : shownLaunchSites);
  }

  function writePicker(rows: readonly PickerRow[], value: string): void {
    const focused = document.activeElement === picker;
    const signature = rows.map((row) => `${row.group ?? ''}\t${row.value}\t${row.label}`).join('\n');
    pickerSync = true;
    try {
      if (picker.dataset.issLaunchOptions !== signature) {
        const existing = [...picker.options];
        const sameShape = existing.length === rows.length && existing.every((option, index) => {
          const parent = option.parentElement;
          const group = parent instanceof HTMLOptGroupElement ? parent.label : '';
          return option.value === rows[index]?.value && group === (rows[index]?.group ?? '');
        });
        if (sameShape) {
          rows.forEach((row, index) => {
            const option = existing[index];
            if (option && option.textContent !== row.label) option.textContent = row.label;
          });
        } else {
          picker.replaceChildren();
          let group: HTMLOptGroupElement | null = null;
          for (const row of rows) {
            const option = document.createElement('option');
            option.value = row.value;
            option.textContent = row.label;
            if (row.group) {
              if (!group || group.label !== row.group) {
                group = document.createElement('optgroup');
                group.label = row.group;
                picker.append(group);
              }
              group.append(option);
            } else {
              group = null;
              picker.append(option);
            }
          }
        }
        picker.dataset.issLaunchOptions = signature;
      }
      if (picker.value !== value) picker.value = value;
    } finally {
      pickerSync = false;
      if (focused) picker.focus();
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
        const current = activePick();
        if (current.kind !== 'held') return;
        const site = siteForEvent(current.eventId, current.group);
        if (site) aimToward(site);
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
    group: 'chance' | 'all' | null,
  ): void {
    if (chancePick.kind === 'cleared') {
      launchCard.hidden = false;
      delete launchCard.dataset.issLaunchGroup;
      if (launchCard.dataset.issLaunchState !== 'missing') {
        launchCard.dataset.issLaunchState = 'missing';
        launchCard.replaceChildren(factMissing);
      }
      return;
    }
    if (chancePick.kind !== 'held' || !choice) {
      launchCard.hidden = true;
      launchCard.dataset.issLaunchState = '';
      delete launchCard.dataset.issLaunchGroup;
      return;
    }
    launchCard.hidden = false;
    if (group === 'all') launchCard.dataset.issLaunchGroup = 'all';
    else delete launchCard.dataset.issLaunchGroup;
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

  function paintTierCard(pick: TierPick, launch: TierLaunch | null): void {
    if (pick.kind === 'cleared') {
      launchCard.hidden = false;
      delete launchCard.dataset.issLaunchGroup;
      if (launchCard.dataset.issLaunchState !== 'missing') {
        launchCard.dataset.issLaunchState = 'missing';
        launchCard.replaceChildren(factMissing);
      }
      return;
    }
    if (pick.kind !== 'held' || !launch) {
      launchCard.hidden = true;
      launchCard.dataset.issLaunchState = '';
      delete launchCard.dataset.issLaunchGroup;
      return;
    }
    launchCard.hidden = false;
    if (pick.group === 'all') launchCard.dataset.issLaunchGroup = 'all';
    else delete launchCard.dataset.issLaunchGroup;
    if (launchCard.dataset.issLaunchState !== 'selected') {
      launchCard.dataset.issLaunchState = 'selected';
      launchCard.replaceChildren(factName, factSite, factTime, factVisibility);
    }
    const fact = tierTimeFact(launch);
    factName.textContent = launch.name;
    factSite.textContent = launch.site.name;
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

  function splitStack(): { chrome: HTMLElement; dock: HTMLElement } | null {
    const pane = host.parentElement;
    if (!pane) return null;
    const chrome = pane.querySelector('[data-iss-split-chrome]');
    const dock = pane.querySelector('[data-iss-split-dock]');
    if (!(chrome instanceof HTMLElement) || !(dock instanceof HTMLElement)) return null;
    return { chrome, dock };
  }

  function parkSplit(): void {
    const presetsNode = toolbar.querySelector('[data-iss-presets]');
    if (clockBlock.parentElement !== toolbar) {
      if (presetsNode) presetsNode.after(clockBlock);
      else toolbar.append(clockBlock);
    }
    if (edition.parentElement !== toolbar && edition.parentElement !== side) toolbar.append(edition);
    if (card.parentElement !== root) root.append(card);
    delete root.dataset.issSplit;
  }

  function syncSplit(): void {
    const stack = splitStack();
    const fullscreen = root.hasAttribute('data-iss-fullscreen-active');
    if (!stack || fullscreen || !splitMedia?.matches) {
      parkSplit();
      return;
    }
    if (clockBlock.parentElement !== stack.chrome) stack.chrome.append(clockBlock);
    if (edition.parentElement !== stack.chrome) stack.chrome.append(edition);
    if (card.parentElement !== stack.dock) stack.dock.append(card);
    root.dataset.issSplit = 'on';
  }

  function restoreSideDock(): void {
    const parked = launchCard.parentElement === side
      || houston.parentElement === side
      || dayMonth.parentElement === side
      || weekday.parentElement === side
      || edition.parentElement === side
      || telemetryBody.parentElement === side;
    if (!parked) {
      side.style.display = 'none';
      delete root.dataset.issSideDock;
      return;
    }
    if (launchCard.parentElement === side) {
      if (side.parentElement === view) view.insertBefore(launchCard, side);
      else view.append(launchCard);
    }
    if (houston.parentElement === side || dayMonth.parentElement === side || weekday.parentElement === side) {
      clockBlock.append(utc, gmtDay, houston, dayMonth, weekday);
    }
    if (edition.parentElement === side && root.dataset.issSplit !== 'on') toolbar.append(edition);
    if (telemetryBody.parentElement === side) card.append(telemetryBody);
    side.style.display = 'none';
    delete root.dataset.issSideDock;
  }

  function syncSideDock(): void {
    const fullscreen = root.hasAttribute('data-iss-fullscreen-active');
    const split = root.dataset.issSplit === 'on';
    const width = root.clientWidth || host.clientWidth || 0;
    if (!sideDockActive(width, window.innerHeight, fullscreen, split)) {
      restoreSideDock();
      return;
    }
    if (side.parentElement !== view) stage.after(side);
    side.style.removeProperty('display');
    const order = [launchCard, houston, dayMonth, weekday, edition, telemetryBody];
    const placed = order.length === side.childElementCount && order.every((node, index) => side.children[index] === node);
    if (!placed) side.append(launchCard, houston, dayMonth, weekday, edition, telemetryBody);
    root.dataset.issSideDock = 'on';
  }

  function layout(syncDock = true): { widthPx: number; heightPx: number } {
    syncSplit();
    syncLaunchChrome();
    if (syncDock) syncSideDock();
    root.toggleAttribute('data-iss-short', window.innerHeight > 0 && window.innerHeight <= SHORT_ISS_WINDOW_PX);
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
    stage.style.height = `${heightPx}px`;
    const labelHeightPx = Math.ceil(Math.max(port.offsetHeight, starboard.offsetHeight));
    if (labelHeightPx > heightPx) stage.style.height = `${labelHeightPx}px`;
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
    const docked = root.dataset.issSplit === 'on';
    const sideDock = root.dataset.issSideDock === 'on';
    const viewStyle = getComputedStyle(view);
    const cardGap = px(viewStyle.gap || viewStyle.columnGap || viewStyle.rowGap);
    const cardShown = !launchCard.hidden;
    const previous = storedLaunchPlace(root.dataset.issLaunchPlace);
    const candidate = launchCardCandidate(width, cardShown);
    const cardBox = measureLaunchCard(sideDock ? 'side' : candidate);
    const columnWidth = sideDock ? Math.max(side.offsetWidth, cardShown ? cardBox.width : 0) : cardBox.width;
    return fitIssPane({
      paneWidthPx: width,
      paneHeightPx: height,
      padXPx: padX,
      padYPx: padY,
      gapPx: gap,
      toolbarPx: toolbar.offsetHeight,
      buttonPx: docked ? 0 : Math.max(controls.offsetHeight, telemetry.offsetHeight),
      bodyPx: docked || sideDock || !open ? 0 : telemetryBody.scrollHeight + bodyBorder + bodyMargin,
      bodyMarginPx: docked || sideDock || !open ? 0 : bodyMargin,
      sideWidthPx: port.offsetWidth + starboard.offsetWidth + stageGap * 2,
      labelPx: Math.max(port.offsetHeight, starboard.offsetHeight),
      launchCardWidthPx: columnWidth,
      launchCardHeightPx: cardBox.height,
      launchCardGapPx: sideDock || cardShown ? cardGap : 0,
    }, previous);
  }

  function measureLaunchCard(candidate: LaunchCardPlace): { width: number; height: number } {
    if (launchCard.hidden || candidate === 'off' || candidate === 'over') return { width: 0, height: 0 };
    const previous = root.dataset.issLaunchPlace;
    root.dataset.issLaunchPlace = candidate;
    const width = launchCard.offsetWidth;
    const height = launchCard.offsetHeight;
    if (previous) root.dataset.issLaunchPlace = previous;
    else delete root.dataset.issLaunchPlace;
    return { width, height };
  }

  function setOpticalFov(value: number): void {
    const next = clampFov(value);
    if (next === opticalFovDeg) return;
    opticalFovDeg = next;
    session.opticalFovDeg = next;
    writeLook(settleLook(session.look, session.mode, currentRoom()));
    persistAim();
    if (phase === 'running' && rendererReady) void paint();
  }

  function confirmAppliedFov(applied: number, token: number): void {
    if (token !== fovEpoch || phase !== 'running' || !Number.isFinite(applied)) return;
    appliedFovDeg = applied;
    paintFov();
  }

  function paintFov(): void {
    if (appliedFovDeg === null) {
      fovReadout.textContent = '';
      fovReadout.dataset.issFovState = 'pending';
      return;
    }
    fovReadout.textContent = formatOpticalFov(appliedFovDeg);
    fovReadout.dataset.issFovState = 'live';
  }

  function clampFov(value: number): number {
    return clampOpticalFov(value, lensFovDeg, opticalFovDeg);
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
      void paint('timer');
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
    opticalFovDeg: clampOpticalFov(aim.opticalFovDeg, lens, aim.opticalFovDeg),
  };
}

function storedWindowId(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7) return value;
  return undefined;
}


