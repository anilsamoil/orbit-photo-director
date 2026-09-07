# ISS Launch Photography: Map-First Plan

Approved 2026-09-07. Public implementation plan; private operational notes are
not part of this repository. CEO, design, developer-experience and engineering
reviews were completed before implementation, including independent Claude
consultations. Missing independent source evidence remains a release gate.

## Objective

Make scheduled launches discoverable without presenting guessed trajectories or
launch times as reliable capture instructions. Display distinct gold LAUNCH /
ASCENT identities across Map, Queue and Upcoming. Show UTC and source freshness.
Only validated, high-confidence positive opportunities may eventually notify.
This release does not implement or activate notifications.

## Implementation

1. Preserve actual launch bounds, precision and timing conflicts. Count missing,
   malformed, stale and partial feed evidence instead of claiming complete negatives.
2. Compute elevated-target angles from the full ISS position/velocity orbital
   frame. Remove generic 51.6-degree inclination and fabricated heading defaults.
3. Require trajectory provenance and a known branch. Sample actual conditional
   liftoff windows under explicit CPU/point budgets; label results sampled only.
4. Publish allowlisted, immutable launch artifacts through a separate pointer.
   Hold one local publisher lock through upload; no Earth output modification.
5. Share one validated launch revision across the frontend. Preserve last-good
   data with explicit age, reject hash/schema/regression errors, and expire Queue
   eligibility with live UTC. Preserve at least three of five ground Queue slots.
6. Show tentative candidates in Map (seven days) and Upcoming (36 hours), not
   unsupported immediate shots. Draw corridors only with supported provenance.
7. Provide a read-only diagnostic, reference registry and operational runbook.

## Verification

- Existing full Python, frontend and Worker suites.
- Independent vector fixtures, invalid inputs, elevated targets and handedness.
- Missing/partial/duplicate feed, timezone, replay, cache receipt and budget cases.
- Publication ordering, concurrent ownership, interrupted upload and old revisions.
- Browser Map/Queue/Upcoming identity, UTC detail, mobile layout, stale/offline
  handling, corrupt artifact fallback and no legacy confidence leakage.
- Public-file privacy check and preservation of unrelated production services.

## Later Gates

Adaptive narrow-crossing refinement, event-specific trajectories, independent
OEM/frame comparison and optical modes require source-backed references before
photographic recall or reliable instructions can be claimed. Historical image
cases remain incomplete until matching archived states are acquired.

Dedicated refresh scheduling, shared provider request budgeting, bounded
pagination, remote ownership recovery, optional outcomes and a 48-hour map soak
are tracked in TODOS.md. No additional source polling is introduced here.

The future proposed morning brief is 06:00 UTC, positive-only, with optional
feedback and at most three attempts per UTC day including a single correction
of prior invalid advice. Durable attempt receipts, crash/restart tests, validated
eligibility and explicit activation approval are required before enabling it.
Orbital-frame angles never imply a particular physical window is accessible.
