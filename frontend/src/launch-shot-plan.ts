import { tierInstantText, tierWindowUtc, tierWord, utcInstant, type TierLaunch, type TierShot } from './launch-tiers';

export interface PlanFact {
  readonly label: string;
  readonly text: string;
}

/** One envelope as the card prints it. */
export interface EnvelopeFacts {
  readonly subject: TierShot['subject'];
  readonly title: string;
  readonly facts: readonly PlanFact[];
}

/** Everything a launch card says about shooting it. Every card prints from this. */
export interface ShotPlan {
  readonly verdict: string;
  /** Best first. Empty when nothing can be planned. */
  readonly envelopes: readonly EnvelopeFacts[];
  /** When and where for the best envelope, for a card with room for two lines. */
  readonly brief: readonly PlanFact[];
  /** Why there is no envelope, in words that do not read as a no. Null when there is one. */
  readonly empty: string | null;
  readonly direction: PlanFact;
  readonly honesty: string | null;
  readonly more: string | null;
}

export const HONESTY_LINE = 'Simulated attitude (+XVV). Window access not verified.';

const BEARINGS = ['ahead', 'ahead and right', 'right', 'aft and right', 'aft', 'aft and left', 'left', 'ahead and left'] as const;

const LIGHT: Record<TierShot['light'], string> = {
  twilight_plume: 'Twilight plume.',
  day_plume: 'Daylight plume.',
  night_engine: 'Night engine. Unvalidated until calibrated.',
  pad_day: 'Daytime pad.',
  pad_night: 'Night pad.',
};

function trimmed(value: number, places: number): string {
  return String(Number(value.toFixed(places)));
}

function span(seconds: number): string {
  const whole = Math.round(Math.abs(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

function offsetText(seconds: number): string {
  if (Math.round(seconds) === 0) return 'at liftoff';
  return `${span(seconds)} ${seconds > 0 ? 'after' : 'before'} liftoff`;
}

function bearing(azimuthDeg: number): string {
  const sector = Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8;
  return BEARINGS[sector] ?? 'ahead';
}

function sentence(text: string): string {
  const clean = text.trim();
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function envelopeFacts(shot: TierShot, launch: TierLaunch): EnvelopeFacts {
  const subject = shot.subject === 'ascent' ? 'Ascent' : 'Pad';
  const score = shot.score.low === shot.score.high
    ? trimmed(shot.score.low, 0)
    : `${trimmed(shot.score.low, 0)} to ${trimmed(shot.score.high, 0)}`;
  const direction = shot.provenance?.direction;
  const scenario = shot.subject === 'ascent' && direction?.kind === 'modeled' && direction.azimuthDeg !== null
    ? ` Modeled azimuth ${trimmed(direction.azimuthDeg, 1)}°.`
    : '';
  return {
    subject: shot.subject,
    title: `${subject} shot if liftoff is ${utcInstant(shot.liftoffMs)}. Estimate.${scenario}`,
    facts: [
      { label: 'Best time', text: `${tierInstantText(shot.bestMs)} · ${offsetText(shot.bestOffsetS)}` },
      { label: 'Shootable', text: `${tierWindowUtc(shot.startMs, shot.endMs)} · ${span((shot.endMs - shot.startMs) / 1000)}` },
      {
        label: 'Stand and look',
        text: `Cupola ${shot.window}. Look ${bearing(shot.look.azimuthDeg)}, ${trimmed(shot.look.azimuthDeg, 1)}° clockwise from the direction of travel, ${trimmed(shot.look.offNadirDeg, 1)}° up from straight down. ${trimmed(shot.slantKm, 0)} km away.`,
      },
      { label: 'Lens', text: `${shot.lens.kind === 'telephoto' ? 'Telephoto' : 'Wide'}. ${sentence(shot.lens.reason)}` },
      { label: 'Light', text: LIGHT[shot.light] },
      {
        label: 'How sure',
        text: `ISS orbit data ${trimmed(shot.confidence.tleAgeH, 1)} h old at the event. ${shot.confidence.robust ? 'Robust to timing error.' : 'Not robust to timing error.'} Score ${score} of 100.${shot.subject === 'ascent' && shot.provenance?.direction.kind === 'modeled' && launch.ascent ? ` Direction grade ${launch.ascent.grade}.` : ''}`,
      },
    ],
  };
}

function directionFact(launch: TierLaunch): PlanFact {
  const { direction, ascent } = launch;
  const label = 'Launch direction';
  if (direction.kind === 'none') {
    if (ascent?.grade === 'D') {
      const sectors = ascent.fans.map((fan) => `${fan.branch ? `${fan.branch} ` : ''}${trimmed(fan.low_deg, 1)}° to ${trimmed(fan.high_deg, 1)}°`).join('; ');
      return { label, text: `Estimate, grade D. Orbit not published. UNVERIFIED assumed site ${ascent.fans.length === 1 ? 'sector' : 'sectors'} ${sectors}. Only the pad can be planned. Source: ${ascent.source}` };
    }
    return { label, text: 'No sourced launch direction, so no ascent path is drawn. Only the pad can be planned.' };
  }
  const azimuth = `${trimmed(direction.azimuthDeg, 1)}°`;
  if (direction.kind === 'modeled') {
    if (!ascent) return { label, text: `Modeled estimate. Azimuth ${azimuth}. Actual heading unverified. Source: ${direction.source}` };
    const fans = ascent.fans.map((fan) => `${fan.branch ? `${fan.branch} branch, ` : ''}${fan.azimuth_deg === direction.azimuthDeg ? 'selected scenario, ' : ''}${fan.azimuth_deg === null ? '' : `azimuth ${trimmed(fan.azimuth_deg, 1)}°, `}fan ${trimmed(fan.low_deg, 1)}° to ${trimmed(fan.high_deg, 1)}°`).join('; ');
    return { label, text: `Modeled, grade ${ascent.grade}. ${fans}. One scenario is selected for planning; the actual heading is unverified. Source: ${ascent.source}` };
  }
  if (direction.kind === 'iss_plane') {
    return {
      label,
      text: `Estimate. The ISS orbital plane, derived from the ISS TLE. Azimuth ${azimuth}, ${trimmed(Math.abs(direction.offPlaneDeg), 2)}° off the plane.`,
    };
  }
  if (direction.kind === 'published') return { label, text: `Published azimuth ${azimuth}. Source: ${direction.source}` };
  return { label, text: `Estimate. Azimuth ${azimuth}. Source: ${direction.source}` };
}

function emptyText(launch: TierLaunch): string {
  if (launch.tier === 'none') return 'Ruled out on a fresh ISS orbit.';
  if (launch.tier === 'unassessed') return 'Not assessed, so no shot window is planned. This is not a no.';
  return 'No shot window yet. The view is unconfirmed. This is not a no.';
}

/** An ascent envelope needs a direction source, so none plans the pad only. */
export function shotPlan(launch: TierLaunch): ShotPlan {
  const plannable = launch.direction.kind === 'none'
    ? launch.shots.filter((shot) => shot.subject === 'pad')
    : launch.shots;
  const envelopes = plannable.map((shot) => envelopeFacts(shot, launch));
  const others = envelopes.length - 1;
  return {
    verdict: `${tierWord(launch.tier)}. ${sentence(launch.why)}`,
    envelopes,
    brief: (envelopes[0]?.facts ?? []).filter((fact) => fact.label === 'Best time' || fact.label === 'Stand and look'),
    empty: envelopes.length ? null : emptyText(launch),
    direction: directionFact(launch),
    honesty: envelopes.length ? HONESTY_LINE : null,
    more: others > 0 ? `${others} more shot ${others === 1 ? 'window' : 'windows'} in the details.` : null,
  };
}
