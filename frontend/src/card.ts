import type { PassEntry } from './types';
import { formatCountdown, formatScore, formatUtcLabel } from './countdown';

/** Variant marker for cards: 'observed' uses Queue styling (Shoot/Skip on
 *  the imminent pass), 'forecast' uses Upcoming styling (no actions; soft
 *  yellow accent so the user can tell forecast from observed at a glance). */
export type CardVariant = 'observed' | 'forecast';

export interface RenderOptions {
  variant?: CardVariant;
  /** When false, the Shoot/Skip buttons get a "(set token to sync)" hint
   *  so first-time users understand why their clicks aren't persisting
   *  to the calibration log. Click still queues to localStorage. */
  tokenSet?: boolean;
}

/** Render the card list into the cards container.
 *  Each card emits Shoot/Skip events via the provided `onAction` callback.
 *  When `variant === 'forecast'`, action buttons are omitted (a pass 6 h
 *  away isn't actionable yet — the user sets an alarm, doesn't tap Shoot).
 */
export function renderCards(
  container: HTMLElement,
  passes: PassEntry[],
  nowMs: number,
  isStale: boolean,
  onAction: (action: 'shoot' | 'skip', p: PassEntry) => void,
  options: RenderOptions | CardVariant = {},
): void {
  const opts = typeof options === 'string' ? { variant: options } : options;
  container.replaceChildren();
  if (passes.length === 0) {
    return;
  }
  for (const p of passes) {
    container.appendChild(renderCard(p, nowMs, isStale, onAction, opts));
  }
}

export function renderCard(
  p: PassEntry,
  nowMs: number,
  isStale: boolean,
  onAction: (action: 'shoot' | 'skip', p: PassEntry) => void,
  options: RenderOptions | CardVariant = {},
): HTMLElement {
  const opts = typeof options === 'string' ? { variant: options } : options;
  const variant: CardVariant = opts.variant ?? 'observed';
  const tokenSet = opts.tokenSet ?? true;
  const card = document.createElement('article');
  const classes = ['card'];
  if (isStale) classes.push('stale');
  if (variant === 'forecast') classes.push('forecast');
  card.className = classes.join(' ');
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
  } else if (p.sample_time) {
    // Show how recent the cloud reading is so the user can weight day-old
    // MODIS vs 10-min GOES-IR appropriately. Renders as "obs 12m ago" /
    // "obs 3h ago"; older manifests without sample_time fall through silently.
    const age = formatObsAge(p.sample_time, nowMs);
    if (age) meta.appendChild(makeTag('obs-age', `obs ${age}`));
  }
  // Forecast variant: tag the pass so the user knows the cloud number came
  // from GFS (forward-looking) not a current observation. Less certain by
  // design — the badge sets the expectation.
  if (variant === 'forecast' || p.cloud_source === 'gfs-forecast') {
    meta.appendChild(makeTag('forecast-tag', 'forecast'));
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

  // Forecast cards omit Shoot/Skip — passes that far out aren't actionable
  // yet, and the user submits a Shoot record only when actually shooting.
  if (variant === 'observed') {
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const shoot = document.createElement('button');
    shoot.className = 'btn btn-shoot';
    shoot.type = 'button';
    shoot.textContent = tokenSet ? 'Shoot' : 'Shoot · set token';
    shoot.disabled = isStale;
    if (!tokenSet) shoot.title = 'Click still queues offline — set your calibration token in the Log tab to sync.';
    shoot.addEventListener('click', () => onAction('shoot', p));
    const skip = document.createElement('button');
    skip.className = 'btn btn-skip';
    skip.type = 'button';
    skip.textContent = tokenSet ? 'Skip' : 'Skip · set token';
    if (!tokenSet) skip.title = 'Click still queues offline — set your calibration token in the Log tab to sync.';
    skip.addEventListener('click', () => onAction('skip', p));
    actions.append(shoot, skip);
    card.append(name, countdown, meta, score, actions);
  } else {
    card.append(name, countdown, meta, score);
  }
  return card;
}

function makeTag(extraClass: string, text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = `tag ${extraClass}`.trim();
  span.textContent = text;
  return span;
}

/** Format the age of a cloud observation as a card tag suffix. Returns the
 *  empty string (which the caller treats as "skip the tag") for malformed
 *  timestamps or future-dated samples — better to omit the tag than render
 *  "obs -3m ago" on clock skew.
 */
export function formatObsAge(sampleTimeIso: string, nowMs: number): string {
  const t = Date.parse(sampleTimeIso);
  if (Number.isNaN(t)) return '';
  const ageMin = (nowMs - t) / 60_000;
  if (ageMin < 0) return '';
  if (ageMin < 1) return '<1m ago';
  if (ageMin < 60) return `${Math.round(ageMin)}m ago`;
  const h = ageMin / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h ago`;
  return `${Math.round(h / 24)}d ago`;
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
