import { describe, expect, it } from 'vitest';
import { launchBrief, launchLookDirection, selectLaunches } from '../src/launch-selectors';
import { parseLaunchArtifact } from '../src/launch-schema';
import { renderLaunchCard, renderLaunchCoverage } from '../src/launch-card';
import { artifact, assessment, interval, iso, launch, NOW, state, supported } from './launch-fixtures';

const planned = () => launch({ assessment: assessment(),
  launch_window: { net: iso(10), start: iso(10), end: iso(97), precision: 'Minute' } });
const selection = (item = planned()) => ({ item, interval: null, expired: false });

describe('plain launch shooting brief', () => {
  it('shows a possible shot only for fresh site visibility at the listed liftoff time, without admitting it to Queue', () => {
    const item = planned(); const s = state([item]);
    const brief = launchBrief(selection(item), s, NOW);
    expect(brief.verdict).toBe('chance');
    expect(brief.label).toBe('Possible at liftoff');
    expect(brief.reason).toContain('launch pad is in view from ISS');
    expect(brief.reason).toContain('Delays, clouds or your window view may prevent a shot');
    expect(brief.reason).not.toContain('12:10');
    expect(brief.direction).toBe('ahead-right of ISS travel; 55.0° from straight down');
    expect(selectLaunches(s, NOW, 'queue')).toEqual([]);
  });

  it('scopes a negative nominal result to NET and does not rule out a delay within the 87-minute window', () => {
    const item = planned();
    item.assessment!.net = { ...item.assessment!.net, verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR', look: null };
    const brief = launchBrief(selection(item), state([item]), NOW);
    expect(brief.verdict).toBe('no_chance');
    expect(brief.label).toBe('Too far at planned time');
    expect(brief.reason).toContain('too far from ISS');
    expect(brief.reason).toContain('nominal model');
    expect(brief.reason).toContain('liftoff and early ascent (first 10 minutes)');
    expect(brief.reason).toContain('later burns unassessed');
    expect(brief.reason).toContain('Delays may change');
    expect(brief.reason).not.toContain('12:10');
    expect(brief.direction).toBeNull();
  });

  it('rules out the entire listed window only with an explicit complete window assessment', () => {
    const item = planned();
    item.assessment!.net = { ...item.assessment!.net, verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR', look: null };
    item.assessment!.window = { verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR' };
    const brief = launchBrief(selection(item), state([item]), NOW);
    expect(brief.verdict).toBe('no_chance');
    expect(brief.label).toBe('Too far in listed window');
    expect(brief.reason).toContain('throughout the listed launch window');
    expect(brief.reason).toContain('nominal model');
  });

  it('treats unknown trajectory as unknown chance, without calling a current schedule bad data', () => {
    const item = launch();
    const brief = launchBrief(selection(item), state([item]), NOW);
    expect(brief).toMatchObject({ verdict: 'unknown', scheduleCurrent: true, direction: null });
    expect(brief.reason).toContain('flight path is unconfirmed');
    expect(brief.reason).not.toMatch(/bad data|stale|too far/i);
  });

  it('uses a neutral passed state and withdraws old directions', () => {
    const item = planned();
    expect(launchBrief({ ...selection(item), expired: true }, state([item]), NOW)).toMatchObject({
      verdict: 'passed', label: 'Listed time has passed', direction: null,
    });
  });

  it('withdraws a nominal result when only its planned NET has passed, even if the launch window remains open', () => {
    const item = planned();
    const brief = launchBrief(selection(item), state([item]), Date.parse(iso(11)));
    expect(brief.verdict).toBe('unknown');
    expect(brief.reason).toContain('planned liftoff time has passed');
    expect(brief.direction).toBeNull();
  });

  it('uses planning validity independently of the 15-minute camera validity', () => {
    const item = planned();
    item.launch_window = { net: iso(90), start: iso(90), end: iso(100), precision: 'Minute' };
    item.assessment!.net.at = iso(90);
    const s = state([item]);
    expect(launchBrief(selection(item), s, Date.parse(iso(20))).verdict).toBe('chance');
    expect(selectLaunches(s, Date.parse(iso(20)), 'queue')).toEqual([]);
  });

  it.each(['expired', 'future-check', 'offline', 'old-source', 'coarse-time', 'time-conflict'])('never presents a current angle or green verdict with %s evidence', (cause) => {
    const item = planned(); const s = state([item]);
    if (cause === 'expired') item.assessment!.valid_until = iso(-1);
    if (cause === 'future-check') item.assessment!.checked_at = iso(1);
    if (cause === 'offline') s.availability = 'offline';
    if (cause === 'old-source') item.sources[0]!.fetched_at = iso(-181);
    if (cause === 'coarse-time') item.launch_window.precision = 'Day';
    if (cause === 'time-conflict') item.reason_codes.push('TIME_CONFLICT');
    const brief = launchBrief(selection(item), s, NOW);
    expect(brief.verdict).toBe('unknown');
    expect(brief.direction).toBeNull();
  });

  it('requires all camera evidence to stay valid before showing supported capture directions', () => {
    const item = supported(); const s = state([item]);
    const selected = { item, interval: interval(), expired: false };
    expect(launchBrief(selected, s, NOW).label).toBe('Possible during capture window');
    item.sources[0]!.fetched_at = iso(-60);
    expect(launchBrief(selected, s, NOW)).toMatchObject({ verdict: 'unknown', direction: null });
  });

  it('distinguishes a nadir sentinel from ahead and uses orbital rather than compass directions', () => {
    expect(launchLookDirection({ frame: 'orbital-lvlh', azimuth_deg: 0, off_nadir_deg: 0 })).toBe('Straight down (nadir)');
    expect(launchLookDirection({ frame: 'orbital-lvlh', azimuth_deg: 90, off_nadir_deg: 45 })).toContain('right of ISS travel');
    expect(launchLookDirection({ frame: 'orbital-lvlh', azimuth_deg: 270, off_nadir_deg: 45 })).toContain('left of ISS travel');
  });
});

describe('additive launch planning schema', () => {
  it('accepts both older artifacts and the new complete planning assessment', () => {
    expect(parseLaunchArtifact(artifact()).items[0]?.assessment).toBeUndefined();
    expect(parseLaunchArtifact(artifact([planned()])).items[0]?.assessment?.net.verdict).toBe('possible');
  });

  it.each(['missing-look', 'wrong-net', 'missing-tle', 'overlong-validity', 'unknown-field', 'negative-without-model', 'unknown-with-look'])('rejects misleading %s assessment', (cause) => {
    const item = planned();
    if (cause === 'missing-look') item.assessment!.net.look = null;
    if (cause === 'wrong-net') item.assessment!.net.at = iso(11);
    if (cause === 'missing-tle') item.assessment!.tle_epoch = null;
    if (cause === 'overlong-validity') item.assessment!.valid_until = iso(180);
    if (cause === 'unknown-field') Object.assign(item.assessment!, { guarantee: true });
    if (cause === 'negative-without-model') {
      item.assessment!.net = { ...item.assessment!.net, verdict: 'too_far', look: null };
      item.assessment!.model = null;
    }
    if (cause === 'unknown-with-look') item.assessment!.net.verdict = 'unknown';
    expect(() => parseLaunchArtifact(artifact([item]))).toThrow();
  });

  it.each([
    'checked-revision-mismatch', 'old-tle', 'future-tle', 'net-outside-tle-horizon', 'negative-model-end-outside-horizon',
    'window-end-outside-horizon', 'source-lease-too-long', 'future-source', 'stale-source', 'model-duration',
    'model-altitude', 'model-downrange', 'pad-distance', 'coarse-time', 'missing-window', 'time-conflict',
    'wrong-negative-reason', 'unknown-reason', 'wrapped-azimuth', 'possible-and-window-negative', 'overwide-negative-window',
    'unverified-item-source', 'unverified-coverage-source',
  ])('enforces producer admission boundaries for %s', (cause) => {
    const item = planned(); const a = artifact([item]);
    const setNegative = () => { item.assessment!.net = { ...item.assessment!.net, verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR', look: null }; };
    if (cause === 'checked-revision-mismatch') item.assessment!.checked_at = iso(-4);
    if (cause === 'old-tle') item.assessment!.tle_epoch = iso(-1500);
    if (cause === 'future-tle') item.assessment!.tle_epoch = iso(1500);
    if (cause === 'net-outside-tle-horizon') {
      item.launch_window = { net: iso(1500), start: iso(1500), end: iso(1501), precision: 'Minute' };
      item.assessment!.net.at = iso(1500);
    }
    if (cause === 'negative-model-end-outside-horizon') {
      setNegative(); item.assessment!.tle_epoch = iso(-1430);
    }
    if (cause === 'window-end-outside-horizon') {
      setNegative(); item.assessment!.tle_epoch = iso(-1350);
      item.assessment!.window = { verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR' };
    }
    if (cause === 'source-lease-too-long') a.coverage.fetched_at = iso(-11);
    if (cause === 'future-source') a.coverage.fetched_at = iso(-4);
    if (cause === 'stale-source') a.coverage.fetched_at = iso(-185);
    if (cause === 'model-duration') item.assessment!.model!.duration_seconds = 3601;
    if (cause === 'model-altitude') item.assessment!.model!.max_altitude_km = 2001;
    if (cause === 'model-downrange') item.assessment!.model!.max_downrange_km = 20001;
    if (cause === 'pad-distance') item.assessment!.net.pad_distance_km = 21001;
    if (cause === 'coarse-time') item.launch_window.precision = 'Day';
    if (cause === 'missing-window') item.launch_window.start = null;
    if (cause === 'time-conflict') item.reason_codes.push('TIME_CONFLICT');
    if (cause === 'unverified-item-source') item.reason_codes.push('SOURCE_AGE_MTIME_ONLY');
    if (cause === 'unverified-coverage-source') a.coverage.reasons.push('REPLAY_SOURCE_MISMATCH');
    if (cause === 'wrong-negative-reason') { setNegative(); item.assessment!.net.reason = 'SITE_IN_VIEW_AT_NET'; }
    if (cause === 'unknown-reason') item.assessment!.window.reason = 'NOT_AN_ASSESSMENT';
    if (cause === 'wrapped-azimuth') item.assessment!.net.look!.azimuth_deg = 360;
    if (cause === 'possible-and-window-negative') item.assessment!.window = { verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR' };
    if (cause === 'overwide-negative-window') {
      setNegative(); item.assessment!.window = { verdict: 'too_far', reason: 'NOMINAL_ASCENT_TOO_FAR' };
      item.launch_window.end = iso(371);
    }
    expect(() => parseLaunchArtifact(a)).toThrow();
  });
});

describe('actionable shared launch card', () => {
  it('shows the shoot, the window, the direction, the launch window, and the chance', () => {
    const item = planned();
    const card = renderLaunchCard(selection(item), state([item]), NOW);
    const summary = card.querySelector('.launch-summary')!;
    expect(card.dataset.verdict).toBe('chance');
    expect(summary.textContent).toContain('Shoot');
    expect(summary.textContent).toContain('Cupola');
    expect(summary.textContent).toContain('55.0° from straight down');
    expect(summary.textContent).toContain('ChancePossible');
    expect(summary.textContent).not.toMatch(/MAP ONLY|VALIDATION_PENDING|TRAJECTORY_UNKNOWN|revision|coverage/i);
    expect(card.querySelector('details')).toBeNull();
  });

  it('offers a site action without inventing a corridor from an unknown trajectory', () => {
    const item = planned(); let selected: string | null = null;
    const card = renderLaunchCard(selection(item), state([item]), NOW, (eventId) => { selected = eventId; });
    const action = card.querySelector<HTMLButtonElement>('.launch-brief-actions button')!;
    expect(action.textContent).toBe('Show launch site');
    action.click();
    expect(selected).toBe(item.event_id);
  });

  it('keeps healthy schedule coverage neutral and collapsed instead of displaying a warning banner', () => {
    const container = document.createElement('div');
    renderLaunchCoverage(container, state(), NOW, 'map');
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toContain('schedule checked');
    expect(container.querySelector('summary')?.textContent).not.toMatch(/incomplete|unknown|STALE|UNEVALUATED/);
    expect(container.querySelector('p')?.textContent).toContain('Coverage');
  });
});
