import type { PassEntry } from './types';
import { formatCountdown, formatScore, formatUtcLabel } from './countdown';

/** Render the card list into the cards container.
 *  Each card emits Shoot/Skip events via the provided `onAction` callback.
 */
export function renderCards(
  container: HTMLElement,
  passes: PassEntry[],
  nowMs: number,
  isStale: boolean,
  onAction: (action: 'shoot' | 'skip', p: PassEntry) => void
): void {
  container.replaceChildren();
  if (passes.length === 0) {
    return;
  }
  for (const p of passes) {
    container.appendChild(renderCard(p, nowMs, isStale, onAction));
  }
}

export function renderCard(
  p: PassEntry,
  nowMs: number,
  isStale: boolean,
  onAction: (action: 'shoot' | 'skip', p: PassEntry) => void
): HTMLElement {
  const card = document.createElement('article');
  card.className = isStale ? 'card stale' : 'card';
  card.dataset.targetId = p.target_id;
  card.dataset.passTime = p.closest_approach;

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = p.target_name;

  const countdown = document.createElement('div');
  countdown.className = 'card-countdown';
  countdown.textContent = formatCountdown(p.closest_approach, nowMs);
  countdown.title = `Closest approach: ${formatUtcLabel(p.closest_approach)}`;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.appendChild(makeTag(`regime-${p.pass_regime}`, p.pass_regime));
  meta.appendChild(makeTag(obstructionClass(p.obstruction_class), p.obstruction_class));
  meta.appendChild(makeTag('', `${formatUtcLabel(p.closest_approach)}`));
  meta.appendChild(makeTag('', `nadir ${Math.round(p.nadir_distance_km)} km`));
  // Angle off nadir → WORF window vs Cupola hint. Older manifests may not
  // include the field; only render the badge when the generator shipped one.
  if (typeof p.angle_off_nadir_deg === 'number') {
    const deg = p.angle_off_nadir_deg;
    const isWorf = deg < 30;
    const window = isWorf ? 'WORF' : 'Cupola';
    meta.appendChild(makeTag(
      isWorf ? 'window-worf' : 'window-cupola',
      `${Math.round(deg)}° · ${window}`,
    ));
  }
  if (isNoObservationSource(p.cloud_source)) {
    // Tell the user the cloud score is a placeholder, not a real measurement.
    meta.appendChild(makeTag('obs-noobs', 'no cloud obs'));
  }

  const score = document.createElement('div');
  score.className = 'card-score';
  const label = document.createElement('span');
  label.className = 'score-label';
  label.textContent = 'Score';
  const value = document.createElement('span');
  value.className = 'score-value';
  value.textContent = formatScore(p.score);
  const sep = document.createElement('span');
  sep.className = 'score-label';
  sep.textContent = `· P(unobstructed) ${formatScore(p.p_unobstructed)}`;
  score.append(label, value, sep);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const shoot = document.createElement('button');
  shoot.className = 'btn btn-shoot';
  shoot.type = 'button';
  shoot.textContent = 'Shoot';
  shoot.disabled = isStale;
  shoot.addEventListener('click', () => onAction('shoot', p));
  const skip = document.createElement('button');
  skip.className = 'btn btn-skip';
  skip.type = 'button';
  skip.textContent = 'Skip';
  skip.addEventListener('click', () => onAction('skip', p));
  actions.append(shoot, skip);

  card.append(name, countdown, meta, score, actions);
  return card;
}

function makeTag(extraClass: string, text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = `tag ${extraClass}`.trim();
  span.textContent = text;
  return span;
}

function obstructionClass(c: string): string {
  if (c === 'clear') return 'obs-clear';
  if (c === 'cloudy') return 'obs-cloudy';
  if (c === 'sun-glint risk') return 'obs-glint';
  return '';
}

const NO_OBSERVATION_SOURCES = new Set([
  'combined-no-coverage',
  'gibs-no-obs',
  'gibs-nodata',
  'geo-ir-no-coverage',
  'geo-ir-nodata',
  'himawari-no-coverage',
  'himawari-night',
  'mock',
]);

function isNoObservationSource(source: string): boolean {
  return NO_OBSERVATION_SOURCES.has(source);
}
