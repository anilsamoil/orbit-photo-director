import type { CaptureInterval, LaunchArtifact, LaunchOpportunity, LaunchPointer } from '../src/launch-schema';
import type { LaunchState } from '../src/launch-store';

export const NOW = Date.parse('2026-09-07T12:00:00Z');
export const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
export function interval(start = 10, end = 15): CaptureInterval {
  return { start: iso(start), peak: iso((start + end) / 2), end: iso(end), liftoff_start: iso(8), liftoff_end: iso(9),
    look: { frame: 'orbital-lvlh', azimuth_deg: 45, off_nadir_deg: 70 } };
}
export function launch(over: Partial<LaunchOpportunity> = {}): LaunchOpportunity {
  return {
    event_id: 'event-1', revision: 'event-r1', name: 'Test launch', rocket: 'Test rocket',
    site: { name: 'Test site', lat: 28.5, lon: -80.6 }, status: 'map_only', reason_codes: ['TRAJECTORY_UNKNOWN'],
    launch_window: { net: iso(10), start: null, end: null, precision: null }, capture_intervals: [],
    trajectory: { quality: 'unknown', source: null, points: [] },
    sources: [{ kind: 'schedule', url: 'https://example.org/launch', fetched_at: iso(-10) }], ...over,
  };
}
export function supported(over: Partial<LaunchOpportunity> = {}): LaunchOpportunity {
  return launch({ status: 'geometry_supported', reason_codes: [], capture_intervals: [interval()],
    launch_window: { net: iso(8), start: iso(8), end: iso(9), precision: 'Second' },
    trajectory: { quality: 'verified', source: 'Mission trajectory', points: [
      { lat: 28.5, lon: -80.6, alt_km: 0, t_offset_seconds: 0 },
      { lat: 29, lon: -80, alt_km: 30, t_offset_seconds: 60 },
    ] }, ...over });
}
export function artifact(items: LaunchOpportunity[] = [launch()], over: Partial<LaunchArtifact> = {}): LaunchArtifact {
  return { schema_version: 2, revision: 'r1', generated_at: iso(-5), valid_until: iso(10),
    coverage: { complete: true, from: iso(-60), until: iso(7 * 24 * 60), fetched_at: iso(-5),
      received: items.length, parsed: items.length, evaluated: items.length, visible: items.length, unevaluated: 0, reasons: [] },
    items, ...over };
}
export function state(items: LaunchOpportunity[] = [launch()], over: Partial<LaunchState> = {}): LaunchState {
  return { artifact: artifact(items), pointer: null, availability: 'ready', ...over };
}
export async function envelope(a = artifact()): Promise<{ pointer: LaunchPointer; body: string }> {
  const body = JSON.stringify(a);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))), (n) => n.toString(16).padStart(2, '0')).join('');
  return { pointer: { schema_version: 2, revision: a.revision, generated_at: a.generated_at, valid_until: a.valid_until, path: `launch/v/${a.revision}.json`, sha256 }, body };
}
