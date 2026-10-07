export interface LaunchPointer {
  schema_version: 2;
  revision: string;
  generated_at: string;
  valid_until: string;
  path: string;
  sha256: string;
}

export interface CaptureInterval {
  start: string; peak: string; end: string;
  liftoff_start: string; liftoff_end: string;
  look: { frame: 'orbital-lvlh'; azimuth_deg: number; off_nadir_deg: number } | null;
}

export interface LaunchOpportunity {
  event_id: string; revision: string; name: string; rocket: string;
  site: { name: string; lat: number; lon: number };
  status: 'map_only' | 'geometry_supported';
  reason_codes: string[];
  launch_window: { net: string; start: string | null; end: string | null; precision: string | null };
  capture_intervals: CaptureInterval[];
  trajectory: {
    quality: 'unknown' | 'approximate' | 'verified'; source: string | null;
    points: { lat: number; lon: number; alt_km: number; t_offset_seconds: number }[];
  };
  sources: { kind: string; url: string; fetched_at: string | null }[];
  assessment?: LaunchAssessment;
}

/** Planning at the listed liftoff time; does not grant camera/Queue eligibility. */
export interface LaunchAssessment {
  checked_at: string; valid_until: string; tle_epoch: string | null;
  model: { name: string; duration_seconds: number; max_altitude_km: number; max_downrange_km: number } | null;
  net: {
    verdict: 'possible' | 'too_far' | 'unknown'; reason: string; at: string;
    pad_distance_km: number | null; t_offset_seconds?: number | null; look: CaptureInterval['look'];
  };
  window: { verdict: 'too_far' | 'unknown'; reason: string };
}

export interface LaunchArtifact {
  schema_version: 2; revision: string; generated_at: string; valid_until: string;
  coverage: {
    complete: boolean; from: string; until: string; fetched_at: string | null;
    received: number; parsed: number; evaluated: number; visible: number;
    unevaluated: number; reasons: string[];
  };
  items: LaunchOpportunity[];
}

export interface ShotEnvelope {
  subject: 'pad' | 'ascent';
  liftoff: string;
  evaluated_at?: string;
  direction?: LaunchCatalogItem['direction'];
  start: string; best: string; end: string; best_offset_s: number;
  look: { frame: 'orbital-lvlh'; azimuth_deg: number; off_nadir_deg: number };
  window: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7';
  slant_km: number; limb_margin_deg: number; plume_mrad: number | null;
  light: 'twilight_plume' | 'day_plume' | 'night_engine' | 'pad_day' | 'pad_night';
  lens: 'telephoto' | 'wide';
  lens_reason: string;
  track: { t_offset_s: number; lat: number; lon: number; alt_km: number }[];
  score: { low: number; high: number; terms: Record<'A' | 'C' | 'D' | 'M' | 'R', [number, number]> };
  confidence: { tle_age_h: number; along_track_sigma_km: number; timing_sigma_s: number; robust: boolean };
}

export interface LaunchCatalogItem {
  event_id: string; revision: string; name: string; rocket: string;
  site: { name: string; lat: number; lon: number };
  schedule: {
    net: string; window_start: string | null; window_end: string | null;
    precision: string | null; status: string; destination: string | null;
  };
  direction: {
    kind: 'published' | 'iss_plane' | 'hazard_area' | 'none';
    azimuth_deg: number | null; source: string | null; off_plane_deg: number | null;
  };
  tier: 'shot' | 'likely' | 'watch' | 'unassessed' | 'none';
  why: string; reasons: string[];
  shots: ShotEnvelope[];
}

export interface LaunchCatalog {
  schema_version: 3; revision: string; generated_at: string;
  schedule_valid_until: string; geometry_valid_until: string;
  tle: { epoch: string; sha256: string; source: string };
  coverage: {
    from: string; until: string; schedule_fetched_at: string | null;
    pages: number; received: number; listed: number; evaluated: number;
    tier_counts: { shot: number; likely: number; watch: number; unassessed: number; none: number };
    complete: boolean; reasons: string[];
  };
  items: LaunchCatalogItem[];
}

const ASSESSMENT_REASONS = new Set([
  'PAD_CLOSEST_APPROACH', 'SITE_IN_VIEW_AT_NET', 'NOMINAL_ASCENT_TOO_FAR', 'VIEW_UNCONFIRMED', 'TIMING_UNCONFIRMED',
  'EPHEMERIS_UNAVAILABLE', 'EPHEMERIS_OUTSIDE_HORIZON', 'SOURCE_UNAVAILABLE', 'PROFILE_UNKNOWN',
  'EVALUATION_INCOMPLETE', 'GEOMETRY_INVALID',
]);
const CATALOG_TIERS = new Set(['shot', 'likely', 'watch', 'unassessed', 'none']);
const DIRECTION_KINDS = new Set(['published', 'iss_plane', 'hazard_area', 'none']);
const SHOT_LIGHTS = new Set(['twilight_plume', 'day_plume', 'night_engine', 'pad_day', 'pad_night']);
const SCORE_TERMS = ['A', 'C', 'D', 'M', 'R'] as const;

function requireValue(ok: unknown): asserts ok {
  if (!ok) throw new Error('Invalid launch schema');
}
function record(value: unknown, keys: string, optionalKeys = ''): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  const obj = value as Record<string, unknown>;
  const required = keys.split(' ');
  const allowed = [...required, ...optionalKeys.split(' ').filter(Boolean)];
  requireValue(Object.keys(obj).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(obj, key)));
  return obj;
}
function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048;
}
function number(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function whole(value: unknown): value is number {
  return number(value, 0, Number.MAX_SAFE_INTEGER) && Number.isInteger(value);
}
function strings(value: unknown): void {
  requireValue(Array.isArray(value) && value.length <= 100 && value.every(string));
}
export function isLaunchUtc(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function timestamp(value: unknown, nullable = false): void {
  requireValue((nullable && value === null) || isLaunchUtc(value));
}
function ordered(start: unknown, end: unknown): void {
  requireValue(isLaunchUtc(start) && isLaunchUtc(end) && Date.parse(start) <= Date.parse(end));
}
function validity(start: unknown, end: unknown): void {
  ordered(start, end);
  const lifetime = Date.parse(end as string) - Date.parse(start as string);
  requireValue(lifetime > 0 && lifetime <= 15 * 60_000);
}
function assessmentLease(start: unknown, end: unknown): void {
  ordered(start, end);
  const lifetime = Date.parse(end as string) - Date.parse(start as string);
  requireValue(lifetime > 0 && lifetime <= 3 * 3600_000);
}
function coordinates(obj: Record<string, unknown>): void {
  requireValue(number(obj.lat, -90, 90) && number(obj.lon, -180, 180));
}
function revision(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function safeSourceUrl(value: unknown): value is string {
  if (!string(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
export function parseLaunchPointer(value: unknown): LaunchPointer {
  const obj = record(value, 'schema_version revision generated_at valid_until path sha256');
  requireValue(obj.schema_version === 2 && revision(obj.revision));
  validity(obj.generated_at, obj.valid_until);
  requireValue(typeof obj.sha256 === 'string' && /^[a-f0-9]{64}$/.test(obj.sha256));
  // The filename and revision must agree. This also excludes traversal,
  // encoding tricks, queries, fragments, absolute URLs and redirects.
  requireValue(obj.path === `launch/v/${obj.revision}.json`);
  return value as LaunchPointer;
}

export interface LaunchCatalogPointer extends Omit<LaunchPointer, 'path'> {
  path: `launch/catalog/v/${string}.json`;
}

/** Catalog publication pointer. Same schema 2 validity and sha256 rules, catalog path only. */
export function parseLaunchCatalogPointer(value: unknown): LaunchCatalogPointer {
  const obj = record(value, 'schema_version revision generated_at valid_until path sha256');
  requireValue(obj.schema_version === 2 && revision(obj.revision));
  validity(obj.generated_at, obj.valid_until);
  requireValue(typeof obj.sha256 === 'string' && /^[a-f0-9]{64}$/.test(obj.sha256));
  requireValue(obj.path === `launch/catalog/v/${obj.revision}.json`);
  return value as LaunchCatalogPointer;
}

export function parseLaunchArtifact(value: unknown): LaunchArtifact | LaunchCatalog {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  const version = (value as Record<string, unknown>).schema_version;
  if (version === 2) return parseSchema2(value);
  if (version === 3) return parseSchema3(value);
  throw new Error('Invalid launch schema');
}
function parseSchema2(value: unknown): LaunchArtifact {
  const obj = record(value, 'schema_version revision generated_at valid_until coverage items');
  requireValue(obj.schema_version === 2 && revision(obj.revision));
  validity(obj.generated_at, obj.valid_until);
  const coverage = record(obj.coverage, 'complete from until fetched_at received parsed evaluated visible unevaluated reasons');
  requireValue(typeof coverage.complete === 'boolean');
  ordered(coverage.from, coverage.until);
  timestamp(coverage.fetched_at, true);
  for (const field of ['received', 'parsed', 'evaluated', 'visible', 'unevaluated']) {
    requireValue(number(coverage[field], 0, Number.MAX_SAFE_INTEGER) && Number.isInteger(coverage[field]));
  }
  strings(coverage.reasons);
  requireValue(Array.isArray(obj.items) && obj.items.length <= 2000);
  const ids = new Set<string>();
  for (const value of obj.items) {
    const item = record(value, 'event_id revision name rocket site status reason_codes launch_window capture_intervals trajectory sources', 'assessment');
    requireValue(string(item.event_id) && !ids.has(item.event_id));
    ids.add(item.event_id);
    requireValue(revision(item.revision) && string(item.name) && string(item.rocket));
    requireValue(item.status === 'map_only' || item.status === 'geometry_supported');
    strings(item.reason_codes);
    const site = record(item.site, 'name lat lon');
    requireValue(string(site.name));
    coordinates(site);
    const window = record(item.launch_window, 'net start end precision');
    timestamp(window.net);
    timestamp(window.start, true);
    timestamp(window.end, true);
    if (window.start !== null && window.end !== null) {
      const retainedConflict = item.status === 'map_only' && (item.reason_codes as string[]).includes('TIME_CONFLICT');
      if (!retainedConflict) ordered(window.start, window.end);
    }
    requireValue(window.precision === null || string(window.precision));
    requireValue(Array.isArray(item.capture_intervals) && item.capture_intervals.length <= 1000);
    for (const value of item.capture_intervals) {
      const interval = record(value, 'start peak end liftoff_start liftoff_end look');
      ordered(interval.start, interval.peak);
      ordered(interval.peak, interval.end);
      ordered(interval.liftoff_start, interval.liftoff_end);
      if (interval.look !== null) {
        const look = record(interval.look, 'frame azimuth_deg off_nadir_deg');
        requireValue(look.frame === 'orbital-lvlh' && number(look.azimuth_deg, 0, 360) && number(look.off_nadir_deg, 0, 180));
      }
    }
    const trajectory = record(item.trajectory, 'quality source points');
    requireValue(['unknown', 'approximate', 'verified'].includes(String(trajectory.quality)));
    requireValue(trajectory.source === null || string(trajectory.source));
    requireValue(Array.isArray(trajectory.points) && trajectory.points.length <= 10000);
    let previous = -Infinity;
    for (const value of trajectory.points) {
      const point = record(value, 'lat lon alt_km t_offset_seconds');
      coordinates(point);
      requireValue(number(point.alt_km, 0, 100000) && number(point.t_offset_seconds, 0, 1e7));
      requireValue(point.t_offset_seconds > previous);
      previous = point.t_offset_seconds;
    }
    if (item.status === 'geometry_supported') {
      ordered(window.start, window.net);
      ordered(window.net, window.end);
      // NET is a lower bound, not permission to model an earlier liftoff.
      ordered(window.net, window.start);
      requireValue(string(window.precision) && ['minute', 'second'].includes(window.precision.toLowerCase()));
      for (const value of item.capture_intervals) {
        const interval = value as CaptureInterval;
        ordered(window.start, interval.liftoff_start);
        ordered(interval.liftoff_end, window.end);
        ordered(interval.liftoff_start, interval.start);
      }
      requireValue(trajectory.quality !== 'unknown' && string(trajectory.source) && trajectory.points.length >= 2 && item.capture_intervals.length > 0);
      // There is no allowlisted non-blocking reason in this release. A
      // future supported claim needs clean evidence and explicit LVLH look.
      requireValue((item.reason_codes as string[]).length === 0);
      requireValue(item.capture_intervals.every((value) => (value as CaptureInterval).look !== null));
    }
    requireValue(Array.isArray(item.sources) && item.sources.length <= 100);
    for (const value of item.sources) {
      const source = record(value, 'kind url fetched_at');
      requireValue(string(source.kind) && safeSourceUrl(source.url));
      timestamp(source.fetched_at, true);
    }
    if (Object.hasOwn(item, 'assessment')) {
      const assessment = record(item.assessment, 'checked_at valid_until tle_epoch model net window');
      assessmentLease(assessment.checked_at, assessment.valid_until);
      requireValue(assessment.checked_at === obj.generated_at);
      timestamp(assessment.tle_epoch, true);
      if (assessment.model !== null) {
        const model = record(assessment.model, 'name duration_seconds max_altitude_km max_downrange_km');
        requireValue(string(model.name) && model.name.length <= 100 && number(model.duration_seconds, 1, 3600)
          && number(model.max_altitude_km, 0, 2000) && number(model.max_downrange_km, 0, 20000));
      }
      const net = record(assessment.net, 'verdict reason at pad_distance_km look', 't_offset_seconds');
      requireValue(['possible', 'too_far', 'unknown'].includes(String(net.verdict)) && ASSESSMENT_REASONS.has(String(net.reason)));
      timestamp(net.at);
      requireValue(net.at === window.net);
      requireValue(net.pad_distance_km === null || number(net.pad_distance_km, 0, 21000));
      if (Object.hasOwn(net, 't_offset_seconds') && net.t_offset_seconds !== null) {
        requireValue(Number.isInteger(net.t_offset_seconds) && number(net.t_offset_seconds, -300, 120));
      }
      if (net.look !== null) {
        const look = record(net.look, 'frame azimuth_deg off_nadir_deg');
        requireValue(look.frame === 'orbital-lvlh' && number(look.azimuth_deg, 0, 360) && look.azimuth_deg !== 360 && number(look.off_nadir_deg, 0, 180));
      }
      if (net.verdict === 'possible') {
        const closest = net.reason === 'PAD_CLOSEST_APPROACH' && Number.isInteger(net.t_offset_seconds)
          && number(net.t_offset_seconds, -300, 120) && typeof net.pad_distance_km === 'number' && net.pad_distance_km < 500;
        requireValue((net.reason === 'SITE_IN_VIEW_AT_NET' || closest) && net.look !== null && net.pad_distance_km !== null
          && assessment.tle_epoch !== null);
      } else requireValue(net.look === null);
      const assessedWindow = record(assessment.window, 'verdict reason');
      requireValue(['too_far', 'unknown'].includes(String(assessedWindow.verdict)) && ASSESSMENT_REASONS.has(String(assessedWindow.reason)));
      const concrete = net.verdict !== 'unknown' || assessedWindow.verdict !== 'unknown';
      const checked = Date.parse(assessment.checked_at as string);
      const expires = Date.parse(assessment.valid_until as string);
      const netTime = Date.parse(net.at as string);
      const epoch = Date.parse(assessment.tle_epoch as string);
      const fetched = Date.parse(coverage.fetched_at as string);
      if (concrete) {
        requireValue(assessment.tle_epoch !== null && coverage.fetched_at !== null && netTime >= checked
          && Math.abs(checked - epoch) <= 24 * 3600_000 && Math.abs(netTime - epoch) <= 24 * 3600_000
          && fetched <= checked && checked - fetched < 3 * 3600_000 && expires - fetched <= 3 * 3600_000
          && ['minute', 'second'].includes(String(window.precision).toLowerCase())
          && [...item.reason_codes as string[], ...coverage.reasons as string[]].every((reason) => ![
            'LAUNCH_UNCONFIRMED', 'TIME_CONFLICT', 'TIME_PRECISION_UNKNOWN', 'TIME_PRECISION_COARSE', 'WINDOW_UNKNOWN',
            'SOURCE_AGE_MTIME_ONLY', 'SOURCE_AGE_UNKNOWN', 'REPLAY_SOURCE_MISMATCH',
          ].includes(reason)));
        ordered(window.start, net.at);
        ordered(net.at, window.end);
      }
      const model = assessment.model as LaunchAssessment['model'];
      for (const result of [net, assessedWindow]) {
        if (result.verdict === 'too_far') requireValue(model !== null && assessment.tle_epoch !== null && result.reason === 'NOMINAL_ASCENT_TOO_FAR');
      }
      if (net.verdict === 'too_far') requireValue(netTime - epoch + model!.duration_seconds * 1000 <= 24 * 3600_000);
      if (assessedWindow.verdict === 'too_far') {
        requireValue(net.verdict !== 'possible' && !hasTimeConflict(item));
        ordered(window.start, window.end);
        const start = Date.parse(window.start as string);
        const end = Date.parse(window.end as string);
        requireValue(start >= netTime && end - start <= 6 * 3600_000 && end - epoch + model!.duration_seconds * 1000 <= 24 * 3600_000);
      }
    }
  }
  return value as LaunchArtifact;
}

function parseSchema3(value: unknown): LaunchCatalog {
  const obj = record(value, 'schema_version revision generated_at schedule_valid_until geometry_valid_until tle coverage items');
  requireValue(obj.schema_version === 3 && revision(obj.revision));
  assessmentLease(obj.generated_at, obj.schedule_valid_until);
  validity(obj.generated_at, obj.geometry_valid_until);
  const tle = record(obj.tle, 'epoch sha256 source');
  timestamp(tle.epoch);
  requireValue(typeof tle.sha256 === 'string' && /^[a-f0-9]{64}$/.test(tle.sha256) && string(tle.source));
  const coverage = record(obj.coverage, 'from until schedule_fetched_at pages received listed evaluated tier_counts complete reasons');
  ordered(coverage.from, coverage.until);
  timestamp(coverage.schedule_fetched_at, true);
  for (const field of ['pages', 'received', 'listed', 'evaluated']) requireValue(whole(coverage[field]));
  const counts = record(coverage.tier_counts, 'shot likely watch unassessed none');
  for (const field of ['shot', 'likely', 'watch', 'unassessed', 'none']) requireValue(whole(counts[field]));
  requireValue(typeof coverage.complete === 'boolean');
  strings(coverage.reasons);
  requireValue(Array.isArray(obj.items) && obj.items.length <= 2000);
  const ids = new Set<string>();
  for (const entry of obj.items) {
    const item = record(entry, 'event_id revision name rocket site schedule direction tier why reasons shots');
    requireValue(string(item.event_id) && !ids.has(item.event_id));
    ids.add(item.event_id);
    requireValue(revision(item.revision) && string(item.name) && string(item.rocket) && string(item.why));
    const site = record(item.site, 'name lat lon');
    requireValue(string(site.name));
    coordinates(site);
    const schedule = record(item.schedule, 'net window_start window_end precision status destination');
    timestamp(schedule.net);
    timestamp(schedule.window_start, true);
    timestamp(schedule.window_end, true);
    if (schedule.window_start !== null && schedule.window_end !== null) ordered(schedule.window_start, schedule.window_end);
    requireValue(schedule.precision === null || string(schedule.precision));
    requireValue(string(schedule.status) && (schedule.destination === null || string(schedule.destination)));
    const direction = record(item.direction, 'kind azimuth_deg source off_plane_deg');
    requireValue(typeof direction.kind === 'string' && DIRECTION_KINDS.has(direction.kind));
    if (direction.kind === 'none') {
      requireValue(direction.azimuth_deg === null && direction.source === null && direction.off_plane_deg === null);
    } else {
      requireValue(number(direction.azimuth_deg, 0, 360) && string(direction.source));
      if (direction.kind === 'iss_plane') requireValue(number(direction.off_plane_deg, -180, 180));
      else requireValue(direction.off_plane_deg === null);
    }
    requireValue(typeof item.tier === 'string' && CATALOG_TIERS.has(item.tier));
    strings(item.reasons);
    requireValue(Array.isArray(item.shots) && item.shots.length <= 1000);
    for (const shotValue of item.shots) {
      const shot = record(shotValue, 'subject liftoff start best end best_offset_s look window slant_km limb_margin_deg plume_mrad light lens lens_reason track score confidence', 'evaluated_at direction');
      requireValue(shot.subject === 'pad' || shot.subject === 'ascent');
      if (shot.subject === 'ascent') requireValue(direction.kind !== 'none');
      timestamp(shot.liftoff);
      const hasEvaluated = Object.hasOwn(shot, 'evaluated_at');
      const hasDirection = Object.hasOwn(shot, 'direction');
      requireValue(hasEvaluated === hasDirection);
      if (hasEvaluated) {
        timestamp(shot.evaluated_at);
        const shotDirection = record(shot.direction, 'kind azimuth_deg source off_plane_deg');
        requireValue(typeof shotDirection.kind === 'string' && DIRECTION_KINDS.has(shotDirection.kind));
        if (shotDirection.kind === 'none') {
          requireValue(shotDirection.azimuth_deg === null && shotDirection.source === null && shotDirection.off_plane_deg === null);
          requireValue(shot.subject !== 'ascent');
        } else {
          requireValue(number(shotDirection.azimuth_deg, 0, 360) && string(shotDirection.source));
          if (shotDirection.kind === 'iss_plane') requireValue(number(shotDirection.off_plane_deg, -180, 180));
          else requireValue(shotDirection.off_plane_deg === null);
        }
      }
      ordered(shot.start, shot.best);
      ordered(shot.best, shot.end);
      requireValue(number(shot.best_offset_s, -86400, 86400));
      const look = record(shot.look, 'frame azimuth_deg off_nadir_deg');
      requireValue(look.frame === 'orbital-lvlh' && number(look.azimuth_deg, 0, 360) && number(look.off_nadir_deg, 0, 180));
      requireValue(typeof shot.window === 'string' && /^W[1-7]$/.test(shot.window));
      requireValue(number(shot.slant_km, 0, 21000));
      requireValue(number(shot.limb_margin_deg, -180, 180));
      requireValue(shot.plume_mrad === null || number(shot.plume_mrad, 0, 1000));
      requireValue(typeof shot.light === 'string' && SHOT_LIGHTS.has(shot.light));
      requireValue((shot.lens === 'telephoto' || shot.lens === 'wide') && string(shot.lens_reason));
      requireValue(Array.isArray(shot.track) && shot.track.length <= 10000);
      if (shot.subject === 'pad') requireValue(shot.track.length === 0);
      let previous = -Infinity;
      for (const pointValue of shot.track) {
        const point = record(pointValue, 't_offset_s lat lon alt_km');
        coordinates(point);
        requireValue(number(point.alt_km, 0, 100000) && number(point.t_offset_s, -86400, 1e7));
        requireValue(point.t_offset_s > previous);
        previous = point.t_offset_s;
      }
      const score = record(shot.score, 'low high terms');
      requireValue(number(score.low, 0, 100) && number(score.high, 0, 100) && score.low <= score.high);
      const terms = record(score.terms, 'A C D M R');
      for (const key of SCORE_TERMS) unitPair(terms[key]);
      const confidence = record(shot.confidence, 'tle_age_h along_track_sigma_km timing_sigma_s robust');
      requireValue(number(confidence.tle_age_h, 0, 100000) && number(confidence.along_track_sigma_km, 0, 100000)
        && number(confidence.timing_sigma_s, 0, 1e7) && typeof confidence.robust === 'boolean');
    }
  }
  return value as LaunchCatalog;
}
function unitPair(value: unknown): void {
  requireValue(Array.isArray(value) && value.length === 2);
  const low = value[0];
  const high = value[1];
  requireValue(number(low, 0, 1) && number(high, 0, 1) && low <= high);
}

function hasTimeConflict(item: Record<string, unknown>): boolean {
  return (item.reason_codes as string[]).includes('TIME_CONFLICT');
}
