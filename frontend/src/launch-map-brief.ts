import type { LaunchState } from './launch-store';
import { launchCatalog } from './launch-catalog';
import { launchBrief, selectLaunches } from './launch-selectors';
import { operatorLaunchLines, renderLaunchCard, renderLaunchCoverage } from './launch-card';
import { renderTierCard } from './launch-tier-card';
import { tierWord, type TierCatalog } from './launch-tiers';

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

/** Launches stay one tap away, leaving the map clear by default. */
export function renderMapLaunchBrief(container: HTMLElement, state: LaunchState, now: number,
  onShowMap: (eventId: string) => void): void {
  const tiers = launchCatalog.read(now);
  if (tiers) {
    renderTierMapBrief(container, tiers, onShowMap);
    return;
  }
  const previousPrimary = container.querySelector<HTMLDetailsElement>('.map-launch-primary');
  const primaryWasOpen = previousPrimary?.open ?? savedPrimaryOpen(container);
  const primaryHadFocus = !!previousPrimary && previousPrimary.querySelector('summary') === document.activeElement;
  // A refresh can arrive before the native toggle event is delivered.
  if (previousPrimary) savePrimaryOpen(container, primaryWasOpen);
  const moreWasOpen = container.querySelector<HTMLDetailsElement>('.map-launch-more')?.open ?? false;
  const dataWasOpen = container.querySelector<HTMLDetailsElement>('.launch-data-details')?.open ?? false;
  container.className = 'map-launch-brief';
  const selections = selectLaunches(state, now, 'map');
  const nodes: HTMLElement[] = [];
  const coverage = document.createElement('div');
  renderLaunchCoverage(coverage, state, now, 'map');
  const next = selections[0];
  const nextCard = next ? renderLaunchCard(next, state, now, onShowMap) : null;
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
    more.append(summary, ...selections.slice(1).map((selection) => renderLaunchCard(selection, state, now, onShowMap)));
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
}

function renderTierMapBrief(container: HTMLElement, tiers: TierCatalog, onShowMap: (eventId: string) => void): void {
  const previousPrimary = container.querySelector<HTMLDetailsElement>('.map-launch-primary');
  const primaryWasOpen = previousPrimary?.open ?? savedPrimaryOpen(container);
  const primaryHadFocus = !!previousPrimary && previousPrimary.querySelector('summary') === document.activeElement;
  if (previousPrimary) savePrimaryOpen(container, primaryWasOpen);
  const moreWasOpen = container.querySelector<HTMLDetailsElement>('.map-launch-more')?.open ?? false;
  container.className = 'map-launch-brief';
  const primary = tiers.highlights[0] ?? null;
  const rest = tiers.pins.filter((pin) => pin !== primary);
  const nodes: HTMLElement[] = [];
  if (primary) {
    const details = document.createElement('details');
    details.className = 'map-launch-primary';
    details.open = primaryWasOpen;
    const summary = document.createElement('summary');
    summary.textContent = `Next launch · ${tierWord(primary.tier)}`;
    details.append(summary, renderTierCard(primary, onShowMap));
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
    more.append(summary, ...rest.map((pin) => renderTierCard(pin, onShowMap)));
    nodes.push(more);
  }
  if (!primary) {
    const empty = document.createElement('p');
    empty.textContent = 'No Shot or Likely launch in the current forecast.';
    nodes.push(empty);
  }
  container.replaceChildren(...nodes);
  if (primaryHadFocus) container.querySelector<HTMLElement>('.map-launch-primary > summary')?.focus({ preventScroll: true });
}
