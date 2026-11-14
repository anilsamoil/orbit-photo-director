import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountIssScene } from '../src/iss-view';
import type { IssRenderer } from '../src/iss-view/renderer';
import type { SceneSnapshot } from '../src/iss-view/model';
import type { Track } from '../src/types';
import { launchCatalog } from '../src/launch-catalog';
import type { LaunchCatalogItem, ShotEnvelope } from '../src/launch-schema';
import { shotPlan } from '../src/launch-shot-plan';
import { openTierDetails, renderTierCard } from '../src/launch-tier-card';
import { tiersAt, type TierCatalog, type TierLaunch } from '../src/launch-tiers';
import { catalog, catalogItem, shot } from './launch-fixtures';
import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const T0 = Date.parse(fixture.start);
const viewMs = T0 + 60_000;
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const NONE = { kind: 'none', azimuth_deg: null, source: null, off_plane_deg: null } as const;
const PLANE = { kind: 'iss_plane', azimuth_deg: 44.7, source: 'iss_tle_plane', off_plane_deg: 0.35 } as const;
const TERMS = shot().score.terms;
const HONESTY = 'Simulated attitude (+XVV). Window access not verified.';
const NO_DIRECTION = 'Launch direction: No sourced launch direction, so no ascent path is drawn. Only the pad can be planned.';
const PLANE_DIRECTION = 'Launch direction: Estimate. The ISS orbital plane, derived from the ISS TLE. Azimuth 44.7°, 0.35° off the plane.';

const ASCENT_LINES = [
  'Ascent shot if liftoff is 17 Oct 2024, 12:10:00 UTC. Estimate.',
  'Best time: 17 Oct 2024, 12:13:15 UTC · 17 Oct 2024, 07:13:15 CDT · 3 min 15 s after liftoff',
  'Shootable: 17 Oct 2024, 12:12:00–12:15:00 UTC · 3 min',
  'Stand and look: Cupola W6. Look aft and left, 225° clockwise from the direction of travel, 70° up from straight down. 490 km away.',
  'Lens: Telephoto. Distant plume.',
  'Light: Twilight plume.',
  'How sure: ISS orbit data 6.5 h old at the event. Robust to timing error. Score 62 to 70 of 100.',
];
const PAD_LINES = [
  'Pad shot if liftoff is 17 Oct 2024, 12:20:00 UTC. Estimate.',
  'Best time: 17 Oct 2024, 12:21:00 UTC · 17 Oct 2024, 07:21:00 CDT · 1 min after liftoff',
  'Shootable: 17 Oct 2024, 12:20:00–12:22:00 UTC · 2 min',
  'Stand and look: Cupola W7. Look ahead, 10° clockwise from the direction of travel, 20° up from straight down. 420 km away.',
  'Lens: Wide. Close pad.',
  'Light: Night pad.',
  'How sure: ISS orbit data 72 h old at the event. Not robust to timing error. Score 20 of 100.',
];

function ascent(over: Partial<ShotEnvelope> = {}): ShotEnvelope {
  return shot({
    subject: 'ascent', liftoff: at(10), evaluated_at: at(-5), direction: { ...PLANE },
    start: at(12), best: at(13.25), end: at(15), best_offset_s: 195,
    look: { frame: 'orbital-lvlh', azimuth_deg: 225, off_nadir_deg: 70 }, window: 'W6',
    slant_km: 490, light: 'twilight_plume', lens: 'telephoto', lens_reason: 'Distant plume.',
    track: [
      { t_offset_s: 120, lat: 30, lon: -79, alt_km: 60 },
      { t_offset_s: 195, lat: 32, lon: -77, alt_km: 110 },
    ],
    score: { low: 62, high: 70, terms: TERMS },
    confidence: { tle_age_h: 6.5, along_track_sigma_km: 3, timing_sigma_s: 1, robust: true },
    ...over,
  });
}

function pad(over: Partial<ShotEnvelope> = {}): ShotEnvelope {
  return shot({
    subject: 'pad', liftoff: at(20), evaluated_at: at(-5), direction: { ...NONE },
    start: at(20), best: at(21), end: at(22), best_offset_s: 60,
    look: { frame: 'orbital-lvlh', azimuth_deg: 10, off_nadir_deg: 20 }, window: 'W7',
    slant_km: 420.4, light: 'pad_night', lens: 'wide', lens_reason: 'Close pad.', track: [],
    score: { low: 20, high: 20, terms: TERMS },
    confidence: { tle_age_h: 72, along_track_sigma_km: 40, timing_sigma_s: 60, robust: false },
    ...over,
  });
}

function item(over: Partial<LaunchCatalogItem>): LaunchCatalogItem {
  return catalogItem({
    event_id: 'launch', name: 'Dragon CRS-35',
    schedule: { net: at(10), window_start: at(10), window_end: at(20), precision: 'Second', status: 'Go', destination: 'ISS' },
    ...over,
  });
}

const SHOT = item({
  tier: 'shot', why: 'Twilight plume 490 km aft, W6, 3 min after liftoff.', direction: { ...PLANE }, shots: [ascent()],
});
const WATCH = item({
  tier: 'watch', why: 'Night pad 420 km ahead, W7, 1 min after liftoff.', direction: { ...NONE }, shots: [pad()],
  schedule: { net: at(20), window_start: at(20), window_end: at(30), precision: 'Second', status: 'TBC', destination: null },
});
const UNASSESSED = item({
  tier: 'unassessed', why: 'Schedule is too loose to plan a window.', direction: { ...NONE }, shots: [],
});
const TWO = item({
  tier: 'likely', why: 'Twilight plume 490 km aft, W6, 3 min after liftoff.', direction: { ...PLANE }, shots: [pad(), ascent()],
});

function tiersOf(entry: LaunchCatalogItem): TierCatalog {
  const tiers = tiersAt(catalog([entry], {
    generated_at: at(-5), geometry_valid_until: at(9), schedule_valid_until: at(60),
  }), viewMs);
  if (!tiers) throw new Error('catalog lease is not live');
  return tiers;
}

function launchOf(entry: LaunchCatalogItem): TierLaunch {
  const launch = tiersOf(entry).find(entry.event_id);
  if (!launch) throw new Error('launch is not listed');
  return launch;
}

/** What a person reads in the shot plan, one line per printed row. */
function planLines(root: ParentNode): string[] {
  return [...root.querySelectorAll('.launch-plan > *')].map((line) => {
    const label = line.querySelector('.launch-fact-label');
    return label ? `${label.textContent}: ${line.lastElementChild?.textContent}` : line.textContent ?? '';
  });
}

function whyOf(card: HTMLElement): string {
  const tier = [...card.querySelectorAll('.launch-fact')].find((line) => line.firstElementChild?.textContent === 'Tier');
  const why = [...card.children].find((child) => child.tagName === 'P');
  return `${tier?.lastElementChild?.textContent}. ${why?.textContent}`;
}

function dialogOf(entry: LaunchCatalogItem): HTMLDialogElement {
  const tiers = tiersOf(entry);
  vi.spyOn(launchCatalog, 'read').mockReturnValue(tiers);
  openTierDetails(tiers.find(entry.event_id)!);
  const dialog = document.querySelector('.launch-dialog');
  if (!(dialog instanceof HTMLDialogElement)) throw new Error('missing dialog');
  return dialog;
}

const scenes: { dispose(): void }[] = [];

function snapshot(): SceneSnapshot {
  return {
    manifestVersion: 'm1',
    generatedAtMs: T0,
    track: {
      iss_polynomial: fixture.iss_polynomial,
      tle: fixture.tle,
      tle_epoch: '2024-10-16T18:58:11.999Z',
      tle_age_hours: 17,
      tle_freshness_factor: 1,
    },
  };
}

async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
}

/** The ISS view card after the launch is picked: the verdict, then each plan line. */
async function issCard(entry: LaunchCatalogItem, group: 'tier' | 'all' = 'tier'): Promise<{ card: HTMLElement; lines: string[] }> {
  vi.spyOn(launchCatalog, 'read').mockReturnValue(tiersOf(entry));
  const host = document.createElement('div');
  document.body.append(host);
  const renderer: IssRenderer = {
    ready: () => Promise.resolve(), aim: () => Promise.resolve(), showLaunches() {}, resize() {}, destroy() {},
  };
  const scene = mountIssScene(host, { nowMs: () => viewMs, createRenderer: () => renderer, drive: 'manual', session: { mode: 'horizon' } });
  scenes.push(scene);
  scene.update(snapshot());
  await settle();
  await scene.paint();
  const picker = host.querySelector<HTMLSelectElement>('[data-iss-launch-picker]')!;
  picker.value = group === 'all' ? `all:${entry.event_id}` : entry.event_id;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  await scene.paint();
  const card = host.querySelector<HTMLElement>('[data-iss-launch-card]')!;
  return {
    card,
    lines: [
      card.querySelector('[data-iss-launch-verdict]')?.textContent ?? '',
      ...[...card.querySelectorAll('[data-iss-launch-plan] p, [data-iss-launch-note]')].map((line) => line.textContent ?? ''),
    ],
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.spyOn(Date, 'now').mockReturnValue(viewMs);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
});

afterEach(() => {
  for (const scene of scenes) scene.dispose();
  scenes.length = 0;
  vi.restoreAllMocks();
});

describe('a Shot with an ascent envelope and an ISS-plane direction', () => {
  it('prints when, where, with what and how sure on the tier card', () => {
    const card = renderTierCard(launchOf(SHOT));
    expect(whyOf(card)).toBe('Shot. Twilight plume 490 km aft, W6, 3 min after liftoff.');
    expect(planLines(card)).toEqual([...ASCENT_LINES, PLANE_DIRECTION, HONESTY]);
  });

  it('prints the same plan in the details dialog', () => {
    expect(planLines(dialogOf(SHOT))).toEqual([...ASCENT_LINES, PLANE_DIRECTION, HONESTY]);
  });

  it('prints the verdict, when, where, direction and honesty line on the ISS view card', async () => {
    const { lines } = await issCard(SHOT);
    expect(lines).toEqual([
      'Shot. Twilight plume 490 km aft, W6, 3 min after liftoff.',
      ASCENT_LINES[1],
      ASCENT_LINES[3],
      PLANE_DIRECTION.replace('Launch direction: ', ''),
      HONESTY,
    ]);
  });

  it.each([
    ['Shot plan button', '[data-iss-launch-plan-open]'],
    ['launch name, which is all a narrow pane has room for', '[data-iss-launch-name]'],
  ])('opens the full plan from the ISS view card by its %s', async (_what, opener) => {
    const { card } = await issCard(SHOT);
    card.querySelector<HTMLElement>(opener)!.click();
    const dialog = document.querySelector('.launch-dialog')!;
    expect(dialog.querySelector('h2')?.textContent).toBe('Dragon CRS-35');
    expect(planLines(dialog)).toEqual([...ASCENT_LINES, PLANE_DIRECTION, HONESTY]);
  });
});

describe('a Watch with a pad-only envelope and no direction', () => {
  const lines = [...PAD_LINES, NO_DIRECTION, HONESTY];

  it('plans the pad and says why there is no ascent path on the tier card', () => {
    expect(planLines(renderTierCard(launchOf(WATCH)))).toEqual(lines);
  });

  it('says the same in the details dialog and draws no path', () => {
    const dialog = dialogOf(WATCH);
    expect(planLines(dialog)).toEqual(lines);
    expect(dialog.querySelector('[data-tier-track]')?.textContent).toBe('Pad only');
  });

  it('says the same on the ISS view card', async () => {
    expect((await issCard(WATCH)).lines).toEqual([
      'Watch. Night pad 420 km ahead, W7, 1 min after liftoff.',
      PAD_LINES[1],
      PAD_LINES[3],
      NO_DIRECTION.replace('Launch direction: ', ''),
      HONESTY,
    ]);
  });
});

describe('an unassessed launch with no envelope', () => {
  const empty = 'Not assessed, so no shot window is planned. This is not a no.';

  it('says it was not assessed and never reads as a no on the tier card or the dialog', () => {
    const card = renderTierCard(launchOf(UNASSESSED));
    expect(whyOf(card)).toBe('Unassessed. Schedule is too loose to plan a window.');
    expect(planLines(card)).toEqual([empty, NO_DIRECTION]);
    expect(planLines(dialogOf(UNASSESSED))).toEqual([empty, NO_DIRECTION]);
    expect(card.textContent).not.toContain('No shot.');
  });

  it('says the same on the ISS view card and shows no window or honesty line', async () => {
    expect((await issCard(UNASSESSED, 'all')).lines).toEqual([
      'Unassessed. Schedule is too loose to plan a window.',
      NO_DIRECTION.replace('Launch direction: ', ''),
      empty,
    ]);
  });

  it('keeps a watch launch without an envelope from reading as a no', () => {
    const plan = shotPlan(launchOf({ ...UNASSESSED, tier: 'watch', why: 'The view is not confirmed.' }));
    expect(plan.verdict).toBe('Watch. The view is not confirmed.');
    expect(plan.empty).toBe('No shot window yet. The view is unconfirmed. This is not a no.');
  });

  it('keeps the plain negative for tier none only', () => {
    const none = tiersAt(catalog([{ ...UNASSESSED, tier: 'none', why: 'The ascent stays behind Earth on a fresh orbit.' }], {
      generated_at: at(-5), geometry_valid_until: at(9), schedule_valid_until: at(60),
    }), viewMs)!.mapPins[0]!;
    const plan = shotPlan(none);
    expect(plan.verdict).toBe('No shot. The ascent stays behind Earth on a fresh orbit.');
    expect(plan.empty).toBe('Ruled out on a fresh ISS orbit.');
  });
});

describe('a launch with two envelopes', () => {
  it('shows the best envelope on the tier card and says one more is in the details', () => {
    expect(planLines(renderTierCard(launchOf(TWO)))).toEqual([
      ...ASCENT_LINES, PLANE_DIRECTION, HONESTY, '1 more shot window in the details.',
    ]);
  });

  it('lists each envelope on its own in the details dialog, best first, never as one interval', () => {
    expect(planLines(dialogOf(TWO))).toEqual([...ASCENT_LINES, ...PAD_LINES, PLANE_DIRECTION, HONESTY]);
  });

  it('shows the best envelope on the ISS view card', async () => {
    const { lines } = await issCard(TWO);
    expect(lines.slice(1, 3)).toEqual([ASCENT_LINES[1], ASCENT_LINES[3]]);
  });
});

describe('no ascent plan without a direction source', () => {
  const unsourced = item({
    tier: 'watch', why: 'The view is not confirmed.', direction: { ...NONE },
    shots: [ascent({ direction: { ...NONE } })],
  });
  const empty = 'No shot window yet. The view is unconfirmed. This is not a no.';

  it('prints no ascent look, window or path on the tier card', () => {
    const launch = launchOf(unsourced);
    expect(launch.corridor).toBeNull();
    const card = renderTierCard(launch);
    expect(planLines(card)).toEqual([empty, NO_DIRECTION]);
    expect(card.textContent).not.toContain('Cupola');
    expect(card.textContent).not.toContain(HONESTY);
  });

  it('prints none in the details dialog', () => {
    const dialog = dialogOf(unsourced);
    expect(planLines(dialog)).toEqual([empty, NO_DIRECTION]);
    expect(dialog.querySelector('[data-tier-track]')?.textContent).toBe('Pad only');
  });

  it('prints none on the ISS view card', async () => {
    expect((await issCard(unsourced)).lines).toEqual([
      'Watch. The view is not confirmed.',
      NO_DIRECTION.replace('Launch direction: ', ''),
      empty,
    ]);
  });

  it('still plans the pad envelope beside an unsourced ascent', () => {
    const both = { ...unsourced, shots: [ascent({ direction: { ...NONE } }), pad()] };
    expect(planLines(renderTierCard(launchOf(both)))).toEqual([...PAD_LINES, NO_DIRECTION, HONESTY]);
  });
});

describe('published numbers drive the card text', () => {
  it.each([
    ['slant_km', { slant_km: 491 }, 3, 'Stand and look: Cupola W6. Look aft and left, 225° clockwise from the direction of travel, 70° up from straight down. 491 km away.'],
    ['look.off_nadir_deg', { look: { frame: 'orbital-lvlh', azimuth_deg: 225, off_nadir_deg: 70.5 } }, 3, 'Stand and look: Cupola W6. Look aft and left, 225° clockwise from the direction of travel, 70.5° up from straight down. 490 km away.'],
    ['look.azimuth_deg', { look: { frame: 'orbital-lvlh', azimuth_deg: 95, off_nadir_deg: 70 } }, 3, 'Stand and look: Cupola W6. Look right, 95° clockwise from the direction of travel, 70° up from straight down. 490 km away.'],
    ['window', { window: 'W2' }, 3, 'Stand and look: Cupola W2. Look aft and left, 225° clockwise from the direction of travel, 70° up from straight down. 490 km away.'],
    ['best_offset_s', { best_offset_s: -45 }, 1, 'Best time: 17 Oct 2024, 12:13:15 UTC · 17 Oct 2024, 07:13:15 CDT · 45 s before liftoff'],
    ['end', { end: at(16.5) }, 2, 'Shootable: 17 Oct 2024, 12:12:00–12:16:30 UTC · 4 min 30 s'],
    ['lens', { lens: 'wide', lens_reason: 'Plume fills the frame.' }, 4, 'Lens: Wide. Plume fills the frame.'],
    ['light', { light: 'night_engine' }, 5, 'Light: Night engine. Unvalidated until calibrated.'],
    ['confidence', { confidence: { tle_age_h: 30.26, along_track_sigma_km: 3, timing_sigma_s: 1, robust: false } }, 6, 'How sure: ISS orbit data 30.3 h old at the event. Not robust to timing error. Score 62 to 70 of 100.'],
  ] as const)('moving %s changes the line', (_field, over, index, text) => {
    const before = planLines(renderTierCard(launchOf(SHOT)));
    const after = planLines(renderTierCard(launchOf({ ...SHOT, shots: [ascent(over as Partial<ShotEnvelope>)] })));
    expect(after[index]).toBe(text);
    expect(after.filter((line, at) => line !== before[at])).toEqual([text]);
  });

  it('moving the direction evidence changes only the direction line', () => {
    const moved = { ...SHOT, direction: { ...PLANE, azimuth_deg: 51.6, off_plane_deg: -1.2 } };
    expect(planLines(renderTierCard(launchOf(moved)))).toEqual([
      ...ASCENT_LINES,
      'Launch direction: Estimate. The ISS orbital plane, derived from the ISS TLE. Azimuth 51.6°, 1.2° off the plane.',
      HONESTY,
    ]);
  });

  it('names a published source instead of calling it an estimate', () => {
    const published = { ...SHOT, direction: { kind: 'published', azimuth_deg: 97, source: 'https://example.org/overview', off_plane_deg: null } as const };
    expect(shotPlan(launchOf(published)).direction.text).toBe('Published azimuth 97°. Source: https://example.org/overview');
  });
});
