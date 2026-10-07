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

const viewMs = Date.parse(fixture.start) + 60_000;
const at = (minutes: number) => new Date(Date.parse(fixture.start) + minutes * 60_000).toISOString();
const ORIGINAL = [
  { lat: 28.5, lon: -80.6 },
  { lat: 28.6, lon: -80.5 },
];
const MOVED = [
  { lat: 28.5, lon: -80.6 },
  { lat: 30, lon: -75 },
];

let stamp = Date.parse(fixture.start) - 5 * 60_000;
let serial = 0;
const scenes: { dispose(): void }[] = [];
const hosts: HTMLElement[] = [];

function nextStamp(): string {
  stamp += 1000;
  return new Date(stamp).toISOString();
}

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

function liveItem(over: Partial<LaunchCatalogItem> = {}): LaunchCatalogItem {
  return catalogItem({
    event_id: 'retained',
    tier: 'shot',
    name: 'Retained event',
    schedule: {
      net: at(10),
      window_start: at(10),
      window_end: at(20),
      precision: 'Second',
      status: 'Go',
      destination: 'ISS',
    },
    ...over,
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

async function pack(items: LaunchCatalogItem[], name: string): Promise<{ text: string; pointer: Record<string, unknown> }> {
  serial += 1;
  const generated_at = nextStamp();
  const generatedMs = Date.parse(generated_at);
  const body = catalog(items, {
    revision: `${name}-${serial}`,
    generated_at,
    geometry_valid_until: new Date(generatedMs + 10 * 60_000).toISOString(),
    schedule_valid_until: new Date(generatedMs + 70 * 60_000).toISOString(),
  });
  const text = JSON.stringify(body);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    text,
    pointer: {
      schema_version: 2,
      revision: body.revision,
      generated_at: body.generated_at,
      valid_until: body.geometry_valid_until,
      path: `launch/catalog/v/${body.revision}.json`,
      sha256,
    },
  };
}

function install(pointer: Record<string, unknown>, body: () => Promise<Response> | Response): void {
  const path = `/${String(pointer.path)}`;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const request = requestPath(input);
    if (request === '/launch/catalog/latest.json') {
      return new Response(JSON.stringify(pointer), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (request === path) return await body();
    return new Response('missing', { status: 404 });
  }));
}

async function publish(items: LaunchCatalogItem[], name: string): Promise<void> {
  const packed = await pack(items, name);
  install(packed.pointer, () => new Response(packed.text, { status: 200, headers: { 'content-type': 'application/json' } }));
  await launchCatalog.refresh(true);
}

async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
}

type Drawn = { eventId: string; corridor: { lat: number; lon: number }[] | null };

async function openScene(): Promise<{
  scene: ReturnType<typeof mountIssScene>;
  picker: HTMLSelectElement;
  card: HTMLElement;
  drawn: Drawn[][];
}> {
  const host = document.createElement('div');
  hosts.push(host);
  document.body.append(host);
  const drawn: Drawn[][] = [];
  const renderer: IssRenderer = {
    ready: () => Promise.resolve(),
    aim: () => Promise.resolve(),
    showLaunches(sites) {
      drawn.push(sites.map((site) => ({
        eventId: site.eventId,
        corridor: site.corridor ? site.corridor.map((point) => ({ lat: point.lat, lon: point.lon })) : null,
      })));
    },
    resize() {},
    destroy() {},
  };
  const scene = mountIssScene(host, {
    nowMs: () => viewMs,
    createRenderer: () => renderer,
    drive: 'manual',
    session: { mode: 'horizon' },
  });
  scenes.push(scene);
  scene.update(shot());
  await settle();
  await scene.paint();
  const picker = host.querySelector('[data-iss-launch-picker]');
  const card = host.querySelector('[data-iss-launch-card]');
  if (!(picker instanceof HTMLSelectElement) || !(card instanceof HTMLElement)) throw new Error('missing launch chrome');
  return { scene, picker, card, drawn };
}

async function choose(scene: ReturnType<typeof mountIssScene>, picker: HTMLSelectElement, value: string): Promise<void> {
  picker.value = value;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  await scene.paint();
}

function moved(item: LaunchCatalogItem): LaunchCatalogItem {
  return {
    ...item,
    shots: item.shots.map((entry) => (entry.subject === 'ascent'
      ? { ...entry, track: [
        { t_offset_s: 0, lat: 28.5, lon: -80.6, alt_km: 0 },
        { t_offset_s: 40, lat: 30, lon: -75, alt_km: 20 },
      ] }
      : entry)),
  };
}

afterEach(() => {
  for (const scene of scenes) scene.dispose();
  scenes.length = 0;
  for (const host of hosts) host.remove();
  hosts.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ISS catalog selection retention', () => {
  it('retains the selected ISS event after a newer catalog revision settles', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(viewMs);
    const item = liveItem();
    await publish([item], 'same');
    const { scene, picker, card, drawn } = await openScene();
    await choose(scene, picker, 'retained');
    expect(picker.value).toBe('retained');
    expect(card.hidden).toBe(false);
    expect(drawn.at(-1)).toEqual([{ eventId: 'retained', corridor: ORIGINAL }]);

    const next = await pack([item], 'same-next');
    let release!: (response: Response) => void;
    let bodySeen = false;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    install(next.pointer, () => {
      bodySeen = true;
      return gate;
    });
    const pending = launchCatalog.refresh(true);
    try {
      await vi.waitFor(() => { expect(bodySeen).toBe(true); });
      expect(card.hidden).toBe(true);
      expect(drawn.at(-1)).toEqual([]);
      release(new Response(next.text, { status: 200, headers: { 'content-type': 'application/json' } }));
      await pending;
      await settle();
      await scene.paint();
      expect(picker.value).toBe('retained');
      expect(card.hidden).toBe(false);
      expect(card.querySelector('[data-iss-launch-name]')?.textContent).toBe('Retained event');
      expect(drawn.at(-1)).toEqual([{ eventId: 'retained', corridor: ORIGINAL }]);
    } finally {
      release(new Response('missing', { status: 404 }));
      await pending;
    }
  });

  it('keeps the selected event when the newer body arrives before the first tick', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(viewMs);
    const item = liveItem();
    await publish([item], 'immediate');
    const { scene, picker, card, drawn } = await openScene();
    await choose(scene, picker, 'retained');
    const marked = drawn.length;
    await publish([item], 'immediate-next');
    await settle();
    await scene.paint();
    expect(drawn.slice(marked).some((sites) => sites.length === 0)).toBe(true);
    expect(picker.value).toBe('retained');
    expect(card.hidden).toBe(false);
    expect(drawn.at(-1)).toEqual([{ eventId: 'retained', corridor: ORIGINAL }]);
  });

  it('restores a Shot selection as Likely when the accepted catalog says so', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(viewMs);
    await publish([liveItem()], 'shot');
    const { scene, picker, card, drawn } = await openScene();
    await choose(scene, picker, 'retained');
    await publish([liveItem({
      tier: 'likely',
      name: 'Retained likely',
      schedule: {
        net: at(12),
        window_start: at(12),
        window_end: at(18),
        precision: 'Second',
        status: 'Go',
        destination: 'ISS',
      },
    })], 'likely');
    await settle();
    await scene.paint();
    expect(picker.value).toBe('retained');
    const group = picker.selectedOptions[0]?.parentElement;
    expect(group instanceof HTMLOptGroupElement && group.label).toBe('Likely');
    expect(card.hidden).toBe(false);
    expect(card.dataset.issLaunchState).toBe('selected');
    expect(card.querySelector('[data-iss-launch-name]')?.textContent).toBe('Retained likely');
    expect(card.querySelector('[data-iss-launch-time-value]')?.textContent).toBe('17 Oct 2024, 12:12:00–12:18:00 UTC');
    expect(drawn.at(-1)).toEqual([{ eventId: 'retained', corridor: ORIGINAL }]);
  });

  it('draws the corridor from the accepted catalog', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(viewMs);
    const item = liveItem();
    await publish([item], 'corridor');
    const { scene, picker, card, drawn } = await openScene();
    await choose(scene, picker, 'retained');
    expect(drawn.at(-1)).toEqual([{ eventId: 'retained', corridor: ORIGINAL }]);
    await publish([moved(item)], 'corridor-next');
    await settle();
    await scene.paint();
    expect(picker.value).toBe('retained');
    expect(card.hidden).toBe(false);
    expect(drawn.at(-1)).toEqual([{ eventId: 'retained', corridor: MOVED }]);
  });

  it('clears a selection the accepted catalog removed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(viewMs);
    await publish([liveItem()], 'present');
    const { scene, picker, card, drawn } = await openScene();
    await choose(scene, picker, 'retained');
    await publish([liveItem({ event_id: 'other', name: 'Other event' })], 'removed');
    await settle();
    await scene.paint();
    expect(picker.value).toBe('');
    expect(card.hidden).toBe(false);
    expect(card.dataset.issLaunchState).toBe('missing');
    expect(card.querySelector('[data-iss-launch-missing]')?.textContent).toBe('Selected launch is no longer available');
    expect(drawn.at(-1)).toEqual([]);
  });

  it('clears a Shot selection downgraded to Watch', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(viewMs);
    await publish([liveItem()], 'watch-before');
    const { scene, picker, card, drawn } = await openScene();
    await choose(scene, picker, 'retained');
    await publish([liveItem({ tier: 'watch', name: 'Retained watch' })], 'watch-after');
    await settle();
    await scene.paint();
    expect(picker.value).toBe('');
    expect(picker.selectedOptions[0]?.textContent).not.toContain('Retained watch');
    expect(card.hidden).toBe(false);
    expect(card.dataset.issLaunchState).toBe('missing');
    expect(card.querySelector('[data-iss-launch-missing]')?.textContent).toBe('Selected launch is no longer available');
    expect(drawn.at(-1)).toEqual([]);
  });

  it('hides the card and corridor when the newer body fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(viewMs);
    const item = liveItem();
    await publish([item], 'fail-before');
    const { scene, picker, card, drawn } = await openScene();
    await choose(scene, picker, 'retained');
    const packed = await pack([item], 'fail-body');
    install(packed.pointer, () => new Response('missing', { status: 404 }));
    await launchCatalog.refresh(true);
    await settle();
    await scene.paint();
    expect(card.hidden).toBe(true);
    expect(card.dataset.issLaunchState).not.toBe('selected');
    expect(picker.value).toBe('');
    expect(drawn.at(-1)).toEqual([]);
  });
});
