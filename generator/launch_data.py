"""Launch Library 2 (LL2) ingestion for V3.0 rocket-launch passes.

Fetches the upcoming-launches feed from `ll.thespacedevs.com`, filters to
launches that are (a) "Go" / "Confirmed" enough to plan around, (b) have a
NET (No Earlier Than) window tight enough to predict ISS overhead geometry,
and (c) have explicit launchpad coordinates. Ships a `Launch` dataclass that
the pass-finding pipeline can treat as a synthetic target with a time
constraint (see /plan-eng-review 2026-05-05 for the architecture).

Hardening locked from the /autoplan + /plan-eng-review cycles:
- TTL-based file cache; fall back to cache on network error AND parse error
- Pinned schema fixture so a silent LL2 shape change fails tests loudly
- `compute_schema_hash()` over sorted keys at depth 2 — catches added or
  removed top-level / per-result fields without false-positiving on order
- Coordinate sanity: lat/lon must be finite + in valid bounds (rejects the
  NaN / Inf / out-of-range cases an attacker-controlled feed could send)
- Past-launch rejection at parse time: LL2 occasionally returns completed
  launches in the upcoming feed; skip them so cache-fallback after weeks
  of LL2 downtime doesn't surface historical entries

Future polish (not yet wired): ETag conditional GET (304 fallthrough). LL2
supports If-None-Match. Currently the file-TTL gate covers the steady-state
case; ETag would eliminate the 1 fresh fetch/hour against the rate budget.

Note: per ARCH-1 in the eng review, launches health (last_successful_fetch,
count_upcoming, schema_hash) is published via fields on the existing
`status.json` artifact rather than a separate `launches-health.json`. This
module exposes the values; main.py threads them into status_data.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import requests

LL2_DEFAULT_URL = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/"
LL2_FETCH_TIMEOUT_SECONDS = 15

# Status abbrevs that count as "actionable, plan around it." Everything else
# (TBD, Hold, Removed, Failed, etc.) is filtered out before pass-finding.
# LL2 status abbrev field is stable across the 2.2.0 schema.
LL2_GO_STATUS_ABBREVS = frozenset({"Go", "Confirmed"})

# How wide a window around t0 to ask find_passes about. The launch can slip
# anywhere within (window_start, window_end); the ISS overhead window is
# narrower. ±5 min covers Falcon-class launches that announce a tight T-0.
PASS_WINDOW_SECONDS = 300

# A launch with a NET window wider than this is "TBD next week" territory, not
# something we can confidently predict ISS overhead for. Must be <=
# PASS_WINDOW_SECONDS — if NET uncertainty exceeds the find_passes window,
# the geometry is meaningless (the real T-0 could fall outside the searched
# window). Adversarial review 2026-05-10 caught the original 1800s threshold
# allowing 30-min-uncertain launches to publish bogus pass entries.
NET_WINDOW_MAX_SECONDS = PASS_WINDOW_SECONDS

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Launch:
    """Filtered, normalized view of one LL2 launch result.

    Field choices map straight to what the synthetic-target pipeline needs:
    `t0` for find_passes window center, `site_lat`/`site_lon` for the target
    coordinates, `name`/`rocket_type`/`site_name` for the card render.
    `net_window_seconds` is the half-width derived from
    `(window_end - window_start) / 2`, exposed so the card can render
    "Window: ±N min" honestly.
    """

    id: str
    name: str
    t0: datetime
    net_window_seconds: int
    site_lat: float
    site_lon: float
    site_name: str
    rocket_type: str
    status_abbrev: str


def _parse_iso8601_z(text: str) -> datetime:
    """LL2 timestamps are ISO 8601 with trailing Z. fromisoformat needs +00:00."""
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def _parse_one_result(result: dict[str, Any], now: datetime | None = None) -> Launch | None:
    """Pull a single LL2 result into a Launch. Return None if any required
    field is missing OR if the row would produce invalid geometry — silently
    skipping is the right call for one bad row in a large response (vs
    failing the whole tick).

    Required fields: id, name, net (or window_start), window_start/end,
    status.abbrev, rocket.configuration.{name|full_name|family},
    pad.location.name, pad.{latitude,longitude}.

    Sanity rejections (added 2026-05-10 from adversarial + security review):
    - lat/lon must be finite + within geographic bounds. float("NaN") /
      float("Infinity") parse cleanly but break json.dumps downstream
      (status.json publication would fail) and silently corrupt great-circle
      distance comparisons (NaN < anything is False, so the launch would be
      filtered out with no signal that LL2 sent garbage).
    - t0 must be in the future. LL2 occasionally surfaces completed launches
      in the upcoming feed; if our cache is served back after weeks of LL2
      downtime, those launches would otherwise be reported as "upcoming"
      with closest_approach in the past.
    """
    n = now or datetime.now(tz=UTC)
    try:
        launch_id = result["id"]
        name = result["name"]
        # `net` is the headline T-0; if absent fall back to window_start.
        # Per LL2 docs, `net` is always present for non-removed launches.
        t0 = _parse_iso8601_z(result.get("net") or result["window_start"])
        # NET window: (window_end - window_start) / 2. If absent, treat as 0
        # (zero-width window — the launch is precisely scheduled).
        ws_raw = result.get("window_start")
        we_raw = result.get("window_end")
        if ws_raw and we_raw:
            ws = _parse_iso8601_z(ws_raw)
            we = _parse_iso8601_z(we_raw)
            net_window_seconds = max(0, int((we - ws).total_seconds() // 2))
        else:
            net_window_seconds = 0
        status_abbrev = result["status"]["abbrev"]
        rocket_type = (
            result["rocket"]["configuration"].get("full_name")
            or result["rocket"]["configuration"].get("name", "Unknown")
        )
        pad = result["pad"]
        site_name = pad["location"]["name"]
        site_lat = float(pad["latitude"])
        site_lon = float(pad["longitude"])
    except (KeyError, TypeError, ValueError) as exc:
        log.debug("LL2 result skipped (parse failure): %s", exc)
        return None

    if not (math.isfinite(site_lat) and math.isfinite(site_lon)):
        log.warning("LL2 result skipped (non-finite coords): id=%s lat=%s lon=%s",
                    launch_id, site_lat, site_lon)
        return None
    if abs(site_lat) > 90 or abs(site_lon) > 180:
        log.warning("LL2 result skipped (out-of-range coords): id=%s lat=%s lon=%s",
                    launch_id, site_lat, site_lon)
        return None
    if t0 <= n:
        log.debug("LL2 result skipped (t0 in past): id=%s t0=%s", launch_id, t0.isoformat())
        return None

    return Launch(
        id=launch_id,
        name=name,
        t0=t0,
        net_window_seconds=net_window_seconds,
        site_lat=site_lat,
        site_lon=site_lon,
        site_name=site_name,
        rocket_type=rocket_type,
        status_abbrev=status_abbrev,
    )


def filter_launches(launches: list[Launch]) -> list[Launch]:
    """Apply the actionable-status + tight-NET filters. Inclination filter
    happens later (find_passes returns no opportunities for sites the ISS
    can't pass over, which is the right encoding — no need to pre-filter
    here)."""
    out: list[Launch] = []
    for la in launches:
        if la.status_abbrev not in LL2_GO_STATUS_ABBREVS:
            continue
        if la.net_window_seconds > NET_WINDOW_MAX_SECONDS:
            continue
        out.append(la)
    return out


def parse_response(payload: dict[str, Any], now: datetime | None = None) -> list[Launch]:
    """Parse a full LL2 response into Launch objects. Skips malformed rows
    AND past-t0 rows; does NOT apply status / NET filters (those run
    separately so callers can audit the raw count).

    `now` parameter threaded through so the cache-fallback path can re-filter
    a stale cached response against the current wall clock — without it, a
    cache served after LL2 has been down for days would surface launches
    that have already happened.
    """
    results = payload.get("results", [])
    if not isinstance(results, list):
        log.warning("LL2 response 'results' is not a list (type=%s)", type(results).__name__)
        return []
    out: list[Launch] = []
    for r in results:
        if not isinstance(r, dict):
            continue
        parsed = _parse_one_result(r, now=now)
        if parsed is not None:
            out.append(parsed)
    return out


def compute_schema_hash(payload: dict[str, Any]) -> str:
    """Hash the SHAPE of the LL2 response (sorted keys at depth 2) so a
    silent schema drift is detectable even when individual launches keep
    parsing fine.

    Why depth 2 and not deeper:
    - Depth 1 alone misses per-result field changes (LL2's most common shape
      shift is adding/removing fields on `results[*]`).
    - Depth 3+ would false-positive on every variation in nested optional
      fields (some launches have `mission`, others don't).
    - Depth 2 captures top-level keys + the keys-of-the-first-result, which
      is what we actually parse against. Tested in test_launch_data.py.

    Deterministic: sorted keys at each level, joined as `k1,k2,k3|nested:k1,k2`.
    """
    parts: list[str] = []
    parts.append(",".join(sorted(payload.keys())))
    results = payload.get("results")
    if isinstance(results, list) and results and isinstance(results[0], dict):
        first = results[0]
        # Top-level keys of the first result.
        parts.append("results[]:" + ",".join(sorted(first.keys())))
        # One level deeper for the most-load-bearing nested objects we parse.
        for nested_key in ("status", "rocket", "pad"):
            nested = first.get(nested_key)
            if isinstance(nested, dict):
                parts.append(f"results[].{nested_key}:" + ",".join(sorted(nested.keys())))
    shape = "|".join(parts)
    return hashlib.sha256(shape.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class FetchResult:
    """Output of fetch_upcoming_launches. Carries the launches PLUS the
    metadata main.py threads into status.json (per ARCH-1 — no separate
    launches-health.json artifact)."""

    launches: list[Launch]
    last_successful_fetch: datetime | None
    schema_hash: str | None
    count_upcoming_unfiltered: int
    """Raw count BEFORE filter_launches() — useful for ops to tell the
    difference between 'LL2 returned nothing' and 'LL2 returned 50 TBD
    launches we filtered out.'"""


def fetch_upcoming_launches(
    cache_path: Path,
    ttl_hours: float = 1.0,
    now: datetime | None = None,
    url: str = LL2_DEFAULT_URL,
) -> FetchResult:
    """Fetch + cache + parse the LL2 upcoming-launches feed.

    Behavior matches generator/main.py:fetch_tle as closely as possible:
    fresh cache → return parsed cache. Cache stale → HTTP GET; on success,
    write cache + parse. On failure (network OR parse error), fall back to
    cache. Never raises — a tick should be able to publish without launches
    if LL2 is down.

    Etag note: LL2 supports `If-None-Match` for 304 responses. We don't use
    it yet because the file-TTL gate already covers the common case (we poll
    hourly, LL2 changes hourly at most). Etag would be a P3 polish to
    eliminate the 1 fresh fetch/hour entirely.
    """
    n = now or datetime.now(tz=UTC)
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    def _from_cache(reason: str) -> FetchResult:
        if not cache_path.exists():
            log.info("LL2: %s; no cache available, returning empty", reason)
            return FetchResult(
                launches=[],
                last_successful_fetch=None,
                schema_hash=None,
                count_upcoming_unfiltered=0,
            )
        try:
            text = cache_path.read_text()
            payload = json.loads(text)
            # Re-filter against the CURRENT wall clock — a cache served after
            # weeks of LL2 downtime would otherwise surface completed launches
            # as upcoming. parse_response with now=n drops past-t0 rows.
            launches = parse_response(payload, now=n)
            schema_hash = compute_schema_hash(payload)
            mtime = datetime.fromtimestamp(cache_path.stat().st_mtime, tz=UTC)
            log.info(
                "LL2: %s; serving %d launches from cache (mtime %s)",
                reason, len(launches), mtime.isoformat(),
            )
            return FetchResult(
                launches=launches,
                last_successful_fetch=mtime,
                schema_hash=schema_hash,
                count_upcoming_unfiltered=len(launches),
            )
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            log.warning("LL2: cache unreadable/corrupt (%s); returning empty", exc)
            return FetchResult(
                launches=[],
                last_successful_fetch=None,
                schema_hash=None,
                count_upcoming_unfiltered=0,
            )

    # Fresh cache → use it without hitting the network.
    if cache_path.exists():
        age_h = (n.timestamp() - cache_path.stat().st_mtime) / 3600.0
        if age_h < ttl_hours:
            return _from_cache(f"cache fresh ({age_h:.2f}h < {ttl_hours}h TTL)")

    # Stale cache (or no cache): try the network.
    try:
        resp = requests.get(url, timeout=LL2_FETCH_TIMEOUT_SECONDS)
        resp.raise_for_status()
        text = resp.text
        # Parse FIRST. If LL2 returned an HTML error page captured as 200 OR
        # a JSON shape we can't parse, fall back to cache (matches the
        # fetch_tle pattern; never overwrite a known-good cache with garbage).
        payload = json.loads(text)
        launches = parse_response(payload, now=n)
        schema_hash = compute_schema_hash(payload)
        cache_path.write_text(text)
        log.info(
            "LL2: fetched %d launches (schema_hash=%s)",
            len(launches), schema_hash,
        )
        return FetchResult(
            launches=launches,
            last_successful_fetch=n,
            schema_hash=schema_hash,
            count_upcoming_unfiltered=len(launches),
        )
    except (requests.RequestException, json.JSONDecodeError, ValueError, OSError) as exc:
        return _from_cache(f"network/parse failure: {exc}")
