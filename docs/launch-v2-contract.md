# Launch V2 Contract (Map-Only First Release)

Approved staged plan: docs/plans/2026-09-07-iss-launch-photography-autoplan.md.
No WhatsApp sender is enabled in this release. All current generic-profile results are map-only estimates.

Pointer GET /launch/latest.json:
`{schema_version:2,revision,generated_at,valid_until,path:"launch/v/<revision>.json",sha256}`.
All times ISO8601 UTC. Hash is SHA256 of exact artifact bytes. Path must be a same-origin relative launch/v/*.json path. Never fetch an external URL supplied by this artifact.

Artifact:
```ts
type LaunchArtifact = {
  schema_version: 2; revision: string; generated_at: string; valid_until: string;
  coverage: {
    complete: boolean; from: string; until: string; fetched_at: string | null;
    received: number; parsed: number; evaluated: number; visible: number;
    unevaluated: number; reasons: string[];
  };
  items: LaunchOpportunity[];
};
type LaunchOpportunity = {
  event_id: string; revision: string; name: string; rocket: string;
  site: {name: string; lat: number; lon: number};
  status: 'map_only' | 'geometry_supported'; reason_codes: string[];
  launch_window: {net: string; start: string | null; end: string | null; precision: string | null};
  capture_intervals: {
    start: string; peak: string; end: string;
    liftoff_start: string; liftoff_end: string;
    look: {frame: 'orbital-lvlh'; azimuth_deg: number; off_nadir_deg: number} | null;
  }[];
  trajectory: {
    quality: 'unknown' | 'approximate' | 'verified'; source: string | null;
    points: {lat: number; lon: number; alt_km: number; t_offset_seconds: number}[];
  };
  sources: {kind: string; url: string; fetched_at: string | null}[];
};
```

UI ownership: one shared store and one pointer refresh cycle for all views, atomic replacement only after hash/schema/revision validation. Preserve last-good on fetch failure, but always label freshness against real clock. Persist only this common artifact for offline use. Launch cards bypass personal ground-target/distance filters; no duplicate legacy launch cards when v2 is available. Legacy launch renderer must suppress probability/score, false exact time and physical-window labels even in fallback.

Queue90min: only valid, future geometry_supported capture intervals; maximum2launch cards in5slots, ground gets at least3when available. Stable start/event_id ordering. Upcoming36h and Map: include tentative candidates within actual coverage, use net when capture interval unknown. Keep unknown trajectory site marker but no fabricated corridor. Upcoming may retain clearly expired launch for30min. Full-contrast stale/unknown labels. No percent or star rating for launches. Gold hue plus text LAUNCH/ASCENT and explicit MAP ONLY status. Clicking marker/card opens the same facts/revision in all views; no real window-access promise. Direction is orbital-relative, not station body orientation.

Coverage complete=false or bounded until must not look like a confident empty feed. A missing launch pointer cannot break the existing Earth map/queue. Existing calendar/export remains unchanged, do not export map-only timing as a guaranteed capture instruction.
