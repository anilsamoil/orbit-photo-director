import type { LaunchState } from './launch-store';
import { launchBrief, selectLaunches } from './launch-selectors';
import { renderLaunchCard, renderLaunchCoverage } from './launch-card';

/** The nearest launch is the map's main answer; the rest stay one tap away. */
export function renderMapLaunchBrief(container: HTMLElement, state: LaunchState, now: number,
  onShowMap: (eventId: string) => void): void {
  const moreWasOpen = container.querySelector<HTMLDetailsElement>('.map-launch-more')?.open ?? false;
  const openEvents = new Set(Array.from(container.querySelectorAll<HTMLElement>('.launch-brief'))
    .filter((card) => card.querySelector<HTMLDetailsElement>('.launch-details')?.open)
    .map((card) => card.dataset.eventId));
  const dataWasOpen = container.querySelector<HTMLDetailsElement>('.launch-data-details')?.open ?? false;
  container.className = 'map-launch-brief';
  const selections = selectLaunches(state, now, 'map');
  const nodes: HTMLElement[] = [];
  const next = selections[0];
  if (next) nodes.push(renderLaunchCard(next, state, now, onShowMap));
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
  nodes.push(coverage);
  container.replaceChildren(...nodes);
  for (const card of container.querySelectorAll<HTMLElement>('.launch-brief')) {
    if (openEvents.has(card.dataset.eventId)) card.querySelector<HTMLDetailsElement>('.launch-details')!.open = true;
  }
  coverage.querySelector<HTMLDetailsElement>('.launch-data-details')!.open = dataWasOpen;
}
