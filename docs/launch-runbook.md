# Launch Candidate Runbook

## Release Boundary

This release is map-only. It does not install a scheduler, send WhatsApp, change
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

No new launch network fetcher is installed. Refresh uses the existing LL2 cache;
its normal one-hour cadence can exceed the 15-minute candidate validity window.
The UI deliberately labels this stale instead of extending validity silently.

## Remote Publication Gate

`--publish --remote <rclone-remote>` is an explicit side effect, never part of
diagnosis. Do not activate it automatically. Use one persistent output directory
and exactly one publisher owner. The local lock cannot coordinate another host
or a different output directory. Before resuming after lost local state, compare
the remote pointer and immutable artifact with the saved local receipt; do not
assume an empty output directory grants ownership or replay an ambiguous write.
Automated ownership recovery, provider-wide request budgeting and a dedicated
launch refresh schedule remain tracked prerequisites for unattended deployment.

The publisher accepts only `map_only`; an instruction-ready item is rejected.
Frontend support for future geometry-supported fixtures is not activation.
All views share one hash/schema-validated revision. Queue allows at most two
supported near-term captures, Upcoming covers 36 hours, Map covers seven days.
Unknown trajectories have a site marker but no invented ascent corridor.

## Rollback And Acceptance

Disable the new launch consumer or remove its pointer to return to explicitly
tentative legacy launch cards. Do not rewind the Earth manifest or restart
messaging or unrelated agents. A last-good cached launch stays labeled as such
and cannot retain a current Queue slot after expiry.

Before production activation: complete browser checks of Map, Queue, Upcoming,
UTC rollover, mobile layouts, corrupt/stale/offline data, and overlapping event
identity. Record revision, cache source age, durations and exact checks. Observe
a map-only soak before considering notifications. No real positive photo case
has been validated by the new sampler in this release.
