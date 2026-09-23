import { setMapLaunchMode } from '../../../map-launch-mode';
import { CURATED_SATELLITES, metaKey, type SatelliteMeta } from '../../../satellites';
import { metaForQuery } from './selection';

const ISS_KEY = '25544';

export type AddResult = { ok: boolean; message: string };

export interface PickerPort {
  tracked(key: string): { stale: boolean; matchCount: number } | undefined;
  add(meta: SatelliteMeta): Promise<AddResult>;
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

/** Rebuilt on open and on every selection change, so checkboxes and
 *  badges never disagree with what is tracked. */
export function renderPickerList(port: PickerPort): void {
  const list = byId('satellite-picker-list');
  if (!list) return;
  list.textContent = '';
  for (const meta of CURATED_SATELLITES) {
    const key = metaKey(meta);
    if (key === ISS_KEY) continue;
    const state = port.tracked(key);
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!state;
    box.addEventListener('change', async () => {
      if (box.checked) {
        const status = byId('satellite-picker-status');
        if (status) status.textContent = `Fetching ${meta.name}…`;
        const result = await port.add(meta);
        showStatus(status, result);
        if (!result.ok) box.checked = false;
      } else {
        port.remove(key);
      }
      renderPickerList(port);
    });
    const icon = badge('sat-icon', meta.icon);
    const name = document.createElement('span');
    name.textContent = meta.name;
    label.append(box, icon, name);
    if (state?.stale) label.appendChild(badge('sat-stale', 'stale TLE'));
    else if (state && state.matchCount > 1) label.appendChild(badge('sat-multi-match', `1 of ${state.matchCount}`));
    list.appendChild(label);
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
    const result = await port.add(metaForQuery(query));
    showStatus(status, result);
    if (result.ok) {
      input.value = '';
      renderPickerList(port);
    }
  };
  addButton.addEventListener('click', () => { void addTyped(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addTyped();
  });
}
