import { afterEach, expect, it, vi } from 'vitest';

import { launchCatalog } from '../src/launch-catalog';
import { parseHazardBundle } from '../src/launch-hazards';
import { setMapLaunchMode } from '../src/map-launch-mode';
import { openTierDetails, renderTierCard } from '../src/launch-tier-card';
import type { TierCatalog, TierLaunch } from '../src/launch-tiers';
import {
  bindAscentPad,
  noteLaunchCore,
  resetLaunchForTest,
  syncLaunchHazards,
  useHazardBundleForTest,
} from '../src/map/features/launch-corridor';
import { createClock } from '../src/map/map-core/clock';
import { createMapCore } from '../src/map/map-core/core';
import capturedHazards from './fixtures/hazards-v2-2026-11-13.json' with { type: 'json' };
import { createVendorDouble } from './vendor-map-double';

const NOW = Date.parse('2026-11-13T22:50:00Z');
const START = Date.parse('2026-11-13T22:45:00Z');
const END = Date.parse('2026-11-14T00:00:00Z');
const EVENT_ID = '0f867f0c-5422-4d44-93b8-d7faaae7019b';
const PIN: TierLaunch = {
  eventId: EVENT_ID,
  revision: 'instruction-inventory',
  name: 'Starship Flight 15',
  rocket: 'Starship',
  site: { name: 'Starbase', lat: 25.99677, lon: -97.15799, pad: null },
  tier: 'watch',
  why: 'Watch',
  reasons: [],
  schedule: { netMs: START, windowStartMs: START, windowEndMs: END, precision: 'Minute', status: 'TBC' },
  direction: { kind: 'none' },
  ascent: null,
  shots: [],
  top: null,
  corridor: null,
  whenMs: START,
  liveUntilMs: END,
};

afterEach(() => {
  document.querySelector<HTMLDialogElement>('.launch-dialog')?.close();
  resetLaunchForTest();
  setMapLaunchMode(false);
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('renders four complete 400-character warnings and a complete listing in the card and details popup', () => {
  const instructions = ['A', 'B', 'C', 'D'].map((letter) => letter.repeat(400));
  const listing = 'L'.repeat(400);
  const captured = capturedHazards.launches.find((entry) => entry.event_id === EVENT_ID);
  const notice = captured?.notices.find((row) => row.restriction_class === 'high_risk');
  const feature = captured?.geojson.features.find((row) => row.properties.area_id === notice?.area_id);
  if (!captured || !notice || !feature) throw new Error('missing captured high-risk area');
  const bundle = parseHazardBundle({
    ...capturedHazards,
    launches: [{
      ...captured,
      notices: [{ ...notice, instructions }],
      geojson: { type: 'FeatureCollection', features: [feature] },
      listed: [{
        authority: 'USCG',
        notice_id: 'USCG LNM 58296',
        reason: 'not_drawn',
        text: listing,
        checked_at: notice.checked_at,
        valid_until: notice.valid_until,
        source_url: notice.source_url,
        source_sha256: notice.source_sha256,
      }],
    }],
  });
  if (!bundle) throw new Error('complete maximum-length hazard bundle failed validation');
  const catalog = {
    revision: PIN.revision,
    pins: [],
    mapPins: [PIN],
    upcoming: [],
    highlights: [],
    groups: { shot: [], likely: [], watch: [PIN] },
    all: [PIN],
    closedLabel: '',
    find: (eventId: string) => eventId === EVENT_ID ? PIN : null,
  } satisfies TierCatalog;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(launchCatalog, 'read').mockReturnValue(catalog);
  vi.spyOn(launchCatalog, 'attempt').mockReturnValue({ startMs: START, endMs: END });
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
  const vendor = createVendorDouble();
  const core = createMapCore(vendor, createClock(() => NOW));
  noteLaunchCore(core);
  bindAscentPad(core);
  useHazardBundleForTest(bundle);
  setMapLaunchMode(true);
  syncLaunchHazards(NOW);

  const card = renderTierCard(PIN, () => {});
  openTierDetails(PIN);
  const dialog = document.querySelector('.launch-dialog');
  expect(dialog).not.toBeNull();
  for (const content of [card.textContent, dialog?.textContent]) {
    for (const instruction of instructions) expect(content).toContain(instruction);
    expect(content).toContain(listing);
    expect(content).toContain('high_risk');
  }

  const source = vendor.sources.get('launch-hazards');
  if (!source || source.type !== 'geojson' || typeof source.data === 'string') {
    throw new Error('missing painted hazard source');
  }
  const painted = source.data.features[0];
  if (!painted) throw new Error('missing painted high-risk area');
  vendor.fireLayer('click', 'launch-hazard-fill-layer', {
    point: { x: 2, y: 2 },
    lngLat: [-97.1, 26],
    features: [{ properties: painted.properties, geometry: painted.geometry }],
  });
  const popup = vendor.popups.at(-1);
  expect(popup).toBeDefined();
  for (const instruction of instructions) expect(popup?.content.textContent).toContain(instruction);
  expect(popup?.content.textContent).toContain('high_risk');
});
