import { liveIssPositionSGP4 } from '../../../iss-sgp4';
import { issSightWindows, sightText } from '../../../orbit-sight';
import {
  lookupMessage,
  metaKey,
  resolveOrbit,
  type LookupMode,
  type OrbitLookup,
  type SatelliteMeta,
} from '../../../satellites';
import { UNREAD_TRACKED, type TrackedRecord } from '../../../tracked';
import { satTrackLayerId, satTrackSourceId } from '../../map-core/catalog';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import type { MarkerHandle } from '../../map-core/vendor-map';
import { markerElement, orbitOf, orbitTrackFeatures, subPointAt, trackLayer } from './layers';
import { bindPicker, renderPickerList, type AddResult, type PickerPort } from './picker';
import {
  isPublished,
  metaForKey,
  persistSelectedKeys,
  publishedMetas,
  readHiddenPublishedKeys,
  readSelectedKeys,
  setPublishedHidden,
} from './selection';

const TRACK_REFRESH_MS = 60_000;
const MARKER_REFRESH_MS = 1_000;

const runtime: {
  core: MapCore | null;
  published: readonly TrackedRecord[];
  onPublished: (() => void) | null;
} = { core: null, published: UNREAD_TRACKED, onPublished: null };

/** Hand the satellites the rows of `tracked.json`. Safe before `mount`. */
export function applyPublishedOrbits(records: readonly TrackedRecord[]): void {
  runtime.published = records;
  runtime.onPublished?.();
}

/** Live sub-points for the topbar. The topbar stays on the wall clock while the map is scrubbed. */
export function getSatelliteTopbarReadouts(): { label: string; text: string; color: string }[] {
  const core = runtime.core;
  if (!core) return [];
  const nowMs = core.clock.now();
  const out: { label: string; text: string; color: string }[] = [];
  for (const { label, color, track } of core.view().satellites) {
    const pos = liveIssPositionSGP4(track, nowMs);
    if (!pos) continue;
    const ns = pos.lat >= 0 ? 'N' : 'S';
    const ew = pos.lon >= 0 ? 'E' : 'W';
    out.push({
      label,
      text: `${Math.abs(pos.lat).toFixed(1)}°${ns}, ${Math.abs(pos.lon).toFixed(1)}°${ew}`,
      color,
    });
  }
  return out;
}

/** A satellite the operator wants. `lookup` is null while the first lookup
 *  runs. Only an `elements` lookup is drawn. `asked` counts lookups, so an
 *  answer to an earlier one never replaces the answer to a later one.
 *  `asking` is true while a tap's CelesTrak lookup is out; a background
 *  lookup waits for it instead of overriding it. */
interface Wanted {
  meta: SatelliteMeta;
  lookup: OrbitLookup | null;
  marker: MarkerHandle | null;
  asked: number;
  asking: boolean;
}

type Elements = Extract<OrbitLookup, { state: 'elements' }>;

function elementsOf(sat: Wanted): Elements | null {
  return sat.lookup?.state === 'elements' ? sat.lookup : null;
}

/** Every orbit the map shows beyond the ISS, from one list. A satellite the
 *  operator checks, and every vehicle the publisher lists unless unchecked,
 *  gets a one-orbit track from the view instant and a marker at its
 *  sub-point, both on the map's one clock. Live, the marker ticks at 1 Hz
 *  and the window slides every minute; scrubbed, both sit at the view
 *  instant. A wanted satellite with no element set stays wanted and draws
 *  nothing; the picker says why. Every minute each published vehicle is
 *  looked up again from the artifact and the cache, so an element set that
 *  passes its age limit in an open map stops being drawn. */
export const satellites: MapFeature = {
  id: 'satellites',
  mount(core: MapCore) {
    runtime.core = core;
    const wanted = new Map<string, Wanted>();

    const publish = (): void => {
      core.setSatellites([...wanted.values()].flatMap((sat) => {
        const elements = elementsOf(sat);
        if (!elements) return [];
        return [{
          name: sat.meta.name,
          label: sat.meta.short_label,
          color: sat.meta.track_color,
          track: orbitOf(elements.tle),
        }];
      }));
    };

    const erase = (key: string, sat: Wanted): void => {
      sat.marker?.remove();
      sat.marker = null;
      core.removeLayer(satTrackLayerId(key));
      core.removeSource(satTrackSourceId(key));
    };

    const paintTracks = (): void => {
      const fromMs = core.clock.viewMs();
      for (const [key, sat] of wanted) {
        const elements = elementsOf(sat);
        if (!elements) continue;
        core.setGeoJson(satTrackSourceId(key), { type: 'FeatureCollection', features: orbitTrackFeatures(elements.tle, fromMs) });
        core.ensureLayer(trackLayer(sat.meta, key));
      }
    };

    const placeMarkers = (): void => {
      const atMs = core.clock.viewMs();
      for (const sat of wanted.values()) {
        const elements = elementsOf(sat);
        const at = elements ? subPointAt(elements.tle, atMs) : null;
        if (!elements || !at) continue;
        if (sat.marker) sat.marker.setLngLat(at);
        else sat.marker = core.addMarker(markerElement(sat.meta, elements.tle), at);
      }
    };

    const redraw = (): void => {
      for (const [key, sat] of wanted) if (!elementsOf(sat)) erase(key, sat);
      publish();
      paintTracks();
      placeMarkers();
    };

    const persist = (): void => {
      persistSelectedKeys([...wanted].flatMap(([key, { meta }]) => (isPublished(meta) ? [] : [key])));
    };

    const look = async (meta: SatelliteMeta, mode: LookupMode): Promise<OrbitLookup | null> => {
      const key = metaKey(meta);
      const sat = wanted.get(key) ?? { meta, lookup: null, marker: null, asked: 0, asking: false };
      wanted.set(key, sat);
      if (mode === 'published' && sat.asking) return null;
      const turn = ++sat.asked;
      sat.asking = mode === 'ask';
      const lookup = await resolveOrbit(meta, runtime.published, mode, core.clock.now());
      if (wanted.get(key) !== sat || sat.asked !== turn) return null;
      sat.asking = false;
      const before = elementsOf(sat);
      sat.lookup = lookup;
      if (before && lookup.state === 'elements' && before.tle.name !== lookup.tle.name) {
        sat.marker?.remove();
        sat.marker = null;
      }
      redraw();
      return lookup;
    };

    const add = async (meta: SatelliteMeta): Promise<AddResult> => {
      const key = metaKey(meta);
      const already = wanted.get(key);
      if (already && elementsOf(already)) return { ok: true, message: 'Already tracking' };
      if (isPublished(meta)) setPublishedHidden(key, false);
      const lookup = (await look(meta, 'ask')) ?? wanted.get(key)?.lookup;
      persist();
      if (!lookup) return { ok: false, message: `${meta.name}: still looking` };
      return { ok: lookup.state === 'elements', message: lookupMessage(meta, lookup) };
    };

    const publishedTwin = (asked: SatelliteMeta): SatelliteMeta | undefined => {
      const resolution = asked.resolution;
      if (resolution.kind !== 'catnr') return undefined;
      const row = runtime.published.find((record) =>
        (record.state === 'elements' ? record.norad : record.lookup.catnr) === resolution.catnr);
      return row && publishedMetas(runtime.published).find((meta) => metaKey(meta) === `tracked:${row.id}`);
    };

    const remove = (key: string): void => {
      const sat = wanted.get(key);
      if (!sat) return;
      erase(key, sat);
      wanted.delete(key);
      if (isPublished(sat.meta)) setPublishedHidden(key, true);
      publish();
      persist();
    };

    const addTyped = async (asked: SatelliteMeta): Promise<AddResult> => {
      const meta = publishedTwin(asked) ?? asked;
      const key = metaKey(meta);
      const known = wanted.has(key);
      const result = await add(meta);
      if (!result.ok && !known) remove(key);
      return result;
    };

    const port: PickerPort = {
      metas: () => {
        const published = publishedMetas(runtime.published);
        const listed = new Set(published.map(metaKey));
        const typed = [...wanted.values()].map(({ meta }) => meta).filter((meta) => !listed.has(metaKey(meta)));
        return [...published, ...typed];
      },
      row: (key) => {
        const sat = wanted.get(key);
        if (!sat) return undefined;
        const elements = elementsOf(sat);
        const iss = core.view().track;
        const nowMs = core.clock.now();
        const sight = elements && iss ? sightText(issSightWindows(iss, orbitOf(elements.tle), nowMs), nowMs) : null;
        return { lookup: sat.lookup, sight };
      },
      add,
      addTyped,
      remove,
      resize: () => core.resize(),
    };

    const followPublisher = (): void => {
      const hidden = readHiddenPublishedKeys();
      const listed = publishedMetas(runtime.published);
      const keys = new Set(listed.map(metaKey));
      for (const [key, sat] of wanted) {
        if (isPublished(sat.meta) && !keys.has(key)) {
          erase(key, sat);
          wanted.delete(key);
        }
      }
      publish();
      void Promise.all(
        listed.filter((meta) => !hidden.has(metaKey(meta))).map((meta) => look(meta, 'published')),
      ).then(() => renderPickerList(port));
    };

    bindPicker(port);

    void (async () => {
      for (const key of readSelectedKeys()) {
        const meta = metaForKey(key);
        if (meta) await look(meta, 'ask');
      }
    })();
    runtime.onPublished = followPublisher;
    followPublisher();

    const drawnState = (): string =>
      [...wanted].map(([key, sat]) => `${key}=${sat.lookup?.state}:${elementsOf(sat)?.tle.line1}`).join();

    const recheckPublished = (): void => {
      const before = drawnState();
      void Promise.all(
        [...wanted.values()].filter(({ meta }) => isPublished(meta)).map(({ meta }) => look(meta, 'published')),
      ).then(() => {
        if (drawnState() !== before) renderPickerList(port);
      });
    };

    core.clock.every(TRACK_REFRESH_MS, () => {
      recheckPublished();
      if (!core.clock.isScrubbed()) paintTracks();
    });
    core.clock.every(MARKER_REFRESH_MS, () => {
      if (!core.clock.isScrubbed()) placeMarkers();
    });
    core.clock.onViewTime(() => {
      paintTracks();
      placeMarkers();
    });
  },
};
