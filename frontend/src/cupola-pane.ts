/** Cupola keepsake-window pane (Loral 2026-06-15).
 *
 *  On-demand: a button reveals a panel of "good Cupola window" cards (daylit +
 *  low-cloud + land/ocean-mix moments for shooting floating trinkets). The
 *  windows are PassEntry-compatible, so they ride the EXISTING card +
 *  🔔 Remind + Add-to-Calendar machinery via renderCards({variant:'forecast'})
 *  — no card.ts fork. This module only wires the toggle, fetches on open, and
 *  appends the golden-hour / water-mix tags. Occasional use → off the main
 *  feed until the button is tapped (busy-ness contract).
 */
import { renderCards, type CardAction } from './card';
import type { PassEntry } from './types';

export interface CupolaPaneDeps {
  button: HTMLElement;
  pane: HTMLElement;            // collapsible container, hidden by default
  cardsContainer: HTMLElement;  // #cupola-cards
  onCardAction: (action: CardAction, p: PassEntry) => void;
  loadWindows: () => Promise<PassEntry[]>;
}

function message(container: HTMLElement, text: string): void {
  container.textContent = '';
  const el = document.createElement('div');
  el.className = 'cupola-empty';
  el.textContent = text;
  container.appendChild(el);
}

/** Append the golden-hour + water-mix decorator tags to each rendered card.
 *  Kept OUT of card.ts (no cupola branch there); a missing .card-meta simply
 *  no-ops via the guard. */
export function decorateCupolaTags(container: HTMLElement, windows: PassEntry[]): void {
  const byId = new Map(windows.map((w) => [w.target_id, w]));
  for (const child of Array.from(container.children)) {
    const card = child as HTMLElement;
    const w = byId.get(card.dataset.targetId ?? '');
    if (!w) continue;
    const meta = card.querySelector('.card-meta');
    if (!meta) continue;
    if (w.golden_hour) {
      const tag = document.createElement('span');
      tag.className = 'tag golden-hour';
      tag.textContent = '🌇 golden hour';
      meta.appendChild(tag);
    }
    if (typeof w.water_pct === 'number') {
      const tag = document.createElement('span');
      tag.className = 'tag water-pct';
      tag.textContent = `🌊 water ${Math.round(w.water_pct)}%`;
      meta.appendChild(tag);
    }
  }
}

export function setupCupolaPane(deps: CupolaPaneDeps): void {
  const { button, pane, cardsContainer, onCardAction, loadWindows } = deps;
  let open = false;
  let inFlight = false;

  button.addEventListener('click', async () => {
    open = !open;
    pane.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('active', open);
    if (!open || inFlight) return;

    inFlight = true;
    message(cardsContainer, 'Finding memorabilia windows…');
    let windows: PassEntry[] = [];
    try {
      windows = await loadWindows();
    } catch {
      message(cardsContainer, 'Fetch windows when online — could not load just now.');
      inFlight = false;
      return;
    }
    inFlight = false;
    if (!windows.length) {
      message(cardsContainer, 'No memorabilia windows just now — fetch again when online.');
      return;
    }
    cardsContainer.textContent = '';
    // 'forecast' variant: omits Shoot/Skip (no calibration for a region) but
    // keeps 🔔 Remind + Hide — exactly the locked reuse.
    renderCards(cardsContainer, windows, Date.now(), false, onCardAction, { variant: 'forecast' });
    decorateCupolaTags(cardsContainer, windows);
  });
}
