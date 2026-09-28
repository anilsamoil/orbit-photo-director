import { satTrackLayerId, satTrackSourceId } from '../../map-core/catalog';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import type { MarkerHandle } from '../../map-core/vendor-map';
import {
  UNPUBLISHED_TRACKED,
  statusText,
  type TrackedElements,
  type TrackedRecord,
} from '../../../tracked';
import { markerElement, subPointAt, trackedOrbitFeatures, trackedTrackLayer } from './layers';

const TRACK_REFRESH_MS = 60_000;
const MARKER_REFRESH_MS = 1_000;

interface Drawn {
  marker: MarkerHandle;
  element: HTMLElement;
}

const runtime: {
  records: readonly TrackedRecord[];
  markers: Map<string, Drawn>;
} = {
  records: UNPUBLISHED_TRACKED,
  markers: new Map(),
};

function isElements(record: TrackedRecord): record is TrackedElements {
  return record.state === 'elements';
}

function writeLegend(records: readonly TrackedRecord[]): void {
  const node = document.getElementById('tracked-legend-text');
  if (!node) return;
  node.textContent = records.map(statusText).join(' / ');
}

function liveRecords(): TrackedElements[] {
  return runtime.records.filter(isElements);
}

function dropStale(core: MapCore, live: readonly TrackedElements[]): void {
  const ids = new Set(live.map((record) => record.id));
  for (const [id, drawn] of runtime.markers) {
    if (ids.has(id)) continue;
    drawn.marker.remove();
    core.removeLayer(satTrackLayerId(id));
    core.removeSource(satTrackSourceId(id));
    runtime.markers.delete(id);
  }
}

function paintTracks(core: MapCore, live: readonly TrackedElements[]): void {
  const fromMs = core.clock.viewMs();
  for (const record of live) {
    core.setGeoJson(satTrackSourceId(record.id), {
      type: 'FeatureCollection',
      features: trackedOrbitFeatures(record.line1, record.line2, fromMs),
    });
    core.ensureLayer(trackedTrackLayer(record.id, record.color));
  }
}

function placeMarkers(core: MapCore, live: readonly TrackedElements[]): void {
  const atMs = core.clock.viewMs();
  for (const record of live) {
    const at = subPointAt(record.line1, record.line2, atMs);
    if (!at) continue;
    const drawn = runtime.markers.get(record.id);
    if (drawn) {
      drawn.element.title = statusText(record);
      drawn.marker.setLngLat(at);
    } else {
      const element = markerElement(record);
      runtime.markers.set(record.id, { marker: core.addMarker(element, at), element });
    }
  }
}

function paint(core: MapCore): void {
  const live = liveRecords();
  dropStale(core, live);
  paintTracks(core, live);
  placeMarkers(core, live);
  writeLegend(runtime.records);
}

/** Replace the tracked vehicles and redraw. Safe before `mount`. */
export function applyTracked(core: MapCore, records: readonly TrackedRecord[]): void {
  runtime.records = records;
  paint(core);
}

/** Starship and any later extra vehicle from `tracked.json`. A row with
 *  elements gets a marker and one ground-track orbit. A row without
 *  elements is legend text only. */
export const tracked: MapFeature = {
  id: 'tracked',
  mount(core) {
    core.clock.every(TRACK_REFRESH_MS, () => {
      if (!core.clock.isScrubbed()) paintTracks(core, liveRecords());
    });
    core.clock.every(MARKER_REFRESH_MS, () => {
      if (!core.clock.isScrubbed()) placeMarkers(core, liveRecords());
    });
    core.clock.onViewTime(() => {
      paint(core);
    });
    paint(core);
  },
};
