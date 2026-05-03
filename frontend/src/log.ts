/** Calibration log view. Lists Shoot/Skip events from the Worker, joins each
 *  with any subsequent Rate event on the same (target_id, pass_time), and
 *  surfaces unrated Shoots so the user can attach 1-5 + observed-obstruction.
 *
 *  The Worker only stores one event per dedupe_key; ratings are separate events
 *  with action="rate" linked back by target_id+pass_time.
 */

import { buildPayload, getToken, postCalib } from './calib';
import { formatUtcLabel } from './countdown';
import type { CalibPayload } from './types';

export interface LogEntry {
  target_id: string;
  target_name?: string;
  pass_time: string;
  action: 'shoot' | 'skip' | 'rate';
  score_at_time?: number;
  rating?: number;
  observed_obstruction?: string;
  received_at?: string;
}

export interface MergedRow {
  target_id: string;
  target_name: string;
  pass_time: string;
  action: 'shoot' | 'skip';
  score_at_time?: number;
  rating?: number;
  observed_obstruction?: string;
  received_at?: string;
}

const OBSTRUCTION_OPTIONS = [
  'clear',
  'cloudy',
  'sun-glint',
  'thin cirrus',
  'haze',
  'other',
] as const;

/** Fetch the recent log from the Worker. Returns [] if unauthenticated. */
export async function fetchLog(baseUrl = '', limit = 100): Promise<LogEntry[]> {
  const token = getToken();
  if (!token) return [];
  try {
    const resp = await fetch(`${baseUrl}/api/log?limit=${limit}`, {
      headers: { 'x-calib-token': token },
      cache: 'no-cache',
    });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { entries?: LogEntry[] };
    return body.entries ?? [];
  } catch {
    return [];
  }
}

/** Group raw log entries by (target_id, pass_time). Each group becomes ONE
 *  row in the UI: the original Shoot/Skip event, optionally enriched with
 *  rating+obstruction from a subsequent Rate event.
 *
 *  Skip events are kept (you can rate a Skip too — "would have been clear,
 *  glad I did"), but Skips without a Shoot don't appear in queue-rating UX
 *  workflows.
 */
export function mergeLogEntries(entries: LogEntry[]): MergedRow[] {
  const byKey = new Map<string, MergedRow>();
  for (const e of entries) {
    const key = `${e.target_id}|${e.pass_time}`;
    if (e.action === 'shoot' || e.action === 'skip') {
      // Don't overwrite an existing entry — keep the first (most recent)
      if (!byKey.has(key)) {
        byKey.set(key, {
          target_id: e.target_id,
          target_name: e.target_name ?? e.target_id,
          pass_time: e.pass_time,
          action: e.action,
          score_at_time: e.score_at_time,
          received_at: e.received_at,
        });
      }
    }
  }
  // Second pass: fold rate events into the matching shoot/skip rows.
  for (const e of entries) {
    if (e.action !== 'rate') continue;
    const key = `${e.target_id}|${e.pass_time}`;
    const row = byKey.get(key);
    if (!row) continue;
    if (typeof e.rating === 'number' && (row.rating === undefined || row.rating < e.rating)) {
      // Most recent rate wins; keep latest by received_at
      const existingTs = row.received_at ?? '';
      const newTs = e.received_at ?? '';
      if (newTs >= existingTs || row.rating === undefined) {
        row.rating = e.rating;
        row.observed_obstruction = e.observed_obstruction;
      }
    }
  }
  // Order: most recent received_at desc
  return Array.from(byKey.values()).sort((a, b) => {
    const ar = a.received_at ?? '';
    const br = b.received_at ?? '';
    return br.localeCompare(ar);
  });
}

/** Render the calibration log into the given container. Returns the number of
 *  rows rendered. Call this on tab activate + after each rate submission.
 */
export function renderLog(
  listEl: HTMLElement,
  emptyEl: HTMLElement,
  statsEl: HTMLElement,
  rows: MergedRow[],
  onRate: (row: MergedRow) => void,
): number {
  listEl.replaceChildren();
  if (rows.length === 0) {
    emptyEl.hidden = false;
    statsEl.replaceChildren();
    return 0;
  }
  emptyEl.hidden = true;

  // Stats
  const shoots = rows.filter((r) => r.action === 'shoot').length;
  const rated = rows.filter((r) => r.rating !== undefined).length;
  const stats = document.createDocumentFragment();
  const mkStat = (label: string, value: string) => {
    const span = document.createElement('span');
    span.innerHTML = `${label}: <span class="stat-value">${value}</span>`;
    return span;
  };
  stats.appendChild(mkStat('total', String(rows.length)));
  stats.appendChild(mkStat('shoots', String(shoots)));
  stats.appendChild(mkStat('rated', `${rated}/${shoots}`));
  statsEl.replaceChildren(stats);

  for (const r of rows) {
    listEl.appendChild(renderRow(r, onRate));
  }
  return rows.length;
}

function renderRow(row: MergedRow, onRate: (row: MergedRow) => void): HTMLElement {
  const el = document.createElement('article');
  el.className = 'log-row';

  const left = document.createElement('div');
  const target = document.createElement('div');
  target.className = 'row-target';
  target.textContent = row.target_name;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.appendChild(span(formatUtcLabel(row.pass_time)));
  if (row.score_at_time !== undefined) {
    meta.appendChild(span(`score ${Math.round(row.score_at_time)}`));
  }
  if (row.observed_obstruction) {
    meta.appendChild(span(`observed: ${row.observed_obstruction}`));
  }
  left.append(target, meta);

  const right = document.createElement('div');
  right.style.cssText = 'display:flex;gap:0.5rem;align-items:center;';

  const actionTag = document.createElement('span');
  actionTag.className = `row-action ${row.action}`;
  actionTag.textContent = row.action;
  right.appendChild(actionTag);

  if (row.rating !== undefined) {
    const stars = document.createElement('span');
    stars.className = 'row-rating-stars';
    stars.textContent = '★'.repeat(row.rating) + '☆'.repeat(5 - row.rating);
    right.appendChild(stars);
  } else if (row.action === 'shoot') {
    const btn = document.createElement('button');
    btn.className = 'row-rate-btn';
    btn.type = 'button';
    btn.textContent = 'Rate';
    btn.addEventListener('click', () => onRate(row));
    right.appendChild(btn);
  }

  el.append(left, right);
  return el;
}

function span(text: string): HTMLElement {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

/** Open the rating modal. Returns a promise that resolves when the user
 *  submits OR cancels. On submit, posts a Rate event and resolves true.
 */
export function openRateModal(row: MergedRow, baseUrl = ''): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const h3 = document.createElement('h3');
    h3.textContent = `Rate this shoot: ${row.target_name}`;
    const metaP = document.createElement('p');
    metaP.className = 'modal-meta';
    metaP.textContent = `Pass at ${formatUtcLabel(row.pass_time)} · predicted score ${Math.round(row.score_at_time ?? 0)}`;

    const ratingLabel = document.createElement('label');
    ratingLabel.textContent = 'Image quality (1-5)';
    const starRow = document.createElement('div');
    starRow.className = 'star-row';
    let chosenRating = 0;
    const starBtns: HTMLButtonElement[] = [];
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'star-btn';
      b.textContent = String(i);
      b.addEventListener('click', () => {
        chosenRating = i;
        starBtns.forEach((sb, idx) => {
          sb.classList.toggle('active', idx < i);
        });
      });
      starBtns.push(b);
      starRow.appendChild(b);
    }

    const obsLabel = document.createElement('label');
    obsLabel.textContent = 'What did you actually see?';
    const obsSelect = document.createElement('select');
    const blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = '— select —';
    obsSelect.appendChild(blankOpt);
    for (const o of OBSTRUCTION_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      obsSelect.appendChild(opt);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-skip';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      backdrop.remove();
      resolve(false);
    });
    const submit = document.createElement('button');
    submit.className = 'btn btn-shoot';
    submit.type = 'button';
    submit.textContent = 'Save';
    submit.addEventListener('click', async () => {
      if (chosenRating < 1) {
        submit.textContent = 'Pick a rating first';
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Saving...';
      const payload: CalibPayload = {
        ...buildPayload('rate', row.target_id, row.pass_time, row.score_at_time ?? 0),
        rating: chosenRating,
        observed_obstruction: obsSelect.value || undefined,
        // Different dedupe key from the original shoot so both events store.
        dedupe_key: `${row.target_id}|${row.pass_time}|rate|${chosenRating}`,
      };
      const result = await postCalib(payload, baseUrl);
      backdrop.remove();
      resolve(result.ok);
    });
    actions.append(cancel, submit);

    modal.append(h3, metaP, ratingLabel, starRow, obsLabel, obsSelect, actions);
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.remove();
        resolve(false);
      }
    });
    document.body.appendChild(backdrop);
  });
}
