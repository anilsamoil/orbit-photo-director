"""Schema 3 launch catalog: tiers, score ranges, and shot envelopes."""

from __future__ import annotations

import hashlib
import math
from datetime import UTC, datetime, timedelta

from .ascent import (
    SunState,
    _surface_sun_elevation_deg,
    plume_angle_score,
    rocket_sun_state,
)
from .ascent_profiles import match_rocket
from .launch_assessment import PLANNING_VALID_SECONDS, build_planning_assessment
from .launch_data import (
    SCHEDULE_STATUS_ABBREVS,
    Launch,
    _parse_iso8601_z,
    parse_response,
    retained_launch_rows,
    validate_feed,
)
from .launch_direction import (
    Destination,
    Direction,
    DirectionKind,
    IssPlaneDirection,
    NoDirection,
    destination_from_ll2,
    direction_for,
)
from .launch_evidence import (
    HORIZON_HOURS,
    MAX_EVENTS,
    MAX_LIFTOFF_SECONDS,
    VALID_SECONDS,
    EvaluationBudget,
    canonical_bytes,
    utc,
)
from .launch_geometry import look_direction_at
from .launch_opportunities import (
    Pad,
    Subject,
    sample_directed,
    sample_liftoff,
)
from .orbit import EARTH_RADIUS_KM, TLE, Position, _ensure_utc, great_circle_km, propagate

SCHEDULE_LEASE_SECONDS = 75 * 60
GEOMETRY_LEASE_SECONDS = VALID_SECONDS
SHOT_TLE_AGE_H = 24.0
LIKELY_TLE_AGE_H = 48.0
SHOT_SCORE_LOW = 50.0
LIKELY_SCORE_LOW = 25.0
ORBITAL_SPEED_KM_S = 7.66
_WEIGHTS = {"A": 30, "C": 25, "D": 20, "M": 15, "R": 10}
_WINDOWS = ((1, -90.0), (2, -30.0), (3, 30.0), (4, 90.0), (5, 150.0), (6, -150.0))
_LIGHT = {
    "twilight_plume": "Twilight plume",
    "day_plume": "Daylight plume",
    "night_engine": "Night engine",
    "pad_day": "Daytime pad",
    "pad_night": "Night pad",
}
_TIERS = ("shot", "likely", "watch", "unassessed", "none")


def build_launch_catalog(
    payload: dict,
    tle: TLE | None,
    now: datetime,
    *,
    fetched_at: datetime | None = None,
    source_reasons: tuple[str, ...] = (),
) -> dict:
    """Publish one schema 3 catalog. Schema 2 stays on build_launch_artifact."""
    _ensure_utc(now)
    validate_feed(payload)
    if fetched_at is not None:
        _ensure_utc(fetched_at)
    horizon = now + timedelta(hours=HORIZON_HOURS)
    pairs = retained_launch_rows(payload, now)
    near = [(launch, row) for launch, row in pairs if launch.t0 <= horizon]
    reasons = list(source_reasons)
    paged = _horizon_paged(payload, horizon)
    if not paged:
        reasons.append("FEED_PAGINATED")
    if fetched_at is None:
        reasons.append("SOURCE_AGE_UNKNOWN")
    elif fetched_at > now:
        reasons.append("REPLAY_SOURCE_MISMATCH")
    elif (now - fetched_at).total_seconds() > SCHEDULE_LEASE_SECONDS:
        reasons.append("SOURCE_STALE")
    if tle is None:
        reasons.append("EPHEMERIS_MISSING")
    elif abs((now - tle.epoch).total_seconds()) > SHOT_TLE_AGE_H * 3600:
        reasons.append("EPHEMERIS_STALE")
    if len(near) > MAX_EVENTS:
        reasons.append("EVENT_LIMIT")
    all_parseable = parse_response(payload, now=datetime(1970, 1, 1, tzinfo=UTC))
    if len(payload["results"]) - len(all_parseable):
        reasons.append("MALFORMED_ROWS")

    budget = EvaluationBudget()
    items: list[dict] = []
    evaluated = 0
    chosen = sorted(near, key=lambda pair: (pair[0].t0, pair[0].id))[:MAX_EVENTS]
    for launch, row in chosen:
        item, finished = _item(
            launch, row, tle, now, fetched_at, tuple(source_reasons), budget,
        )
        evaluated += int(finished)
        items.append(item)
    if evaluated < len(items):
        reasons.append("EVALUATION_INCOMPLETE")
    counts = {tier: sum(item["tier"] == tier for item in items) for tier in _TIERS}
    schedule_until, geometry_until = _leases(now, fetched_at)
    catalog = {
        "schema_version": 3,
        "generated_at": utc(now),
        "schedule_valid_until": utc(schedule_until),
        "geometry_valid_until": utc(geometry_until),
        "tle": _tle_block(tle),
        "coverage": {
            "from": utc(now),
            "until": utc(horizon),
            "schedule_fetched_at": utc(fetched_at) if fetched_at else None,
            "pages": 1,
            "received": len(payload["results"]),
            "listed": len(items),
            "evaluated": evaluated,
            "tier_counts": counts,
            "complete": paged,
            "reasons": sorted(set(reasons)),
        },
        "items": items,
    }
    catalog["revision"] = hashlib.sha256(canonical_bytes(catalog)).hexdigest()[:24]
    return catalog


def _item(
    launch: Launch,
    raw: dict,
    tle: TLE | None,
    now: datetime,
    fetched_at: datetime | None,
    source_reasons: tuple[str, ...],
    budget: EvaluationBudget,
) -> tuple[dict, bool]:
    reasons = list(launch.timing_reasons)
    if launch.status_abbrev not in SCHEDULE_STATUS_ABBREVS:
        reasons.append("LAUNCH_UNCONFIRMED")
    destination_iss = destination_from_ll2(raw) is Destination.ISS
    g1 = _g1(launch)
    shots: list[dict] = []
    direction: Direction = NoDirection()
    finished = True
    if g1 and tle is not None:
        if budget.clock() >= budget.deadline:
            reasons.append("EVALUATION_INCOMPLETE")
            finished = False
        else:
            try:
                shots, direction = _shots(launch, tle, destination_iss, reasons)
            except (ValueError, RuntimeError, ArithmeticError):
                reasons.append("GEOMETRY_INVALID")
                shots = []
                direction = NoDirection()
    elif g1 and tle is None:
        reasons.append("EPHEMERIS_MISSING")
    if direction.kind is DirectionKind.NONE:
        reasons.append("TRAJECTORY_UNVERIFIED")

    age_h = None if tle is None else abs((launch.t0 - tle.epoch).total_seconds()) / 3600.0
    capture_ages = [
        _capture_age_h(shot, tle.epoch) for shot in shots if tle is not None
    ]
    if (capture_ages and max(capture_ages) > SHOT_TLE_AGE_H) or (
        not capture_ages and age_h is not None and age_h > SHOT_TLE_AGE_H
    ):
        reasons.append("TLE_AGE_OVER_24H")
    g2 = bool(shots)
    fresh_negative = False
    blocked = {"GEOMETRY_INVALID", "EVALUATION_INCOMPLETE", "EPHEMERIS_MISSING"}
    stale = tle is None or age_h is None or age_h > SHOT_TLE_AGE_H
    if (
        g1 and not g2 and finished and not stale and not blocked.intersection(reasons)
        and _can_exclude(launch, g1, g2, finished, age_h, reasons)
    ):
        fresh_negative = _disk_negative(launch, tle, now, fetched_at, budget, source_reasons)
        reasons.append("NOMINAL_ASCENT_TOO_FAR" if fresh_negative else "NO_LINE_OF_SIGHT")
    if any(shot["light"] == "night_engine" for shot in shots):
        reasons.append("NIGHT_ENGINE_UNVALIDATED")

    usable = _receipt_usable(now, fetched_at)
    tier = _tier(
        launch, g1, shots, tle.epoch if tle is not None else None,
        fresh_negative, finished, usable,
    )
    item = {
        "event_id": launch.id,
        "name": launch.name,
        "rocket": launch.rocket_type,
        "site": {"name": launch.site_name, "lat": launch.site_lat, "lon": launch.site_lon},
        "schedule": _schedule(launch, raw),
        "direction": _direction_block(direction),
        "tier": tier,
        "why": _why(tier, shots, reasons),
        "reasons": sorted(set(reasons)),
        "shots": shots,
    }
    item["revision"] = hashlib.sha256(canonical_bytes(item)).hexdigest()[:24]
    return item, finished


def _can_exclude(
    launch: Launch,
    g1: bool,
    g2: bool,
    finished: bool,
    age_h: float | None,
    reasons: list[str],
) -> bool:
    precision = (launch.time_precision or "").lower()
    capped = launch.status_abbrev == "TBC" or precision == "hour"
    return bool(
        g1 and not g2 and finished and not capped and age_h is not None and age_h <= SHOT_TLE_AGE_H
        and "GEOMETRY_INVALID" not in reasons and "EVALUATION_INCOMPLETE" not in reasons
        and launch.status_abbrev in {"Go", "Confirmed"}
        and precision in {"second", "minute"}
    )


def _g1(launch: Launch) -> bool:
    precision = (launch.time_precision or "").lower()
    start, end = launch.window_start, launch.window_end
    if (
        launch.status_abbrev not in SCHEDULE_STATUS_ABBREVS
        or precision not in {"second", "minute", "hour"}
    ):
        return False
    if start is None or end is None or end < start or launch.t0 < start or launch.t0 > end:
        return False
    return (end - start).total_seconds() <= MAX_LIFTOFF_SECONDS


def _tier(
    launch: Launch,
    g1: bool,
    shots: list[dict],
    epoch: datetime | None,
    fresh_negative: bool,
    finished: bool,
    usable: bool,
) -> str:
    if not g1:
        return "unassessed"
    precision = (launch.time_precision or "").lower()
    if launch.status_abbrev == "TBC" or precision == "hour" or not finished or not usable:
        return "watch"
    if not shots:
        return "none" if fresh_negative else "watch"
    concrete = launch.status_abbrev in {"Go", "Confirmed"} and precision in {"second", "minute"}
    liftoffs = _liftoffs(launch)
    if (
        concrete and epoch is not None
        and _covers(shots, liftoffs, epoch, SHOT_SCORE_LOW, SHOT_TLE_AGE_H, True)
    ):
        return "shot"
    if (
        concrete and epoch is not None
        and _covers(shots, liftoffs, epoch, LIKELY_SCORE_LOW, LIKELY_TLE_AGE_H, False)
    ):
        return "likely"
    return "watch"


def _covers(
    shots: list[dict],
    liftoffs: tuple[datetime, ...],
    epoch: datetime,
    score_low: float,
    max_age_h: float,
    need_robust: bool,
) -> bool:
    if not liftoffs:
        return False
    for liftoff in liftoffs:
        stamp = utc(liftoff)
        best = _best([shot for shot in shots if shot["liftoff"] == stamp])
        if best is None or best["score"]["low"] < score_low:
            return False
        if need_robust and not best["confidence"]["robust"]:
            return False
        if _capture_age_h(best, epoch) > max_age_h:
            return False
    ordered = sorted(liftoffs)
    for left, right in zip(ordered, ordered[1:], strict=False):
        gap = (right - left).total_seconds()
        if gap <= 0:
            continue
        left_shot = _best([shot for shot in shots if shot["liftoff"] == utc(left)])
        right_shot = _best([shot for shot in shots if shot["liftoff"] == utc(right)])
        if left_shot is None or right_shot is None:
            return False
        if gap > _span_seconds(left_shot) and gap > _span_seconds(right_shot):
            return False
    return True


def _span_seconds(shot: dict) -> float:
    start = _parse_iso8601_z(shot["start"])
    end = _parse_iso8601_z(shot["end"])
    return max(0.0, (end - start).total_seconds())


def _shots(
    launch: Launch, tle: TLE, destination_iss: bool, reasons: list[str],
) -> tuple[list[dict], Direction]:
    profile = match_rocket({"full_name": launch.rocket_type})
    if destination_iss and profile is None:
        reasons.append("PROFILE_UNKNOWN")
    pad = Pad(launch.site_lat, launch.site_lon)

    def observer(when: datetime) -> Position:
        return propagate(tle, when)

    shots: list[dict] = []
    ascent_directions: list[tuple[dict, Direction]] = []
    for liftoff in _liftoffs(launch):
        direction: Direction = NoDirection()
        if destination_iss and profile is not None:
            try:
                direction = direction_for(
                    tle, liftoff, launch.site_lat, launch.site_lon, Destination.ISS,
                )
            except (ValueError, RuntimeError, ArithmeticError):
                reasons.append("GEOMETRY_INVALID")
                direction = NoDirection()
        try:
            if isinstance(direction, IssPlaneDirection) and profile is not None:
                scenario = sample_directed(liftoff, observer, pad, profile, direction)
            else:
                scenario = sample_liftoff(liftoff, observer, pad, None)
        except (ValueError, RuntimeError, ArithmeticError):
            reasons.append("GEOMETRY_INVALID")
            continue
        for span in scenario.spans:
            shot = _envelope(span, scenario, tle)
            if shot is None:
                continue
            shots.append(shot)
            if shot["subject"] == "ascent" and isinstance(direction, IssPlaneDirection):
                ascent_directions.append((shot, direction))
    if not ascent_directions:
        return shots, NoDirection()
    best_ascent = _best([shot for shot, _direction in ascent_directions])
    chosen = next(direction for shot, direction in ascent_directions if shot is best_ascent)
    return shots, chosen


def _liftoffs(launch: Launch) -> tuple[datetime, ...]:
    start, end = launch.window_start, launch.window_end
    if (
        start is None or end is None or end < start
        or launch.t0 < start or launch.t0 > end
        or (end - start).total_seconds() > MAX_LIFTOFF_SECONDS
    ):
        return ()
    earliest = max(start, launch.t0)
    found: list[datetime] = []
    for when in (earliest, launch.t0, end):
        if earliest <= when <= end and when not in found:
            found.append(when)
    return tuple(found)


def _envelope(span, scenario, tle: TLE) -> dict | None:
    sight = span.closest
    try:
        look = look_direction_at(tle, sight.when, sight.lat, sight.lon, sight.alt_km)
        iss = propagate(tle, sight.when)
    except (ValueError, RuntimeError, ArithmeticError):
        return None
    duration = max(0.0, (span.end - span.start).total_seconds())
    age_h = _age_hours(span.start, span.end, tle.epoch)
    sigma = _sigma_km(age_h)
    timing = sigma / ORBITAL_SPEED_KM_S
    start, best, end = utc(span.start), utc(sight.when), utc(span.end)
    if best < start:
        best = start
    if end < best:
        end = best
    lens, lens_reason = _lens(sight)
    return {
        "subject": sight.subject.value,
        "liftoff": utc(span.liftoff),
        "start": start,
        "best": best,
        "end": end,
        "best_offset_s": int(sight.t_offset_s),
        "look": {
            "frame": "orbital-lvlh",
            "azimuth_deg": _angle(look["azimuth_deg"], 0.0, 360.0),
            "off_nadir_deg": _angle(look["off_nadir_deg"], 0.0, 180.0),
        },
        "window": _window(float(look["azimuth_deg"]), float(look["off_nadir_deg"])),
        "slant_km": _angle(sight.slant_km, 0.0, 21000.0, places=1),
        "limb_margin_deg": _angle(sight.limb_margin_deg, -180.0, 180.0),
        "plume_mrad": None if sight.plume_mrad is None else _angle(sight.plume_mrad, 0.0, 1000.0),
        "light": sight.light.value,
        "lens": lens,
        "lens_reason": lens_reason,
        "track": _track(scenario, span),
        "score": _score(sight, iss, duration),
        "confidence": {
            "tle_age_h": round(age_h, 3),
            "along_track_sigma_km": round(sigma, 3),
            "timing_sigma_s": round(timing, 3),
            "robust": duration >= 4.0 * timing,
        },
    }


def _score(sight, iss: Position, duration_s: float) -> dict:
    terms = {
        "A": _pair(_angular(sight, iss)),
        "C": _pair(_contrast(sight, iss)),
        "D": _pair(_cap(duration_s / 60.0)),
        "M": _pair(_cap(sight.limb_margin_deg / 5.0)),
        "R": _pair(_cap((3000.0 - sight.slant_km) / 2000.0)),
    }
    low = sum(_WEIGHTS[key] * terms[key][0] for key in _WEIGHTS)
    high = sum(_WEIGHTS[key] * terms[key][1] for key in _WEIGHTS)
    low = round(min(100.0, max(0.0, low)), 1)
    high = round(min(100.0, max(0.0, high)), 1)
    if low > high:
        high = low
    return {"low": low, "high": high, "terms": {key: list(terms[key]) for key in _WEIGHTS}}


def _angular(sight, iss: Position) -> tuple[float, float]:
    if sight.subject is Subject.ASCENT:
        value = plume_angle_score(0.0 if sight.plume_mrad is None else sight.plume_mrad)
        return (value, value)
    horizon = _horizon_km(iss.alt_km)
    if horizon <= 0.0:
        return (0.0, 0.0)
    ground = great_circle_km(iss.lat, iss.lon, sight.lat, sight.lon)
    value = min(1.0, max(0.0, 1.0 - ground / horizon))
    return (value, value)


def _contrast(sight, iss: Position) -> tuple[float, float]:
    if sight.light == "night_engine" or (
        sight.subject is Subject.PAD and sight.light == "pad_night"
    ):
        return (0.3, 0.8)
    sun = rocket_sun_state(sight.when, sight.lat, sight.lon, sight.alt_km)
    illumination = {SunState.SUNLIT: 1.0, SunState.PENUMBRA: 0.5, SunState.UMBRA: 0.0}[sun]
    if sight.limb_margin_deg > 0.0:
        elev = _surface_sun_elevation_deg(sight.when, iss.lat, iss.lon)
    else:
        elev = _surface_sun_elevation_deg(sight.when, sight.lat, sight.lon)
    if elev <= -12.0:
        dark = 1.0
    elif elev <= -6.0:
        dark = 0.5
    else:
        dark = 0.0
    value = illumination * dark
    return (value, value)


def _pair(value: tuple[float, float]) -> tuple[float, float]:
    low, high = (_unit(value[0]), _unit(value[1]))
    if low > high:
        high = low
    return (low, high)


def _unit(value: float) -> float:
    return round(min(1.0, max(0.0, value)), 4)


def _cap(value: float) -> tuple[float, float]:
    clamped = min(1.0, max(0.0, value))
    return (clamped, clamped)


def _lens(sight) -> tuple[str, str]:
    if sight.subject is Subject.PAD:
        if sight.slant_km <= 800.0:
            return "wide", "Close pad."
        return "telephoto", "Pad is a small target."
    if sight.light == "night_engine":
        return "telephoto", "Night engine is a point."
    if sight.plume_mrad is not None and sight.plume_mrad >= 3.0:
        return "wide", "Plume fills the frame."
    return "telephoto", "Distant plume."


def _track(scenario, span) -> list[dict]:
    if span.subject is not Subject.ASCENT:
        return []
    points: list[dict] = []
    last = None
    for sight in scenario.sights:
        if sight.subject is not Subject.ASCENT or not sight.in_plan:
            continue
        if sight.when < span.start or sight.when > span.end:
            continue
        if last is not None and sight.t_offset_s - last < 15:
            continue
        points.append(_point(sight))
        last = sight.t_offset_s
    if not points:
        points.append(_point(span.closest))
    return points


def _point(sight) -> dict:
    return {
        "t_offset_s": int(sight.t_offset_s),
        "lat": min(90.0, max(-90.0, round(sight.lat, 5))),
        "lon": min(180.0, max(-180.0, round(sight.lon, 5))),
        "alt_km": round(max(0.0, sight.alt_km), 3),
    }


def _why(tier: str, shots: list[dict], reasons: list[str]) -> str:
    best = _best(shots)
    if best is None:
        if tier == "unassessed":
            return "Schedule is too loose to plan a window."
        if "EPHEMERIS_MISSING" in reasons:
            return "No ISS orbit is available, so the view was not assessed."
        if "EVALUATION_INCOMPLETE" in reasons:
            return "The view assessment did not finish."
        if "TLE_AGE_OVER_24H" in reasons or "EPHEMERIS_STALE" in reasons:
            return "The ISS orbit is too old to confirm or rule out a view."
        if tier == "none":
            return "The ascent stays behind Earth on a fresh orbit."
        if "NO_LINE_OF_SIGHT" in reasons:
            return "No clear line of sight inside 3500 km."
        return "No clear line of sight inside 3500 km."
    minutes = int(round(best["best_offset_s"] / 60.0))
    if minutes == 0:
        when = "at liftoff"
    elif minutes > 0:
        when = f"{minutes} min after liftoff"
    else:
        when = f"{-minutes} min before liftoff"
    slant = round(best["slant_km"])
    bearing = _bearing(best["look"]["azimuth_deg"])
    sentence = f"{_LIGHT[best['light']]} {slant} km {bearing}, {best['window']}, {when}"
    if best["light"] == "night_engine":
        sentence += ", scored but unvalidated until calibrated"
    return sentence + "."


def _best(shots: list[dict]) -> dict | None:
    if not shots:
        return None
    return min(shots, key=lambda shot: (-shot["score"]["low"], shot["best"], shot["subject"]))


def _window(azimuth: float, off_nadir: float) -> str:
    if off_nadir < 35.0:
        return "W7"

    def distance(left: float, right: float) -> float:
        return abs((left - right + 180.0) % 360.0 - 180.0)

    signed = azimuth if azimuth <= 180.0 else azimuth - 360.0
    number = min(_WINDOWS, key=lambda item: (distance(signed, item[1]), item[0]))[0]
    return f"W{number}"


def _bearing(azimuth: float) -> str:
    labels = ((0.0, "ahead"), (90.0, "right"), (180.0, "aft"), (270.0, "left"))

    def distance(left: float, right: float) -> float:
        gap = abs(left - right) % 360.0
        return min(gap, 360.0 - gap)

    return min(labels, key=lambda item: (distance(azimuth, item[0]), item[1]))[1]


def _schedule(launch: Launch, raw: dict) -> dict:
    start, end = launch.window_start, launch.window_end
    if start is not None and end is not None and end < start:
        end = None
    return {
        "net": utc(launch.t0),
        "window_start": utc(start) if start else None,
        "window_end": utc(end) if end else None,
        "precision": launch.time_precision,
        "status": launch.status_abbrev,
        "destination": _destination_name(raw),
    }


def _destination_name(raw: dict) -> str | None:
    kind = destination_from_ll2(raw)
    if kind is Destination.ISS:
        return "ISS"
    if kind is Destination.OTHER:
        return "other"
    return None


def _direction_block(direction: Direction) -> dict:
    if direction.kind is DirectionKind.NONE:
        return {"kind": "none", "azimuth_deg": None, "source": None, "off_plane_deg": None}
    azimuth = round(direction.azimuth_deg % 360.0, 4)
    if azimuth >= 360.0:
        azimuth = 0.0
    return {
        "kind": direction.kind.value,
        "azimuth_deg": azimuth,
        "source": direction.source,
        "off_plane_deg": round(direction.off_plane_deg, 4),
    }


def _disk_negative(
    launch: Launch,
    tle: TLE | None,
    now: datetime,
    fetched_at: datetime | None,
    budget: EvaluationBudget,
    source_reasons: tuple[str, ...],
) -> bool:
    try:
        assessment = build_planning_assessment(
            launch, tle, now, fetched_at, budget, source_reasons=source_reasons,
        )
    except (ValueError, RuntimeError, ArithmeticError):
        return False
    window = assessment["window"]
    return window["verdict"] == "too_far" and window["reason"] == "NOMINAL_ASCENT_TOO_FAR"


def _tle_block(tle: TLE | None) -> dict:
    if tle is None:
        return {
            "epoch": "1970-01-01T00:00:00Z",
            "sha256": hashlib.sha256(b"").hexdigest(),
            "source": "missing",
        }
    body = f"{tle.line1}\n{tle.line2}\n".encode()
    return {
        "epoch": utc(tle.epoch),
        "sha256": hashlib.sha256(body).hexdigest(),
        "source": "iss.tle",
    }


def _horizon_paged(payload: dict, horizon: datetime) -> bool:
    if not payload.get("next"):
        return True
    latest = None
    for row in payload["results"]:
        if not isinstance(row, dict):
            continue
        raw = row.get("net") or row.get("window_start")
        if not isinstance(raw, str) or not raw:
            continue
        try:
            when = _parse_iso8601_z(raw)
        except (TypeError, ValueError):
            continue
        if latest is None or when > latest:
            latest = when
    return latest is not None and latest >= horizon


def _leases(now: datetime, fetched_at: datetime | None) -> tuple[datetime, datetime]:
    schedule_until = now + timedelta(seconds=SCHEDULE_LEASE_SECONDS)
    geometry_until = now + timedelta(seconds=GEOMETRY_LEASE_SECONDS)
    if fetched_at is not None and fetched_at <= now:
        receipt_deadline = fetched_at + timedelta(seconds=PLANNING_VALID_SECONDS)
        evidence_deadline = fetched_at + timedelta(seconds=SCHEDULE_LEASE_SECONDS)
        if evidence_deadline <= now or receipt_deadline <= now:
            remaining = receipt_deadline - now
            if remaining > timedelta(0):
                schedule_until = now + remaining
        else:
            schedule_until = min(schedule_until, evidence_deadline, receipt_deadline)
    if schedule_until <= now:
        schedule_until = now + timedelta(seconds=1)
    geometry_until = min(geometry_until, schedule_until)
    if geometry_until <= now:
        geometry_until = now + timedelta(seconds=1)
    if geometry_until > schedule_until:
        geometry_until = schedule_until
    return schedule_until, geometry_until


def _receipt_usable(now: datetime, fetched_at: datetime | None) -> bool:
    if fetched_at is None or fetched_at > now:
        return False
    evidence_deadline = fetched_at + timedelta(seconds=SCHEDULE_LEASE_SECONDS)
    receipt_deadline = fetched_at + timedelta(seconds=PLANNING_VALID_SECONDS)
    return evidence_deadline > now and receipt_deadline > now


def _capture_age_h(shot: dict, epoch: datetime) -> float:
    return _age_hours(_parse_iso8601_z(shot["start"]), _parse_iso8601_z(shot["end"]), epoch)


def _age_hours(start: datetime, end: datetime, epoch: datetime) -> float:
    span = max(abs((start - epoch).total_seconds()), abs((end - epoch).total_seconds()))
    return span / 3600.0


def _sigma_km(age_h: float) -> float:
    days = max(0.0, age_h) / 24.0
    return 1.0 + 2.0 * days**1.5


def _horizon_km(alt_km: float) -> float:
    if alt_km <= 0.0:
        return 0.0
    ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + alt_km)
    if ratio >= 1.0:
        return 0.0
    return EARTH_RADIUS_KM * math.acos(min(1.0, ratio))


def _angle(value: float, low: float, high: float, places: int = 3) -> float:
    return round(min(high, max(low, float(value))), places)
