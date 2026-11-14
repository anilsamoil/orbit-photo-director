import { setMapLaunchMode } from '../../../map-launch-mode';
import {
  CURATED_SATELLITES,
  alsoInOrbit,
  staleOrbit,
  lookupMessage,
  metaKey,
  type OrbitLookup,
  type SatelliteMeta,
} from '../../../satellites';
import { isPublished, metaForQuery } from './selection';

const ISS_KEY = '25544';

export type AddResult = { ok: boolean; message: string };

/** What the picker shows for a wanted satellite. `lookup` is null while
 *  the first lookup runs. `sight` is the ISS line-of-sight line. */
export type PickerRow = { lookup: OrbitLookup | null; sight: string | null };

export interface PickerPort {
  /** Published vehicles and typed satellites, beyond the curated list. */
  metas(): SatelliteMeta[];
  row(key: string): PickerRow | undefined;
  add(meta: SatelliteMeta): Promise<AddResult>;
  /** Add what the operator typed. A lookup that finds nothing is not kept. */
  addTyped(meta: SatelliteMeta): Promise<AddResult>;
  remove(key: string): void;
  resize(): void;
}

const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function showStatus(status: HTMLElement | null, result: AddResult): void {
  if (!status) return;
  status.textContent = result.message;
  status.className = `satellite-picker-status ${result.ok ? 'success' : 'error'}`;
}

function badge(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** The curated rows in their fixed order, then published vehicles and
 *  typed satellites. A row never moves when it is checked. */
function listed(port: PickerPort): SatelliteMeta[] {
  const curated = CURATED_SATELLITES.filter((meta) => metaKey(meta) !== ISS_KEY && !isPublished(meta));
  const curatedKeys = new Set(curated.map(metaKey));
  return [...curated, ...port.metas().filter((meta) => !curatedKeys.has(metaKey(meta)))];
}

/** One line per wanted satellite: why nothing is drawn, or when the ISS
 *  has a line of sight to what is drawn and which other objects of that
 *  vehicle are in orbit. */
function rowNote(meta: SatelliteMeta, row: PickerRow): HTMLElement | null {
  if (!row.lookup) return null;
  const drawn = row.lookup.state === 'elements';
  const about = [staleOrbit(row.lookup), row.sight, alsoInOrbit(row.lookup)].filter(Boolean).join('. ');
  const text = drawn ? about && `${meta.name}: ${about}` : lookupMessage(meta, row.lookup);
  if (!text) return null;
  const note = document.createElement('div');
  note.className = drawn ? 'sat-row-note' : 'sat-row-note error';
  note.textContent = text;
  return note;
}

/** The notes sit under the list, not between its rows, so a note never
 *  moves a row the operator is about to tap. */
function notesBlock(list: HTMLElement): HTMLElement {
  const existing = byId('satellite-picker-notes');
  if (existing) return existing;
  const notes = document.createElement('div');
  notes.id = 'satellite-picker-notes';
  notes.className = 'satellite-picker-notes';
  notes.setAttribute('role', 'status');
  list.insertAdjacentElement('afterend', notes);
  return notes;
}

/** Rebuilt on open and on every change while open, so checkboxes and
 *  badges never disagree with what is wanted. A closed panel is left alone:
 *  a rebuild resizes the map, which would cut a drag in progress. A checked box means wanted,
 *  whether or not an orbit could be drawn. */
export function renderPickerList(port: PickerPort): void {
  const list = byId('satellite-picker-list');
  if (!list || byId('satellite-picker-panel')?.hidden) return;
  list.textContent = '';
  const notes = notesBlock(list);
  notes.textContent = '';
  for (const meta of listed(port)) {
    const key = metaKey(meta);
    const row = port.row(key);
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!row;
    box.addEventListener('change', async () => {
      if (box.checked) {
        const status = byId('satellite-picker-status');
        if (status) {
          status.textContent = `Looking up ${meta.name}…`;
          status.className = 'satellite-picker-status';
        }
        showStatus(status, await port.add(meta));
      } else {
        port.remove(key);
        const status = byId('satellite-picker-status');
        if (status && isPublished(meta)) {
          status.textContent = `${meta.name} is hidden. Check it to look for its orbit again.`;
          status.className = 'satellite-picker-status';
        }
      }
      renderPickerList(port);
    });
    const icon = badge('sat-icon', meta.icon);
    const name = document.createElement('span');
    name.textContent = meta.name;
    label.append(box, icon, name);
    const lookup = row?.lookup;
    if (lookup?.state === 'elements') {
      if (lookup.stale_epoch_hours !== undefined) label.appendChild(badge('sat-stale', 'stale orbit'));
      else if (lookup.stale) label.appendChild(badge('sat-stale', isPublished(meta) ? 'last good' : 'stale TLE'));
      else if (lookup.match_count > 1) label.appendChild(badge('sat-multi-match', `1 of ${lookup.match_count}`));
    } else if (lookup) {
      label.appendChild(badge('sat-stale', 'no orbit'));
    }
    list.appendChild(label);
    const note = row ? rowNote(meta, row) : null;
    if (note) notes.appendChild(note);
  }
  requestAnimationFrame(() => port.resize());
}

export function bindPicker(port: PickerPort): void {
  const button = byId('toggle-satellite-picker');
  const panel = byId('satellite-picker-panel');
  const input = byId<HTMLInputElement>('satellite-picker-input');
  const addButton = byId('satellite-picker-add');
  const status = byId('satellite-picker-status');
  if (!button || !panel || !input || !addButton) return;

  let open = false;
  const close = (): void => {
    open = false;
    panel.hidden = true;
    button.classList.remove('active');
    requestAnimationFrame(() => port.resize());
  };
  const show = (): void => {
    setMapLaunchMode(false);
    open = true;
    panel.hidden = false;
    button.classList.add('active');
    renderPickerList(port);
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) close();
    else show();
  });
  document.addEventListener('click', (e) => {
    if (!open) return;
    const target = e.target as Node | null;
    if (target && (panel.contains(target) || button.contains(target))) return;
    close();
  });

  const addTyped = async (): Promise<void> => {
    const query = input.value.trim();
    if (!query) return;
    if (status) {
      status.textContent = 'Searching…';
      status.className = 'satellite-picker-status';
    }
    const result = await port.addTyped(metaForQuery(query));
    showStatus(status, result);
    if (result.ok) input.value = '';
    renderPickerList(port);
  };
  addButton.addEventListener('click', () => { void addTyped(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addTyped();
  });
}
