import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountIssScene } from '../src/iss-view';
import type { IssRenderer } from '../src/iss-view/renderer';
import type { SceneSnapshot } from '../src/iss-view/model';
import type { Track } from '../src/types';
import { launchCatalog } from '../src/launch-catalog';
import type { LaunchCatalogItem } from '../src/launch-schema';
import { catalog, catalogItem } from './launch-fixtures';
import fixtureRaw from './fixtures/iss-sgp4-fixture.json' with { type: 'json' };

const fixture = fixtureRaw as {
  tle: { line1: string; line2: string };
  start: string;
  iss_polynomial: Track['iss_polynomial'];
};

function shot(): SceneSnapshot {
  return {
    manifestVersion: 'm1',
    generatedAtMs: Date.parse(fixture.start),
    track: {
      iss_polynomial: fixture.iss_polynomial,
      tle: fixture.tle,
      tle_epoch: '2024-10-16T18:58:11.999Z',
      tle_age_hours: 17,
      tle_freshness_factor: 1,
    },
  };
}

const hosts: HTMLElement[] = [];

afterEach(() => {
  for (const host of hosts) host.remove();
  hosts.length = 0;
  vi.unstubAllGlobals();
});

const viewMs = Date.parse(fixture.start) + 60_000;
const at = (minutes: number) => new Date(Date.parse(fixture.start) + minutes * 60_000).toISOString();

async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
}

async function selectedWindow(item: LaunchCatalogItem): Promise<string> {
  const body = catalog([item], {
    generated_at: at(-5),
    geometry_valid_until: at(10),
    schedule_valid_until: at(70),
  });
  const text = JSON.stringify(body);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const pointer = {
    schema_version: 2,
    revision: body.revision,
    generated_at: body.generated_at,
    valid_until: body.geometry_valid_until,
    path: `launch/catalog/v/${body.revision}.json`,
    sha256,
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (path === '/launch/catalog/latest.json') {
      return new Response(JSON.stringify(pointer), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === `/${pointer.path}`) {
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('missing', { status: 404 });
  }));
  await launchCatalog.refresh(true);
  if (!launchCatalog.read(viewMs)?.find(item.event_id)) throw new Error('catalog did not hold the launch');
  const host = document.createElement('div');
  hosts.push(host);
  document.body.append(host);
  const renderer: IssRenderer = {
    ready: () => Promise.resolve(),
    aim: () => Promise.resolve(),
    showLaunches() {},
    resize() {},
    destroy() {},
  };
  const scene = mountIssScene(host, {
    nowMs: () => viewMs,
    createRenderer: () => renderer,
    drive: 'manual',
    session: { mode: 'horizon' },
  });
  try {
    scene.update(shot());
    await settle();
    await scene.paint();
    const picker = host.querySelector('[data-iss-launch-picker]');
    if (!(picker instanceof HTMLSelectElement)) throw new Error('missing picker');
    picker.value = item.event_id;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await scene.paint();
    return host.querySelector('[data-iss-launch-time-value]')?.textContent ?? '';
  } finally {
    scene.dispose();
  }
}

describe('ISS tier window', () => {
  it('shows both endpoints of a nonzero launch window', async () => {
    const text = await selectedWindow(catalogItem({
      event_id: 'same-day',
      name: 'Same day',
      tier: 'shot',
      schedule: {
        net: at(10),
        window_start: at(10),
        window_end: at(20),
        precision: 'Second',
        status: 'Go',
        destination: 'ISS',
      },
    }));
    expect(text).toBe('17 Oct 2024, 12:10:00–12:20:00 UTC');
  });

  it('shows both dates when the launch window crosses midnight', async () => {
    const text = await selectedWindow(catalogItem({
      event_id: 'cross-day',
      name: 'Cross day',
      tier: 'shot',
      schedule: {
        net: at(11 * 60 + 30),
        window_start: at(11 * 60 + 30),
        window_end: at(12 * 60 + 30),
        precision: 'Second',
        status: 'Go',
        destination: 'ISS',
      },
    }));
    expect(text).toBe('17 Oct 2024, 23:30:00 UTC – 18 Oct 2024, 00:30:00 UTC');
  });
});
