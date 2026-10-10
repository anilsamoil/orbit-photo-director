import { describe, expect, it, vi } from 'vitest';

import { mountIssScene } from '../src/iss-view';
import {
  classifyLaunchSite,
  launchChoiceLabel,
  launchCorridorLines,
  launchSites,
  launchTimeFact,
  selectAllLaunches,
  lookArrowDeg,
  lookNudge,
  placeLaunchMarks,
  siteOnDisk,
  type LaunchSite,
} from '../src/iss-view/launches';
import type { LaunchSelection } from '../src/launch-selectors';
import type { LaunchOpportunity } from '../src/launch-schema';
import type { IssAim, IssRenderer, IssRendererFactory, IssRendererHooks } from '../src/iss-view/renderer';
import type { SceneSnapshot } from '../src/iss-view/model';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };
import { launchStore } from '../src/launch-store';
import { NOW, artifact, assessment, catalog, envelope, iso, launch, state, supported } from './launch-fixtures';

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

const startMs = Date.parse(fixture.start);

function shot(): SceneSnapshot {
  return {
    manifestVersion: 'm1',
    generatedAtMs: startMs,
    track: {
      iss_polynomial: fixture.iss_polynomial,
      tle: fixture.tle,
      tle_epoch: '2024-10-16T18:58:11.999Z',
      tle_age_hours: 17,
      tle_freshness_factor: 1,
    },
  };
}

const cape: LaunchSite = {
  eventId: 'cape',
  name: 'Crew',
  siteName: 'Cape Canaveral',
  lat: 28.5,
  lon: -80.6,
  corridor: null,
};

describe('launch sites near telemetry', () => {
  it('keeps a pad and a sourced corridor, and drops a track the artifact did not source', () => {
    const sourced = supported({
      assessment: assessment(),
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
    });
    const unsourced = launch({
      event_id: 'mahia',
      name: 'Electron',
      assessment: assessment(),
      site: { name: 'Mahia', lat: -39.26, lon: 177.86 },
      trajectory: {
        quality: 'approximate',
        source: null,
        points: [
          { lat: -39.26, lon: 177.86, alt_km: 0, t_offset_seconds: 0 },
          { lat: -39, lon: 178, alt_km: 20, t_offset_seconds: 30 },
        ],
      },
    });
    const sites = launchSites(state([sourced, unsourced]), NOW);
    expect(sites.map((site) => site.siteName)).toEqual(['Cape Canaveral', 'Mahia']);
    expect(sites[0]?.corridor).toEqual([
      { lat: 28.5, lon: -80.6 },
      { lat: 29, lon: -80 },
    ]);
    expect(sites[1]?.corridor).toBeNull();
    expect(launchCorridorLines(sites)).toEqual([[[-80.6, 28.5], [-80, 29]]]);
  });

  it('omits a launch the map would not call a chance', () => {
    const far = launch({
      assessment: assessment({
        net: {
          verdict: 'too_far',
          reason: 'NOMINAL_ASCENT_TOO_FAR',
          at: iso(10),
          pad_distance_km: 9000,
          look: null,
        },
      }),
    });
    expect(launchSites(state([far]), NOW)).toEqual([]);
  });

  it('points the rolled look down for ahead, left for starboard, up for aft, and right for port', () => {
    expect(lookArrowDeg(10, 10)).toBeCloseTo(180);
    expect(lookNudge(10, 10)).toEqual({ right: expect.closeTo(0), up: expect.closeTo(-1) });
    expect(lookNudge(0, 90)).toEqual({ right: expect.closeTo(-1), up: expect.closeTo(0) });
    expect(lookNudge(0, 180)).toEqual({ right: expect.closeTo(0), up: expect.closeTo(1) });
    expect(lookNudge(0, 270)).toEqual({ right: expect.closeTo(1), up: expect.closeTo(0) });
  });

  it('pins a site inside the frame and parks an arrow on the edge when it falls outside', () => {
    const placed = placeLaunchMarks(
      [cape, { ...cape, eventId: 'side', siteName: 'Vandenberg', lon: -120.5 }],
      (lon) => (lon === -80.6 ? { x: 100, y: 80 } : { x: 10, y: 80 }),
      200,
      160,
    );
    expect(placed.pins).toEqual([
      { eventId: 'cape', name: 'Crew', siteName: 'Cape Canaveral', lat: 28.5, lon: -80.6, x: 100, y: 80 },
    ]);
    expect(placed.arrows).toHaveLength(1);
    expect(placed.arrows[0]?.x).toBeCloseTo(28);
    expect(placed.arrows[0]?.y).toBeCloseTo(80);
    expect(placed.arrows[0]?.deg).toBeCloseTo(-90);
    expect(placeLaunchMarks([cape], () => ({ x: 10, y: 10 }), 40, 40)).toEqual({ pins: [], arrows: [] });
  });

  it('treats a nearby pad as on the disk and a far pad as beyond the limb', () => {
    expect(siteOnDisk(0, 0, 420_000, 0, 8)).toBe(true);
    expect(siteOnDisk(0, 0, 420_000, 0, 80)).toBe(false);
  });

  it('names a listed window and a tentative NET without a second schedule model', () => {
    const listed = supported();
    expect(launchTimeFact(selection(listed), state([]), NOW)).toEqual({
      label: 'Launch window',
      text: '7 Sep 2026, 12:08:00–12:09:00 UTC',
    });
    const tentative = launch({
      launch_window: { net: iso(10), start: null, end: null, precision: 'minute' },
    });
    expect(launchTimeFact(selection(tentative), state([]), NOW)).toEqual({
      label: 'NET, tentative',
      text: '7 Sep 2026, 12:10 UTC (tentative)',
    });
    expect(launchChoiceLabel(selection(listed), state([]), NOW)).toBe(
      'Test launch · Test site · 7 Sep 2026, 12:08:00–12:09:00 UTC',
    );
  });

  it('reports the four visibility states from the marker geometry', () => {
    const inside = classifyLaunchSite(cape, true, () => ({ x: 100, y: 80 }), 200, 160);
    expect(inside.visibility).toBe('Site in frame');
    expect(inside.pin?.eventId).toBe('cape');
    expect(inside.arrow).toBeNull();
    const outside = classifyLaunchSite(cape, true, () => ({ x: 10, y: 80 }), 200, 160);
    expect(outside.visibility).toBe('Site outside frame');
    expect(outside.pin).toBeNull();
    expect(outside.arrow?.eventId).toBe('cape');
    expect(classifyLaunchSite(cape, false, () => ({ x: 100, y: 80 }), 200, 160)).toEqual({
      visibility: 'Site below horizon',
      pin: null,
      arrow: null,
    });
    expect(classifyLaunchSite(cape, true, null, 200, 160).visibility).toBe('View unavailable');
    const tiny = classifyLaunchSite(cape, true, () => ({ x: 20, y: 20 }), 40, 40);
    expect(tiny).toEqual({ visibility: 'View unavailable', pin: null, arrow: null });
  });
});

describe('selected launch in the ISS view', () => {
  it.each([
    ['chance', 'CRS'], ['chance', 'SpX-35'],
    ['all', 'CRS'], ['all', 'SpX-35'],
  ])('keeps the saved CRS/SpX aliases available in the v2 %s fallback for %s', async (group, prefix) => {
    const name = 'Falcon 9 Block 5 | Dragon CRS-2 SpX-35';
    const item = selection(supported({ event_id: 'bf2c3027-a314-403e-a416-2bfd5d165ad1', name }));
    const host = document.createElement('div');
    document.body.append(host);
    const scene = mountIssScene(host, {
      nowMs: () => NOW,
      launches: () => [item],
      allLaunches: () => [item],
      createRenderer: () => ({
        ready: () => Promise.resolve(), aim: () => Promise.resolve(), resize() {}, destroy() {},
      }),
      drive: 'manual',
      session: { mode: 'horizon' },
    });
    try {
      scene.update(shot());
      await settle();
      await scene.paint();
      const picker = host.querySelector('[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement)) throw new Error('missing picker');
      picker.focus();
      const option = [...picker.options].find((entry) => entry.textContent?.startsWith(prefix)
        && (entry.parentElement instanceof HTMLOptGroupElement) === (group === 'all'));
      if (!option) throw new Error('missing prefix option');
      picker.selectedIndex = [...picker.options].indexOf(option);
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await scene.paint();
      expect(picker.value).toBe(`${group === 'all' ? 'all:' : ''}${item.item.event_id}`);
      expect(picker.selectedOptions[0]).toBe(option);
      expect(document.activeElement).toBe(picker);
      expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe(name);
      expect(host.querySelector('[data-iss-launch-card]')?.hasAttribute('hidden')).toBe(false);
    } finally {
      scene.dispose();
      host.remove();
    }
  });

  it('chooses one launch without moving the aim, then keeps the pad nudge', async () => {
    const shown: string[][] = [];
    const aims: IssAim[] = [];
    let report: IssRendererHooks['onLaunchVisibility'];
    const factory: IssRendererFactory = (): IssRenderer => ({
      ready: () => Promise.resolve(),
      aim: (aim) => {
        aims.push(aim);
        return Promise.resolve();
      },
      showLaunches(sites) {
        shown.push(sites.map((site) => site.eventId));
      },
      resize: () => {},
      destroy: () => {},
    });
    const capeChoice = selection(supported({
      event_id: 'cape',
      name: 'Crew',
      assessment: assessment(),
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
    }));
    const vandenberg = selection(supported({
      event_id: 'vandenberg',
      name: 'Transporter',
      site: { name: 'Vandenberg', lat: 34.7, lon: -120.6 },
      trajectory: {
        quality: 'approximate',
        source: null,
        points: [
          { lat: 34.7, lon: -120.6, alt_km: 0, t_offset_seconds: 0 },
          { lat: 35, lon: -121, alt_km: 20, t_offset_seconds: 30 },
        ],
      },
    }));
    const catalog = [capeChoice, vandenberg];
    const host = document.createElement('div');
    document.body.append(host);
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: (frame, received) => {
        report = received.onLaunchVisibility;
        return factory(frame, received);
      },
      drive: 'manual',
      session: { mode: 'horizon' },
      launches: () => catalog,
    });
    const picker = host.querySelector('[data-iss-launch-picker]');
    const telemetry = host.querySelector('[data-iss-telemetry]');
    expect(picker).toBeInstanceOf(HTMLSelectElement);
    expect(picker?.closest('[data-iss-controls]')?.contains(telemetry)).toBe(true);
    if (!(picker instanceof HTMLSelectElement)) return;
    expect(picker.value).toBe('');
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      'Choose launch',
      'None',
      launchChoiceLabel(capeChoice, state([]), NOW),
      launchChoiceLabel(vandenberg, state([]), NOW),
    ]);
    expect(host.querySelector('[data-iss-launches]')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('[data-iss-launch-card]')?.hasAttribute('hidden')).toBe(true);
    scene.update(shot());
    await settle();
    await scene.paint();
    const before = aims.at(-1);
    picker.value = 'cape';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    const selected = aims.at(-1);
    expect(selected?.pose.targetLatDeg).toBe(before?.pose.targetLatDeg);
    expect(selected?.pose.targetLonDeg).toBe(before?.pose.targetLonDeg);
    expect(selected?.pose.altitudeM).toBe(before?.pose.altitudeM);
    expect(shown.at(-1)).toEqual(['cape']);
    expect(shown.at(-1)).toHaveLength(1);
    const button = host.querySelector('[data-iss-launch]') as HTMLButtonElement | null;
    expect(button?.querySelector('[data-iss-launch-label]')?.textContent).toBe('Look toward Cape Canaveral');
    expect(button?.textContent).toContain('Cape Canaveral');
    expect(button?.closest('[data-iss-controls]')?.contains(telemetry)).toBe(true);
    const card = host.querySelector('[data-iss-launch-card]');
    expect(card?.querySelector('[data-iss-launch-name]')?.textContent).toBe('Crew');
    expect(card?.querySelector('[data-iss-launch-site]')?.textContent).toBe('Cape Canaveral');
    expect(card?.querySelector('[data-iss-launch-time-label]')?.textContent).toBe('Launch window');
    expect(card?.querySelector('[data-iss-launch-time-value]')?.textContent).toContain('UTC');
    expect(card?.querySelector('[data-iss-launch-visibility]')?.textContent).toBe('View unavailable');
    const states = ['Site in frame', 'Site outside frame', 'Site below horizon', 'View unavailable'] as const;
    for (const visibility of states) {
      report?.('cape', visibility);
      expect(card?.querySelector('[data-iss-launch-visibility]')?.textContent).toBe(visibility);
    }
    expect(button?.isConnected).toBe(true);
    const aimed = aims.at(-1)?.pose.targetLatDeg;
    button?.click();
    await settle();
    await scene.paint();
    const arrow = host.querySelector('[data-iss-launch-arrow]') as HTMLElement | null;
    expect(arrow?.style.getPropertyValue('--iss-launch-aim')).toMatch(/-?\d+\.\d+deg/);
    expect(aims.at(-1)?.pose.targetLatDeg).not.toBe(aimed);
    const replaced = aims.at(-1);
    picker.value = 'vandenberg';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    expect(shown.at(-1)).toEqual(['vandenberg']);
    expect(aims.at(-1)?.pose.targetLatDeg).toBe(replaced?.pose.targetLatDeg);
    expect(host.querySelector('[data-iss-launch-label]')?.textContent).toBe('Look toward Vandenberg');
    expect(host.querySelector('[data-iss-launch]')?.textContent).toContain('Vandenberg');
    expect(host.querySelector('[data-iss-launch-card] [data-iss-launch-name]')?.textContent).toBe('Transporter');
    picker.value = 'none';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    expect(picker.value).toBe('');
    expect(shown.at(-1)).toEqual([]);
    expect(host.querySelector('[data-iss-launches]')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('[data-iss-launch-card]')?.hasAttribute('hidden')).toBe(true);
    scene.dispose();
    host.remove();
  });

  it('keeps the option while metadata changes, then clears the choice when the launch leaves', async () => {
    const shown: LaunchSite[][] = [];
    const aims: IssAim[] = [];
    const crew = selection(supported({
      event_id: 'crew',
      name: 'Crew',
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
    }));
    const other = selection(supported({
      event_id: 'other',
      name: 'Other',
      site: { name: 'Mahia', lat: -39.26, lon: 177.86 },
    }));
    const catalog = { items: [crew, other] };
    const host = document.createElement('div');
    document.body.append(host);
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: (aim) => {
          aims.push(aim);
          return Promise.resolve();
        },
        showLaunches(sites) {
          shown.push([...sites]);
        },
        resize: () => {},
        destroy: () => {},
      }),
      drive: 'manual',
      session: { mode: 'horizon' },
      launches: () => catalog.items,
    });
    scene.update(shot());
    await settle();
    await scene.paint();
    const picker = host.querySelector('[data-iss-launch-picker]');
    expect(picker).toBeInstanceOf(HTMLSelectElement);
    if (!(picker instanceof HTMLSelectElement)) return;
    picker.value = 'crew';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    const option = picker.querySelector('option[value="crew"]');
    picker.focus();
    crew.item.name = 'Crew updated';
    crew.item.site.name = 'Cape updated';
    await scene.paint();
    await scene.paint();
    expect(document.activeElement).toBe(picker);
    expect(picker.querySelector('option[value="crew"]')).toBe(option);
    expect(picker.value).toBe('crew');
    expect(option?.textContent).toContain('Crew updated');
    expect(option?.textContent).toContain('Cape updated');
    expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Crew updated');
    expect(host.querySelector('[data-iss-launch-site]')?.textContent).toBe('Cape updated');
    expect(shown.at(-1)?.map((site) => site.eventId)).toEqual(['crew']);
    expect(shown.at(-1)?.[0]?.corridor?.length).toBeGreaterThanOrEqual(2);
    const held = aims.at(-1)?.pose.targetLatDeg;
    catalog.items = [other];
    await scene.paint();
    expect(picker.value).toBe('');
    expect(picker.selectedOptions[0]?.textContent).toBe('Choose launch');
    expect([...picker.options].some((entry) => entry.textContent === 'Selected launch is no longer available')).toBe(false);
    expect(host.querySelector('[data-iss-launch-missing]')?.textContent).toBe('Selected launch is no longer available');
    expect(host.querySelector('[data-iss-launch-card]')?.hasAttribute('hidden')).toBe(false);
    expect(shown.at(-1)).toEqual([]);
    expect(host.querySelector('[data-iss-launch]')).toBeNull();
    expect(aims.at(-1)?.pose.targetLatDeg).toBe(held);
    expect([...picker.options].some((entry) => entry.value === 'other' && entry.selected)).toBe(false);
    catalog.items = [crew, other];
    await scene.paint();
    expect(picker.value).toBe('');
    expect(picker.selectedOptions[0]?.textContent).toBe('Choose launch');
    expect([...picker.options].some((entry) => entry.value === 'crew' && !entry.selected)).toBe(true);
    expect(host.querySelector('[data-iss-launch-missing]')?.textContent).toBe('Selected launch is no longer available');
    expect(shown.at(-1)).toEqual([]);
    expect(host.querySelector('[data-iss-launch]')).toBeNull();
    expect(aims.at(-1)?.pose.targetLatDeg).toBe(held);
    picker.value = 'other';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    expect(picker.value).toBe('other');
    expect(host.querySelector('[data-iss-launch-missing]')).toBeNull();
    expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Other');
    expect(shown.at(-1)?.map((site) => site.eventId)).toEqual(['other']);
    catalog.items = [crew];
    await scene.paint();
    expect(picker.value).toBe('');
    expect([...picker.options].some((entry) => entry.value === 'crew' && entry.selected)).toBe(false);
    expect(host.querySelector('[data-iss-launch-missing]')?.textContent).toBe('Selected launch is no longer available');
    expect(shown.at(-1)).toEqual([]);
    picker.value = 'none';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    expect(picker.value).toBe('');
    expect(host.querySelector('[data-iss-launch-card]')?.hasAttribute('hidden')).toBe(true);
    scene.dispose();
    host.remove();
  });

  it('passes one sourced corridor and drops an unsourced track for the chosen launch', async () => {
    const shown: LaunchSite[][] = [];
    const sourced = selection(supported({
      event_id: 'sourced',
      name: 'Sourced',
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
    }));
    const unsourced = selection(launch({
      event_id: 'unsourced',
      name: 'Electron',
      site: { name: 'Mahia', lat: -39.26, lon: 177.86 },
      trajectory: {
        quality: 'approximate',
        source: null,
        points: [
          { lat: -39.26, lon: 177.86, alt_km: 0, t_offset_seconds: 0 },
          { lat: -39, lon: 178, alt_km: 20, t_offset_seconds: 30 },
        ],
      },
    }));
    const host = document.createElement('div');
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: () => Promise.resolve(),
        showLaunches(sites) {
          shown.push([...sites]);
        },
        resize: () => {},
        destroy: () => {},
      }),
      drive: 'manual',
      session: { mode: 'horizon' },
      launches: () => [sourced, unsourced],
    });
    scene.update(shot());
    await settle();
    const picker = host.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) throw new Error('missing picker');
    picker.value = 'unsourced';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    expect(shown.at(-1)).toHaveLength(1);
    expect(shown.at(-1)?.[0]?.corridor).toBeNull();
    expect(launchCorridorLines(shown.at(-1) ?? [])).toEqual([]);
    picker.value = 'sourced';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    expect(shown.at(-1)?.map((site) => site.eventId)).toEqual(['sourced']);
    expect(launchCorridorLines(shown.at(-1) ?? [])).toEqual([[[-80.6, 28.5], [-80, 29]]]);
    scene.dispose();
  });

  it('holds the choice while a newer pointer downloads and does not restore it', async () => {
    localStorage.clear();
    const chance = (eventId: string, name: string, siteName: string, lat: number, lon: number, checkedAt: string) => launch({
      event_id: eventId,
      name,
      site: { name: siteName, lat, lon },
      assessment: assessment({ checked_at: checkedAt }),
      launch_window: { net: iso(10), start: iso(10), end: iso(97), precision: 'Minute' },
      sources: [{ kind: 'schedule', url: 'https://example.org/launch', fetched_at: checkedAt }],
    });
    const crewAt = (checkedAt: string) => chance('crew', 'Crew', 'Cape Canaveral', 28.5, -80.6, checkedAt);
    const otherAt = (checkedAt: string) => chance('other', 'Other', 'Mahia', -39.26, 177.86, checkedAt);
    const first = await envelope(artifact([crewAt(iso(-5)), otherAt(iso(-5))]));
    const dropped = await envelope(artifact([otherAt(iso(-1))], { revision: 'r2', generated_at: iso(-1) }));
    const returned = await envelope(artifact([crewAt(iso(0)), otherAt(iso(0))], { revision: 'r3', generated_at: iso(0) }));
    let phase: 'first' | 'hold' | 'back' = 'first';
    let releaseBody: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const latest = path.includes('launch/latest.json');
      if (phase === 'first') return new Response(latest ? JSON.stringify(first.pointer) : first.body);
      if (phase === 'hold') {
        if (latest) return new Response(JSON.stringify(dropped.pointer));
        return new Promise<Response>((resolve) => { releaseBody = resolve; });
      }
      return new Response(latest ? JSON.stringify(returned.pointer) : returned.body);
    }));
    const host = document.createElement('div');
    document.body.append(host);
    try {
      await launchStore.refresh();
      const scene = mountIssScene(host, {
        nowMs: () => NOW,
        createRenderer: () => ({
          ready: () => Promise.resolve(),
          aim: () => Promise.resolve(),
          showLaunches() {},
          resize: () => {},
          destroy: () => {},
        }),
        drive: 'manual',
        session: { mode: 'horizon' },
      });
      scene.update(shot());
      await settle();
      await scene.paint();
      const picker = host.querySelector('[data-iss-launch-picker]');
      expect(picker).toBeInstanceOf(HTMLSelectElement);
      if (!(picker instanceof HTMLSelectElement)) return;
      expect([...picker.options].some((entry) => entry.value === 'crew')).toBe(true);
      picker.value = 'crew';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await scene.paint();
      expect(picker.value).toBe('crew');
      phase = 'hold';
      const pending = launchStore.refresh();
      await vi.waitFor(() => {
        if (!launchStore.getState().superseded) throw new Error('pointer not observed');
      });
      await settle();
      expect(picker.value).toBe('crew');
      expect(host.querySelector('[data-iss-launch-missing]')).toBeNull();
      expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Crew');
      releaseBody(new Response(dropped.body));
      await pending;
      await settle();
      expect(picker.value).toBe('');
      expect(picker.selectedOptions[0]?.textContent).toBe('Choose launch');
      expect(host.querySelector('[data-iss-launch-missing]')?.textContent).toBe('Selected launch is no longer available');
      expect([...picker.options].some((entry) => entry.value === 'other' && entry.selected)).toBe(false);
      phase = 'back';
      await launchStore.refresh();
      await settle();
      expect(picker.value).toBe('');
      expect([...picker.options].some((entry) => entry.value === 'crew' && !entry.selected)).toBe(true);
      expect(host.querySelector('[data-iss-launch-missing]')?.textContent).toBe('Selected launch is no longer available');
      expect(host.querySelector('[data-iss-launch]')).toBeNull();
      scene.dispose();
    } finally {
      vi.unstubAllGlobals();
      host.remove();
    }
  });

  it('shows an All launches row as a pad without claiming a chance or an unsourced corridor', async () => {
    const shown: LaunchSite[][] = [];
    const net = new Date(startMs + 2 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const end = new Date(startMs + 3 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const schedule = launch({
      event_id: 'horizon',
      name: 'Horizon',
      site: { name: 'Coast', lat: 28.5, lon: -80.6 },
      reason_codes: ['TIME_PRECISION_COARSE'],
      launch_window: { net, start: net, end, precision: 'Hour' },
    });
    const sourced = launch({
      event_id: 'sourced',
      name: 'Sourced',
      site: { name: 'Cape', lat: 28.4, lon: -80.5 },
      reason_codes: [],
      launch_window: { net, start: net, end, precision: 'Second' },
      trajectory: {
        quality: 'approximate',
        source: 'Published track',
        points: [
          { lat: 28.4, lon: -80.5, alt_km: 0, t_offset_seconds: 0 },
          { lat: 28.8, lon: -80.1, alt_km: 20, t_offset_seconds: 30 },
        ],
      },
    });
    const catalog = selectAllLaunches(state([schedule, sourced]), startMs + 60_000);
    const host = document.createElement('div');
    document.body.append(host);
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: () => ({
        ready: () => Promise.resolve(),
        aim: () => Promise.resolve(),
        showLaunches(sites) {
          shown.push([...sites]);
        },
        resize: () => {},
        destroy: () => {},
      }),
      drive: 'manual',
      session: { mode: 'horizon' },
      launches: () => [],
      allLaunches: () => catalog,
    });
    scene.update(shot());
    await settle();
    await scene.paint();
    const picker = host.querySelector('[data-iss-launch-picker]');
    expect(picker).toBeInstanceOf(HTMLSelectElement);
    if (!(picker instanceof HTMLSelectElement)) return;
    const group = [...picker.querySelectorAll('optgroup')].find((entry) => entry.label === 'All launches');
    expect(group?.querySelectorAll('option').length).toBe(2);
    picker.value = 'all:horizon';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    const card = host.querySelector('[data-iss-launch-card]');
    expect(card?.getAttribute('data-iss-launch-group')).toBe('all');
    expect(card?.textContent ?? '').not.toMatch(/possible|chance/i);
    expect(shown.at(-1)?.[0]?.corridor).toBeNull();
    expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Horizon');
    picker.value = 'all:sourced';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    expect(shown.at(-1)?.[0]?.corridor?.length).toBe(2);
    expect(host.querySelector('[data-iss-launch-card]')?.textContent ?? '').not.toMatch(/possible|chance/i);
    scene.dispose();
    host.remove();
  });

  it('aims an All launches pick from the pin and from the edge arrow', async () => {
    const net = new Date(startMs + 2 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const end = new Date(startMs + 3 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const schedule = launch({
      event_id: 'horizon',
      name: 'Horizon',
      site: { name: 'Coast', lat: 28.5, lon: -80.6 },
      reason_codes: ['TIME_PRECISION_COARSE'],
      launch_window: { net, start: net, end, precision: 'Hour' },
    });
    const catalog = selectAllLaunches(state([schedule]), startMs + 60_000);
    const aims: IssAim[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: (frame, received) => ({
        ready: () => Promise.resolve(),
        aim: (aim) => {
          aims.push(aim);
          return Promise.resolve();
        },
        showLaunches(sites) {
          frame.querySelectorAll('.iss-launch-pin, [data-iss-launch-edge]').forEach((node) => node.remove());
          for (const site of sites) {
            const pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'iss-launch-pin';
            pin.addEventListener('click', () => received.onLaunchLook?.(site.eventId));
            const edge = document.createElement('button');
            edge.type = 'button';
            edge.dataset.issLaunchEdge = site.eventId;
            edge.addEventListener('click', () => received.onLaunchLook?.(site.eventId));
            frame.append(pin, edge);
          }
        },
        resize: () => {},
        destroy: () => {},
      }),
      drive: 'manual',
      session: { mode: 'horizon' },
      launches: () => [],
      allLaunches: () => catalog,
    });
    scene.update(shot());
    await settle();
    await scene.paint();
    const picker = host.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) throw new Error('missing picker');
    picker.value = 'all:horizon';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    const card = host.querySelector('[data-iss-launch-card]');
    expect(card?.getAttribute('data-iss-launch-group')).toBe('all');
    expect(card?.querySelector('[data-iss-launch-name]')?.textContent).toBe('Horizon');
    const beforePin = aims.at(-1)?.pose.targetLatDeg;
    host.querySelector<HTMLButtonElement>('.iss-launch-pin')?.click();
    await settle();
    await scene.paint();
    expect(aims.at(-1)?.pose.targetLatDeg).not.toBe(beforePin);
    expect(card?.querySelector('[data-iss-launch-name]')?.textContent).toBe('Horizon');
    expect(picker.value).toBe('all:horizon');
    const beforeEdge = aims.at(-1)?.pose.targetLatDeg;
    host.querySelector<HTMLButtonElement>('[data-iss-launch-edge]')?.click();
    await settle();
    await scene.paint();
    expect(aims.at(-1)?.pose.targetLatDeg).not.toBe(beforeEdge);
    expect(card?.querySelector('[data-iss-launch-name]')?.textContent).toBe('Horizon');
    expect(host.querySelector('[data-iss-launch]')?.getAttribute('data-iss-launch')).toBe('horizon');
    scene.dispose();
    host.remove();
  });

  it('keeps a stale chance pick unchanged and still draws an All launches pick', async () => {
    const chance = launch({
      event_id: 'crew',
      name: 'Crew',
      assessment: assessment({ checked_at: iso(1) }),
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
      launch_window: { net: iso(10), start: iso(10), end: iso(97), precision: 'Minute' },
      sources: [{ kind: 'schedule', url: 'https://example.org/launch', fetched_at: iso(1) }],
    });
    const schedule = launch({
      event_id: 'horizon',
      name: 'Horizon',
      site: { name: 'Coast', lat: 34.6, lon: -120.6 },
      reason_codes: ['TIME_PRECISION_COARSE'],
      launch_window: { net: iso(20), start: iso(20), end: iso(80), precision: 'Hour' },
    });
    const body = await envelope(artifact([chance, schedule], { revision: 'r-stale', generated_at: iso(1) }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      return new Response(path.includes('launch/latest.json') ? JSON.stringify(body.pointer) : body.body);
    }));
    const host = document.createElement('div');
    document.body.append(host);
    try {
      await launchStore.refresh();
      const scene = mountIssScene(host, {
        nowMs: () => NOW + 2 * 60_000,
        createRenderer: () => ({
          ready: () => Promise.resolve(),
          aim: () => Promise.resolve(),
          showLaunches() {},
          resize: () => {},
          destroy: () => {},
        }),
        drive: 'manual',
        session: { mode: 'horizon' },
      });
      scene.update(shot());
      await settle();
      await scene.paint();
      const picker = host.querySelector('[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement)) throw new Error('missing picker');
      picker.value = 'crew';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await scene.paint();
      expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Crew');
      expect(host.querySelector('[data-iss-launch]')?.getAttribute('data-iss-launch')).toBe('crew');
      await launchStore.refresh(false);
      await settle();
      await scene.paint();
      expect(launchStore.getState().availability).toBe('offline');
      expect(picker.value).toBe('crew');
      expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Crew');
      expect(host.querySelector('[data-iss-launch]')?.getAttribute('data-iss-launch')).toBe('crew');
      expect(host.querySelector('[data-iss-launch-card]')?.hasAttribute('hidden')).toBe(false);
      picker.value = 'all:horizon';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await scene.paint();
      const card = host.querySelector('[data-iss-launch-card]');
      expect(card?.getAttribute('data-iss-launch-group')).toBe('all');
      expect(card?.querySelector('[data-iss-launch-name]')?.textContent).toBe('Horizon');
      expect(card?.hasAttribute('hidden')).toBe(false);
      expect(host.querySelector('[data-iss-launch]')?.getAttribute('data-iss-launch')).toBe('horizon');
      scene.dispose();
    } finally {
      vi.unstubAllGlobals();
      host.remove();
    }
  });

  it('clears a schema 2 chance when an empty schema 3 catalog is accepted', async () => {
    const shown: LaunchSite[][] = [];
    const chance = launch({
      event_id: 'crew',
      name: 'Crew',
      assessment: assessment({ checked_at: iso(2) }),
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
      launch_window: { net: iso(10), start: iso(10), end: iso(97), precision: 'Minute' },
      sources: [{ kind: 'schedule', url: 'https://example.org/launch', fetched_at: iso(2) }],
    });
    const current = await envelope(artifact([chance], { revision: 'r-v2-chance', generated_at: iso(2) }));
    const empty = await envelope(catalog([], { revision: 'r-v3-empty', generated_at: iso(3) }));
    let phase: 'v2' | 'v3' = 'v2';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const body = phase === 'v2' ? current : empty;
      return new Response(path.includes('launch/latest.json') ? JSON.stringify(body.pointer) : body.body);
    }));
    const host = document.createElement('div');
    document.body.append(host);
    try {
      await launchStore.refresh();
      const scene = mountIssScene(host, {
        nowMs: () => NOW + 2 * 60_000,
        createRenderer: () => ({
          ready: () => Promise.resolve(),
          aim: () => Promise.resolve(),
          showLaunches(sites) {
            shown.push([...sites]);
          },
          resize: () => {},
          destroy: () => {},
        }),
        drive: 'manual',
        session: { mode: 'horizon' },
      });
      scene.update(shot());
      await settle();
      await scene.paint();
      const picker = host.querySelector('[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement)) throw new Error('missing picker');
      picker.value = 'crew';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await scene.paint();
      expect(picker.value).toBe('crew');
      expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Crew');
      expect(host.querySelector('[data-iss-launch]')?.getAttribute('data-iss-launch')).toBe('crew');
      expect(shown.at(-1)?.map((site) => site.eventId)).toEqual(['crew']);
      phase = 'v3';
      await launchStore.refresh();
      await settle();
      await scene.paint();
      expect(launchStore.getState().artifact?.schema_version).toBe(3);
      expect(launchStore.getState().availability).toBe('ready');
      expect(picker.value).toBe('');
      expect(host.querySelector('[data-iss-launch-name]')).toBeNull();
      expect(host.querySelector('[data-iss-launch-missing]')?.textContent).toBe('Selected launch is no longer available');
      expect(host.querySelector('[data-iss-launch]')).toBeNull();
      expect(host.querySelector('[data-iss-launches]')?.hasAttribute('hidden')).toBe(true);
      expect(shown.at(-1)).toEqual([]);
      scene.dispose();
    } finally {
      vi.unstubAllGlobals();
      host.remove();
    }
  });

  it('keeps a schema 2 chance when a schema 3 body fails and the last good copy remains', async () => {
    const shown: LaunchSite[][] = [];
    const chance = launch({
      event_id: 'crew',
      name: 'Crew',
      assessment: assessment({ checked_at: iso(4) }),
      site: { name: 'Cape Canaveral', lat: 28.5, lon: -80.6 },
      launch_window: { net: iso(10), start: iso(10), end: iso(97), precision: 'Minute' },
      sources: [{ kind: 'schedule', url: 'https://example.org/launch', fetched_at: iso(4) }],
    });
    const current = await envelope(artifact([chance], { revision: 'r-v2-kept', generated_at: iso(4) }));
    const broken = await envelope(catalog([], { revision: 'r-v3-bad', generated_at: iso(5) }));
    broken.body += ' ';
    let phase: 'v2' | 'bad' = 'v2';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const body = phase === 'v2' ? current : broken;
      return new Response(path.includes('launch/latest.json') ? JSON.stringify(body.pointer) : body.body);
    }));
    const host = document.createElement('div');
    document.body.append(host);
    try {
      await launchStore.refresh();
      const scene = mountIssScene(host, {
        nowMs: () => NOW + 4 * 60_000,
        createRenderer: () => ({
          ready: () => Promise.resolve(),
          aim: () => Promise.resolve(),
          showLaunches(sites) {
            shown.push([...sites]);
          },
          resize: () => {},
          destroy: () => {},
        }),
        drive: 'manual',
        session: { mode: 'horizon' },
      });
      scene.update(shot());
      await settle();
      await scene.paint();
      const picker = host.querySelector('[data-iss-launch-picker]');
      if (!(picker instanceof HTMLSelectElement)) throw new Error('missing picker');
      picker.value = 'crew';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await scene.paint();
      expect(shown.at(-1)?.map((site) => site.eventId)).toEqual(['crew']);
      phase = 'bad';
      await launchStore.refresh();
      await settle();
      await scene.paint();
      expect(launchStore.getState().availability).toBe('last-good');
      expect(launchStore.getState().artifact?.schema_version).toBe(2);
      expect(picker.value).toBe('crew');
      expect(host.querySelector('[data-iss-launch-name]')?.textContent).toBe('Crew');
      expect(host.querySelector('[data-iss-launch]')?.getAttribute('data-iss-launch')).toBe('crew');
      expect(shown.at(-1)?.map((site) => site.eventId)).toEqual(['crew']);
      scene.dispose();
    } finally {
      vi.unstubAllGlobals();
      host.remove();
    }
  });
});

function selection(item: LaunchOpportunity): LaunchSelection {
  return { item, interval: item.capture_intervals[0] ?? null, expired: false };
}

async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
}
