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
    pad_distance_km: number | null; look: CaptureInterval['look'];
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

const ASSESSMENT_REASONS = new Set([
  'SITE_IN_VIEW_AT_NET', 'NOMINAL_ASCENT_TOO_FAR', 'VIEW_UNCONFIRMED', 'TIMING_UNCONFIRMED',
  'EPHEMERIS_UNAVAILABLE', 'EPHEMERIS_OUTSIDE_HORIZON', 'SOURCE_UNAVAILABLE', 'PROFILE_UNKNOWN',
  'EVALUATION_INCOMPLETE', 'GEOMETRY_INVALID',
]);

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
export function parseLaunchArtifact(value: unknown): LaunchArtifact {
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
      ordered(assessment.checked_at, assessment.valid_until);
      const duration = Date.parse(assessment.valid_until as string) - Date.parse(assessment.checked_at as string);
      requireValue(assessment.checked_at === obj.generated_at && duration > 0 && duration <= 3 * 3600_000);
      timestamp(assessment.tle_epoch, true);
      if (assessment.model !== null) {
        const model = record(assessment.model, 'name duration_seconds max_altitude_km max_downrange_km');
        requireValue(string(model.name) && model.name.length <= 100 && number(model.duration_seconds, 1, 3600)
          && number(model.max_altitude_km, 0, 2000) && number(model.max_downrange_km, 0, 20000));
      }
      const net = record(assessment.net, 'verdict reason at pad_distance_km look');
      requireValue(['possible', 'too_far', 'unknown'].includes(String(net.verdict)) && ASSESSMENT_REASONS.has(String(net.reason)));
      timestamp(net.at);
      requireValue(net.at === window.net);
      requireValue(net.pad_distance_km === null || number(net.pad_distance_km, 0, 21000));
      if (net.look !== null) {
        const look = record(net.look, 'frame azimuth_deg off_nadir_deg');
        requireValue(look.frame === 'orbital-lvlh' && number(look.azimuth_deg, 0, 360) && look.azimuth_deg !== 360 && number(look.off_nadir_deg, 0, 180));
      }
      if (net.verdict === 'possible') {
        requireValue(net.reason === 'SITE_IN_VIEW_AT_NET' && net.look !== null && net.pad_distance_km !== null
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
        ordered(net.at, window.start);
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

function hasTimeConflict(item: Record<string, unknown>): boolean {
  return (item.reason_codes as string[]).includes('TIME_CONFLICT');
}
