"""Attach published hazard notices to catalog launches and build hazard schema 2.

A notice is drawn for a launch only when it is a launch notice, lies at the pad, and is
in force when that launch's window opens. Anything else is logged with its reason.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

from .hazard_notices import Area, Notice, Position, Window
from .launch_data import SCHEDULE_STATUS_ABBREVS, _parse_iso8601_z
from .launch_evidence import canonical_bytes, utc

LABEL = "Published hazard areas — not a flight path or navigation guidance"
SCHEMA_VERSION = 2
PAD_ANCHOR_KM = 25.0
OPEN_SLACK = timedelta(minutes=10)
LEAD_MAX = timedelta(hours=6)
REVIEW_MAX = timedelta(hours=48)
HORIZON = timedelta(days=8)
RING_TOLERANCE_DEG = 0.001
MAX_LAUNCHES = 32
MAX_NOTICES = 16
MAX_WINDOWS = 16
MAX_INSTRUCTIONS = 4
MAX_LISTED = 8
MAX_LISTED_TEXT = 400
LISTING_SPAN_MAX = timedelta(days=21)
UNREAD_LEAD = timedelta(hours=24)
MAX_BYTES = 256 * 1024
STANDING_CLOSURE_NO_LAUNCH_WINDOW: Final = "STANDING_CLOSURE_NO_LAUNCH_WINDOW"
_CLASSES = ("hazard", "high_risk", "restricted_airspace")
_INSTANT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


@dataclass(frozen=True)
class Sighting:
    """A parsed notice and the last time its source confirmed it."""

    notice: Notice
    checked_at: datetime


@dataclass(frozen=True)
class Launch:
    event_id: str
    lat: float
    lon: float
    net: datetime
    opens: datetime
    closes: datetime


@dataclass
class _Row:
    sighting: Sighting
    area: Area
    windows: list[Window]
    restriction_class: str
    instructions: tuple[str, ...]
    also: list[str]
    cross_check: Sighting | None = None


def launches_from_catalog(items: list[dict], now: datetime) -> list[Launch]:
    """Catalog launches that can still be a map pin. An incoherent schedule has no attempt."""
    launches: list[Launch] = []
    for item in items:
        try:
            schedule, site = item["schedule"], item["site"]
            net = _parse_iso8601_z(schedule["net"])
            opens = _parse_iso8601_z(schedule["window_start"]) if schedule["window_start"] else net
            closes = _parse_iso8601_z(schedule["window_end"]) if schedule["window_end"] else net
            launch = Launch(
                str(item["event_id"]), float(site["lat"]), float(site["lon"]), net, opens, closes
            )
        except (KeyError, TypeError, ValueError):
            continue
        if schedule.get("status") not in SCHEDULE_STATUS_ABBREVS:
            continue
        if not launch.opens <= launch.net <= launch.closes:
            continue
        if launch.closes <= now or launch.net > now + HORIZON:
            continue
        launches.append(launch)
    return launches


def pad_distance_km(launch: Launch, ring: tuple[Position, ...]) -> float:
    """Distance from the pad to a polygon, zero inside it. Flat-earth around the pad."""
    east = 111.32 * math.cos(math.radians(launch.lat))
    offsets = tuple((((lon - launch.lon + 540.0) % 360.0) - 180.0, lat) for lon, lat in ring)
    if any(
        abs(b[0] - a[0]) > 180
        for a, b in zip(offsets, offsets[1:] + offsets[:1], strict=True)
    ):
        return math.inf
    points = [
        (lon * east, (lat - launch.lat) * 110.57)
        for lon, lat in offsets
    ]
    inside = False
    nearest = math.inf
    for (ax, ay), (bx, by) in zip(points, [*points[1:], points[0]], strict=True):
        if (ay > 0) != (by > 0) and ax + (0 - ay) * (bx - ax) / (by - ay) > 0:
            inside = not inside
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        along = 0.0 if span == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / span))
        nearest = min(nearest, math.hypot(ax + along * dx, ay + along * dy))
    return 0.0 if inside else nearest


def in_force_at_window_open(launch: Launch, notice: Notice) -> bool:
    """A window that opens with the launch window and still holds at NET."""
    earliest, latest = launch.opens - LEAD_MAX, launch.opens + OPEN_SLACK
    return any(
        earliest <= window.start <= latest and window.start <= launch.net < window.end
        for area in notice.areas
        for window in area.windows
    )


def same_ring(left: tuple[Position, ...], right: tuple[Position, ...]) -> bool:
    """The same vertices within tolerance, from any start vertex, in either direction."""
    size = len(left)
    if size != len(right):
        return False

    def near(a: Position, b: Position) -> bool:
        return abs(a[0] - b[0]) <= RING_TOLERANCE_DEG and abs(a[1] - b[1]) <= RING_TOLERANCE_DEG

    return any(
        all(near(left[index], right[(offset + step * index) % size]) for index in range(size))
        for step in (1, -1)
        for offset in range(size)
    )


def _pad_km(launch: Launch, notice: Notice) -> float:
    """Distance from the pad to the notice: its parsed areas, or its record outline."""
    rings = [area.ring for area in notice.areas] or ([notice.outline] if notice.outline else [])
    return min((pad_distance_km(launch, ring) for ring in rings), default=math.inf)


def _published_span(notice: Notice) -> tuple[datetime, datetime] | None:
    """From the first readable window, or the record start, to the cancel time. Short spans only."""
    starts = [window.start for area in notice.areas for window in area.windows]
    begin = min(starts) if starts else notice.valid_from
    if begin is None or notice.valid_until is None or notice.valid_until - begin > LISTING_SPAN_MAX:
        return None
    return begin, notice.valid_until


def _regulated_area_launches(launches: list[Launch], notice: Notice) -> list[str]:
    """Launches a safety zone or regulated navigation area is published for."""
    at_pad = [launch for launch in launches if _pad_km(launch, notice) <= PAD_ANCHOR_KM]
    if any(area.windows for area in notice.areas):
        return [launch.event_id for launch in at_pad if in_force_at_window_open(launch, notice)]
    span = _published_span(notice)
    return [launch.event_id for launch in at_pad if span and span[0] <= launch.net < span[1]]


def _unread_time_launches(launches: list[Launch], notice: Notice) -> list[str]:
    """Launches at the pad inside the life of a notice that has a time nobody could read."""
    span = _published_span(notice)
    return [
        launch.event_id
        for launch in launches
        if span
        and _pad_km(launch, notice) <= PAD_ANCHOR_KM
        and span[0] - UNREAD_LEAD <= launch.opens
        and launch.net < span[1]
    ]


def _listings(sighting: Sighting, reason: str, texts: list[str]) -> list[dict]:
    """Text for the launch card. A listing has no geometry and is never drawn."""
    notice = sighting.notice
    ends = [window.end for area in notice.areas for window in area.windows]
    until = notice.valid_until or max(ends, default=None)
    if until is None:
        return []
    return [
        {
            "authority": notice.authority,
            "notice_id": notice.notice_id,
            "reason": reason,
            "text": text[:MAX_LISTED_TEXT],
            "checked_at": utc(sighting.checked_at),
            "valid_until": utc(until),
            "source_url": notice.source_url,
            "source_sha256": notice.source_sha256,
        }
        for text in texts
        if text
    ]


def match_notices(
    launches: list[Launch],
    sightings: list[Sighting],
    now: datetime,
    overrides: dict | None = None,
) -> tuple[dict[str, list[Sighting]], dict[str, list[dict]], list[dict]]:
    """Decide each notice once: drawn, listed as text, or neither. The log holds every reason."""
    pins = dict((overrides or {}).get("pin", {}))
    bans = set((overrides or {}).get("ban", []))
    known = {launch.event_id: launch for launch in launches}
    superseded = {name for sighting in sightings for name in sighting.notice.cancels}
    matched: dict[str, list[Sighting]] = {}
    listed: dict[str, list[dict]] = {}
    log: list[dict] = []
    for sighting in sorted(sightings, key=lambda entry: entry.notice.notice_id):
        notice = sighting.notice
        event_id: str | None = None
        reasons: list[str] = []
        unread = [
            problem.split(":", 1)[1]
            for problem in notice.problems
            if problem.startswith("WINDOW_UNPARSED:")
        ]
        if notice.notice_id in bans:
            decision = "banned"
        elif notice.notice_id in superseded:
            decision = "cancelled"
        elif notice.valid_until is not None and notice.valid_until <= now:
            decision = "expired"
        elif now - sighting.checked_at >= REVIEW_MAX:
            decision = "stale"
        elif "NUMBER_CONFLICT" in notice.problems:
            decision, reasons = "rejected", ["NUMBER_CONFLICT"]
        elif notice.kind == "standing_closure":
            decision, reasons = "unmatched", [STANDING_CLOSURE_NO_LAUNCH_WINDOW]
        elif notice.notice_id in pins:
            event_id = pins[notice.notice_id]
            decision = "matched" if event_id in known and notice.areas else "unmatched"
            reasons = ["PINNED" if decision == "matched" else "PIN_UNUSABLE"]
        elif notice.kind == "regulated_area":
            located = _regulated_area_launches(launches, notice)
            if len(located) == 1:
                decision, event_id = "listed", located[0]
            elif located:
                decision, reasons = "ambiguous", located
            else:
                decision, reasons = "not_launch", [notice.kind]
        elif notice.kind != "launch":
            decision, reasons = "not_launch", [notice.kind]
        elif not notice.areas:
            decision, reasons = "rejected", list(notice.problems) or ["NO_AREAS"]
        else:
            confident: list[str] = []
            for launch in launches:
                distance = _pad_km(launch, notice)
                anchored = distance <= PAD_ANCHOR_KM
                timed = in_force_at_window_open(launch, notice)
                if anchored and timed:
                    confident.append(launch.event_id)
                elif anchored:
                    reasons.append(f"NOT_IN_FORCE_AT_WINDOW_OPEN:{launch.event_id}")
                elif timed:
                    reasons.append(f"NOT_AT_PAD:{launch.event_id}:{distance:.0f}km")
            around = _unread_time_launches(launches, notice) if unread else []
            if len(confident) == 1:
                decision, event_id, reasons = "matched", confident[0], []
            elif confident:
                decision, reasons = "ambiguous", confident
            elif len(around) == 1:
                decision, event_id, reasons = "listed", around[0], ["UNREAD_TIME"]
            else:
                decision, reasons = "unmatched", reasons or ["NO_LAUNCH_AT_PAD_AND_TIME"]
        if decision == "matched":
            matched.setdefault(event_id, []).append(sighting)
        if decision in ("matched", "listed"):
            found = (
                _listings(sighting, "not_drawn", [notice.subject])
                if notice.kind == "regulated_area"
                else _listings(sighting, "unread_time", unread)
            )
            if notice.kind == "launch":
                undrawn = [area.area_id for area in notice.areas if not area.drawable]
                if undrawn:
                    label, action = (
                        ("Area", "is not drawn because its ring crosses")
                        if len(undrawn) == 1
                        else ("Areas", "are not drawn because their rings cross")
                    )
                    found.extend(_listings(sighting, "not_drawn", [
                        f"{label} {', '.join(undrawn)} {action} the antimeridian.",
                    ]))
            if found:
                listed.setdefault(event_id, []).extend(found)
        else:
            event_id = None
        log.append(
            {
                "notice_id": notice.notice_id,
                "authority": notice.authority,
                "kind": notice.kind,
                "decision": decision,
                "event_id": event_id,
                "reasons": reasons,
                "problems": list(notice.problems),
                "checked_at": utc(sighting.checked_at),
            }
        )
    return matched, listed, log


def _closed_counter_clockwise(ring: tuple[Position, ...]) -> list[list[float]]:
    turn = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, [*ring[1:], ring[0]], strict=True))
    ordered = list(ring) if turn >= 0 else list(reversed(ring))
    return [[lon, lat] for lon, lat in [*ordered, ordered[0]]]


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _launch_entry(
    event_id: str,
    sightings: list[Sighting],
    listings: list[dict],
    now: datetime,
    log: list[dict],
) -> dict | None:
    rows: list[_Row] = []
    for sighting in sightings:
        for area in sighting.notice.areas:
            if not area.drawable:
                continue
            windows = [window for window in area.windows if window.end > now][:MAX_WINDOWS]
            if windows:
                rows.append(
                    _Row(sighting, area, windows, area.restriction_class, area.instructions, [])
                )
    rows.sort(
        key=lambda row: (
            row.sighting.notice.domain != "maritime",
            row.sighting.notice.notice_id,
            row.area.area_id,
        )
    )
    kept: list[_Row] = []
    for row in rows:
        notice = row.sighting.notice
        twin = next(
            (
                other
                for other in kept
                if other.sighting.notice.authority == notice.authority
                and other.sighting.notice.notice_id != notice.notice_id
                and other.windows == row.windows
                and same_ring(other.area.ring, row.area.ring)
            ),
            None,
        )
        if twin:
            twin.also.append(notice.notice_id)
            _note(log, notice.notice_id, f"SAME_AREA_AS:{twin.sighting.notice.notice_id}")
            continue
        kept.append(row)
    primary = [row for row in kept if row.sighting.notice.authority == "NGA"]
    final: list[_Row] = []
    for row in kept:
        notice = row.sighting.notice
        twin = None
        if notice.authority == "USCG":
            twin = next(
                (other for other in primary if same_ring(other.area.ring, row.area.ring)), None
            )
        if twin is None:
            final.append(row)
            continue
        twin.cross_check = row.sighting
        twin.instructions = row.instructions
        twin.restriction_class = row.restriction_class
        agree = "" if twin.windows == row.windows else ":WINDOWS_DIFFER"
        _note(log, notice.notice_id, f"CROSS_CHECK_OF:{twin.sighting.notice.notice_id}{agree}")
    if not final and not listings:
        return None
    if len(final) > MAX_NOTICES:
        for row in final:
            _note(log, row.sighting.notice.notice_id, "TOO_MANY_AREAS")
        raise ValueError("HAZARD_NOTICES")
    notices, features = [], []
    for row in final:
        notice = row.sighting.notice
        entry = {
            "authority": notice.authority,
            "notice_id": notice.notice_id,
            "area_id": row.area.area_id,
            "domain": notice.domain,
            "restriction_class": row.restriction_class,
            "windows": [{"start": utc(w.start), "end": utc(w.end)} for w in row.windows],
            "checked_at": utc(row.sighting.checked_at),
            "valid_until": utc(notice.valid_until or row.windows[-1].end),
            "instructions": list(row.instructions[:MAX_INSTRUCTIONS]),
            "also": sorted(row.also),
            "source_url": notice.source_url,
            "source_sha256": notice.source_sha256,
        }
        if row.cross_check:
            entry["cross_check_url"] = row.cross_check.notice.source_url
            entry["cross_check_sha256"] = row.cross_check.notice.source_sha256
        notices.append(entry)
        features.append(
            {
                "type": "Feature",
                "id": _slug(f"{notice.notice_id} {row.area.area_id}"),
                "properties": {
                    "notice_id": notice.notice_id,
                    "area_id": row.area.area_id,
                    "name": f"{notice.notice_id} area {row.area.area_id}",
                    "domain": notice.domain,
                    "restriction_class": row.restriction_class,
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [_closed_counter_clockwise(row.area.ring)],
                },
            }
        )
    return {
        "event_id": event_id,
        "notices": notices,
        "geojson": {"type": "FeatureCollection", "features": features},
        "listed": listings,
    }


def _note(log: list[dict], notice_id: str, reason: str) -> None:
    for entry in log:
        if entry["notice_id"] == notice_id and reason not in entry["reasons"]:
            entry["reasons"].append(reason)


def build_bundle(
    items: list[dict],
    sightings: list[Sighting],
    now: datetime,
    overrides: dict | None = None,
) -> tuple[dict, list[dict]]:
    """Hazard schema 2 for every catalog launch with a confident notice, and the decision log."""
    launches = launches_from_catalog(items, now)
    matched, listed, log = match_notices(launches, sightings, now, overrides)
    entries = []
    for event_id in sorted({*matched, *listed}):
        entry = _launch_entry(
            event_id, matched.get(event_id, []), listed.get(event_id, []), now, log
        )
        if entry:
            entries.append(entry)
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "label": LABEL,
        "launches": entries[:MAX_LAUNCHES],
    }
    bundle["revision"] = hashlib.sha256(canonical_bytes(bundle)).hexdigest()[:16]
    bundle["generated_at"] = utc(now)
    validate_bundle(bundle)
    return bundle, log


def validate_bundle(bundle: dict) -> None:
    """The checks the map applies before it draws. A file that fails is never written."""

    def keys(value: object, required: str, optional: str = "") -> dict:
        allowed = set(required.split()) | set(optional.split())
        if not isinstance(value, dict) or not set(required.split()) <= set(value) <= allowed:
            raise ValueError("HAZARD_FIELDS")
        return value

    def instant(value: object) -> datetime:
        if not isinstance(value, str) or not _INSTANT.fullmatch(value):
            raise ValueError("HAZARD_INSTANT")
        return _parse_iso8601_z(value)

    keys(bundle, "schema_version revision generated_at label launches")
    if bundle["schema_version"] != SCHEMA_VERSION or bundle["label"] != LABEL:
        raise ValueError("HAZARD_SCHEMA")
    if not isinstance(bundle["revision"], str) or not re.fullmatch(
        r"[a-f0-9]{16}", bundle["revision"]
    ):
        raise ValueError("HAZARD_REVISION")
    instant(bundle["generated_at"])
    launches = bundle["launches"]
    if not isinstance(launches, list) or len(launches) > MAX_LAUNCHES:
        raise ValueError("HAZARD_LAUNCHES")
    seen_events: set[str] = set()
    for launch in launches:
        keys(launch, "event_id notices geojson listed")
        if (
            not isinstance(launch["event_id"], str)
            or not launch["event_id"]
            or launch["event_id"] in seen_events
        ):
            raise ValueError("HAZARD_EVENT")
        seen_events.add(launch["event_id"])
        notices, listed = launch["notices"], launch["listed"]
        if not isinstance(listed, list) or len(listed) > MAX_LISTED or not (notices or listed):
            raise ValueError("HAZARD_LISTED")
        for item in listed:
            keys(
                item,
                "authority notice_id reason text checked_at valid_until source_url source_sha256",
            )
            texts = (item["authority"], item["notice_id"], item["text"])
            if any(not isinstance(text, str) or not text for text in texts):
                raise ValueError("HAZARD_LISTED")
            if item["reason"] not in ("unread_time", "not_drawn"):
                raise ValueError("HAZARD_LISTED")
            if len(item["text"]) > MAX_LISTED_TEXT or not str(item["source_url"]).startswith(
                "https://"
            ):
                raise ValueError("HAZARD_LISTED")
            if not re.fullmatch(r"[a-f0-9]{64}", str(item["source_sha256"])):
                raise ValueError("HAZARD_LISTED")
            instant(item["checked_at"])
            instant(item["valid_until"])
        collection = keys(launch["geojson"], "type features")
        features = collection["features"]
        if (
            not isinstance(notices, list)
            or len(notices) > MAX_NOTICES
            or collection["type"] != "FeatureCollection"
            or not isinstance(features, list)
            or len(features) != len(notices)
        ):
            raise ValueError("HAZARD_NOTICES")
        expected = []
        for notice in notices:
            keys(
                notice,
                "authority notice_id area_id domain restriction_class windows checked_at "
                "valid_until instructions also source_url source_sha256",
                "cross_check_url cross_check_sha256",
            )
            for field in ("authority", "notice_id", "area_id"):
                if not isinstance(notice[field], str) or not notice[field]:
                    raise ValueError("HAZARD_TEXT")
            if (
                notice["domain"] not in ("maritime", "airspace")
                or notice["restriction_class"] not in _CLASSES
            ):
                raise ValueError("HAZARD_CLASS")
            windows = notice["windows"]
            if not isinstance(windows, list) or not 1 <= len(windows) <= MAX_WINDOWS:
                raise ValueError("HAZARD_WINDOWS")
            previous = None
            for window in windows:
                keys(window, "start end")
                start, end = instant(window["start"]), instant(window["end"])
                if end <= start or (previous is not None and start < previous):
                    raise ValueError("HAZARD_WINDOWS")
                previous = end
            instant(notice["checked_at"])
            instant(notice["valid_until"])
            for field, limit, length in (("instructions", MAX_INSTRUCTIONS, 400), ("also", 8, 80)):
                texts = notice[field]
                if (
                    not isinstance(texts, list)
                    or len(texts) > limit
                    or any(
                        not isinstance(text, str) or not 0 < len(text) <= length for text in texts
                    )
                ):
                    raise ValueError("HAZARD_TEXT")
            for field in ("source_url", "cross_check_url"):
                if field in notice and not str(notice[field]).startswith("https://"):
                    raise ValueError("HAZARD_URL")
            for field in ("source_sha256", "cross_check_sha256"):
                if field in notice and not re.fullmatch(r"[a-f0-9]{64}", str(notice[field])):
                    raise ValueError("HAZARD_SHA")
            expected.append(
                (
                    notice["notice_id"],
                    notice["area_id"],
                    notice["domain"],
                    notice["restriction_class"],
                )
            )
        if len(set(expected)) != len(expected):
            raise ValueError("HAZARD_DUPLICATE")
        for feature, wanted in zip(features, expected, strict=True):
            keys(feature, "type id properties geometry")
            props = keys(feature["properties"], "notice_id area_id name domain restriction_class")
            geometry = keys(feature["geometry"], "type coordinates")
            found = (
                props["notice_id"],
                props["area_id"],
                props["domain"],
                props["restriction_class"],
            )
            if feature["type"] != "Feature" or found != wanted or geometry["type"] != "Polygon":
                raise ValueError("HAZARD_FEATURE")
            rings = geometry["coordinates"]
            if not isinstance(rings, list) or len(rings) != 1:
                raise ValueError("HAZARD_RING")
            _validate_ring(rings[0])
    if len(canonical_bytes(bundle)) > MAX_BYTES:
        raise ValueError("HAZARD_TOO_LARGE")


def _validate_ring(ring: object) -> None:
    if not isinstance(ring, list) or not 4 <= len(ring) <= 513 or ring[0] != ring[-1]:
        raise ValueError("HAZARD_RING")
    turn = 0.0
    for index, point in enumerate(ring):
        if (
            not isinstance(point, list)
            or len(point) != 2
            or any(
                isinstance(value, bool) or not isinstance(value, (int, float)) for value in point
            )
            or not math.isfinite(point[0])
            or not math.isfinite(point[1])
            or not -180 <= point[0] <= 180
            or not -90 <= point[1] <= 90
        ):
            raise ValueError("HAZARD_RING")
        if index:
            before = ring[index - 1]
            if abs(point[0] - before[0]) > 180 or (index < len(ring) - 1 and point == before):
                raise ValueError("HAZARD_RING")
            turn += before[0] * point[1] - point[0] * before[1]
    if turn < 0:
        raise ValueError("HAZARD_RING")
