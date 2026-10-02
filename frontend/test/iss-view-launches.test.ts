import { describe, expect, it } from 'vitest';

import { mountIssScene } from '../src/iss-view';
import {
  launchCorridorLines,
  launchSites,
  lookArrowDeg,
  lookNudge,
  placeLaunchMarks,
  siteOnDisk,
  type LaunchSite,
} from '../src/iss-view/launches';
import type { IssAim, IssRendererFactory } from '../src/iss-view/renderer';
import type { SceneSnapshot } from '../src/iss-view/model';
import type { Track } from '../src/types';

import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };
import { NOW, assessment, iso, launch, state, supported } from './launch-fixtures';

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

  it('puts a look control beside Telemetry and moves the aim when it is pressed', async () => {
    const aims: IssAim[] = [];
    const factory: IssRendererFactory = () => ({
      ready: () => Promise.resolve(),
      aim: (aim) => {
        aims.push(aim);
        return Promise.resolve();
      },
      resize: () => {},
      destroy: () => {},
    });
    const host = document.createElement('div');
    const scene = mountIssScene(host, {
      nowMs: () => startMs + 60_000,
      createRenderer: factory,
      drive: 'manual',
      session: { mode: 'horizon' },
      launches: () => [cape],
    });
    const button = host.querySelector('[data-iss-launch]') as HTMLButtonElement | null;
    const telemetry = host.querySelector('[data-iss-telemetry]');
    expect(button?.textContent).toContain('Cape Canaveral');
    expect(button?.closest('[data-iss-controls]')?.contains(telemetry)).toBe(true);
    expect(host.querySelector('[data-iss-launches]')?.hasAttribute('hidden')).toBe(false);
    scene.update(shot());
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
    await scene.paint();
    const before = aims.at(-1)?.pose.targetLatDeg;
    button?.click();
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    await scene.paint();
    const arrow = host.querySelector('[data-iss-launch-arrow]') as HTMLElement | null;
    expect(arrow?.style.getPropertyValue('--iss-launch-aim')).toMatch(/-?\d+\.\d+deg/);
    expect(aims.at(-1)?.pose.targetLatDeg).not.toBe(before);
    scene.dispose();
  });
});
