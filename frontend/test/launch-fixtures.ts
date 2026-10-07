import type { CaptureInterval, LaunchArtifact, LaunchAssessment, LaunchCatalog, LaunchCatalogItem, LaunchOpportunity, LaunchPointer, ShotEnvelope } from '../src/launch-schema';
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
export function assessment(over: Partial<LaunchAssessment> = {}): LaunchAssessment {
  return {
    checked_at: iso(-5), valid_until: iso(170), tle_epoch: iso(-60),
    model: { name: 'Nominal ascent envelope', duration_seconds: 600, max_altitude_km: 400, max_downrange_km: 1500 },
    net: { verdict: 'possible', reason: 'PAD_CLOSEST_APPROACH', at: iso(10), pad_distance_km: 150,
      t_offset_seconds: 0,
      look: { frame: 'orbital-lvlh', azimuth_deg: 45, off_nadir_deg: 55 } },
    window: { verdict: 'unknown', reason: 'VIEW_UNCONFIRMED' }, ...over,
  };
}
export function artifact(items: LaunchOpportunity[] = [launch()], over: Partial<LaunchArtifact> = {}): LaunchArtifact {
  return { schema_version: 2, revision: 'r1', generated_at: iso(-5), valid_until: iso(10),
    coverage: { complete: true, from: iso(-60), until: iso(7 * 24 * 60), fetched_at: iso(-5),
      received: items.length, parsed: items.length, evaluated: items.length, visible: items.length, unevaluated: 0, reasons: [] },
    items, ...over };
}
type Schema2State = Omit<LaunchState, 'artifact'> & { artifact: LaunchArtifact | null };
export function state(items: LaunchOpportunity[] = [launch()], over: Partial<Schema2State> = {}): Schema2State {
  return { artifact: artifact(items), pointer: null, availability: 'ready', ...over };
}
export function shot(over: Partial<ShotEnvelope> = {}): ShotEnvelope {
  return {
    subject: 'pad', liftoff: iso(10), evaluated_at: iso(10),
    direction: { kind: 'none', azimuth_deg: null, source: null, off_plane_deg: null },
    start: iso(10), best: iso(11), end: iso(12), best_offset_s: 60,
    look: { frame: 'orbital-lvlh', azimuth_deg: 45, off_nadir_deg: 70 }, window: 'W6',
    slant_km: 490, limb_margin_deg: 8, plume_mrad: 1.6, light: 'twilight_plume',
    lens: 'telephoto', lens_reason: 'Distant plume', track: [],
    score: { low: 30, high: 40, terms: { A: [0.2, 0.4], C: [0.5, 0.5], D: [0.1, 0.2], M: [0.8, 1], R: [0.4, 0.6] } },
    confidence: { tle_age_h: 30, along_track_sigma_km: 12, timing_sigma_s: 4, robust: false }, ...over,
  };
}
export function catalogItem(over: Partial<LaunchCatalogItem> = {}): LaunchCatalogItem {
  return {
    event_id: 'event-1', revision: 'event-r1', name: 'Dragon CRS-35', rocket: 'Falcon 9',
    site: { name: 'Kennedy', lat: 28.5, lon: -80.6 },
    schedule: { net: iso(10), window_start: iso(10), window_end: iso(20), precision: 'Second', status: 'Go', destination: 'ISS' },
    direction: { kind: 'iss_plane', azimuth_deg: 44.7, source: 'iss plane', off_plane_deg: 0.35 },
    tier: 'watch', why: 'Twilight plume 490 km aft, W6, 3 min after liftoff.', reasons: [],
    shots: [shot(), shot({ subject: 'ascent', direction: { kind: 'iss_plane', azimuth_deg: 44.7, source: 'iss plane', off_plane_deg: 0.35 }, track: [
      { t_offset_s: 0, lat: 28.5, lon: -80.6, alt_km: 0 },
      { t_offset_s: 15, lat: 28.6, lon: -80.5, alt_km: 10 },
    ] })], ...over,
  };
}
export function catalog(items: LaunchCatalogItem[] = [catalogItem()], over: Partial<LaunchCatalog> = {}): LaunchCatalog {
  return {
    schema_version: 3, revision: 'r1', generated_at: iso(-5), schedule_valid_until: iso(70), geometry_valid_until: iso(10),
    tle: { epoch: iso(-60), sha256: 'a'.repeat(64), source: 'celestrak' },
    coverage: {
      from: iso(-60), until: iso(14 * 24 * 60), schedule_fetched_at: iso(-5), pages: 1,
      received: items.length, listed: items.length, evaluated: items.length,
      tier_counts: { shot: 0, likely: 0, watch: items.length, unassessed: 0, none: 0 },
      complete: true, reasons: [],
    },
    items, ...over,
  };
}
export async function envelope(a: LaunchArtifact | LaunchCatalog = artifact()): Promise<{ pointer: LaunchPointer; body: string }> {
  const body = JSON.stringify(a);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))), (n) => n.toString(16).padStart(2, '0')).join('');
  const valid_until = a.schema_version === 2 ? a.valid_until : a.geometry_valid_until;
  return { pointer: { schema_version: 2, revision: a.revision, generated_at: a.generated_at, valid_until, path: `launch/v/${a.revision}.json`, sha256 }, body };
}
