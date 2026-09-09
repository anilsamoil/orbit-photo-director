import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCard, formatLaunchWindow } from '../src/card';
import { openLaunchDetails, renderLaunchCard, renderLaunchFacts } from '../src/launch-card';
import { launchStore } from '../src/launch-store';
import type { PassEntry } from '../src/types';
import { interval, iso, launch, NOW, state, supported } from './launch-fixtures';

beforeEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('launch-specific cards', () => {
  it('marks conflicting source bounds unknown rather than showing an inverted launch window', () => {
    const item = launch({ reason_codes: ['TIME_CONFLICT'], launch_window: { net: iso(10), start: iso(20), end: iso(-40), precision: 'minute' } });
    const facts = renderLaunchFacts(item, state([item]), NOW);
    expect(facts.textContent).toContain('Launch window startUnknown (conflicting source bounds)');
    expect(facts.textContent).toContain('Launch window endUnknown (conflicting source bounds)');
    expect(facts.textContent).toContain('Schedule precisionUnknown (time conflict)');
    expect(facts.textContent).not.toContain('2026-09-07 11:20:00 UTC');
    expect(renderLaunchCard({ item, interval: null, expired: false }, state([item]), NOW).textContent).toContain('TIME_CONFLICT');
  });
  it('shows tentative NET, unknown capture and explicit MAP ONLY without ground claims', () => {
    const item = launch();
    const card = renderLaunchCard({ item, interval: null, expired: false }, state([item]), NOW);
    expect(card.textContent).toContain('LAUNCH / ASCENT');
    expect(card.textContent).toContain('MAP ONLY');
    expect(card.textContent).toContain('NET (tentative): 2026-09-07 12:10:00 UTC');
    expect(card.textContent).toContain('Capture interval unknown');
    expect(card.textContent).not.toMatch(/%|[★☆]|WORF|Cupola|exact|Remind|Shoot/);
    expect(card.querySelector('.card-countdown,.card-score,.btn-remind')).toBeNull();
  });
  it('shows supported conditional capture and all UTC facts with orbital frame', () => {
    const item = supported(); const s = state([item]);
    const card = renderLaunchCard({ item, interval: interval(), expired: false }, s, NOW);
    expect(card.textContent).toContain('Conditional capture:');
    const facts = renderLaunchFacts(item, s, NOW);
    expect(facts.textContent).toContain('Orbital-relative (LVLH)');
    expect(facts.textContent).toContain('Conditional liftoff');
    expect(facts.textContent).toContain('2026-09-07 12:12:30 UTC');
    expect(facts.textContent).toContain('event-r1');
    expect(facts.textContent).not.toMatch(/%|[★☆]|WORF|Cupola|body|access/);
  });
  it('keeps stale/expired labels full contrast and missing bounds unknown', () => {
    const item = launch(); const s = state([item], { availability: 'offline' });
    const card = renderLaunchCard({ item, interval: null, expired: true }, s, Date.parse(iso(180)));
    expect(card.textContent).toContain('STALE / EXPIRED DATA');
    expect(card.textContent).toContain('OFFLINE');
    expect(card.classList.contains('stale')).toBe(false);
    const facts = renderLaunchFacts(item, s, NOW);
    expect(facts.textContent).toContain('Launch window startUnknown');
    expect(facts.textContent).toContain('Schedule precisionUnknown');
  });
  it('recent schedule-only cards do not claim camera evidence is valid', () => {
    const item = launch(); const s = state([item]);
    const card = renderLaunchCard({ item, interval: null, expired: false }, s, Date.parse(iso(120)));
    expect(card.textContent).not.toContain('STALE / EXPIRED DATA');
    expect(card.textContent).toContain('MAP ONLY');
    expect(card.textContent).toContain('Capture interval unknown');
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
