"""Bounded, no-network launch evidence shared by diagnostics and map publication.

The first release is map-only. A profile and an orbit inclination are NOT
independent evidence of a launch azimuth, optical detectability or window access.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .ascent import (
    INTERPOLATION_CADENCE_SECONDS,
    SunState,
    build_ascent_trajectory,
    rocket_position_at,
    rocket_sun_state,
    tangent_clearance,
)
from .ascent_profiles import match_rocket
from .launch_data import LL2_GO_STATUS_ABBREVS, Launch, parse_response, validate_feed
from .orbit import TLE, _ensure_utc, propagate

HORIZON_HOURS = 7 * 24
MAX_EVENTS = 100
MAX_LIFTOFF_SECONDS = 6 * 3600
MAX_POINTS_EVENT = 50_000
MAX_POINTS_RUN = 250_000
COMPUTE_SECONDS = 15
VALID_SECONDS = 900
LL2_SOURCE = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/"


def utc(value: datetime) -> str:
    _ensure_utc(value)
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"
    ).encode()


class EvaluationBudget:
    def __init__(
        self,
        *,
        max_points: int = MAX_POINTS_RUN,
        seconds: float = COMPUTE_SECONDS,
        clock: Callable = time.monotonic,
    ):
        self.clock = clock
        self.deadline = clock() + seconds
        self.max_points = max_points
        self.points = 0

    def take(self) -> bool:
        if self.points >= self.max_points or self.clock() >= self.deadline:
            return False
        self.points += 1
        return True


def evaluate_liftoff_window(
    launch: Launch,
    tle: TLE,
    budget: EvaluationBudget,
    *,
    liftoff_step: int = 60,
    ascent_step: int = INTERPOLATION_CADENCE_SECONDS,
) -> dict:
    """Conditional sampled geometry, never a probability or a guaranteed union.

    Only explicit azimuth + source permits trajectory evaluation. Inclination
    alone does not resolve direction/branch. A coarse grid can miss a narrow
    crossing, so every result is explicitly sampled/map-only in this release.
    """
    from .launch_geometry import look_direction_at

    if liftoff_step < 1 or ascent_step < 1:
        raise ValueError("sampling steps must be positive")
    reasons = list(launch.timing_reasons)
    profile = match_rocket({"full_name": launch.rocket_type})
    if profile is None:
        reasons.append("PROFILE_UNKNOWN")
    azimuth = launch.launch_azimuth_deg
    if (
        azimuth is None
        or not math.isfinite(azimuth)
        or not 0 <= azimuth < 360
        or not launch.trajectory_source
    ):
        reasons.append("TRAJECTORY_UNVERIFIED")
    start, end = launch.window_start, launch.window_end
    if start is None or end is None:
        reasons.append("WINDOW_UNKNOWN")
    elif end < start or start < launch.t0 or (end - start).total_seconds() > MAX_LIFTOFF_SECONDS:
        reasons.append("TIME_CONFLICT" if end < start or start < launch.t0 else "WINDOW_TOO_WIDE")
    if reasons:
        return {
            "intervals": [],
            "points": [],
            "reasons": sorted(set(reasons)),
            "evaluated": False,
            "sample_count": 0,
        }
    span = int((end - start).total_seconds())
    offsets = sorted({*range(0, span + 1, liftoff_step), span})
    climb_offsets = sorted(
        {*range(0, profile.insertion_t_seconds + 1, ascent_step), profile.insertion_t_seconds}
    )
    intervals: list[dict] = []
    counts: Counter = Counter()
    consumed = 0
    incomplete = False

    def flush(visible: list[tuple[datetime, dict]], liftoff: datetime) -> None:
        if visible:
            peak, look = visible[len(visible) // 2]
            intervals.append(
                {
                    "start": utc(visible[0][0]),
                    "peak": utc(peak),
                    "end": utc(visible[-1][0]),
                    "liftoff_start": utc(liftoff),
                    "liftoff_end": utc(liftoff),
                    "look": look,
                }
            )
            visible.clear()

    for offset in offsets:
        liftoff = start + timedelta(seconds=offset)
        visible: list[tuple[datetime, dict]] = []

        for climb in climb_offsets:
            if consumed >= MAX_POINTS_EVENT or not budget.take():
                incomplete = True
                break
            consumed += 1
            when = liftoff + timedelta(seconds=climb)
            lat, lon, alt, _ = rocket_position_at(
                profile, climb, launch.site_lat, launch.site_lon, azimuth
            )
            iss = propagate(tle, when)
            if not tangent_clearance(iss, lat, lon, alt):
                counts["EARTH_OCCULTED"] += 1
                flush(visible, liftoff)
                continue
            if rocket_sun_state(when, lat, lon, alt) == SunState.UMBRA:
                counts["OPTICAL_MODE_UNVALIDATED"] += 1
                flush(visible, liftoff)
                continue
            visible.append((when, look_direction_at(tle, when, lat, lon, alt)))
        flush(visible, liftoff)
        if incomplete:
            break
    reasons = ["SAMPLED_GEOMETRY_ONLY", "OPTICAL_VALIDATION_PENDING"]
    if incomplete:
        reasons.append("EVALUATION_INCOMPLETE")
    elif not intervals:
        reasons.extend(counts or ["NO_SAMPLED_GEOMETRY"])
    points = [
        {"lat": p.lat, "lon": p.lon, "alt_km": p.alt_km, "t_offset_seconds": p.t_offset_seconds}
        for p in build_ascent_trajectory(profile, launch.site_lat, launch.site_lon, azimuth)
    ]
    return {
        "intervals": intervals,
        "points": points,
        "reasons": sorted(set(reasons)),
        "evaluated": not incomplete,
        "sample_count": consumed,
    }


def build_launch_artifact(
    payload: dict,
    tle: TLE | None,
    now: datetime,
    *,
    fetched_at: datetime | None = None,
    source_reasons: tuple[str, ...] = (),
) -> dict:
    _ensure_utc(now)
    validate_feed(payload)
    if fetched_at is not None:
        _ensure_utc(fetched_at)
    parsed_launches = parse_response(payload, now=now)
    horizon = now + timedelta(hours=HORIZON_HOURS)
    reasons = list(source_reasons)
    ids = Counter(la.id for la in parsed_launches)
    launches = [la for la in parsed_launches if ids[la.id] == 1]
    if len(launches) != len(parsed_launches):
        reasons.append("DUPLICATE_EVENT_IDS")
    if payload.get("next") or payload.get("count", len(payload["results"])) > len(
        payload["results"]
    ):
        reasons.append("FEED_PAGINATED")
    if fetched_at is None:
        reasons.append("SOURCE_AGE_UNKNOWN")
    elif fetched_at > now:
        reasons.append("REPLAY_SOURCE_MISMATCH")
    elif (now - fetched_at).total_seconds() > VALID_SECONDS:
        reasons.append("SOURCE_STALE")
    if tle is None:
        reasons.append("EPHEMERIS_MISSING")
    elif abs((now - tle.epoch).total_seconds()) > 24 * 3600:
        reasons.append("EPHEMERIS_STALE")
    near = [la for la in launches if la.t0 <= horizon]
    if len(near) > MAX_EVENTS:
        reasons.append("EVENT_LIMIT")
    budget = EvaluationBudget()
    items: list[dict] = []
    evaluated = visible = 0
    for la in sorted(near, key=lambda x: (x.t0, x.id))[:MAX_EVENTS]:
        why = list(la.timing_reasons)
        if la.status_abbrev not in LL2_GO_STATUS_ABBREVS:
            why.append("LAUNCH_UNCONFIRMED")
        result = {"intervals": [], "points": [], "evaluated": False, "reasons": []}
        if (
            tle is not None
            and not (set(reasons) & {"EPHEMERIS_STALE", "REPLAY_SOURCE_MISMATCH"})
            and not why
        ):
            if abs((la.t0 - tle.epoch).total_seconds()) > 24 * 3600:
                why.append("EPHEMERIS_OUTSIDE_VALIDATED_HORIZON")
            else:
                try:
                    result = evaluate_liftoff_window(la, tle, budget)
                except (ValueError, RuntimeError, ArithmeticError):
                    why.append("GEOMETRY_INVALID")
        elif la.launch_azimuth_deg is None:
            why.append("TRAJECTORY_UNVERIFIED")
        why.extend(result["reasons"])
        # Feed completeness does not change a physical fact, but this first
        # release deliberately does not issue instructions from partial data.
        why.extend(reasons)
        evaluated += int(result["evaluated"])
        visible += int(bool(result["intervals"]))
        item = {
            "event_id": la.id,
            "name": la.name,
            "rocket": la.rocket_type,
            "site": {"name": la.site_name, "lat": la.site_lat, "lon": la.site_lon},
            "status": "map_only",
            "reason_codes": sorted(set(why + ["VALIDATION_PENDING"])),
            "launch_window": {
                "net": utc(la.t0),
                "start": utc(la.window_start) if la.window_start else None,
                "end": utc(la.window_end) if la.window_end else None,
                "precision": la.time_precision,
            },
            "capture_intervals": result["intervals"],
            "trajectory": {
                "quality": "approximate" if result["points"] else "unknown",
                "source": la.trajectory_source,
                "points": result["points"],
            },
            "sources": [
                {
                    "kind": "launch_schedule",
                    "url": LL2_SOURCE,
                    "fetched_at": utc(fetched_at) if fetched_at else None,
                }
            ],
        }
        item["revision"] = hashlib.sha256(canonical_bytes(item)).hexdigest()[:24]
        items.append(item)
    # Count malformed rows separately from completed events; both were once
    # silently dropped by the legacy list-only parser.
    all_parseable = parse_response(payload, now=datetime(1970, 1, 1, tzinfo=UTC))
    malformed = len(payload["results"]) - len(all_parseable)
    if malformed:
        reasons.append("MALFORMED_ROWS")
    artifact = {
        "schema_version": 2,
        "generated_at": utc(now),
        "valid_until": utc(now + timedelta(seconds=VALID_SECONDS)),
        "coverage": {
            "complete": not reasons and evaluated == len(items),
            "from": utc(now),
            "until": utc(horizon),
            "fetched_at": utc(fetched_at) if fetched_at else None,
            "received": len(payload["results"]),
            "parsed": len(launches),
            "evaluated": evaluated,
            "visible": visible,
            "unevaluated": len(items) - evaluated,
            "reasons": sorted(
                set(reasons + (["UNEVALUATED_CANDIDATES"] if evaluated < len(items) else []))
            ),
        },
        "items": items,
    }
    artifact["revision"] = hashlib.sha256(canonical_bytes(artifact)).hexdigest()[:24]
    return artifact


def read_cached_artifact(cache_dir: Path, now: datetime, *, replay: bool = False) -> dict:
    """Never fetches, fixes caches, writes output, publishes or sends."""
    cache = cache_dir / "launches.json"
    try:
        if cache.stat().st_size > 8_000_000:
            raise ValueError("cache too large")
        raw = cache.read_bytes()
        payload = json.loads(raw)
        validate_feed(payload)
    except FileNotFoundError as exc:
        raise ValueError("MISSING_CACHE") from exc
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError("CORRUPT_CACHE") from exc
    fetched = datetime.fromtimestamp(cache.stat().st_mtime, UTC)
    source_reasons = ("SOURCE_AGE_MTIME_ONLY",)
    try:
        receipt = json.loads(cache.with_suffix(".json.receipt.json").read_text())
        if receipt["sha256"] == hashlib.sha256(raw).hexdigest():
            fetched = datetime.fromisoformat(receipt["fetched_at"].replace("Z", "+00:00"))
            _ensure_utc(fetched)
            source_reasons = ()
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        pass
    if replay and fetched > now:
        raise ValueError("REPLAY_SOURCE_MISMATCH")
    try:
        tle = TLE.from_text((cache_dir / "iss.tle").read_text())
    except (OSError, ValueError):
        tle = None
    return build_launch_artifact(
        payload, tle, now, fetched_at=fetched, source_reasons=source_reasons
    )
