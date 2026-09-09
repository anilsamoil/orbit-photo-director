import type { LaunchOpportunity } from './launch-schema';
import { isLaunchUtc, safeSourceUrl } from './launch-schema';
import { launchStore, type LaunchState } from './launch-store';
import { hasLaunchTimeConflict, launchCoverageLabel, launchFresh, launchScheduleFresh, utc, type LaunchSelection } from './launch-selectors';
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
      row(body, 'Orbital-relative (LVLH)', interval.look
        ? `Azimuth ${interval.look.azimuth_deg.toFixed(1)} deg; off-nadir ${interval.look.off_nadir_deg.toFixed(1)} deg`
        : 'Unknown');
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

export function renderLaunchCard(selection: LaunchSelection, state: LaunchState, now: number): HTMLElement {
  const { item, interval, expired } = selection;
  const card = element('article', 'card launch launch-v2 launch-ascent-card');
  card.dataset.launch = 'v2';
  card.dataset.eventId = item.event_id;
  card.dataset.revision = item.revision;
  card.dataset.artifactRevision = state.artifact?.revision ?? '';
  const name = element('button', 'card-name launch-name', item.name);
  name.type = 'button';
  name.addEventListener('click', () => openLaunchDetails(item.event_id));
  const meta = element('div', 'card-meta');
  meta.append(element('span', 'tag launch-ascent', 'LAUNCH / ASCENT'), element('span', 'tag launch-status', status(item, state, now, expired)));
  const summary = element('div', 'launch-summary');
  summary.append(element('div', '', `${item.rocket} | ${item.site.name}`));
  summary.append(element('div', 'launch-time', interval
    ? `Conditional capture: ${utc(interval.start)} to ${utc(interval.end)}`
    : `NET (tentative): ${tentativeNet(item)}`));
  if (!interval) summary.append(element('div', 'launch-status', 'Capture interval unknown'));
  if (hasLaunchTimeConflict(item)) summary.append(element('div', 'launch-status', 'Launch window unknown: TIME_CONFLICT'));
  card.append(name, meta, summary);
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
  container.textContent = launchCoverageLabel(state, now, view);
}
