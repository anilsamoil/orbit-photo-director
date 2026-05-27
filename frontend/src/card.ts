import type { PassEntry } from './types';
import { formatCountdown, formatScore, formatUtcLabel } from './countdown';
import { renderStarBlock, scoreToStars, starsToLabel } from './score-stars';

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
  /** v2 — CEO zoom imagery (Jack feedback 2026-05-27). When provided AND
   *  the pass's target_id is a personal-target id (`personal:…`), the card
   *  adds a 🌍 icon-button that toggles an inline thumbnail under the
   *  card. The factory returns the thumbnail DOM (renderPassThumbnail
   *  from pass-thumbnail.ts); we pass it as a callback so card.ts doesn't
   *  need to import the thumbnail module (keeps the test surface clean —
   *  thumbnail tests run in isolation, card tests don't need to stub
   *  satellite.js or Esri tiles). */
  renderThumbnail?: (pass: PassEntry) => HTMLElement;
}

/** Personal-target ids are minted as `personal:<profile>:<token>` by
 *  profile.ts:makePersonalTargetId. The 🌍 thumbnail button is offered
 *  ONLY on these cards (per design doc: "Each personal-target pass card
 *  gets a 🌍 icon-button"). */
function isPersonalTarget(targetId: string): boolean {
  return targetId.startsWith('personal:');
}

/** Per-session per-card expansion state for the 🌍 thumbnail. Module-local
 *  Set keyed by (target_id + closest_approach) so re-renders preserve
 *  open state. Same pattern as OPEN_BREAKDOWNS for score panels. Not
 *  persisted — refresh / tab-close collapses everything. */
const OPEN_THUMBNAILS = new Set<string>();

function thumbnailKey(p: PassEntry): string {
  return `${p.target_id}|${p.closest_approach}`;
}

/** Test-only: clear the open-thumbnail registry between tests so module
 *  state from one test doesn't leak into the next. */
export function _resetOpenThumbnailsForTest(): void {
  OPEN_THUMBNAILS.clear();
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
  // V3.0 launch-tag is leftmost when present — operator scans the meta
  // row from left to right; "this is a rocket launch" is the most
  // load-bearing thing they can know about a card. Rocket name + window
  // confidence follow as adjacent tags so the visual cluster stays tight.
  if (p.launch) {
    // Kind-aware tag (V3-P2): ASCENT and OVERHEAD are different photo
    // opportunities for the same launch — different lens, look angle, and
    // timing. Operator needs to see which one this card represents.
    // Fall back to generic LAUNCH tag for older manifests that don't yet
    // carry the `kind` field.
    const kind = p.launch.kind ?? p.launch.geometry;
    const launchLabel = kind === 'ascent' ? '🚀 ASCENT plume' :
                        kind === 'overhead' ? '🚀 OVERHEAD pass' :
                        '🚀 LAUNCH';
    const launchClass = kind === 'ascent' ? 'launch-ascent' : 'launch-overhead';
    meta.appendChild(makeTag(launchClass, launchLabel));
    meta.appendChild(makeTag('launch-rocket', p.launch.rocket_type));
    meta.appendChild(makeTag('launch-window', formatLaunchWindow(p.launch.net_window_seconds)));
  }
  meta.appendChild(makeTag(`regime-${p.pass_regime}`, p.pass_regime));
  meta.appendChild(makeTag(obstructionClass(p.obstruction_class), p.obstruction_class));
  meta.appendChild(makeTag('', `${formatUtcLabel(p.closest_approach)}`));
  meta.appendChild(makeTag('', `nadir ${Math.round(p.nadir_distance_km)} km`));
  // Angle off nadir → WORF window vs Cupola hint. Older manifests may not
  // include the field; only render the badge when the generator shipped one.
  // Weather v1.3 tags (Dominick + Pettit feedback 2026-05-19). Render
  // BEFORE the angle/window tag so the most-load-bearing operator signal
  // sits in the eye-scan band right after the launch-kind tag.
  // ⚡ lightning tag: only when potential > 0.05 (placeholder sampler in
  // v1.3.1 always returns 0; this short-circuits silently). Source text
  // differentiates observed vs forecast.
  if (typeof p.lightning_potential === 'number' && p.lightning_potential > 0.05) {
    const obs = p.lightning_source === 'glm' || p.lightning_source === 'blitzortung';
    const label = obs ? '⚡ lightning observed' : '⚡ lightning forecast';
    meta.appendChild(makeTag('weather-lightning', label));
  }
  // 🌀 hurricane tag: real-data even in v1.3.1 (NHC tracker is shipped).
  if (p.hurricane_nearby) {
    const h = p.hurricane_nearby;
    meta.appendChild(makeTag(
      'weather-hurricane',
      `🌀 ${h.classification} ${h.name}`,
    ));
  }
  if (typeof p.angle_off_nadir_deg === 'number') {
    const deg = p.angle_off_nadir_deg;
    const isWorf = deg < 30;
    const window = isWorf ? 'WORF' : 'Cupola';
    // Append direction-of-look so the operator knows which side to point
    // the camera. Without this, "35° · Cupola" is ambiguous between
    // fore/aft/port/starboard. Drops gracefully on older manifests that
    // don't include iss_relative_bearing_deg.
    const direction = typeof p.iss_relative_bearing_deg === 'number'
      ? formatRelativeBearing(p.iss_relative_bearing_deg)
      : null;
    const label = direction
      ? `${Math.round(deg)}° · ${window} · ${direction}`
      : `${Math.round(deg)}° · ${window}`;
    meta.appendChild(makeTag(
      isWorf ? 'window-worf' : 'window-cupola',
      label,
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
  // design — the badge sets the expectation. Include the lookahead horizon
  // ("forecast +6h") so the user can weight 1h-ahead vs 23h-ahead samples;
  // the prior "forecast" tag alone hid that distinction.
  if (variant === 'forecast' || p.cloud_source === 'gfs-forecast') {
    const horizon = p.sample_time ? formatForecastHorizon(p.sample_time, nowMs) : '';
    meta.appendChild(makeTag(
      'forecast-tag',
      horizon ? `forecast ${horizon}` : 'forecast',
    ));
  }

  const score = renderScoreWithBreakdown(p);

  // v2 — 🌍 CEO zoom imagery button (Jack feedback 2026-05-27). Offered on
  // personal-target pass cards only. Tap toggles an inline thumbnail under
  // the card; per-session per-card state. Renderer is injected by the
  // caller (main.ts) to keep card.ts free of satellite/tile deps.
  let thumbnailToggle: HTMLButtonElement | null = null;
  let thumbnailContainer: HTMLDivElement | null = null;
  if (opts.renderThumbnail && isPersonalTarget(p.target_id)) {
    const key = thumbnailKey(p);
    const initiallyOpen = OPEN_THUMBNAILS.has(key);
    thumbnailToggle = document.createElement('button');
    thumbnailToggle.type = 'button';
    thumbnailToggle.className = initiallyOpen
      ? 'btn btn-thumbnail open'
      : 'btn btn-thumbnail';
    thumbnailToggle.setAttribute('aria-expanded', String(initiallyOpen));
    thumbnailToggle.setAttribute(
      'aria-label', 'Toggle satellite imagery thumbnail',
    );
    thumbnailToggle.title = 'Show / hide satellite imagery + ISS track for this pass';
    thumbnailToggle.textContent = '🌍';
    thumbnailContainer = document.createElement('div');
    thumbnailContainer.className = 'pass-thumbnail-container';
    thumbnailContainer.hidden = !initiallyOpen;
    if (initiallyOpen) {
      // Eagerly render on initial open — the per-render path is what the
      // user-click does too, just deferred until the click.
      thumbnailContainer.appendChild(opts.renderThumbnail(p));
    }
    thumbnailToggle.addEventListener('click', () => {
      const opening = thumbnailContainer!.hidden;
      thumbnailContainer!.hidden = !opening;
      thumbnailToggle!.setAttribute('aria-expanded', String(opening));
      thumbnailToggle!.classList.toggle('open', opening);
      if (opening) {
        OPEN_THUMBNAILS.add(key);
        // Render lazily on first open. Subsequent opens reuse the
        // already-mounted thumbnail (browser HTTP cache serves the tile
        // instantly on re-show; SVG overlay is cheap to keep around).
        if (thumbnailContainer!.children.length === 0) {
          thumbnailContainer!.appendChild(opts.renderThumbnail!(p));
        }
      } else {
        OPEN_THUMBNAILS.delete(key);
      }
    });
  }

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
    if (thumbnailToggle) actions.appendChild(thumbnailToggle);
    card.append(name, countdown, meta, score, actions);
    if (thumbnailContainer) card.appendChild(thumbnailContainer);
  } else {
    card.append(name, countdown, meta, score);
    // Forecast variants offer the 🌍 too — same value for the operator,
    // just without the Shoot/Skip row to attach it to. Append directly
    // to the card.
    if (thumbnailToggle) {
      const fcActions = document.createElement('div');
      fcActions.className = 'card-actions card-actions-forecast';
      fcActions.appendChild(thumbnailToggle);
      card.appendChild(fcActions);
    }
    if (thumbnailContainer) card.appendChild(thumbnailContainer);
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

/** Format the lookahead of a GFS forecast sample. Counterpart to
 *  formatObsAge for future-dated cloud readings — "obs N ago" would render
 *  as nothing (formatObsAge returns '' for negative age), leaving the user
 *  blind to whether the forecast is 1h ahead or 23h ahead. Returns
 *  "+Nh" / "+Nd" / "" for malformed timestamps. Past-dated samples return
 *  '' so the caller falls back to formatObsAge.
 */
export function formatForecastHorizon(sampleTimeIso: string, nowMs: number): string {
  const t = Date.parse(sampleTimeIso);
  if (Number.isNaN(t)) return '';
  const aheadMin = (t - nowMs) / 60_000;
  if (aheadMin <= 0) return '';  // not a forecast
  if (aheadMin < 60) return `+${Math.round(aheadMin)}m`;
  const h = aheadMin / 60;
  if (h < 24) return `+${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `+${Math.round(h / 24)}d`;
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

/** Render the launch's NET (No Earlier Than) window half-width as a
 *  human-readable confidence chip. 0s = "T-0 exact"; under 60s = seconds;
 *  under 60min = minutes; otherwise hours. The "±" prefix is critical —
 *  a "Window: 15 min" chip is ambiguous (is that the window length or
 *  half-width?), but "Window: ±15 min" reads as "anywhere in [T-15, T+15]."
 *  Source for the half-width is launch_data.py's net_window_seconds field
 *  computed from (LL2.window_end - LL2.window_start) / 2. */
export function formatLaunchWindow(netWindowSeconds: number): string {
  if (netWindowSeconds <= 0) return 'T-0 exact';
  if (netWindowSeconds < 60) return `Window: ±${netWindowSeconds}s`;
  if (netWindowSeconds < 3600) {
    return `Window: ±${Math.round(netWindowSeconds / 60)} min`;
  }
  const h = netWindowSeconds / 3600;
  return `Window: ±${h.toFixed(h < 10 ? 1 : 0)}h`;
}

/** Convert relative bearing (0=fore, 90=starboard, 180=aft, 270=port) to a
 *  short operator-friendly direction label.
 *
 *  Within ±15° of a cardinal, use just the cardinal word ("fore", "aft",
 *  "port", "starboard"). Otherwise report degrees off forward on the
 *  closer side: 35° → "35° starboard"; 220° → "40° port" (since
 *  360-220=140 off forward is closer measured port-side as 220-180=40
 *  off aft, so we use the smaller-magnitude port representation).
 *
 *  Always describes the smallest reachable angle so the operator's mental
 *  arc is never > 90° from a cardinal.
 */
export function formatRelativeBearing(rel: number): string {
  // Normalize to [0, 360).
  const r = ((rel % 360) + 360) % 360;
  const CARDINAL_THRESHOLD = 15;
  if (r <= CARDINAL_THRESHOLD || r >= 360 - CARDINAL_THRESHOLD) return 'fore';
  if (Math.abs(r - 180) <= CARDINAL_THRESHOLD) return 'aft';
  if (Math.abs(r - 90) <= CARDINAL_THRESHOLD) return 'starboard';
  if (Math.abs(r - 270) <= CARDINAL_THRESHOLD) return 'port';
  // Off-cardinal: name the side, then degrees-off-nearest-cardinal.
  if (r < 90) return `${Math.round(r)}° starboard`;           // fore-starboard
  if (r < 180) return `${Math.round(180 - r)}° starboard aft`; // aft-starboard
  if (r < 270) return `${Math.round(r - 180)}° port aft`;      // aft-port
  return `${Math.round(360 - r)}° port`;                       // fore-port
}

/** Module-level state: which cards (by target_id + closest_approach) have
 *  their score breakdown panel currently open. The `rerenderCountdowns`
 *  tick blows away the entire card DOM every 1 second (TODOS:111-119),
 *  which would otherwise close any panel the user just opened. We keep an
 *  external Set so re-renders can restore the open state without churn.
 *
 *  Key: `${target_id}|${closest_approach}` matches `card.dataset.targetId`
 *  + `card.dataset.passTime` exactly. Same precondition the per-card
 *  Shoot/Skip handlers use to identify a card after re-render. */
const OPEN_BREAKDOWNS = new Set<string>();

function breakdownKey(p: PassEntry): string {
  return `${p.target_id}|${p.closest_approach}`;
}

/** Test-only: clear the open-breakdown registry between tests so module
 *  state from one test doesn't leak into the next. Production code never
 *  calls this — the registry naturally drains as the user closes panels. */
export function _resetOpenBreakdownsForTest(): void {
  OPEN_BREAKDOWNS.clear();
}

/** Render the score line with a click-to-expand breakdown panel.
 *  Chris (2026-05-10): "I think I don't fully understand the queue vs
 *  upcoming and the scoring." This makes the formula transparent — tap the
 *  score number, see the components that produced it. No tooltips (touch
 *  devices), no hover (operator's iPad). Click toggles the panel under the
 *  score line, second click hides it.
 *
 *  The data already exists in PassEntry.score_components — we're not
 *  recomputing anything, just exposing what the generator already published.
 *
 *  Open state survives the 1Hz card re-render via OPEN_BREAKDOWNS — see
 *  the comment on that Set for why it's tracked external to the DOM.
 */
export function renderScoreWithBreakdown(p: PassEntry): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'card-score-wrap';
  const key = breakdownKey(p);
  const initiallyOpen = OPEN_BREAKDOWNS.has(key);

  const line = document.createElement('button');
  line.type = 'button';
  line.className = initiallyOpen ? 'card-score open' : 'card-score';
  line.setAttribute('aria-expanded', String(initiallyOpen));
  line.title = 'Tap to see the score breakdown';

  // Stars replaced the numeric "Score 47" headline in v1.2.5.0 — aligns
  // the predicted-score scale (1-5★) with the operator's calibration
  // rating scale (1-5★) so prediction-vs-rating comparisons in v1.2.5.1+
  // can compare aligned scales. Raw 0-100 stays in the artifact and is
  // surfaced in the breakdown panel for diagnostic use.
  const stars = scoreToStars(p.score);
  const starBlock = renderStarBlock(stars);
  const sep = document.createElement('span');
  sep.className = 'score-label';
  sep.textContent = `· P(unobstructed) ${formatScore(p.p_unobstructed)}`;
  const chev = document.createElement('span');
  chev.className = 'score-chev';
  chev.textContent = '▾';  // rotates to ▴ when open via CSS
  chev.setAttribute('aria-hidden', 'true');
  line.append(starBlock, sep, chev);

  const panel = document.createElement('div');
  panel.className = 'score-breakdown';
  panel.hidden = !initiallyOpen;
  // Breakdown header surfaces the raw score + word anchor ("solid",
  // "marginal", etc.) — diagnostics for "why is this rated this way".
  // Stars alone in the headline lack a verbal anchor (Codex review
  // 2026-05-17 flagged "3 stars doesn't say usable / marginal /
  // excellent"); attaching it here resolves that without cluttering
  // the card's compact title row.
  panel.appendChild(buildBreakdownHeader(stars, p.score));
  panel.appendChild(buildBreakdownTable(p));

  line.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    line.setAttribute('aria-expanded', String(open));
    line.classList.toggle('open', open);
    if (open) {
      OPEN_BREAKDOWNS.add(key);
    } else {
      OPEN_BREAKDOWNS.delete(key);
    }
  });

  wrap.append(line, panel);
  return wrap;
}

/** Header row for the breakdown panel — combines the star tier, raw
 *  composite score, and a word anchor so the operator gets both the
 *  visual signal (stars) and the verbal anchor ("solid", "marginal")
 *  on expand. The headline outside the panel stays star-only to keep
 *  the card compact. */
function buildBreakdownHeader(stars: number, rawScore: number): HTMLElement {
  const header = document.createElement('div');
  header.className = 'score-breakdown-header';
  header.appendChild(renderStarBlock(stars));
  const text = document.createElement('span');
  text.className = 'score-breakdown-header-text';
  text.textContent = ` ${starsToLabel(stars)} · score ${formatScore(rawScore)}`;
  header.appendChild(text);
  return header;
}

function buildBreakdownTable(p: PassEntry): HTMLElement {
  const c = p.score_components;
  // Each row: [name, value 0-100 from generator, what it means]. The
  // generator publishes each component on a 0-100 scale (see
  // generator/score.py:compute_score). Final score is the product divided
  // by 10^4 and clamped — but exposing the components alone is enough for
  // the operator to see "ah, regime fit is the low one" or "nadir distance
  // is killing this score."
  const rows: Array<[string, number, string]> = [
    ['p(unobstructed)', c.p_unobstructed, 'cloud + sun-glint clear'],
    ['regime fit', c.regime_fit, p.target_regime === 'any'
      ? 'target accepts any lighting'
      : `target wants ${p.target_regime}; pass is ${p.pass_regime}`],
    ['nadir proximity', c.nadir_proximity, `ISS ${Math.round(p.nadir_distance_km)} km off target`],
    ['priority weight', c.priority_weight, `target priority ${p.target_priority}/5`],
    ['TLE freshness', c.tle_freshness * 100, `track confidence; 1.0 = fresh, 0.5 = days old`],
  ];
  const table = document.createElement('table');
  table.className = 'score-breakdown-table';
  for (const [name, val, note] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.className = 'sb-name';
    td1.textContent = name;
    const td2 = document.createElement('td');
    td2.className = 'sb-val';
    td2.textContent = formatScore(val);
    const td3 = document.createElement('td');
    td3.className = 'sb-note';
    td3.textContent = note;
    tr.append(td1, td2, td3);
    table.appendChild(tr);
  }
  // Footer with the final composite score so the user can see the math
  // arrives at the score line above.
  const tfoot = document.createElement('tr');
  tfoot.className = 'sb-foot';
  const f1 = document.createElement('td');
  f1.className = 'sb-name';
  f1.textContent = 'Composite';
  const f2 = document.createElement('td');
  f2.className = 'sb-val';
  f2.textContent = formatScore(p.score);
  const f3 = document.createElement('td');
  f3.className = 'sb-note';
  f3.textContent = 'product of the five above, scaled 0-100';
  tfoot.append(f1, f2, f3);
  table.appendChild(tfoot);
  return table;
}
