# Launch Candidate Runbook

## Release Boundary

This release is map-only. The host runs a two-hour cache-only publisher. It does not send WhatsApp, change
Earth scoring, claim photographic detection, or infer a physical spacecraft
window. Source validation and notification activation are separate gates.

The existing Earth daemon defaults to 60 minutes. Its generation lock does not
span deployment. Do not run a second Earth generator against the same output.
Do not edit a watched production checkout while developing Python changes.

## Safe Diagnosis

From an isolated checkout with dependencies installed:

```sh
make PYTHON=.venv/bin/python launch-diag LAUNCH_DIAG_ARGS="--cache-dir /path/to/cache"
.venv/bin/python -m scripts.ascent_smoke --fixture tests/fixtures/launch_cases/progress-2018.json --json
```

Both commands are read-only: no fetch, cache repair, publication or message.
Exit 0 means complete evidence evaluation; exit 2 means missing/incomplete
evidence. A missing archive must report `HISTORICAL_EPHEMERIS_MISSING`. Never
substitute today's TLE for an observed historical event. JSON includes received,
parsed, evaluated, sampled-visible, unevaluated counts and reason codes.

`--now` requires timezone-qualified time and rejects a later source receipt.
An old cache without a matching hash receipt is labeled `SOURCE_AGE_MTIME_ONLY`.
Partial pages are `FEED_PAGINATED`, not a complete empty search result.

## Local Shadow Publication

```sh
.venv/bin/python -m scripts.launch_refresh --cache-dir /path/to/cache --output /path/to/launch-output
```

Only `launch/v/<revision>.json` and `launch/latest.json` are generated. The writer
refuses Earth `out/`, unknown public fields, altered revisions and older local
pointers. One lock spans immutable upload and pointer upload. Failed uploads
retain the local last-good pointer; remote acceptance can still be ambiguous.

No new launch network fetcher is installed. Refresh uses the existing LL2 cache,
whose normal source cadence is about one hour plus Earth-generation time.
Map/Upcoming can label a hash-receipted schedule current for less than three hours
from its original source check. This accommodates the two-hour publisher and
existing source cadence; it is not a promise against a late launch slip.
The independent 15-minute camera-evidence lifetime and all Queue gates are unchanged.
Map-only items still have unknown capture intervals/directions and never enter Queue.

## Remote Publication Gate

`--publish --remote <rclone-remote>` is an explicit side effect, never part of diagnosis.
The approved unattended invocation is:

```sh
python -m scripts.launch_refresh --scheduled --publish \
  --cache-dir /path/to/existing/cache --output /path/to/persistent/launch-output \
  --remote <rclone-remote>
```

Use exactly one owner and persistent output directory. The host's launchd job
runs at login and every 7200 seconds, with background priority/nice 10 and no
KeepAlive retry loop. It uses a pinned runtime checkout, separate from watched
Earth source. No additional LL2/TLE fetch, Earth generation, model or sender is called.

The scheduled path requires a stable, hash-matched source receipt less than
three hours old; future/missing/stale receipts fail closed. It consumes each
schedule-receipt/TLE identity once across restarts. Unchanged input checks remote
ownership but performs no compute or upload. Actual source timestamps are retained.
A refreshed source receipt may publish unchanged event content because the provider
really was checked again. Source timestamp rollback is rejected.

Each attempt journals its artifact before upload. The publisher reads and hashes
the remote artifact, requires the saved local pointer or exact journaled commit,
uploads immutable data first, rechecks ownership, flips the pointer last and
verifies readback. An accepted but unacknowledged commit is adopted without replay.
An expired unaccepted intent can be retired only when remote still equals local
last-good. Conflicting remote state stops publication. Lost local ownership is
not automatically adopted: restore/verify the saved receipt before enabling.
These checks are single-owner fencing, not cross-host compare-and-swap; never
install a second writer against this namespace. No new provider budget is needed
for cache-only publication; paginated source coverage remains explicitly incomplete.

Inspect timestamped JSON stdout/stderr and `.refresh-state.json` in the private
output directory. A healthy run reports `PUBLISHED` or `UNCHANGED_INPUT` and
`notified: false`; source/publication failures return exit 2. A stopped source or
publisher ages out visibly, rather than being made fresh by a timer.

The publisher accepts only `map_only`; an instruction-ready item is rejected.
Frontend support for future geometry-supported fixtures is not activation.
All views share one hash/schema-validated revision. Queue allows at most two
supported near-term captures, Upcoming covers 36 hours, Map covers seven days.
Unknown trajectories have a site marker but no invented ascent corridor.
Fresh, clean last-good data can retain a Queue slot within its source/artifact
validity; failed refreshes are labeled, not silently refreshed. A stricter
ready-only Queue policy is an explicit activation decision tracked in TODOS.md.

## Rollback And Acceptance

Disable the new launch consumer or remove its pointer to return to explicitly
tentative legacy launch cards. Do not rewind the Earth manifest or restart
messaging or unrelated agents. A last-good cached launch stays labeled as such
and cannot retain a current Queue slot after expiry.

To stop only automation, unload its launchd job; retain the output directory and
receipts for restart. Do not remove/recreate ownership state to bypass a conflict.
Keep a 48-hour map-only soak before claiming long-term unattended reliability.

Before production activation: complete browser checks of Map, Queue, Upcoming,
UTC rollover, mobile layouts, corrupt/stale/offline data, and overlapping event
identity. Record revision, cache source age, durations and exact checks. Observe
a map-only soak before considering notifications. No real positive photo case
has been validated by the new sampler in this release.
