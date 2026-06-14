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
import { greatCircleAngleDeg, subsolarPoint } from './terminator';

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
  // Gate on PASS regime, not target regime (Codex review 2026-06-14): the
  // Moon only washes the sky when THIS pass is actually dark. A night-best
  // TARGET shot on a daylit pass has no moonlight problem. This also makes
  // the moon row mutually exclusive with beta-blackout — a blackout means
  // no orbital night, so pass_regime is never 'night' then.
  if (ctx.pass.pass_regime !== 'night') return null;
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

/** Sun-elevation band (degrees, at the target) for raking texture light.
 *  Below the floor the terrain is too dark / sun on the horizon; above the
 *  ceiling shadows shorten toward flat midday. Advisory only — no scorer
 *  interaction (Unit 4 decision A, 2026-06-14): a low-sun SCORING boost is
 *  dead against the existing regime_fit, which penalizes terminator-lit
 *  passes; this tells the photographer the light is good and lets them
 *  decide (Pettit shoots terrain texture opportunistically at low sun). */
export const GOLDEN_FLOOR_DEG = 2;
export const GOLDEN_CEIL_DEG = 25;
/** Curated categories whose subjects have RELIEF that low-angle light
 *  carves into texture. NOT iconic-shape (sea-level coastline outlines —
 *  no relief to shadow; outside-voice 2026-06-14) and never night targets. */
export const GOLDEN_CATEGORIES = ['big-terrain', 'volcano'] as const;

/** Sun elevation (deg) at a ground point — same model as aurora/moon
 *  (90 − great-circle angle to the subsolar point), inlined to avoid
 *  pulling the heavy aurora module into this chunk. */
function targetSunElevationDeg(lat: number, lon: number, when: Date): number {
  const sub = subsolarPoint(when);
  return 90 - greatCircleAngleDeg(lat, lon, sub.lat, sub.lon);
}

/** Golden-hour row (Unit 4): on terrain-texture targets (big-terrain /
 *  volcano) whose sun sits low at closest approach — raking light that
 *  carves relief. Advisory; no score change. Silent otherwise. */
export function goldenHourConditionProvider(ctx: ConditionCtx): ConditionRow | null {
  const cat = ctx.pass.category;
  if (!cat || !(GOLDEN_CATEGORIES as readonly string[]).includes(cat)) return null;
  const passMs = Date.parse(ctx.pass.closest_approach ?? '');
  if (!Number.isFinite(passMs)) return null;
  if (!Number.isFinite(ctx.pass.target_lat) || !Number.isFinite(ctx.pass.target_lon)) return null;
  const elev = targetSunElevationDeg(ctx.pass.target_lat, ctx.pass.target_lon, new Date(passMs));
  if (elev < GOLDEN_FLOOR_DEG || elev > GOLDEN_CEIL_DEG) return null;
  return {
    id: 'golden-hour',
    icon: '🌅',
    label: 'golden hour',
    value: `low sun ${Math.round(elev)}° · raking light, long shadows`,
    almanacAnchor: 'almanac-golden-hour',
  };
}

/** Noctilucent-cloud (NLC) window (Unit 5). NLC are the highest clouds
 *  (~83km, electric blue), a RARE summer-high-latitude twilight phenomenon
 *  seen toward the pole at the limb when the mesosphere is still sunlit but
 *  the ground below has gone dark. Geometric, not per-target. Verified by a
 *  multi-agent pass (2026-06-14); the key correction: gate on the
 *  sun-elevation BAND directly, NOT on pass_regime — the generator buckets
 *  pass_regime by zenith, whose 'terminator' span [-10,+20] would clip the
 *  NLC band [-16,-6] to a [-10,-6] dead-band and make most of the window
 *  unreachable. The band (computed at the VIEWED ground point) is the true
 *  twilight condition. */
export const NLC_LAT_MIN = 45;
/** Twilight band for NLC visibility (sun elevation at the target, deg,
 *  negative = below horizon). HI: any brighter and the lower sky drowns
 *  the faint clouds. LO: any darker and the sunlit 83km deck has dropped
 *  below the poleward horizon (the 83km sunlit-depression cap is ~9.2°;
 *  the band runs deeper because NLC are seen low toward the pole at slant
 *  range). */
export const NLC_SUN_HI = -6;
export const NLC_SUN_LO = -16;

/** NLC season by hemisphere (NASA AIM climatology): N May 24-Aug 22
 *  (centered on the June solstice); S Nov 17-Feb 22 (wraps the year).
 *  Compared as calendar month/day (MMDD), not day-of-year, so the dates
 *  are EXACT and leap-year-safe (Codex review 2026-06-14). Conservative
 *  onset (under-fires vs the earliest recorded seasons) — silence is the
 *  right default for a rare event. */
export function isNlcSeason(d: Date, hemisphere: 'N' | 'S'): boolean {
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); // e.g. May 24 -> 524
  if (hemisphere === 'N') return md >= 524 && md <= 822;
  return md >= 1117 || md <= 222;
}

/** NLC window row: a summer high-latitude target at twilight, where the
 *  mesosphere toward the pole is lit while the ground is dark. Honest:
 *  signals a viewing GEOMETRY window ("possible"), not a detection. */
export function nlcConditionProvider(ctx: ConditionCtx): ConditionRow | null {
  const passMs = Date.parse(ctx.pass.closest_approach ?? '');
  if (!Number.isFinite(passMs)) return null;
  const when = new Date(passMs);
  const lat = ctx.pass.target_lat;
  const lon = ctx.pass.target_lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) < NLC_LAT_MIN) return null;
  // Summer hemisphere: the target's hemisphere must match the sun's
  // declination sign AND be inside the climatological season.
  const sub = subsolarPoint(when);
  if (sub.lat === 0 || Math.sign(lat) !== Math.sign(sub.lat)) return null;
  const hemisphere: 'N' | 'S' = lat >= 0 ? 'N' : 'S';
  if (!isNlcSeason(when, hemisphere)) return null;
  // Twilight band at the viewed point.
  const elev = targetSunElevationDeg(lat, lon, when);
  if (elev > NLC_SUN_HI || elev < NLC_SUN_LO) return null;
  return {
    id: 'nlc',
    icon: '🌌',
    label: 'noctilucent clouds',
    value: `possible · look toward the ${hemisphere} pole at the limb · summer twilight, sun ${Math.round(Math.abs(elev))}° below`,
    almanacAnchor: 'almanac-nlc',
  };
}

/** Sun glint (Unit 6): the Sun mirroring off water specularly into the
 *  station's camera — a bright spot that reveals surface detail (eddies,
 *  ship wakes, internal waves) invisible under flat light. Pettit's prized
 *  water-surface genre. ADVISORY ROW ONLY: the generator's sun_glint_risk
 *  PENALTY is left untouched (same call as golden hour — no fleet-wide
 *  scorer change). Designed + adversarially verified (2026-06-14): the
 *  3-D reflection math is exact; the honest scope is the 12 curated
 *  water-framed coastline targets (no reliable general water mask exists
 *  yet — is_water flags the Sahara and misses coastlines; that's the
 *  deferred GSHHG-mask enhancement). The CATEGORY gate is the SOLE land
 *  guard: a mis-categorized iconic-shape target would fire glint with no
 *  geometry-side defense, so the curated category list must stay clean. */
export const GLINT_CATEGORIES = ['iconic-shape'] as const;
/** Max deviation (deg) of the specular-reflection direction from the
 *  actual target→ISS direction for the row to fire. 10° (tightened from
 *  the design's 15° after the over-fire finding) — captures the
 *  roughness-widened glint lobe while cutting near-noon false abundance. */
export const GLINT_DEVIATION_DEG = 10;
/** Sun must be at least this high at the target. Below it the specular
 *  sheet is too low/narrow and the lobe balloons (over-fire); also keeps
 *  glint (day) cleanly separated from golden-hour twilight. */
export const GLINT_SUN_FLOOR_DEG = 15;

/** Deviation (deg) between the mirror reflection of the sun ray about the
 *  target's local vertical and the actual target→ISS direction. 0° = a
 *  perfect mirror toward the station. ISS at FINITE altitude (the V1 fix);
 *  Sun at infinity (its sub-point direction). Spherical model — geodetic
 *  vs geocentric normal adds ~0.2° physical, negligible vs the 10° gate.
 *  Exported so tests assert the math directly (never re-implement it). */
export function glintDeviationDeg(
  tLat: number, tLon: number,
  sLat: number, sLon: number,
  iLat: number, iLon: number,
  altKm: number,
): number {
  const D = Math.PI / 180;
  const unit = (la: number, lo: number): [number, number, number] => {
    const cl = Math.cos(la * D);
    return [cl * Math.cos(lo * D), cl * Math.sin(lo * D), Math.sin(la * D)];
  };
  const up = unit(tLat, tLon);
  const toSun = unit(sLat, sLon);
  const niss = unit(iLat, iLon);
  const R = EARTH_RADIUS_KM, Ri = R + altKm;
  const toIssV: [number, number, number] = [
    niss[0] * Ri - up[0] * R, niss[1] * Ri - up[1] * R, niss[2] * Ri - up[2] * R,
  ];
  const im = Math.hypot(toIssV[0], toIssV[1], toIssV[2]);
  if (!(im > 0)) return 180; // ISS at the target → degenerate, never glint
  const toIss: [number, number, number] = [toIssV[0] / im, toIssV[1] / im, toIssV[2] / im];
  // incoming sun ray d = -toSun; reflect about up: r = d - 2(d·up)up
  const d: [number, number, number] = [-toSun[0], -toSun[1], -toSun[2]];
  const dDotUp = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
  const rv: [number, number, number] = [
    d[0] - 2 * dDotUp * up[0], d[1] - 2 * dDotUp * up[1], d[2] - 2 * dDotUp * up[2],
  ];
  const rm = Math.hypot(rv[0], rv[1], rv[2]);
  if (!(rm > 0)) return 180;
  const dot = (rv[0] * toIss[0] + rv[1] * toIss[1] + rv[2] * toIss[2]) / rm;
  return Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
}

/** Sun-glint opportunity row: a curated water-framed coastal target where
 *  the Sun mirrors specularly off the water toward the station. Honest:
 *  predicts the GEOMETRY (sea state, which it cannot see, decides the
 *  actual glint), and is scoped to coastal targets where "the water" is
 *  the scene. */
export function glintConditionProvider(ctx: ConditionCtx): ConditionRow | null {
  // Gate on the generator's per-pass water flag (GSHHG mask) — fires on ANY
  // real water (lakes, coasts, estuaries), not just the 12 curated coasts.
  // Back-compat: when `water` is absent (a pre-mask manifest) fall back to the
  // legacy iconic-shape category gate so old manifests still surface glint.
  const w = ctx.pass.water;
  if (w === false) return null;
  if (w === undefined) {
    const cat = ctx.pass.category;
    if (!cat || !(GLINT_CATEGORIES as readonly string[]).includes(cat)) return null;
  }
  const passMs = Date.parse(ctx.pass.closest_approach ?? '');
  if (!Number.isFinite(passMs)) return null;
  const when = new Date(passMs);
  const lat = ctx.pass.target_lat;
  const lon = ctx.pass.target_lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (targetSunElevationDeg(lat, lon, when) < GLINT_SUN_FLOOR_DEG) return null;
  const at = ctx.pass.iss_at_closest;
  if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lon)) return null;
  const altKm = Number.isFinite(at.alt_km) && at.alt_km > 0 ? at.alt_km : DEFAULT_ALT_KM;
  const sub = subsolarPoint(when);
  if (glintDeviationDeg(lat, lon, sub.lat, sub.lon, at.lat, at.lon, altKm) > GLINT_DEVIATION_DEG) {
    return null;
  }
  return {
    id: 'glint',
    icon: '✨',
    label: 'sun glint',
    value: 'sun glints off the water below · surface permitting',
    almanacAnchor: 'almanac-glint',
  };
}

/** 16-point compass label from a true bearing (deg). Coarse on purpose:
 *  the generator computes the bearing at closest approach from the moving
 *  sub-point, so a 16-point cue stays usable across the orient-and-shoot
 *  window where a precise degree would already be stale. */
export function compassPoint(deg: number): string {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

/** Sprite-watch row (Unit 7): the generator already proved a sprite-capable
 *  storm is in the limb annulus on a dark (night) pass — this adds the MOON
 *  gate (faint red sprites need a black sky; a bright Moon up washes them
 *  out, per the beta almanac) and renders an honest "possible" heads-up.
 *  "You will not be able to see them with your eyes" (Pettit) — so a flag
 *  that a vigorous storm is in view at the limb is the whole game. */
export function spriteConditionProvider(ctx: ConditionCtx): ConditionRow | null {
  const sp = ctx.pass.sprite;
  if (!sp || !Number.isFinite(sp.distance_km) || !Number.isFinite(sp.bearing_deg)) return null;
  // Moon-darkness gate: suppress when a bright Moon is up at the station
  // (it washes the faint sprite glow). The generator only proved the SUN is
  // down; the Moon is the frontend's to check.
  const passMs = Date.parse(ctx.pass.closest_approach ?? '');
  const at = ctx.pass.iss_at_closest;
  if (Number.isFinite(passMs) && at && Number.isFinite(at.lat) && Number.isFinite(at.lon)) {
    const moon = assessMoon(passMs, { lat: at.lat, lon: at.lon },
      Number.isFinite(at.alt_km) && at.alt_km > 0 ? at.alt_km : undefined);
    if (moon.skyState === 'moonlit') return null;
  }
  const dist = Math.round(sp.distance_km);
  const dir = compassPoint(sp.bearing_deg);
  return {
    id: 'sprite',
    icon: '⚡',
    label: 'sprite watch',
    value: `possible sprites · vigorous storm at the limb, ${dist}km ${dir} · try the dark limb`,
    almanacAnchor: 'almanac-sprites',
  };
}

/** Ordered registry — order IS display priority. β (period-critical) >
 *  moon > golden hour > camera (baseline)./** Ordered registry — order IS display priority. β (period-critical) >
 *  moon > golden hour > camera (baseline). Golden hour is a DAY-side
 *  signal (terrain at low sun); moon/beta are night signals, so they don't
 *  co-occur — worst real case is golden-hour + camera = 2 rows, under
 *  MAX_VISIBLE_ROWS=3. β gates on a night-regime TARGET during a
 *  full-sun blackout (pass_regime is day/terminator then); moon gates on a
 *  night PASS. A blackout has no orbital night, so β and moon can never
 *  co-occur — worst real case is moon + camera (or β + camera) = 2 rows,
 *  well under MAX_VISIBLE_ROWS=3 (Codex review 2026-06-14). */
export const PROVIDERS: ConditionProvider[] = [
  betaBlackoutProvider,
  moonConditionProvider,
  spriteConditionProvider,
  goldenHourConditionProvider,
  glintConditionProvider,
  nlcConditionProvider,
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
