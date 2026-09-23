import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCard, formatLaunchWindow } from '../src/card';
import { openLaunchDetails, renderLaunchCard, renderLaunchFacts } from '../src/launch-card';
import { launchStore } from '../src/launch-store';
import type { PassEntry } from '../src/types';
import { assessment, interval, iso, launch, NOW, state, supported } from './launch-fixtures';

beforeEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('launch-specific cards', () => {
  const summaryRow = (card: HTMLElement, label: string) => Array.from(card.querySelectorAll('.launch-summary .launch-fact'))
    .find((row) => row.firstElementChild?.textContent === label)?.lastElementChild?.textContent;

  it.each([
    ['Minute', '13 Sep 2026, 18:49 UTC (tentative)'],
    ['Second', '13 Sep 2026, 18:49:27 UTC (tentative)'],
    ['Day', '13 Sep 2026 UTC (day estimate; time unconfirmed)'],
    ['Month', 'Sep 2026 (month estimate)'],
    ['Year', '2026 (year estimate)'],
    [null, 'Not established'],
  ])('states the launch window without overstating %s schedule precision', (precision, expected) => {
    const item = launch({ launch_window: { net: '2026-09-13T18:49:27Z', start: null, end: null, precision } });
    const card = renderLaunchCard({ item, interval: null, expired: false }, state([item]), NOW);
    expect(summaryRow(card, 'Launch window')).toBe(expected);
    expect(summaryRow(card, 'Chance')).toBe('Unknown');
    expect(card.querySelector('details')).toBeNull();
  });
  it('keeps seconds for a capture that crosses midnight', () => {
    const item = supported(); const capture = item.capture_intervals[0]!;
    capture.start = '2026-09-07T23:59:57Z';
    capture.peak = '2026-09-08T00:00:00Z';
    capture.end = '2026-09-08T00:00:03Z';
    const card = renderLaunchCard({ item, interval: capture, expired: false }, state([item]), NOW);
    expect(summaryRow(card, 'Shoot')).toBe('7 Sep 2026, 23:59:57 UTC – 8 Sep 2026, 00:00:03 UTC');
  });
  it('shares the UTC date for a same-day capture range without dropping seconds', () => {
    const item = supported();
    const card = renderLaunchCard({ item, interval: item.capture_intervals[0]!, expired: false }, state([item]), NOW);
    expect(summaryRow(card, 'Shoot')).toBe('7 Sep 2026, 12:10:00–12:15:00 UTC');
    expect(summaryRow(card, 'Window')).toBe('Cupola');
    expect(summaryRow(card, 'Chance')).toBe('Possible');
  });
  it.each([
    ['Minute', '7 Sep 2026, 12:10–13:37 UTC'],
    ['Second', '7 Sep 2026, 12:10:00–13:37:00 UTC'],
  ])('says not possible and keeps the listed window at %s precision', (precision, expected) => {
    const plan = assessment({ net: { ...assessment().net, verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR', look: null },
      window: { verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR' } });
    const item = launch({ assessment: plan, launch_window: { net: iso(10), start: iso(10), end: iso(97), precision } });
    const card = renderLaunchCard({ item, interval: null, expired: false }, state([item]), NOW);
    expect(summaryRow(card, 'Shoot')).toBe('Not possible');
    expect(summaryRow(card, 'Window')).toBe('Not possible');
    expect(summaryRow(card, 'Direction')).toBe('Not possible');
    expect(summaryRow(card, 'Launch window')).toBe(expected);
    expect(summaryRow(card, 'Chance')).toBe('Not possible');
  });
  it('does not turn a day-only TBD schedule into a midnight launch time', () => {
    const item = launch({ reason_codes: ['LAUNCH_UNCONFIRMED', 'TIME_PRECISION_COARSE'],
      launch_window: { net: '2026-09-16T00:00:00Z', start: '2026-09-16T00:00:00Z', end: '2026-09-16T00:00:00Z', precision: 'Day' } });
    const s = state([item]);
    const card = renderLaunchCard({ item, interval: null, expired: false }, s, NOW);
    expect(summaryRow(card, 'Launch window')).toBe('16 Sep 2026 UTC (day estimate; time unconfirmed)');
    expect(card.textContent).not.toContain('2026-09-16 00:00:00 UTC');
    const facts = renderLaunchFacts(item, s, NOW);
    expect(facts.textContent).toContain('2026-09-16 UTC (day estimate; time unconfirmed)');
    expect(facts.textContent).not.toContain('2026-09-16 00:00:00 UTC');
    expect(facts.textContent).toContain('SCHEDULE UNCONFIRMED');
  });
  it('marks conflicting source bounds unknown rather than showing an inverted launch window', () => {
    const item = launch({ reason_codes: ['TIME_CONFLICT'], launch_window: { net: iso(10), start: iso(20), end: iso(-40), precision: 'minute' } });
    const facts = renderLaunchFacts(item, state([item]), NOW);
    expect(facts.textContent).toContain('Launch window startUnknown (conflicting source bounds)');
    expect(facts.textContent).toContain('Launch window endUnknown (conflicting source bounds)');
    expect(facts.textContent).toContain('Schedule precisionUnknown (time conflict)');
    expect(facts.textContent).not.toContain('2026-09-07 11:20:00 UTC');
    const card = renderLaunchCard({ item, interval: null, expired: false }, state([item]), NOW);
    expect(summaryRow(card, 'Launch window')).toBe('Unknown');
    expect(summaryRow(card, 'Chance')).toBe('Unknown');
    expect(card.textContent).not.toContain('11:20');
  });
  it('keeps an unconfirmed launch on the five lines without the raw schedule dump', () => {
    const item = launch();
    const card = renderLaunchCard({ item, interval: null, expired: false }, state([item]), NOW);
    expect(summaryRow(card, 'Shoot')).toBe('Not established');
    expect(summaryRow(card, 'Direction')).toBe('Not established');
    expect(summaryRow(card, 'Chance')).toBe('Unknown');
    expect(card.querySelector('details')).toBeNull();
    expect(card.textContent).not.toContain('12:10');
    expect(card.textContent).not.toMatch(/%|[★☆]|exact|Remind|MAP ONLY/);
    expect(card.querySelector('.card-countdown,.card-score,.btn-remind')).toBeNull();
  });
  it('shows the capture time, Cupola or WORF, and the direction', () => {
    const item = supported(); const s = state([item]);
    const card = renderLaunchCard({ item, interval: interval(), expired: false }, s, NOW);
    expect(summaryRow(card, 'Shoot')).toBe('7 Sep 2026, 12:10:00–12:15:00 UTC');
    expect(summaryRow(card, 'Window')).toBe('Cupola');
    expect(summaryRow(card, 'Direction')).toContain('ahead-right of ISS travel');
    expect(summaryRow(card, 'Chance')).toBe('Possible');
    const facts = renderLaunchFacts(item, s, NOW);
    expect(facts.textContent).toContain('Orbital-relative (LVLH)');
    expect(facts.textContent).toContain('Conditional liftoff');
    expect(facts.textContent).toContain('2026-09-07 12:12:30 UTC');
    expect(facts.textContent).toContain('event-r1');
  });
  it('names WORF when the shot is within 30 degrees of straight down', () => {
    const item = supported();
    const capture = item.capture_intervals[0]!;
    const look = capture.look;
    if (!look) throw new Error('fixture look missing');
    look.off_nadir_deg = 18;
    const card = renderLaunchCard({ item, interval: item.capture_intervals[0]!, expired: false }, state([item]), NOW);
    expect(summaryRow(card, 'Window')).toBe('WORF');
  });
  it('does not put stale labels on the operator card', () => {
    const item = launch(); const s = state([item], { availability: 'offline' });
    const card = renderLaunchCard({ item, interval: null, expired: true }, s, Date.parse(iso(180)));
    expect(summaryRow(card, 'Chance')).toBe('Passed');
    expect(card.classList.contains('stale')).toBe(false);
    expect(card.textContent).not.toContain('STALE / EXPIRED DATA');
    const facts = renderLaunchFacts(item, s, NOW);
    expect(facts.textContent).toContain('Launch window startUnknown');
    expect(facts.textContent).toContain('Schedule precisionUnknown');
  });
  it('does not claim a shot from schedule data alone', () => {
    const item = launch(); const s = state([item]);
    const card = renderLaunchCard({ item, interval: null, expired: false }, s, Date.parse(iso(120)));
    expect(summaryRow(card, 'Shoot')).toBe('Not established');
    expect(summaryRow(card, 'Chance')).toBe('Unknown');
    expect(card.textContent).not.toContain('STALE / EXPIRED DATA');
    expect(renderLaunchFacts(item, s, NOW).textContent).toContain('Camera evidence valid until');
  });
  it('renders source and name as text, never HTML', () => {
    const item = launch({ name: '<img src=x onerror=alert(1)>', reason_codes: ['<script>bad</script>'] });
    const card = renderLaunchCard({ item, interval: null, expired: false }, state([item]), NOW);
    expect(card.querySelector('img')).toBeNull();
    const facts = renderLaunchFacts(item, state([item]), NOW);
    expect(facts.querySelector('script')).toBeNull();
    expect(facts.querySelector('a')?.rel).toContain('noopener');
  });
  it('card and marker entry point opens current shared facts and updates revisions', () => {
    let s = state(); let update = () => {};
    vi.spyOn(launchStore, 'getState').mockImplementation(() => s);
    vi.spyOn(launchStore, 'subscribe').mockImplementation((fn) => { update = fn; return () => {}; });
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
    renderLaunchCard({ item: s.artifact!.items[0]!, interval: null, expired: false }, s, NOW).querySelector('button')!.click();
    expect(document.querySelector('.launch-facts')?.getAttribute('data-revision')).toBe('event-r1');
    s = state([launch({ revision: 'event-r2', name: 'Revised schedule' })]); update();
    expect(document.querySelector('.launch-facts')?.getAttribute('data-revision')).toBe('event-r2');
    expect(document.querySelector('h2')?.textContent).toContain('Revised schedule');
    document.querySelector('dialog')?.close();
    openLaunchDetails('event-1');
    expect(document.querySelector('.launch-facts')?.getAttribute('data-revision')).toBe('event-r2');
  });
});

describe('legacy launch fallback', () => {
  it('suppresses score claims even when legacy launch metadata is missing', () => {
    const card = renderCard({ target_id: 'launch:broken', target_name: 'Launch' } as PassEntry, NOW, false, () => {});
    expect(card.textContent).toContain('MAP ONLY | LEGACY');
    expect(card.querySelector('.card-score')).toBeNull();
  });
  const legacy = (t0?: string) => ({ target_id: 'launch:one', target_name: 'Legacy', closest_approach: iso(1),
    launch: { name: 'Legacy', rocket_type: 'Rocket', geometry: 'ascent', site_name: 'Pad', net_window_seconds: 0, t0 },
    score: 99, p_unobstructed: 95, angle_off_nadir_deg: 25,
  }) as PassEntry;
  it.each([undefined, '', 'not-a-time', '2026-09-07T12:00:00-05:00'])('does not substitute closest approach for missing UTC NET: %s', (t0) => {
    const card = renderCard(legacy(t0), NOW, true, () => {});
    expect(card.textContent).toContain('NET (tentative)Unknown');
    expect(card.textContent).toContain('MAP ONLY | LEGACY | STALE');
    expect(card.textContent).not.toMatch(/%|[★☆]|WORF|Cupola|exact|Remind|Shoot|12:01/);
    expect(card.querySelector('button,.card-score,.card-countdown')).toBeNull();
  });
  it('labels available schedule as tentative, never exact', () => {
    expect(renderCard(legacy(iso(10)), NOW, false, () => {}).textContent).toContain('NET (tentative)2026-09-07 12:10:00 UTC');
    expect(formatLaunchWindow(0)).toBe('Schedule precision unknown');
    expect(formatLaunchWindow(NaN)).toBe('Schedule precision unknown');
  });
});
