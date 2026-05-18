/** Shared type definitions matching the generator's output schema. */

export interface Manifest {
  version: string;
  generated_at: string;
  tle_epoch: string;
  cloud_composite_hour: string;
  target_data_version: string;
  build_version: string;
  freshness: {
    tle_hours: number;
    cloud_hours: number;
    ok: boolean;
  };
  artifacts: Record<string, { path: string; sha256: string; bytes: number }>;
}

export interface PassEntry {
  target_id: string;
  target_name: string;
  target_regime: 'day' | 'night' | 'terminator' | 'any';
  target_priority: number;
  target_lat: number;
  target_lon: number;
  closest_approach: string; // ISO 8601 Z
  nadir_distance_km: number;
  /** Angle from ISS-nadir vector to the line-of-sight to the target.
   *  <30° → WORF (Destiny lab nadir window). ≥30° → Cupola (panoramic dome).
   *  Older builds may not include this field; treat as optional. */
  angle_off_nadir_deg?: number;
  /** Direction the target sits relative to ISS direction of travel,
   *  measured clockwise from forward [0, 360). 0=ahead/fore, 90=starboard,
   *  180=aft, 270=port. Lets the card render "35° starboard" so the
   *  operator knows which window/side to point the camera. Added v1.2.6.0;
   *  older manifests will omit it. */
  iss_relative_bearing_deg?: number;
  pass_regime: 'day' | 'night' | 'terminator';
  obstruction_class: 'clear' | 'cloudy' | 'sun-glint risk';
  p_unobstructed: number;
  cloud_fraction: number;
  cloud_source: string;
  /** Wall-clock time the cloud sample was taken (or, for forecasts, the
   *  forecast valid-time). Drives the card "obs Nm ago" tag so the user
   *  can tell day-old MODIS from 10-min GOES-IR. Older manifests may not
   *  include this field. */
  sample_time?: string;
  score: number;
  score_components: {
    p_unobstructed: number;
    regime_fit: number;
    nadir_proximity: number;
    priority_weight: number;
    tle_freshness: number;
  };
  iss_at_closest: { lat: number; lon: number; alt_km: number };
  /** Present iff this PassEntry came from the V3.0 launch pipeline (the
   *  generator wrapped a rocket launch's site as a synthetic target).
   *  Triggers the 🚀 LAUNCH tag + rocket name + window-confidence chip on
   *  the card. Older v1.0/v1.1 manifests don't include this field; treat
   *  as optional everywhere. */
  launch?: {
    name: string;
    rocket_type: string;
    /** V3.0 legacy field. Stays 'overhead' for OVERHEAD entries; will be
     *  'ascent' for V3-P2 ASCENT entries. Kept for older readers; new
     *  code should prefer `kind`. */
    geometry: 'overhead' | 'ascent';
    /** V3-P2 discriminator. 'overhead' = rocket already in orbit passing
     *  under ISS (V3.0). 'ascent' = rocket climbing through atmosphere
     *  (V3-P2). Drives the card tag — different photographic setup per
     *  kind, so the operator needs to see it (per Codex review of the
     *  design doc). Optional for back-compat with v1.2.6.x manifests. */
    kind?: 'overhead' | 'ascent';
    site_name: string;
    /** Half-width of the LL2 NET window in seconds. 0 = precisely scheduled.
     *  Card renders "Window: ±N min" so the operator can weight a "T-0
     *  exact" Falcon vs a "±15 min Soyuz." */
    net_window_seconds: number;
    /** ISO 8601 Z. The headline launch time (LL2 `net`). Distinct from
     *  `closest_approach` (when ISS is overhead) — the two should agree
     *  within ±5 min. */
    t0: string;
  };
}

export interface Track {
  iss_polynomial: {
    start: string; // ISO 8601 Z
    duration_seconds: number;
    lat_coeffs: number[];
    lon_coeffs: number[];
    polynomial_order: number;
  };
  /** Direct SGP4 samples for the ground-track polyline. Each entry is
   *  `[t_seconds_from_polynomial.start, lat, lon]`. Covers ~2 ISS orbits
   *  (200 min @ 30s = 401 points). The polynomial is great for the live
   *  dot but degrades past ~120 min; track_points has zero drift over the
   *  full 2-orbit window. Older manifests may not include this field. */
  track_points?: [number, number, number][];
  /** Source TLE the polynomial + track_points were fit from. Lets the
   *  frontend run satellite.js SGP4 client-side past the polynomial window
   *  or during a multi-hour Mac outage. Older manifests may not include
   *  this field. */
  tle?: { line1: string; line2: string };
  tle_epoch: string;
  tle_age_hours: number;
  tle_freshness_factor: number;
}

export interface Status {
  last_run: string;
  tick_minutes: number;
  tle_age_hours: number;
  tle_freshness_factor: number;
  cloud_source: string;
  cloud_composite_hour: string;
  target_count: number;
  pass_count: number;
  version: string;
  build_version: string;
  /** V3.0 launches health (per ARCH-1 in the eng review — folded into
   *  status.json instead of a separate launches-health.json artifact).
   *  All four are optional so older v1.0/v1.1 status snapshots still
   *  parse cleanly. Frontend uses last_successful_fetch to drive the
   *  stale-launches banner overlay when >24h old. */
  launches_last_successful_fetch?: string | null;
  launches_count_upcoming?: number;
  launches_count_pass_opportunities?: number;
  launches_schema_hash?: string | null;
}

export type CalibAction = 'shoot' | 'skip' | 'rate';

export interface CalibPayload {
  target_id: string;
  pass_time: string;
  action: CalibAction;
  score_at_time?: number;
  rating?: number;
  observed_obstruction?: string;
  dedupe_key?: string;
}
