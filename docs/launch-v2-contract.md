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
      t_offset_seconds: number | null;
      look: {frame: 'orbital-lvlh'; azimuth_deg: number; off_nadir_deg: number} | null;
    };
    window: {verdict: 'too_far' | 'unknown'; reason: string};
  };
};
```

UI ownership: one shared store and one pointer refresh cycle for all views, atomic replacement only after hash/schema/revision validation. Preserve last-good on fetch failure, but always label freshness against real clock. Persist only this common artifact for offline use. Launch cards bypass personal ground-target/distance filters; no duplicate legacy launch cards when v2 is available. Legacy launch renderer must suppress probability/score, false exact time and physical-window labels even in fallback.

Queue90min: only valid, future geometry_supported capture intervals; maximum2launch cards in5slots, ground gets at least3when available. Stable start/event_id ordering. Upcoming36h and Map: include a launch only when the brief verdict is chance. Pins follow that selection. Keep unknown trajectory site marker but no fabricated corridor. Upcoming may retain clearly expired launch for30min. Full-contrast stale/unknown labels. No percent or star rating for launches. Gold hue plus text LAUNCH/ASCENT and explicit MAP ONLY status. Clicking marker/card opens the same facts/revision in all views; no real window-access promise. Direction is orbital-relative, not station body orientation.

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

Green requires a Go or Confirmed launch, minute or second precision, a TLE
within 24 hours, and a closest ground range under 500 km with a clear line of
sight from 300 seconds before NET until 120 seconds after it. `t_offset_seconds`
is that instant minus NET. The orbital LVLH angle describes the pad at that
instant, not a physical spacecraft window or rocket tracking instruction. A pad
that is only inside the limb at NET is not a shot. `SITE_IN_VIEW_AT_NET` remains
accepted so an artifact from the previous publisher still parses. Clouds, optical
detectability and window access can still prevent a shot. The display never converts a nominal ascent-disk
intersection into a positive result.

A negative uses each rocket family's generic first-insertion model: all bearings
within its maximum downrange and altitude, expanded for ISS motion between
30-second samples plus a spatial margin. Every point must remain behind Earth.
The advertised NET and the union of the entire launch window plus early ascent
are screened independently. Neither excludes later burns or visibility outside
the model. Unknown timing, orbit, model, incomplete evaluation or intersection
remains unknown. No ascent corridor is fabricated from this envelope.

The frontend parser accepts schema 3 catalogs and schema 2 artifacts.
The publisher emits schema 3 and still accepts a schema 2 body. A schema 3 body
carries `schedule_valid_until` (75 minutes) and `geometry_valid_until` (15 minutes).
The pointer stays schema 2, and its `valid_until` equals `geometry_valid_until`.
The parser allows a schedule lease up to three hours. Each shot envelope includes
`lens` (`telephoto` or `wide`) and `lens_reason`. A `night_engine` shot stays scored;
its item carries `NIGHT_ENGINE_UNVALIDATED` until that mode is calibrated. An ascent
envelope requires `direction.kind` of `published`, `iss_plane`, or `hazard_area`.
A pad envelope has an empty track. Unknown keys are rejected on both versions. A hash
mismatch keeps the last good artifact.

The accepting parser supports old artifacts without assessment. Older deployed
strict parsers reject the new field, so publish the new frontend first, then
update the separate publisher checkout. Existing tabs may need a reload to pick
up the new app; do not clear personal site data. Publisher policy 3 changes the
input identity once while preserving the persistent owner and receipts.
