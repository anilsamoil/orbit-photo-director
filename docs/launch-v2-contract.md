# Launch V2 Contract

Approved staged plan: docs/plans/2026-09-07-iss-launch-photography-autoplan.md.
No WhatsApp sender is enabled. Published items remain map-only for camera admission.
Release 1.22.0.9 adds a separate planning assessment; see below.

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
  assessment?: {
    checked_at: string; valid_until: string; tle_epoch: string | null;
    model: {name: string; duration_seconds: number; max_altitude_km: number; max_downrange_km: number} | null;
    net: {
      verdict: 'possible' | 'too_far' | 'unknown'; reason: string; at: string;
      pad_distance_km: number | null;
      look: {frame: 'orbital-lvlh'; azimuth_deg: number; off_nadir_deg: number} | null;
    };
    window: {verdict: 'too_far' | 'unknown'; reason: string};
  };
};
```

UI ownership: one shared store and one pointer refresh cycle for all views, atomic replacement only after hash/schema/revision validation. Preserve last-good on fetch failure, but always label freshness against real clock. Persist only this common artifact for offline use. Launch cards bypass personal ground-target/distance filters; no duplicate legacy launch cards when v2 is available. Legacy launch renderer must suppress probability/score, false exact time and physical-window labels even in fallback.

Queue90min: only valid, future geometry_supported capture intervals; maximum2launch cards in5slots, ground gets at least3when available. Stable start/event_id ordering. Upcoming36h and Map: include tentative candidates within actual coverage, use net when capture interval unknown. Keep unknown trajectory site marker but no fabricated corridor. Upcoming may retain clearly expired launch for30min. Full-contrast stale/unknown labels. No percent or star rating for launches. Gold hue plus text LAUNCH/ASCENT and explicit MAP ONLY status. Clicking marker/card opens the same facts/revision in all views; no real window-access promise. Direction is orbital-relative, not station body orientation.

Coverage complete=false or bounded until must not look like a confident empty feed. A missing launch pointer cannot break the existing Earth map/queue. Existing calendar/export remains unchanged, do not export map-only timing as a guaranteed capture instruction.

## Planning brief (1.22.0.9)

The nearest upcoming launch appears above the map; others and technical evidence
are collapsed. Color expresses the shooting verdict rather than missing camera
validation: green means a geometric possibility; too-far and unknown have distinct
text and colors. This supersedes the blanket gold/status presentation above.

`assessment.checked_at` equals the artifact generation time, and `net.at` equals
the event NET. A planning lease is at most three hours and cannot outlive the
source receipt's three-hour lease. A concrete result needs a TLE within 24 hours
of evaluation and the assessed event horizon. The existing 15-minute camera
lease and `geometry_supported` Queue gates are unchanged. Timers withdraw stale
planning results without requiring a new network response.

Green at NET requires direct line of sight from ISS to the launch site. The
orbital LVLH angle describes that site at NET, not a physical spacecraft window
or rocket tracking instruction. Clouds, optical detectability and window access
can still prevent a shot. The display never converts a nominal ascent-disk
intersection into a positive result.

A negative uses each rocket family's generic first-insertion model: all bearings
within its maximum downrange and altitude, expanded for ISS motion between
30-second samples plus a spatial margin. Every point must remain behind Earth.
The advertised NET and the union of the entire launch window plus early ascent
are screened independently. Neither excludes later burns or visibility outside
the model. Unknown timing, orbit, model, incomplete evaluation or intersection
remains unknown. No ascent corridor is fabricated from this envelope.

The accepting parser supports old artifacts without assessment. Older deployed
strict parsers reject the new field, so publish the new frontend first, then
update the separate publisher checkout. Existing tabs may need a reload to pick
up the new app; do not clear personal site data. Publisher policy 2 changes the
input identity once while preserving the persistent owner and receipts.
