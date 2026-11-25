import { launchCatalog } from './launch-catalog';
import { subscribeHazardNotes } from './launch-hazards';
import { operatorLaunchLines, renderLaunchCard, renderLaunchCoverage } from './launch-card';
import { launchBrief, selectLaunches } from './launch-selectors';
import { launchStore, type LaunchState } from './launch-store';
import { renderTierCard } from './launch-tier-card';
import { shotForecastLabel, tierWord, type TierCatalog } from './launch-tiers';

const PRIMARY_OPEN_KEY = 'opd-map-launch-brief-open';

function savedPrimaryOpen(container: HTMLElement): boolean {
  if (container.dataset.launchBriefOpen !== undefined) return container.dataset.launchBriefOpen === '1';
  try { return localStorage.getItem(PRIMARY_OPEN_KEY) === '1'; } catch { return false; }
}

function savePrimaryOpen(container: HTMLElement, open: boolean): void {
  const value = open ? '1' : '0';
  container.dataset.launchBriefOpen = value;
  try {
    if (localStorage.getItem(PRIMARY_OPEN_KEY) !== value) localStorage.setItem(PRIMARY_OPEN_KEY, value);
  } catch { /* The current page still remembers when browser storage is unavailable. */ }
}

type BriefHost = HTMLElement & {
  hazardWatch?: () => void;
  showMap?: (eventId: string) => void;
  isShown?: (eventId: string) => boolean;
};

function watchHazardNotes(container: HTMLElement, onShowMap: (eventId: string) => void,
  isShown: (eventId: string) => boolean): void {
  const host = container as BriefHost;
  host.showMap = onShowMap;
  host.isShown = isShown;
  if (host.hazardWatch) return;
  const unsubscribe = subscribeHazardNotes(() => {
    if (!container.isConnected) {
      unsubscribe();
      host.hazardWatch = undefined;
      return;
    }
    const show = host.showMap;
    if (!show) return;
    renderMapLaunchBrief(container, launchStore.getState(), Date.now(), show, host.isShown);
  });
  host.hazardWatch = unsubscribe;
}

export function collapseMapLaunchBrief(container: HTMLElement): void {
  for (const details of container.querySelectorAll<HTMLDetailsElement>('.map-launch-primary, .map-launch-more')) {
    const hadFocus = details.contains(document.activeElement);
    details.open = false;
    if (hadFocus) details.querySelector('summary')?.focus({ preventScroll: true });
  }
  savePrimaryOpen(container, false);
}

/** Launches stay one tap away, leaving the map clear by default. */
export function renderMapLaunchBrief(container: HTMLElement, state: LaunchState, now: number,
  onShowMap: (eventId: string) => void, isShown: (eventId: string) => boolean = () => false): void {
  watchHazardNotes(container, onShowMap, isShown);
  const showMap = (eventId: string): void => {
    collapseMapLaunchBrief(container);
    onShowMap(eventId);
  };
  const tiers = launchCatalog.read(now);
  if (tiers) {
    renderTierMapBrief(container, tiers, now, showMap, isShown);
    return;
  }
  const previousPrimary = container.querySelector<HTMLDetailsElement>('.map-launch-primary');
  const primaryWasOpen = previousPrimary?.open ?? savedPrimaryOpen(container);
  const primaryHadFocus = !!previousPrimary && previousPrimary.querySelector('summary') === document.activeElement;
  // A refresh can arrive before the native toggle event is delivered.
  if (previousPrimary) savePrimaryOpen(container, primaryWasOpen);
  const moreWasOpen = container.querySelector<HTMLDetailsElement>('.map-launch-more')?.open ?? false;
  const moreHadFocus = container.querySelector('.map-launch-more > summary') === document.activeElement;
  const dataWasOpen = container.querySelector<HTMLDetailsElement>('.launch-data-details')?.open ?? false;
  container.className = 'map-launch-brief';
  const selections = selectLaunches(state, now, 'map');
  const nodes: HTMLElement[] = [];
  const coverage = document.createElement('div');
  renderLaunchCoverage(coverage, state, now, 'map');
  const next = selections[0];
  const nextCard = next ? renderLaunchCard(next, state, now, showMap) : null;
  if (next && nextCard) {
    const primary = document.createElement('details');
    primary.className = 'map-launch-primary';
    primary.open = primaryWasOpen;
    const summary = document.createElement('summary');
    const brief = launchBrief(next, state, now);
    const lines = operatorLaunchLines(next, state, now);
    summary.textContent = `Next launch · ${lines.chance}`;
    summary.dataset.hasChance = String(brief.verdict === 'chance');
    primary.append(summary, nextCard, coverage);
    primary.addEventListener('toggle', (event) => {
      if (event.target === primary && container.querySelector('.map-launch-primary') === primary) {
        savePrimaryOpen(container, primary.open);
      }
    });
    nodes.push(primary);
  }
  if (selections.length > 1) {
    const more = document.createElement('details');
    more.className = 'map-launch-more';
    more.open = moreWasOpen;
    const summary = document.createElement('summary');
    const chances = selections.slice(1).filter((selection) => launchBrief(selection, state, now).verdict === 'chance').length;
    summary.textContent = `Other launches (${selections.length - 1})${chances ? ` · ${chances} possible` : ''}`;
    summary.dataset.hasChance = String(chances > 0);
    more.append(summary, ...selections.slice(1).map((selection) => renderLaunchCard(selection, state, now, showMap)));
    nodes.push(more);
  }
  if (!next) {
    const empty = document.createElement('p');
    empty.textContent = state.artifact
      ? 'No upcoming launch is listed in the available schedule.'
      : 'Checking upcoming launches…';
    if (!state.artifact && state.availability !== 'loading') empty.textContent = 'Launch schedule unavailable. Reconnect to check upcoming launches.';
    nodes.push(empty, coverage);
  }
  container.replaceChildren(...nodes);
  coverage.querySelector<HTMLDetailsElement>('.launch-data-details')!.open = dataWasOpen;
  if (primaryHadFocus) container.querySelector<HTMLElement>('.map-launch-primary > summary')?.focus({ preventScroll: true });
  if (moreHadFocus) container.querySelector<HTMLElement>('.map-launch-more > summary')?.focus({ preventScroll: true });
}

function renderTierMapBrief(container: HTMLElement, tiers: TierCatalog, now: number, onShowMap: (eventId: string) => void,
  isShown: (eventId: string) => boolean): void {
  const previousPrimary = container.querySelector<HTMLDetailsElement>('.map-launch-primary');
  const primaryWasOpen = previousPrimary?.open ?? savedPrimaryOpen(container);
  const primaryHadFocus = !!previousPrimary && previousPrimary.querySelector('summary') === document.activeElement;
  if (previousPrimary) savePrimaryOpen(container, primaryWasOpen);
  const moreWasOpen = container.querySelector<HTMLDetailsElement>('.map-launch-more')?.open ?? false;
  const moreHadFocus = container.querySelector('.map-launch-more > summary') === document.activeElement;
  container.className = 'map-launch-brief';
  const primary = tiers.highlights?.[0] ?? tiers.mapPins[0] ?? null;
  const rest = tiers.mapPins.filter((pin) => pin !== primary);
  const nodes: HTMLElement[] = [];
  if (primary) {
    const details = document.createElement('details');
    details.className = 'map-launch-primary';
    details.open = primaryWasOpen;
    const summary = document.createElement('summary');
    const forecast = primary.tier === 'shot'
      ? shotForecastLabel(primary.schedule.netMs, primary.schedule.windowEndMs, now)
      : null;
    summary.textContent = `Next launch · ${forecast ?? tierWord(primary.tier)}`;
    details.append(summary, renderTierCard(primary, onShowMap, isShown));
    details.addEventListener('toggle', (event) => {
      if (event.target === details && container.querySelector('.map-launch-primary') === details) {
        savePrimaryOpen(container, details.open);
      }
    });
    nodes.push(details);
  }
  if (rest.length) {
    const more = document.createElement('details');
    more.className = 'map-launch-more';
    more.open = moreWasOpen;
    const summary = document.createElement('summary');
    summary.textContent = `Other launches (${rest.length})`;
    more.append(summary, ...rest.map((pin) => renderTierCard(pin, onShowMap, isShown)));
    nodes.push(more);
  }
  if (!primary) {
    const empty = document.createElement('p');
    empty.textContent = 'No upcoming launch is listed in the available schedule.';
    nodes.push(empty);
  }
  container.replaceChildren(...nodes);
  if (primaryHadFocus) container.querySelector<HTMLElement>('.map-launch-primary > summary')?.focus({ preventScroll: true });
  if (moreHadFocus) container.querySelector<HTMLElement>('.map-launch-more > summary')?.focus({ preventScroll: true });
}
