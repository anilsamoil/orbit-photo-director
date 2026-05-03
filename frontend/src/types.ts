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
  pass_regime: 'day' | 'night' | 'terminator';
  obstruction_class: 'clear' | 'cloudy' | 'sun-glint risk';
  p_unobstructed: number;
  cloud_fraction: number;
  cloud_source: string;
  score: number;
  score_components: {
    p_unobstructed: number;
    regime_fit: number;
    nadir_proximity: number;
    priority_weight: number;
    tle_freshness: number;
  };
  iss_at_closest: { lat: number; lon: number; alt_km: number };
}

export interface Track {
  iss_polynomial: {
    start: string; // ISO 8601 Z
    duration_seconds: number;
    lat_coeffs: number[];
    lon_coeffs: number[];
    polynomial_order: number;
  };
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
