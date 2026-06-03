/** Shared type definitions matching the generator's output schema. */

/** One artifact's location + integrity metadata. Daemon emits one of
 *  these per logical artifact name (passes, status, top5, top_24h,
 *  track, targets). */
export interface ArtifactEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/** v1.6.7.0+ per-astronaut artifact block. Slot 4 daemon multiplexer
 *  emits this when `OPD_CALIB_TOKEN` is set in the daemon env. Each
 *  named profile (e.g., "jack", "chris", "anil") gets its own variant
 *  set of `passes`, `status`, `top5`, `top_24h` artifacts. Track and
 *  targets are profile-agnostic and stay at the top level only. Older
 *  manifests omit this entirely; the resolver falls back to top-level
 *  canonical artifacts in that case. */
export type ProfileArtifactsBlock = Record<string, Record<string, ArtifactEntry>>;

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
  /** The artifacts map. Most entries are flat `ArtifactEntry` records,
   *  but the special `profiles` key (when present) holds a nested
   *  per-astronaut map of variant artifacts. Use `resolveArtifactEntry()`
   *  from `manifest.ts` to access either kind safely. */
  artifacts: Record<string, ArtifactEntry | ProfileArtifactsBlock | undefined>;
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
  /** Initial-encounter geometry — when the target first becomes frameable
   *  (off-nadir ≤60°, scanning back from closest approach) and the look
   *  angle/side at that moment. The look angle sweeps fore→nadir→aft across a
   *  pass, so these differ from the closest-approach values and tell the
   *  operator where the target first appears. Added v1.7.5.0. Absent for
   *  grazing passes whose closest approach is itself past 60°, and for older
   *  manifests — every render path must tolerate absent. */
  encounter?: {
    time: string;            // ISO 8601 Z — initial-encounter moment
    off_nadir_deg: number;   // off-nadir angle at encounter (≤60°)
    rel_bearing_deg: number; // 0=fore, 90=starboard, 180=aft, 270=port
  } | null;                  // generator serializes explicit null when absent
  /** Lightning probability at the pass target_lat/lon at closest_approach.
   *  Range [0.0, 1.0]. Added v1.3.1 (weather v1.3). v1.3.1 ships a
   *  placeholder sampler that returns 0.0 for every query — real GLM /
   *  Blitzortung / GFS CAPE samplers slot in for v1.3.2. Cards render
   *  the ⚡ tag only when potential > 0.05. */
  lightning_potential?: number;
  /** Observed flash rate near the target at pass time, flashes per minute.
   *  Observed sources (GLM, Blitzortung) populate; forecast sources (CAPE)
   *  report 0. v1.3.1 placeholder always reports 0. */
  flash_rate_per_min?: number;
  /** Which sampler produced lightning_potential. Drives the
   *  "observed" vs "forecast" subtext on the ⚡ tag. */
  lightning_source?: 'placeholder' | 'glm' | 'blitzortung' | 'gfs-cape' | 'combined-no-data';
  /** Additive score bonus from lightning_potential, in 0-30 range
   *  (capped per the locked D3 architecture decision). Lets the score
   *  breakdown panel show "lightning: +12" alongside the multiplicative
   *  components, so the operator understands how the bonus moved the
   *  star count. */
  lightning_bonus?: number;
  /** Named tropical system within ~1500km of the pass target. NHC
   *  Atlantic + East Pacific basins only in v1.3.1; JTWC deferred to
   *  V4-P3. When present, the card renders a 🌀 tag with the storm
   *  name + classification (e.g., "🌀 Hurricane Dorian Cat 4"). */
  hurricane_nearby?: {
    name: string;            // e.g., "Dorian"
    classification: string;  // e.g., "Hurricane Cat 4", "Tropical Storm"
    distance_km: number;     // great-circle from storm center to target
    nhc_id: string;          // NHC storm ID, e.g., "AL052024"
  };
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
    /** Pad coordinates. Added v1.6.1.0 to anchor the ascent-trajectory
     *  map layer's "pad" marker. Older manifests omit. */
    pad_lat?: number;
    pad_lon?: number;
    /** Real launch azimuth (deg from north, computed from mission
     *  inclination + pad latitude). v1.6.1.0. */
    launch_azimuth_deg?: number;
    /** ASCENT trajectory polyline for the map layer. Walked at 15s
     *  cadence from T+0 to nominal orbit insertion (~9 min). Only
     *  present when kind="ascent" and a profile matched. */
    trajectory?: Array<{
      t_offset_s: number;
      lat: number;
      lon: number;
      alt_km: number;
    }>;
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
  /** v1.6.1.1+: launches that passed the looser ASCENT NET-window filter
   *  (≤6h vs OVERHEAD's ≤5min). Always ≥ launches_count_upcoming. Lets
   *  the operator tell "we have data for the trajectory layer" apart from
   *  "we have data for an exact-time pass." Optional for back-compat. */
  launches_count_ascent_eligible?: number;
  launches_count_pass_opportunities?: number;
  launches_schema_hash?: string | null;
}

/** A curated target as published by the generator in `targets.json`.
 *  v3 — Component C (operator ergonomics, 2026-05-26): the Profile-tab
 *  "Hidden curated targets" section needs the catalog so the typeahead
 *  can search by name instead of forcing the operator to paste an
 *  exact id. Shape matches `generator/config.py:_validate_target` —
 *  `geom.lat/lon` (nested), priority int 1-5, and optional metadata
 *  fields the typeahead surfaces if present.
 *
 *  Defensive: every render path that touches `tier` / `category` /
 *  `notes` / `caption_hook` must handle the absent case — older
 *  targets.json snapshots predate those fields. */
export interface CuratedTarget {
  id: string;
  name: string;
  geom: {
    type: 'point';
    lat: number;
    lon: number;
  };
  priority: number;
  regime: 'day' | 'night' | 'terminator' | 'any';
  tier?: number;
  category?: string;
  notes?: string;
  caption_hook?: string;
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
  /** Slot 8 (design rev 2): per-astronaut log scoping. Stamped by
   *  buildPayload() from getCurrentProfile()?.name; defaults to "anil"
   *  when no profile is active so legacy reads return naturally. The
   *  Worker validates the regex + falls back to the same default when
   *  the field is missing. */
  profile?: string;
}
