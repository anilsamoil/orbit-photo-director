import { fetchSatelliteTLE, metaKey, type SatelliteMeta, type TLEPair } from '../../../satellites';
import { satTrackLayerId, satTrackSourceId } from '../../map-core/catalog';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import type { MarkerHandle } from '../../map-core/vendor-map';
import { markerElement, orbitOf, orbitTrackFeatures, subPointAt, trackLayer } from './layers';
import { bindPicker, type AddResult } from './picker';
import { metaForKey, persistSelectedKeys, readSelectedKeys } from './selection';

const TRACK_REFRESH_MS = 60_000;
const MARKER_REFRESH_MS = 1_000;

interface Tracked {
  meta: SatelliteMeta;
  tle: TLEPair;
  matchCount: number;
  stale: boolean;
  marker: MarkerHandle | null;
}

/** Every satellite the operator tracks beyond the ISS: a dashed one-orbit
 *  track from the view instant and a marker at its sub-point, both on the
 *  map's one clock. Live, the marker ticks at 1 Hz and the window slides
 *  every minute; scrubbed, both sit at the view instant. */
export const satellites: MapFeature = {
  id: 'satellites',
  mount(core: MapCore) {
    const tracked = new Map<string, Tracked>();

    const publish = (): void => {
      core.setSatellites([...tracked.values()].map(({ meta, tle }) => ({
        name: meta.name,
        label: meta.short_label,
        color: meta.track_color,
        track: orbitOf(tle),
      })));
    };

    const paintTracks = (): void => {
      const fromMs = core.clock.viewMs();
      for (const [key, { meta, tle }] of tracked) {
        core.setGeoJson(satTrackSourceId(key), { type: 'FeatureCollection', features: orbitTrackFeatures(tle, fromMs) });
        core.ensureLayer(trackLayer(key, meta.track_color));
      }
    };

    const placeMarkers = (): void => {
      const atMs = core.clock.viewMs();
      for (const sat of tracked.values()) {
        const at = subPointAt(sat.tle, atMs);
        if (!at) continue;
        if (sat.marker) sat.marker.setLngLat(at);
        else sat.marker = core.addMarker(markerElement(sat.meta), at);
      }
    };

    const add = async (meta: SatelliteMeta): Promise<AddResult> => {
      const key = metaKey(meta);
      if (tracked.has(key)) return { ok: true, message: 'Already tracking' };
      const result = await fetchSatelliteTLE(meta);
      if (!result) {
        return {
          ok: false,
          message: meta.resolution.kind === 'name'
            ? `No satellite found for "${meta.resolution.query}"`
            : `Couldn't fetch TLE for NORAD ${meta.resolution.catnr}`,
        };
      }
      tracked.set(key, { meta, tle: result.tle, matchCount: result.match_count, stale: result.stale, marker: null });
      publish();
      paintTracks();
      placeMarkers();
      persistSelectedKeys(tracked.keys());
      return { ok: true, message: 'Tracking added' };
    };

    const remove = (key: string): void => {
      const sat = tracked.get(key);
      if (!sat) return;
      sat.marker?.remove();
      core.removeLayer(satTrackLayerId(key));
      core.removeSource(satTrackSourceId(key));
      tracked.delete(key);
      publish();
      persistSelectedKeys(tracked.keys());
    };

    bindPicker({
      tracked: (key) => tracked.get(key),
      add,
      remove,
      resize: () => core.resize(),
    });

    void (async () => {
      for (const key of readSelectedKeys()) {
        const meta = metaForKey(key);
        if (meta) await add(meta);
      }
    })();

    core.clock.every(TRACK_REFRESH_MS, () => {
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
