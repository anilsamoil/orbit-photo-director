import type { LaunchOpportunity } from './launch-schema';
import { isLaunchUtc, safeSourceUrl } from './launch-schema';
import { launchStore, type LaunchState } from './launch-store';
import { hasLaunchTimeConflict, launchBrief, launchCameraEvidenceFresh, launchCoverageLabel, launchFresh, launchScheduleFresh, utc, type LaunchSelection } from './launch-selectors';
import type { PassEntry } from './types';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function status(item: LaunchOpportunity, state: LaunchState, now: number, expired = false): string {
  const fresh = item.status === 'map_only' ? launchScheduleFresh(state, now) : launchFresh(state, now);
  return [item.status === 'map_only' ? 'MAP ONLY' : 'GEOMETRY SUPPORTED',
    item.reason_codes.includes('LAUNCH_UNCONFIRMED') ? 'SCHEDULE UNCONFIRMED' : '',
    expired ? 'EXPIRED' : '', !fresh ? 'STALE / EXPIRED DATA' : '',
    state.availability === 'offline' ? 'OFFLINE' : state.availability === 'last-good' ? 'LAST GOOD' : '',
  ].filter(Boolean).join(' | ');
}
function tentativeNet(item: LaunchOpportunity): string {
  const timestamp = utc(item.launch_window.net);
  const precision = item.launch_window.precision?.toLowerCase();
  if (precision === 'day') return `${timestamp.slice(0, 10)} UTC (day estimate; time unconfirmed)`;
  if (precision === 'month') return `${timestamp.slice(0, 7)} (month estimate; date/time unconfirmed)`;
  if (precision === 'year') return `${timestamp.slice(0, 4)} (year estimate; date/time unconfirmed)`;
  return timestamp;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function friendlyDate(value: string): string {
  const date = new Date(value);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
function friendlyUtc(value: string, seconds: boolean): string {
  return `${friendlyDate(value)}, ${utc(value).slice(11, seconds ? 19 : 16)} UTC`;
}
function friendlyRange(start: string, end: string, seconds: boolean): string {
  if (start.slice(0, 10) !== end.slice(0, 10)) return `${friendlyUtc(start, seconds)} – ${friendlyUtc(end, seconds)}`;
  return `${friendlyDate(start)}, ${utc(start).slice(11, seconds ? 19 : 16)}–${utc(end).slice(11, seconds ? 19 : 16)} UTC`;
}
function summaryNet(item: LaunchOpportunity): string {
  if (hasLaunchTimeConflict(item)) return 'Launch time disputed (see Details)';
  const { net, precision } = item.launch_window;
  switch (precision?.toLowerCase()) {
    case 'minute': return `${friendlyUtc(net, false)} (tentative)`;
    case 'second': return `${friendlyUtc(net, true)} (tentative)`;
    case 'day': return `${friendlyDate(net)} UTC (day estimate; time unconfirmed)`;
    case 'month': return `${MONTHS[new Date(net).getUTCMonth()]} ${new Date(net).getUTCFullYear()} (month estimate)`;
    case 'year': return `${new Date(net).getUTCFullYear()} (year estimate)`;
    default: return 'Timing unconfirmed (see Details)';
  }
}
function row(container: HTMLElement, label: string, value: string): void {
  const line = element('div', 'launch-fact');
  line.append(element('span', 'launch-fact-label', label), element('span', '', value));
  container.append(line);
}
export function renderLaunchFacts(item: LaunchOpportunity, state: LaunchState, now: number): HTMLElement {
  const body = element('div', 'launch-facts');
  body.dataset.eventId = item.event_id;
  body.dataset.revision = item.revision;
  row(body, 'Status', status(item, state, now));
  row(body, 'Rocket / site', `${item.rocket} / ${item.site.name}`);
  row(body, 'Site', `${item.site.lat}, ${item.site.lon}`);
  row(body, 'NET (tentative)', tentativeNet(item));
  const conflict = hasLaunchTimeConflict(item);
  const coarse = ['day', 'month', 'year'].includes(item.launch_window.precision?.toLowerCase() ?? '');
  row(body, 'Launch window start', conflict ? 'Unknown (conflicting source bounds)' : coarse ? 'Unknown (coarse schedule)' : item.launch_window.start ? utc(item.launch_window.start) : 'Unknown');
  row(body, 'Launch window end', conflict ? 'Unknown (conflicting source bounds)' : coarse ? 'Unknown (coarse schedule)' : item.launch_window.end ? utc(item.launch_window.end) : 'Unknown');
  row(body, 'Schedule precision', conflict ? 'Unknown (time conflict)' : item.launch_window.precision ?? 'Unknown');
  row(body, 'Trajectory', `${item.trajectory.quality}${item.trajectory.source ? ` / ${item.trajectory.source}` : ' / source unknown'}`);
  if (item.status === 'map_only' || item.capture_intervals.length === 0) {
    row(body, 'Capture interval', 'Unknown');
    row(body, 'Orbital-relative direction', 'Unknown');
  } else {
    for (const interval of item.capture_intervals) {
      row(body, 'Conditional capture', `${utc(interval.start)} to ${utc(interval.end)}`);
      row(body, 'Peak', utc(interval.peak));
      row(body, 'Conditional liftoff', `${utc(interval.liftoff_start)} to ${utc(interval.liftoff_end)}`);
      row(body, 'Orbital-relative (LVLH)', launchCameraEvidenceFresh({ item, interval, expired: Date.parse(interval.end) <= now }, state, now) && interval.look
        ? `Azimuth ${interval.look.azimuth_deg.toFixed(1)} deg; off-nadir ${interval.look.off_nadir_deg.toFixed(1)} deg`
        : 'Unavailable — current camera evidence required');
    }
  }
  if (item.assessment) {
    row(body, 'Planning checked', utc(item.assessment.checked_at));
    row(body, 'Planning valid until', utc(item.assessment.valid_until));
    row(body, 'At planned liftoff', `${item.assessment.net.verdict}: ${item.assessment.net.reason}`);
    row(body, 'Across launch window', `${item.assessment.window.verdict}: ${item.assessment.window.reason}`);
    if (item.assessment.net.pad_distance_km !== null) row(body, 'ISS to launch site at NET', `${Math.round(item.assessment.net.pad_distance_km)} km`);
    if (item.assessment.model) {
      row(body, 'Nominal ascent model', item.assessment.model.name);
      row(body, 'Model duration', `${item.assessment.model.duration_seconds} seconds`);
      row(body, 'Model maximum altitude', `${item.assessment.model.max_altitude_km} km`);
      row(body, 'Model maximum downrange', `${item.assessment.model.max_downrange_km} km`);
    }
  }
  if (item.reason_codes.length) row(body, 'Reasons', item.reason_codes.join(', '));
  row(body, 'Event revision', item.revision);
  if (state.artifact) {
    row(body, 'Artifact revision', state.artifact.revision);
    row(body, 'Generated', utc(state.artifact.generated_at));
    row(body, 'Camera evidence valid until', utc(state.artifact.valid_until));
    row(body, 'Coverage fetched', state.artifact.coverage.fetched_at ? utc(state.artifact.coverage.fetched_at) : 'Unknown');
  }
  for (const source of item.sources) {
    const line = element('div', 'launch-source');
    if (safeSourceUrl(source.url)) {
      const link = element('a', '', source.kind);
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      line.append(link);
    } else line.append(element('span', '', source.kind));
    line.append(element('span', '', ` | Fetched: ${source.fetched_at ? utc(source.fetched_at) : 'Unknown'}`));
    body.append(line);
  }
  return body;
}

/** Every view resolves the selected identity from the common current revision. */
export function openLaunchDetails(eventId: string): void {
  document.querySelector<HTMLDialogElement>('.launch-dialog')?.close();
  const dialog = element('dialog', 'launch-dialog');
  const heading = element('h2', '', 'LAUNCH / ASCENT');
  heading.id = 'launch-details-title';
  heading.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', heading.id);
  const close = element('button', 'btn', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  const content = element('div', '');
  const update = () => {
    const state = launchStore.getState();
    const item = state.artifact?.items.find((candidate) => candidate.event_id === eventId);
    heading.textContent = item ? `LAUNCH / ASCENT: ${item.name}` : 'LAUNCH / ASCENT';
    content.replaceChildren(item ? renderLaunchFacts(item, state, Date.now()) : element('p', 'launch-status', 'Event unavailable in current revision'));
  };
  const unsubscribe = launchStore.subscribe(update);
  dialog.addEventListener('close', () => { unsubscribe(); dialog.remove(); }, { once: true });
  update();
  dialog.append(heading, content, close);
  document.body.append(dialog);
  dialog.showModal();
  heading.focus({ preventScroll: true });
  dialog.scrollTop = 0;
}

function photoWindow(offNadir: number | null | undefined): string {
  if (typeof offNadir !== 'number' || !Number.isFinite(offNadir)) return 'Not established';
  return offNadir < 30 ? 'WORF' : 'Cupola';
}

function listedLaunchWindow(item: LaunchOpportunity): string {
  if (hasLaunchTimeConflict(item)) return 'Unknown';
  const precision = item.launch_window.precision?.toLowerCase() ?? '';
  const { start, end } = item.launch_window;
  if (precision === 'day' || precision === 'month' || precision === 'year') return summaryNet(item);
  if (start && end) return friendlyRange(start, end, precision === 'second');
  if (precision === 'minute' || precision === 'second') return summaryNet(item);
  return 'Not established';
}

/** The five lines an operator needs. Orbital rejection is one phrase. */
export function operatorLaunchLines(selection: LaunchSelection, state: LaunchState, now: number): {
  shoot: string; window: string; direction: string; launchWindow: string; chance: string;
} {
  const brief = launchBrief(selection, state, now);
  const impossible = brief.verdict === 'no_chance';
  const look = launchCameraEvidenceFresh(selection, state, now)
    ? selection.interval?.look
    : selection.item.assessment?.net.verdict === 'possible' ? selection.item.assessment.net.look : null;
  const capture = selection.interval && launchCameraEvidenceFresh(selection, state, now)
    ? friendlyRange(selection.interval.start, selection.interval.end, true)
    : null;
  const chance = brief.verdict === 'no_chance' ? 'Not possible'
    : brief.verdict === 'chance' ? 'Possible'
    : brief.verdict === 'passed' ? 'Passed'
    : 'Unknown';
  return {
    shoot: impossible ? 'Not possible' : capture ?? (brief.verdict === 'chance' ? summaryNet(selection.item) : 'Not established'),
    window: impossible ? 'Not possible' : photoWindow(look?.off_nadir_deg),
    direction: impossible ? 'Not possible' : brief.direction ?? 'Not established',
    launchWindow: listedLaunchWindow(selection.item),
    chance,
  };
}

export function renderLaunchCard(selection: LaunchSelection, state: LaunchState, now: number, onShowMap?: (eventId: string) => void): HTMLElement {
  const { item } = selection;
  const brief = launchBrief(selection, state, now);
  const card = element('article', 'card launch launch-v2 launch-brief');
  card.dataset.launch = 'v2';
  card.dataset.verdict = brief.verdict;
  card.dataset.eventId = item.event_id;
  card.dataset.revision = item.revision;
  card.dataset.artifactRevision = state.artifact?.revision ?? '';
  const name = element('button', 'card-name launch-name', item.name);
  name.type = 'button';
  name.addEventListener('click', () => openLaunchDetails(item.event_id));
  const lines = operatorLaunchLines(selection, state, now);
  const summary = element('div', 'launch-summary');
  row(summary, 'Shoot', lines.shoot);
  row(summary, 'Window', lines.window);
  row(summary, 'Direction', lines.direction);
  row(summary, 'Launch window', lines.launchWindow);
  row(summary, 'Chance', lines.chance);
  card.append(name, summary);
  if (onShowMap) {
    const actions = element('div', 'launch-brief-actions');
    const corridor = item.trajectory.quality !== 'unknown' && !!item.trajectory.source && item.trajectory.points.length >= 2;
    const showMap = element('button', 'btn', corridor ? 'Show site and corridor' : 'Show launch site');
    showMap.type = 'button';
    showMap.addEventListener('click', () => onShowMap(item.event_id));
    actions.append(showMap);
    card.append(actions);
  }
  return card;
}

/** Legacy fields do not establish capture timing, access or probability. */
export function renderLegacyLaunchCard(pass: PassEntry, stale: boolean): HTMLElement {
  const card = element('article', 'card launch launch-v2 launch-ascent-card');
  card.dataset.launch = 'legacy';
  card.dataset.targetId = pass.target_id;
  const launch = pass.launch;
  const meta = element('div', 'card-meta');
  meta.append(element('span', 'tag launch-ascent', 'LAUNCH / ASCENT'), element('span', 'tag launch-status', `MAP ONLY | LEGACY${stale ? ' | STALE' : ''}`));
  const summary = element('div', 'launch-summary');
  summary.append(element('div', 'tag launch-rocket', launch?.rocket_type ?? 'Unknown rocket'));
  row(summary, 'Site', launch?.site_name ?? 'Unknown');
  row(summary, 'NET (tentative)', isLaunchUtc(launch?.t0) ? utc(launch.t0) : 'Unknown');
  row(summary, 'Schedule precision', 'Unknown');
  row(summary, 'Capture interval', 'Unknown');
  card.append(element('div', 'card-name', launch?.name ?? pass.target_name), meta, summary);
  return card;
}

export function renderLaunchCoverage(container: HTMLElement, state: LaunchState, now: number, view: 'upcoming' | 'map' = 'upcoming'): void {
  container.classList.add('launch-coverage');
  container.setAttribute('role', 'status');
  const details = element('details', 'launch-data-details');
  const checked = state.artifact?.coverage.fetched_at;
  const label = !state.artifact && state.availability === 'loading' ? 'Launch data details · checking schedule'
    : checked ? `Launch data details · schedule checked ${utc(checked)}` : 'Launch data details · schedule unavailable';
  details.append(element('summary', '', label), element('p', '', launchCoverageLabel(state, now, view)));
  container.replaceChildren(details);
}
