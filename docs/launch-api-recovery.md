# Launch API Recovery

The existing Earth generator remains the only launch-feed fetch owner. Successful-cache TTL stays one hour. No model call or WhatsApp send is added; schedule/trajectory/visibility admission rules remain unchanged.

Next to `launches.json`, `.json.fetch.lock` serializes attempts without waiting and `.json.request.json` records the current attempt plus at most 24 earlier attempts. Only status, timestamps, exception class and selected non-sensitive cache headers are recorded. Do not delete these files to bypass a cooldown. Missing/corrupt/unwritable control state fails closed when an attempt cannot be safely reserved; existing good cache remains usable.

Attempts are reserved before the GET with a 15-minute minimum interval, including after process loss. Errors back off 15, 30, 60, then at most 120 minutes; a valid longer server `Retry-After` is honored, including HTTP dates. Cooldown uses wall clock, not the generator's older tick-start timestamp. There is no inline retry, sleep or redirect follow. Success resets the failure count. The upstream quota failure's historical cause is not claimed fixed; these receipts make a recurrence diagnosable.

The separate scheduled publisher uses only existing hash-matched source receipts. Set the existing `com.astroanil.opd-launch-refresh` launchd job's `StartInterval` to **600 seconds**, preserving its label, pinned checkout, arguments, ownership state and all other settings. Wait until idle, back up the plist, lint the edited copy, and reload only that job. Never add another publisher. Unchanged data does not upload or renew freshness, but still performs its normal remote ownership readback; expect up to 144 checks/day rather than 24. No LL2 request is made by this path.

Ten-minute checks bound ordinary local publication phase delay, not upstream outages or Mac sleep. Old schedules still expire at three hours and camera evidence at fifteen minutes. Updating the source cannot by itself establish a photographic opportunity.

## Verification and Deployment

Run `pytest tests/ --cov=generator --cov-fail-under=85` and `ruff check generator/ tests/`. The request-control tests cover throttle headers, restart, overlapping consumers, interrupted requests, corrupt/unwritable state, recovery and last-good-cache preservation. Publisher tests forbid source fetches and verify repeated ten-minute no-ops, new receipt consumption and expiry refusal. Use the existing synthetic browser QA server for fresh/stale launch presentation; do not send test alerts.

Work in an isolated checkout: the live generator watches Python mtimes and restarts when they change. Promote reviewed code while its tick is idle, retain a rollback copy, verify the new process and its first genuine request receipt, then verify source hash and the existing publisher's acknowledgement. Update the daily review's expected cadence to 600 seconds; do not add a monitoring job.

Rollback restores the previous generator source and the backed-up publisher plist while idle. Retain launch publication state and last-good source receipts. Any rollback to a fetcher that lacks cooldown support must wait until the recorded `next_attempt_at`; do not turn recovery into an extra request. Provider outages remain visible, and existing messaging, fantasy and remote-access services are outside this change.
