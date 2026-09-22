import { wrapLon } from '../../../geo';
import { legacyLaunchInHorizon, selectLaunches } from '../../../launch-selectors';
import type { LaunchState } from '../../../launch-store';
import type { PassEntry } from '../../../types';

/** Pad pins for legacy launch rows. Corridor lines are not derived from these rows. */
export function buildAscentFeatures(passes: PassEntry[]): {
  lines: GeoJSON.Feature[];
  pads: GeoJSON.Feature[];
} {
  const lines: GeoJSON.Feature[] = [];
  const pads: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const pass of passes) {
    if (!pass.launch) continue;
    const key = `${pass.launch.name}|${pass.launch.t0}`;
    if (seen.has(key)) continue;
    const lat = pass.launch.pad_lat ?? pass.target_lat;
    const lon = pass.launch.pad_lon ?? pass.target_lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    seen.add(key);
    pads.push({
      type: 'Feature' as const,
      properties: {
        target_id: pass.target_id,
        label: 'LAUNCH / MAP ONLY',
        launch_name: pass.launch?.name ?? '',
        site_name: pass.launch?.site_name ?? '',
        t0: pass.launch?.t0 ?? '',
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [lon, lat],
      },
    });
  }
  return { lines, pads };
}

/** Pads and supplied corridors for the current launch artifact. */
export function buildLaunchMapFeatures(launchState: LaunchState, now: number): { lines: GeoJSON.Feature[]; pads: GeoJSON.Feature[] } {
  const lines: GeoJSON.Feature[] = [];
  const pads: GeoJSON.Feature[] = [];
  for (const { item } of selectLaunches(launchState, now, 'map')) {
    const properties = {
      event_id: item.event_id,
      revision: item.revision,
      artifact_revision: launchState.artifact!.revision,
      label: `LAUNCH / ${item.status === 'map_only' ? 'MAP ONLY' : 'ASCENT'}`,
      launch_name: item.name,
    };
    pads.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [item.site.lon, item.site.lat] } });
    const trajectory = item.trajectory;
    if (trajectory.quality === 'unknown' || !trajectory.source || trajectory.points.length < 2) continue;
    const segments: GeoJSON.Feature[] = [];
    for (let i = 1; i < trajectory.points.length; i++) {
      const start = trajectory.points[i - 1]!;
      const end = trajectory.points[i]!;
      const lon = start.lon + wrapLon(end.lon - start.lon);
      for (const offset of [-360, 0, 360]) {
        segments.push({
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [[start.lon + offset, start.lat], [lon + offset, end.lat]],
          },
        });
      }
    }
    for (const segment of segments) segment.properties = { ...properties, quality: trajectory.quality };
    lines.push(...segments);
  }
  return { lines, pads };
}

export function legacyPassesInHorizon(passes: PassEntry[], now: number): PassEntry[] {
  return passes.filter((pass) => legacyLaunchInHorizon(pass, now, 7 * 24 * 3600_000));
}
