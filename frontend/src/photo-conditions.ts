/** Photo Conditions — the shared surface for photography signals (Unit 1).
 *
 *  Seven photography signals land across this arc (camera line, beta-angle
 *  blackout, moon, orbital golden hour, NLC windows, sun glint, sprite
 *  watch). This module is the ONE place they surface so the site never
 *  becomes an instrument panel. The busy-ness contract (plan 2026-06-11):
 *
 *    1. Collapsed cards gain NOTHING — conditions render only inside the
 *       expanded 🌍 thumbnail panel, BELOW the image at card width (D4:
 *       the caption rows are a 256px overlay and cannot fit condition
 *       content).
 *    2. At most MAX_VISIBLE_ROWS condition rows + a divider + an optional
 *       "▸ N more" disclosure. Provider order IS display priority.
 *    3. Every row is a real <button> that opens the Photography Almanac
 *       at its entry — the row shows the number, the almanac explains why.
 *    4. Silence is a feature: a condition that doesn't apply returns null
 *       and renders nothing.
 *
 *  Architecture: providers are pure functions over a single ctx object —
 *  later units widen the ctx without breaking signatures, add ONE provider
 *  to PROVIDERS and ONE almanac entry, and touch nothing else.
 *
 *      ctx ──► PROVIDERS[] ──► buildConditionRows() ──► renderConditionBlock()
 *               (ordered)        Row[] (pure)             DOM under thumbnail
 */

import type { Manifest, PassEntry, Track } from './types';
import { openHelpModal } from './help';
import { betaCriticalDeg, scanBetaForecast } from './beta-angle';
import { assessMoon } from './moon';

// ── Physics constants ──────────────────────────────────────────────────────
// Sources: D. Pettit, "Astronauts' Guide to Photography from Space",
// 2nd ed. (2017) — Fig. 23 (lens kit + fields of view), "Telephoto Lens
// Skills" (hand-tracking, 1/f floor, 2-3 month learning curve), "Shutter
// Speed" (orbital-motion blur). Nikon Z9 sensor data: Nikon specifications
// (45.7MP FX, 35.9×23.9mm → 4.35µm pitch).

/** ISS ground-relative speed, km/s. Conservative: treats ALL motion as
 *  cross-line-of-sight, so floors err toward fast (a too-slow floor smears
 *  the shot; too-fast merely costs ISO — asymmetric harm). */
export const V_REL_KM_S = 7.7;
/** Nikon Z9 pixel pitch, µm. The D5 the guide was written for has 6.45µm
 *  pixels — the Z9's finer grid needs ~1.5× faster shutters for the same
 *  pixel-level sharpness, which is exactly how we modernize Pettit's 1/f
 *  tracked rule below. */
export const PITCH_UM = 4.35;
/** Acceptable smear budget on the sensor, pixels. */
export const BLUR_BUDGET_PX = 1.5;
/** FX sensor width, mm (Pettit guide: "36 by 24 millimeters"; Z9 35.9). */
export const SENSOR_W_MM = 35.9;
/** Mean Earth radius, km (slant-range geometry). */
const EARTH_RADIUS_KM = 6371;
/** ISS altitude fallback when the pass carries none, km. */
export const DEFAULT_ALT_KM = 420;
/** The long-lens kit that actually flies (guide Fig. 23): 400mm f2.8,
 *  800mm (2× TC on the 400), 1200mm. "The use of the long focal length
 *  telephoto lenses with focal lengths ranging from 400 to 1200mm is
 *  popular among the crew." The originally-planned 200mm anchor does not
 *  exist in the drawer. */
export const KIT_FOCAL_LENGTHS_MM = [400, 800, 1200] as const;

/** Third-stop shutter ladder (denominators), so floors read like a camera
 *  dial instead of a calculator. Spans the orbital-photography range. */
export const SHUTTER_LADDER = [
  60, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800,
  1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000,
] as const;

// ── Math (all exported — tests import these, never re-implement) ──────────

/** Slant range to a ground point `nadirKm` of GREAT-CIRCLE ground distance
 *  away, from `altKm` up. Law of cosines on the Earth-center triangle —
 *  nadir_distance_km is arc distance, not a flat chord (outside voice #9;
 *  the flat √(alt²+nadir²) under-reads on oblique encounters). */
export function slantRangeKm(nadirKm: number, altKm: number): number {
  const r = EARTH_RADIUS_KM;
  const theta = nadirKm / r;
  const ra = r + altKm;
  return Math.sqrt(r * r + ra * ra - 2 * r * ra * Math.cos(theta));
}

/** Apparent angular rate of the ground from the station, rad/s. */
export function angularRateRadS(slantKm: number): number {
  return V_REL_KM_S / slantKm;
}

/** UNTRACKED physics floor, seconds: the longest exposure before orbital
 *  motion smears more than BLUR_BUDGET_PX on the Z9 sensor. At nadir/420km:
 *  400mm→~1/1124, 800mm→~1/2250, 1200mm→~1/3373 (pre-ladder). Relaxes with
 *  slant range. Lives in the almanac — the visible row leads with TRACKED
 *  floors because hand-tracking is how the genre is actually shot. */
export function untrackedFloorSec(focalMm: number, slantKm: number): number {
  const smearM = BLUR_BUDGET_PX * PITCH_UM * 1e-6;
  return smearM / ((focalMm / 1000) * angularRateRadS(slantKm));
}

/** TRACKED practice floor, seconds: Pettit's 1/f handheld rule ("use a
 *  shutter speed at least equal to one over the focal length"), tightened
 *  1.5× for the Z9's finer pixels. Validation: his 800mm exposures ran
 *  1/1000–1/1250 (Palm Island, pyramids — hand-tracked), matching this
 *  floor at 1/1250. Per-lens constant — tracking cancels the orbital
 *  component, leaving handshake, which doesn't care about slant range. */
export function trackedFloorSec(focalMm: number): number {
  return 1 / (1.5 * focalMm);
}

/** Ground footprint width at slant range, km. Validated against guide
 *  Fig. 23 (400mm = 5.2° horizontal → ×420km ≈ 38km). */
export function footprintKm(focalMm: number, slantKm: number): number {
  return (SENSOR_W_MM / focalMm) * slantKm;
}

/** Snap an exposure-time floor DOWN (faster) onto the ladder: the smallest
 *  denominator D with 1/D ≤ tSec. Clamps to the ladder ends. Returns null
 *  for non-finite/non-positive input. */
export function snapToFasterStop(tSec: number): number | null {
  if (!Number.isFinite(tSec) || tSec <= 0) return null;
  const need = 1 / tSec;
  for (const d of SHUTTER_LADDER) {
    if (d >= need) return d;
  }
  return 8000; // beyond the ladder: clamp to its fastest stop
}

// ── Provider framework ─────────────────────────────────────────────────────

export interface ConditionCtx {
  pass: PassEntry;
  /** Null when the caller has no manifest in hand (the camera provider
   *  doesn't need it; later units widen what they read from ctx). */
  manifest: Manifest | null;
  /** Track (TLE carrier) — null for legacy snapshots; β provider needs it. */
  track: Track | null;
  nowMs: number;
}

export interface ConditionRow {
  id: string;
  icon: string;
  /** Short header line, e.g. "tracked floors · hand-track". */
  label: string;
  /** Value line, e.g. "400mm ≈38km ≥1/640 · 800mm ≈19km ≥1/1250 · …". */
  value: string;
  /** Help-item id the row's button opens in the Photography Almanac. */
  almanacAnchor: string;
}

export type ConditionProvider = (ctx: ConditionCtx) => ConditionRow | null;

/** Camera line (Unit 1): footprint + tracked shutter floor for the real
 *  long-lens kit. Null (silence) when the pass has no usable geometry. */
export function cameraConditionProvider(ctx: ConditionCtx): ConditionRow | null {
  const nadir = ctx.pass.nadir_distance_km;
  if (!Number.isFinite(nadir) || nadir < 0) return null;
  const altRaw = ctx.pass.iss_at_closest?.alt_km;
  const alt = Number.isFinite(altRaw) && (altRaw as number) > 0
    ? (altRaw as number)
    : DEFAULT_ALT_KM;
  const d = slantRangeKm(nadir, alt);
  if (!Number.isFinite(d) || d <= 0) return null;

  const parts: string[] = [];
  for (const f of KIT_FOCAL_LENGTHS_MM) {
    const stop = snapToFasterStop(trackedFloorSec(f));
    if (stop === null) return null;
    parts.push(`${f}mm ≈${Math.round(footprintKm(f, d))}km ≥1/${stop}`);
  }
  return {
    id: 'camera',
    icon: '📷',
    label: 'tracked floors · hand-track',
    value: parts.join(' · '),
    almanacAnchor: 'almanac-camera',
  };
}

/** Beta-blackout row (Unit 2, D1=A + outside-voice gating): fires ONLY
 *  when this pass's own time falls on a HARD-ZERO full-sun day (β beyond
 *  critical — physically no orbital night) AND the target is a
 *  night-regime target. Shoulder days (short-but-real nights) stay
 *  row-silent; the Upcoming header carries the period story. */
export function betaBlackoutProvider(ctx: ConditionCtx): ConditionRow | null {
  if (ctx.pass.target_regime !== 'night') return null;
  const fc = scanBetaForecast(ctx.track, ctx.nowMs);
  if (!fc || fc.windows.length === 0) return null;
  const passMs = Date.parse(ctx.pass.closest_approach ?? '');
  if (!Number.isFinite(passMs)) return null;
  const day = fc.days.find((d) => passMs >= d.dayStartMs && passMs < d.dayStartMs + 86400_000);
  if (!day || day.nightMin > 0) return null;
  return {
    id: 'beta-blackout',
    icon: '☀️',
    label: 'beta blackout',
    value: `no orbital night this period (β ${Math.round(Math.abs(day.betaDeg))}° ≥ ${Math.round(betaCriticalDeg(420))}°)`,
    almanacAnchor: 'almanac-beta',
  };
}

/** Moon row (Unit 3): on NIGHT passes where the Moon is up in the
 *  station's sky. 'moonlit' (bright + up) warns night genres are washed;
 *  'up-faint' notes soft fill light. A DARK sky returns null — silence IS
 *  the aurora/star window signal. Verified (multi-agent, 2026-06-14):
 *  illum from true elongation (right at the quarters), "up" gated against
 *  the orbital horizon via the pass's alt_km. */
export function moonConditionProvider(ctx: ConditionCtx): ConditionRow | null {
  if (ctx.pass.target_regime !== 'night' && ctx.pass.pass_regime !== 'night') return null;
  const passMs = Date.parse(ctx.pass.closest_approach ?? '');
  if (!Number.isFinite(passMs)) return null;
  const at = ctx.pass.iss_at_closest;
  const observer = at && Number.isFinite(at.lat) && Number.isFinite(at.lon)
    ? { lat: at.lat, lon: at.lon } : null;
  const altKm = at && Number.isFinite(at.alt_km) && at.alt_km > 0 ? at.alt_km : undefined;
  const m = assessMoon(passMs, observer, altKm);
  if (m.skyState === 'dark') return null;
  const phase = m.phaseName.replace('-', ' ');
  const tail = m.skyState === 'moonlit'
    ? 'moonlit — night genres washed'
    : 'up, faint — soft fill';
  return {
    id: 'moon',
    icon: m.glyph,
    label: 'moon',
    value: `${phase} ${Math.round(m.illum * 100)}% · ${tail}`,
    almanacAnchor: 'almanac-moon',
  };
}

/** Ordered registry — order IS display priority. β (period-critical) >
 *  moon > camera (baseline). Worst real case on a night-regime target is
 *  β + moon + camera = 3 rows = exactly MAX_VISIBLE_ROWS (they are NOT
 *  mutually exclusive — both gate on night regime; verified 2026-06-14),
 *  so the disclosure never triggers and slice(0,3) shows the most
 *  planning-critical rows first. */
export const PROVIDERS: ConditionProvider[] = [
  betaBlackoutProvider,
  moonConditionProvider,
  cameraConditionProvider,
];

/** Run every provider, isolated: a throwing provider loses its row and
 *  logs — NEVER silently (a silent failure would make bad data look like
 *  "condition doesn't apply", which for a trust-sensitive photography
 *  recommendation is itself misinformation) — and never takes down the
 *  thumbnail. Pure apart from the warn. */
export function buildConditionRows(ctx: ConditionCtx): ConditionRow[] {
  const rows: ConditionRow[] = [];
  for (const provider of PROVIDERS) {
    try {
      const row = provider(ctx);
      if (row) rows.push(row);
    } catch (err) {
      console.warn('[photo-conditions] provider failed:', err);
    }
  }
  return rows;
}

/** Visible condition rows before the "▸ N more" disclosure takes over. */
export const MAX_VISIBLE_ROWS = 3;

/** Render the conditions block INTO `container` (the expanded thumbnail
 *  panel, below the image). Zero rows → nothing at all, not even the
 *  divider (silence is a feature). Each row is a button → almanac. */
export function renderConditionBlock(
  rows: ConditionRow[],
  container: HTMLElement,
  openAlmanac: (anchor: string) => void = openHelpModal,
): void {
  if (rows.length === 0) return;

  const block = document.createElement('div');
  block.className = 'photo-conditions';

  const divider = document.createElement('div');
  divider.className = 'photo-conditions-divider';
  divider.textContent = 'photo conditions';
  block.appendChild(divider);

  const makeRowButton = (row: ConditionRow): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'photo-condition-row';
    btn.setAttribute(
      'aria-label',
      `${row.label} — open the photography almanac for details`,
    );
    const head = document.createElement('span');
    head.className = 'photo-condition-label';
    head.textContent = `${row.icon} ${row.label}`;
    const val = document.createElement('span');
    val.className = 'photo-condition-value';
    val.textContent = row.value;
    btn.append(head, val);
    btn.addEventListener('click', () => openAlmanac(row.almanacAnchor));
    return btn;
  };

  rows.slice(0, MAX_VISIBLE_ROWS).forEach((row) => {
    block.appendChild(makeRowButton(row));
  });

  const overflow = rows.slice(MAX_VISIBLE_ROWS);
  if (overflow.length > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'photo-conditions-more';
    more.textContent = `▸ ${overflow.length} more`;
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      more.remove();
      overflow.forEach((row) => block.appendChild(makeRowButton(row)));
    });
    block.appendChild(more);
  }

  container.appendChild(block);
}
