import type { LaunchState } from './launch-store';
import { launchBrief, selectLaunches } from './launch-selectors';
import { renderLaunchCard, renderLaunchCoverage } from './launch-card';

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
  const previousPrimary = container.querySelector<HTMLDetailsElement>('.map-launch-primary');
  const primaryWasOpen = previousPrimary?.open ?? savedPrimaryOpen(container);
  const primaryHadFocus = !!previousPrimary && previousPrimary.querySelector('summary') === document.activeElement;
  // A refresh can arrive before the native toggle event is delivered.
  if (previousPrimary) savePrimaryOpen(container, primaryWasOpen);
  const moreWasOpen = container.querySelector<HTMLDetailsElement>('.map-launch-more')?.open ?? false;
  const openEvents = new Set(Array.from(container.querySelectorAll<HTMLElement>('.launch-brief'))
    .filter((card) => card.querySelector<HTMLDetailsElement>('.launch-details')?.open)
    .map((card) => card.dataset.eventId));
  const dataWasOpen = container.querySelector<HTMLDetailsElement>('.launch-data-details')?.open ?? false;
  container.className = 'map-launch-brief';
  const selections = selectLaunches(state, now, 'map');
  const nodes: HTMLElement[] = [];
  const next = selections[0];
  const nextCard = next ? renderLaunchCard(next, state, now, onShowMap) : null;
  if (next && nextCard) {
    const primary = document.createElement('details');
    primary.className = 'map-launch-primary';
    primary.open = primaryWasOpen;
    const summary = document.createElement('summary');
    const brief = launchBrief(next, state, now);
    summary.textContent = `Next launch · ${brief.label}`;
    summary.dataset.hasChance = String(brief.verdict === 'chance');
    primary.append(summary, nextCard);
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
  const coverage = document.createElement('div');
  renderLaunchCoverage(coverage, state, now, 'map');
  if (!next) {
    const empty = document.createElement('p');
    empty.textContent = state.artifact
      ? 'No upcoming launch is listed in the available schedule.'
      : 'Checking upcoming launches…';
    if (!state.artifact && state.availability !== 'loading') empty.textContent = 'Launch schedule unavailable. Reconnect to check upcoming launches.';
    nodes.push(empty);
  }
  if (nextCard) nextCard.querySelector('.launch-details')!.append(coverage);
  else nodes.push(coverage);
  container.replaceChildren(...nodes);
  for (const card of container.querySelectorAll<HTMLElement>('.launch-brief')) {
    if (openEvents.has(card.dataset.eventId)) card.querySelector<HTMLDetailsElement>('.launch-details')!.open = true;
  }
  coverage.querySelector<HTMLDetailsElement>('.launch-data-details')!.open = dataWasOpen;
  if (primaryHadFocus) container.querySelector<HTMLElement>('.map-launch-primary > summary')?.focus({ preventScroll: true });
}
