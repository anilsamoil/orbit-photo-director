import { launchCatalog } from './launch-catalog';
import { tierScheduleFacts, tierWord, type TierLaunch } from './launch-tiers';

function row(container: HTMLElement, label: string, value: string): void {
  const line = document.createElement('div');
  line.className = 'launch-fact';
  const name = document.createElement('span');
  name.className = 'launch-fact-label';
  name.textContent = label;
  const text = document.createElement('span');
  text.textContent = value;
  line.append(name, text);
  container.append(line);
}

export function renderTierCard(launch: TierLaunch, onShowMap?: (eventId: string) => void): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card launch launch-tier';
  card.dataset.launch = 'tier';
  card.dataset.tier = launch.tier;
  card.dataset.eventId = launch.eventId;
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'card-name launch-name';
  name.textContent = launch.name;
  name.addEventListener('click', () => openTierDetails(launch));
  const summary = document.createElement('div');
  summary.className = 'launch-summary';
  row(summary, 'Tier', tierWord(launch.tier));
  row(summary, 'Site', launch.site.name);
  for (const fact of tierScheduleFacts(launch)) row(summary, fact.label, fact.text);
  const why = document.createElement('p');
  why.textContent = launch.why;
  card.append(name, summary, why);
  if (onShowMap) {
    const actions = document.createElement('div');
    actions.className = 'launch-brief-actions';
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'btn';
    show.textContent = launch.corridor ? 'Show site and corridor' : 'Show launch site';
    show.addEventListener('click', () => onShowMap(launch.eventId));
    actions.append(show);
    card.append(actions);
  }
  return card;
}

function evidenceNote(kind: 'expired' | 'missing'): HTMLParagraphElement {
  const note = document.createElement('p');
  note.dataset.tierEvidence = kind;
  note.textContent = kind === 'expired' ? 'STALE / EXPIRED DATA' : 'This launch is not in the current catalog.';
  return note;
}

/** Details follow the catalog. A closed dialog drops its subscription. */
export function openTierDetails(launch: TierLaunch): void {
  document.querySelector<HTMLDialogElement>('.launch-dialog')?.close();
  const eventId = launch.eventId;
  const dialog = document.createElement('dialog');
  dialog.className = 'launch-dialog';
  const heading = document.createElement('h2');
  heading.id = 'launch-details-title';
  heading.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', heading.id);
  const content = document.createElement('div');
  content.className = 'launch-facts';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  const paint = (): void => {
    const tiers = launchCatalog.read(Date.now());
    const current = tiers?.find(eventId) ?? null;
    heading.textContent = current?.name ?? 'Launch';
    content.replaceChildren();
    if (!current) {
      content.append(evidenceNote(tiers ? 'missing' : 'expired'));
      return;
    }
    row(content, 'Tier', tierWord(current.tier));
    row(content, 'Site', current.site.name);
    for (const fact of tierScheduleFacts(current)) row(content, fact.label, fact.text);
    const why = document.createElement('p');
    why.textContent = current.why;
    const track = document.createElement('p');
    track.dataset.tierTrack = '1';
    track.textContent = current.corridor
      ? current.corridor.points.map((point) => `${point.lat.toFixed(2)}, ${point.lon.toFixed(2)}`).join(' → ')
      : 'Pad only';
    content.append(why, track);
  };
  const unsubscribe = launchCatalog.subscribe(paint);
  dialog.addEventListener('close', () => {
    unsubscribe();
    dialog.remove();
  }, { once: true });
  dialog.append(heading, content, close);
  paint();
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  heading.focus({ preventScroll: true });
}
