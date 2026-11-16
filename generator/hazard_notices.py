"""Launch hazard notices as their agencies publish them.

NGA broadcast warnings, U.S. Coast Guard space-operations notices and FAA flight
restrictions are read into polygons and UTC windows. Source readers reject
possibly relevant content they cannot read completely. Diagnostic-only parsers
retain ``problems`` for callers. Nothing is repaired or inferred.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from enum import Enum, auto
from urllib.parse import parse_qs, urlsplit
from xml.etree import ElementTree

MAX_WINDOW = timedelta(hours=24)
MAX_VERTICES = 512
MAX_SOURCE_BYTES = 4_000_000

_MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
_MON = "(?:" + "|".join(_MONTHS) + ")"
_SERIES = {
    "4": "NAVAREA IV",
    "12": "NAVAREA XII",
    "A": "HYDROLANT",
    "P": "HYDROPAC",
    "C": "HYDROARC",
}

Position = tuple[float, float]


class NoticeError(ValueError):
    """A source document or possibly relevant row that cannot be read completely."""


class _UndrawnRingError(ValueError):
    pass


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _decode_json(body: bytes) -> object:
    """Decode without discarding repeated object members, including nested members."""
    return json.loads(body, object_pairs_hook=_unique_json_object)


def _sequential_numbers(numbers: tuple[int, ...]) -> bool:
    return numbers == tuple(range(1, len(numbers) + 1))


def _consecutive_area_labels(labels: list[str]) -> bool:
    return labels == ["1"] or labels == [chr(ord("A") + index) for index in range(len(labels))]


def _known_fields(record: dict[str, object], allowed: frozenset[str], error: str) -> None:
    """Owned record keys are closed; listed unused metadata values remain opaque."""
    if not record.keys() <= allowed:
        raise NoticeError(error)


def _readable_relevance(*fields: bool | None, error: str) -> bool:
    """Only readable exclusion fields establish irrelevance.

    Missing, blank, or wrong-type exclusion fields are errors unless another
    readable field proves the row irrelevant.
    """
    if False in fields:
        return False
    if None in fields:
        raise NoticeError(error)
    return True


def _equals_if_readable(value: object, expected: str, excluded: frozenset[str]) -> bool | None:
    if not isinstance(value, str) or not value.strip():
        return None
    if value.strip() == expected:
        return True
    if value.strip() in excluded:
        return False
    return None


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime


@dataclass
class _Schedule:
    windows: list[Window] = field(default_factory=list)
    long_windows: list[str] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)

    def add(self, window: Window, text: str) -> None:
        if window.end - window.start > MAX_WINDOW:
            self.long_windows.append(text)
        else:
            self.windows.append(window)

    @property
    def readable(self) -> bool:
        return bool(self.windows or self.long_windows) and not self.unreadable

    @property
    def problems(self) -> list[str]:
        return [f"WINDOW_UNPARSED:{text}" for text in (*self.unreadable, *self.long_windows)]


@dataclass(frozen=True)
class Area:
    """One published polygon. The ring is open, (lon, lat), in published order."""

    area_id: str
    ring: tuple[Position, ...]
    windows: tuple[Window, ...]
    restriction_class: str
    instructions: tuple[str, ...] = ()

    @property
    def drawable(self) -> bool:
        return _ring_drawable(self.ring)


@dataclass(frozen=True)
class Notice:
    authority: str
    notice_id: str
    kind: str
    domain: str
    subject: str
    areas: tuple[Area, ...]
    cancels: tuple[str, ...]
    valid_until: datetime | None
    problems: tuple[str, ...]
    source_url: str
    source_sha256: str
    valid_from: datetime | None = None
    outline: tuple[Position, ...] = ()


def sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _stamp(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _instant(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def notice_record(notice: Notice) -> dict:
    """JSON form kept between runs, so an unreachable source keeps its last good notices."""
    return {
        "authority": notice.authority,
        "notice_id": notice.notice_id,
        "kind": notice.kind,
        "domain": notice.domain,
        "subject": notice.subject,
        "areas": [
            {
                "area_id": area.area_id,
                "ring": [[lon, lat] for lon, lat in area.ring],
                "windows": [[_stamp(w.start), _stamp(w.end)] for w in area.windows],
                "restriction_class": area.restriction_class,
                "instructions": list(area.instructions),
            }
            for area in notice.areas
        ],
        "cancels": list(notice.cancels),
        "valid_until": _stamp(notice.valid_until) if notice.valid_until else None,
        "valid_from": _stamp(notice.valid_from) if notice.valid_from else None,
        "outline": [[lon, lat] for lon, lat in notice.outline],
        "problems": list(notice.problems),
        "source_url": notice.source_url,
        "source_sha256": notice.source_sha256,
    }


def notice_from_record(record: dict) -> Notice:
    return Notice(
        authority=record["authority"],
        notice_id=record["notice_id"],
        kind=record["kind"],
        domain=record["domain"],
        subject=record["subject"],
        areas=tuple(
            Area(
                area_id=area["area_id"],
                ring=tuple((float(lon), float(lat)) for lon, lat in area["ring"]),
                windows=tuple(Window(_instant(a), _instant(b)) for a, b in area["windows"]),
                restriction_class=area["restriction_class"],
                instructions=tuple(area["instructions"]),
            )
            for area in record["areas"]
        ),
        cancels=tuple(record["cancels"]),
        valid_until=_instant(record["valid_until"]) if record["valid_until"] else None,
        valid_from=_instant(record["valid_from"]) if record.get("valid_from") else None,
        outline=tuple((float(lon), float(lat)) for lon, lat in record.get("outline", [])),
        problems=tuple(record["problems"]),
        source_url=record["source_url"],
        source_sha256=record["source_sha256"],
    )


def _sexagesimal(hemisphere: str, degrees: str, minutes: str, seconds: str = "0") -> float:
    """Degrees with minutes and seconds, rounded half up to five places."""
    parts = Decimal(degrees), Decimal(minutes), Decimal(seconds)
    if parts[1] >= 60 or parts[2] >= 60:
        raise ValueError("minutes or seconds out of range")
    value = parts[0] + parts[1] / 60 + parts[2] / 3600
    value = value.quantize(Decimal("0.00001"), rounding=ROUND_HALF_UP)
    return float(-value if hemisphere in "SW" else value)


def _position(lat: float, lon: float) -> Position:
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError("coordinate out of range")
    return (lon, lat)


def _validated_ring(points: list[Position]) -> tuple[Position, ...]:
    """Keep one open ring with distinct vertices and a bounded size."""
    if len(points) >= 2 and points[0] == points[-1]:
        points = points[:-1]
    if not 3 <= len(points) <= MAX_VERTICES or len(set(points)) != len(points):
        raise ValueError("ring size")
    return tuple(points)


def _ring_drawable(ring: tuple[Position, ...]) -> bool:
    return all(
        abs(b[0] - a[0]) <= 180
        for a, b in zip(ring, ring[1:] + ring[:1], strict=True)
    )


def _ring(points: list[Position]) -> tuple[Position, ...]:
    """Refuse a ring the map cannot draw as published."""
    ring = _validated_ring(points)
    if not _ring_drawable(ring):
        raise _UndrawnRingError("ring crosses the antimeridian")
    return ring


def _moment(year: int, month: int, day: int, hhmm: str) -> datetime:
    return datetime(year, month, day, int(hhmm[:2]), int(hhmm[2:]), tzinfo=UTC)


def _window(start: datetime, end: datetime) -> Window:
    if not timedelta(0) < end - start <= MAX_WINDOW:
        raise ValueError("window length")
    return Window(start, end)


def _positive_window(start: datetime, end: datetime) -> Window:
    if end <= start:
        raise ValueError("window order")
    return Window(start, end)


_DM_PAIR = re.compile(r"(\d{2})-(\d{2}(?:\.\d+)?)([NS])\s+(\d{3})-(\d{2}(?:\.\d+)?)([EW])")
_PARAGRAPH = re.compile(r"(?<!\S)(\d{1,2})\.(?!\d)")
_LABEL = re.compile(r"(?:^| )([A-Z])\. ")
_BOUND = re.compile(r"\bIN AREAS? BOUND BY:?")
_ISSUE = re.compile(rf"^(\d{{2}})(\d{{2}})(\d{{2}})Z ({_MON}) (\d{{4}})$")
_CANCEL_SELF = re.compile(rf"CANCEL\s+THIS\s+MSG\s+(\d{{2}})(\d{{4}})Z\s+({_MON})\s+(\d{{2}})\b")
_CANCEL_OTHER = re.compile(r"CANCEL (NAVAREA (?:IV|XII)|HYDROLANT|HYDROPAC|HYDROARC) (\d+/\d{2})")
_SPACE_OPERATIONS = re.compile(
    r"\b(?:ROCKET\w*|SPACE(?:CRAFT)?|SATELLITE\w*|BOOSTER\w*|STAGES?|"
    r"RE-?ENTR(?:Y|IES)|RE-?ENTER(?:S|ED|ING)?)\b"
    r"|\bLAUNCH(?:ING|ES|ED)?\b",
    re.IGNORECASE,
)
_UNCERTAIN_FLIGHT = re.compile(
    r"\b(?:(?:DE|SUB)?ORBIT\w*|FLIGHTS?|FLYING|AIRBORNE|AIRCRAFT|AERIAL)\b", re.IGNORECASE,
)
_BROADCAST_LOCATIONS = (
    "ALASKA", "ANGUILLA", "ANTIGUA AND BARBUDA", "BAHAMAS", "BAY OF CAMPECHE",
    "BELIZE", "BERING SEA", "BERING STRAIT", "BRAZIL", "CALIFORNIA", "CANADA",
    "CARIBBEAN SEA", "CAYMAN ISLANDS", "COLOMBIA", "CUBA", "CURACAO",
    "DOMINICAN REPUBLIC", "EASTERN CARIBBEAN SEA", "EASTERN INDIAN OCEAN",
    "EASTERN NORTH PACIFIC", "FEDERATED STATES OF MICRONESIA", "FLORIDA",
    "FRENCH GUIANA", "GUADELOUPE", "GUATEMALA", "GULF OF AMERICA",
    "GULF OF HONDURAS", "GULF OF MEXICO", "GUYANA", "HAITI", "HAWAII", "HONDURAS",
    "HUDSON BAY", "HUDSON STRAIT", "JAMAICA", "KIRIBATI", "LOUISIANA", "MARTINIQUE",
    "MEXICO", "MIDWAY ISLANDS", "NETHERLANDS ANTILLES", "NORTH ATLANTIC",
    "NORTH PACIFIC", "OLD BAHAMA CHANNEL", "OREGON", "PACIFIC OCEAN", "PANAMA",
    "SOUTH PACIFIC", "SURINAME", "TEXAS", "TRINIDAD AND TOBAGO", "VENEZUELA",
    "WESTERN CARIBBEAN SEA", "WESTERN NORTH ATLANTIC", "YUCATAN CHANNEL",
)
_BROADCAST_GEOGRAPHY = re.compile(
    r"\s*(?:(?:" + "|".join(re.escape(place) for place in _BROADCAST_LOCATIONS)
    + r")\.(?=\s|$)|CHART[ \t]+\d{5}(?:[ \t]*,[ \t]*\d{5})*\.?"
    r"(?=[ \t]*(?:\r?\n|$)))",
    re.IGNORECASE,
)
_NAVIGATION_SUBJECTS = (
    "AIDS TO NAVIGATION", "BEACON ISLAND RACON", "BOATSWAIN POINT LIGHT",
    "BROADCAST AND COMMUNICATION SERVICES", "BUOY", "CAYO ARENAS LIGHT",
    "CAYO FRAGOSO LIGHT", "CHILTEPEC LIGHT", "CHUPARA POINT LIGHT",
    "COMMDET KODIAK, AK REMOTE SITE SHEMYA", "COROCORO ISLAND LIGHTHOUSE",
    "COVE ROJO LIGHTHOUSE", "CROWN POINT LIGHT", "DEMERARA ENTRANCE BUOY",
    "ENAP RANGE LIGHTS", "GREEN BUOY", "HUNTING CAY, ZAPODILLA CAYS LIGHT",
    "ILE DE LA TORTUE W. POINT LIGHT", "ILE ROYALE LIGHT", "ILE VACHE LIGHT",
    "ILET A GOZIER LIGHT", "ILET CABRITS LIGHT", "ISLA CONTOY LIGHT", "JRCC CURACAO",
    "KLEIN CURACAO LIGHT", "LA BARRA LIGHT", "LA TABLA LIGHT", "LIGHT",
    "MISSION LAKE LIGHT", "MORRO SANTO DOMINGO LIGHT", "NAVAREA IV/XII WEB SERVICES",
    "NAVTEX STATION", "NUMBER 2 BUOY", "ODAS BUOY", "PORTLAND RIDGE LIGHT",
    "PUERTO CORTES ENTRANCE BUOY", "PUERTO MORELOS LIGHT", "PUERTO PLATA LIGHT",
    "PUNTA ALLEN LIGHT", "PUNTA DEL ARENAL LIGHT", "PUNTA LAGUNA LIGHT",
    "PUNTA PALMAS LIGHT", "PUNTA SAL LIGHT", "PUNTA ZAPOTITLAN LIGHT", "RACON",
    "RECALADA GUIRIA LIGHT", "ROCA PARTIDA LIGHT", "SAFE WATER BUOY",
    "SANDBORE CAY LIGHT", "TONALA LIGHT", "TULUM LIGHT", "UNARE LIGHT",
    "USCG REMOTE COMMUNICATION FACILITY", "ZORRITA LIGHT",
)
_TIME_GROUP = re.compile(
    rf"(?<![\dA-Z])(?:"
    rf"(?P<opens>\d{{4}})Z TO (?P<closes>\d{{4}})Z DAILY (?P<first_day>\d{{1,2}})"
    rf"(?: (?P<first_month>{_MON}))? THRU? (?P<last_day>\d{{1,2}}) (?P<last_month>{_MON})"
    rf"|(?P<start_day>\d{{2}})(?P<start_time>\d{{4}})Z(?: (?P<start_month>{_MON}))?"
    rf" TO (?P<end_day>\d{{2}})?(?P<end_time>\d{{4}})Z(?: (?P<end_month>{_MON}))?"
    rf")(?![\dA-Z])"
)
_BETWEEN_GROUPS = re.compile(r",|\b(?:AND|ALTERNATE)\b")


def _year_for(issued: datetime, month: int, day: int, hhmm: str) -> datetime:
    """A group carries no year. It belongs to the first such date not long before issue."""
    moment = _moment(issued.year, month, day, hhmm)
    if moment < issued - timedelta(days=45):
        moment = _moment(issued.year + 1, month, day, hhmm)
    return moment


def _broadcast_windows(text: str, issued: datetime) -> _Schedule:
    """Time groups of one schedule. A month applies to the groups written before it.

    Text between groups that is not a separator is returned as it stands, piece by piece.
    """
    flat = " ".join(text.upper().split())
    groups = list(_TIME_GROUP.finditer(flat))
    edges = [0, *(edge for group in groups for edge in group.span()), len(flat)]
    gaps = [flat[edges[index] : edges[index + 1]] for index in range(0, len(edges), 2)]
    pieces = [piece.strip(" .:") for gap in gaps for piece in _BETWEEN_GROUPS.split(gap)]
    schedule = _Schedule(unreadable=[piece for piece in pieces if piece])
    month_after: str | None = None
    for group in reversed(groups):
        try:
            found, month_after = _group_windows(group, issued, month_after)
        except ValueError:
            schedule.unreadable.append(group.group(0))
            continue
        for window in found:
            schedule.add(window, group.group(0))
    schedule.windows.sort(key=lambda window: window.start)
    return schedule


def _group_windows(
    group: re.Match[str],
    issued: datetime,
    month_after: str | None,
) -> tuple[list[Window], str]:
    if group["opens"]:
        first_month = group["first_month"] or group["last_month"]
        day = _year_for(
            issued, _MONTHS.index(first_month) + 1, int(group["first_day"]), group["opens"]
        )
        last = _year_for(
            issued,
            _MONTHS.index(group["last_month"]) + 1,
            int(group["last_day"]),
            group["opens"],
        )
        if last < day or last - day > timedelta(days=62):
            raise ValueError("daily range")
        found = []
        while day <= last:
            end = day.replace(hour=int(group["closes"][:2]), minute=int(group["closes"][2:]))
            if end <= day:
                end += timedelta(days=1)
            found.append(_window(day, end))
            day += timedelta(days=1)
        return found, first_month
    end_month = group["end_month"] or month_after
    if end_month is None:
        raise ValueError("no month")
    start_month = group["start_month"] or end_month
    start_day, start_time, end_time = group["start_day"], group["start_time"], group["end_time"]
    start = _year_for(issued, _MONTHS.index(start_month) + 1, int(start_day), start_time)
    if group["end_day"] is None:
        end = start.replace(hour=int(end_time[:2]), minute=int(end_time[2:]))
        if end <= start:
            end += timedelta(days=1)
    else:
        end = _year_for(issued, _MONTHS.index(end_month) + 1, int(group["end_day"]), end_time)
        if end <= start and group["start_month"] is None:
            start = (start.replace(day=1) - timedelta(days=1)).replace(day=int(start_day))
            start_month = _MONTHS[start.month - 1]
    return [_positive_window(start, end)], start_month


def _broadcast_ring(text: str) -> tuple[Position, ...]:
    if _DM_PAIR.sub("", text).strip(" ,.\t\n"):
        raise ValueError("text between coordinates")
    points = [
        _position(_sexagesimal(ns, lat_d, lat_m), _sexagesimal(ew, lon_d, lon_m))
        for lat_d, lat_m, ns, lon_d, lon_m, ew in _DM_PAIR.findall(text)
    ]
    return _validated_ring(points)


@dataclass(frozen=True)
class _Labelled:
    prefix: str
    chunks: tuple[tuple[str, str], ...]


def _labelled(text: str) -> _Labelled:
    marks = list(_LABEL.finditer(text))
    return _Labelled(
        text[:marks[0].start()] if marks else text,
        tuple(
            (
                mark.group(1),
                text[
                    mark.end() : (marks[index + 1].start() if index + 1 < len(marks) else len(text))
                ],
            )
            for index, mark in enumerate(marks)
        ),
    )


def _broadcast_kind(phrase: str) -> str:
    if phrase == "HAZARDOUS OPERATIONS, ROCKET LAUNCHING":
        return "launch"
    if phrase == "HAZARDOUS OPERATIONS, SPACE DEBRIS":
        return "space_debris"
    return "other"


@dataclass(frozen=True)
class _BroadcastBody:
    preamble: str
    paragraphs: tuple[tuple[int, str], ...]


def _broadcast_body(text: str) -> _BroadcastBody:
    cancellations = tuple(match.span() for match in _CANCEL_SELF.finditer(text))
    marks = tuple(
        mark for mark in _PARAGRAPH.finditer(text)
        if not any(start <= mark.start() < end for start, end in cancellations)
    )
    return _BroadcastBody(
        text[:marks[0].start()] if marks else text,
        tuple(
            (
                int(mark[1]),
                text[
                    mark.end():(marks[index + 1].start() if index + 1 < len(marks) else len(text))
                ],
            )
            for index, mark in enumerate(marks)
        ),
    )


def _after_broadcast_geography(text: str) -> str:
    offset = 0
    while match := _BROADCAST_GEOGRAPHY.match(text, offset):
        offset = match.end()
    return text[offset:].strip()


class _Relevance(Enum):
    RELEVANT = auto()
    OTHER = auto()
    UNCERTAIN = auto()


_MARINE_VOCABULARY: tuple[str, ...] = (
    r"(?:INTERMITTENT )?MISSILE (?:FIRING )?OPERATIONS\b",
    r"FIRING OPERATIONS\b",
    r"GUNNERY FIRING\b",
    r"DREDGING OPERATIONS\b",
    r"MILITARY EXERCISES\b",
    r"(?:SURVEY|UNDERWATER|CABLE|PIPELINE) (?:LAYING )?OPERATIONS\b",
    r"(?:SCIENTIFIC )?MOORINGS?\b",
    r"DEPTHS LESS THAN CHARTED\b",
    r"(?:\d+(?:\.\d+)? METER )?SHOAL\b",
    r"UNCHARTED REEF\b",
    r"DANGEROUS WRECK\b",
    r"VESSEL\b",
    r"NAVAREA (?:IV|XII) (?:WARNINGS IN FORCE|MOBILE OFFSHORE DRILLING UNITS)\b",
    *(re.escape(subject) + r"\b" for subject in _NAVIGATION_SUBJECTS),
)
_MARINE_ACTIVITY = re.compile("(?:" + "|".join(_MARINE_VOCABULARY) + ")")


@dataclass(frozen=True)
class _AuditedGenericExclusion:
    body_sha256: str
    reason: str


_AUDITED_GENERIC_EXCLUSIONS: dict[str, _AuditedGenericExclusion] = {
    "NAVAREA XII 802/26": _AuditedGenericExclusion(
        "e6fc38412cc123d3ff1a3ebc57302bf9ccc39812e2399591236582671086a126",
        "Audited California one-mile closure at 32-35.82N 117-10.88W; "
        "capture names no launch range or authority.",
    ),
    "NAVAREA XII 795/26": _AuditedGenericExclusion(
        "2d289e1cab7950c0c85fa352747c4037ae93a284d9c49ef125b120224c77941a",
        "Audited California polygon near 33-59.00N 119-26.00W; "
        "capture names no launch range or authority.",
    ),
    "NAVAREA XII 752/26": _AuditedGenericExclusion(
        "334ca9a77836d1abd61dd9814a5af9eebec4ce4147004840e1f3f18beb58aa4e",
        "Audited California polygon near 32-55.00N 118-25.00W; "
        "capture names no launch range or authority.",
    ),
    "NAVAREA XII 751/26": _AuditedGenericExclusion(
        "34d681b8ff5471f07cecac3b708ab3b84b05b39da26114aa61a98a967f94c610",
        "Audited California polygon near 32-52.70N 119-11.96W; "
        "capture names no launch range or authority.",
    ),
    "NAVAREA XII 750/26": _AuditedGenericExclusion(
        "aab1914fb54eb050ba1367b8f2b0032b1d4f0495aebb05c763012f70bce896af",
        "Audited California polygon near 32-33.00N 118-25.00W; "
        "capture names no launch range or authority.",
    ),
    "NAVAREA IV 1100/23": _AuditedGenericExclusion(
        "8ec731b7bf5b30500fe0fb8a0660a796dd0c13904f282d61f5d9081250f0192d",
        "Audited indefinite Venezuela closure under VENEZUELA 17/23; "
        "capture names no launch authority.",
    ),
    "NAVAREA IV 222/23": _AuditedGenericExclusion(
        "594d893f0a37071188cffb3ea421fc22193d5ee7600aa38a9b7ccc0217da2a64",
        "Audited Anguilla anchoring prohibition and wide berth request under ANGUILLA 2/23; "
        "capture names no launch authority.",
    ),
}
_GENERIC_MARINE = re.compile(
    r"^(?:HAZARDOUS OPERATIONS|(?:NAVIGATION|ANCHORING) PROHIBITED)\b[ ,:;]*(?:DUE TO )?"
)
_MARINE_ADVICE = re.compile(
    r"(?:CANCEL\b|VESSELS\b|MARINERS\b|THE COMPLETE TEXT OF ALL IN-FORCE\b|"
    r"TO REPORT A MOBILE OFFSHORE DRILLING UNIT\b|HONOLULU BROADCASTS\b|DSC RESPONSES\b)"
)
_ACTIVITY_SUBJECT = re.compile(r"\b(OPERATIONS?|ACTIVIT(?:Y|IES))\b")
_SUBJECT_BREAK = re.compile(r"[^A-Z -]+")
_MARINE_SUBJECT = re.compile(rf"{_MARINE_ACTIVITY.pattern}$")
_GENERIC_SUBJECT = re.compile(
    r"^(HAZARDOUS OPERATIONS|NAVIGATION PROHIBITED|ANCHORING PROHIBITED)"
    r"(?: IN PROGRESS)?(?= |$)"
)
_GENERIC_RADIUS = re.compile(r"\bIN AREA WITHIN (ONE|\d+(?:\.\d+)?) MILES? OF ")
_SPACE_AUTHORITY = re.compile(r"\b(?:LAUNCH RANGE|EASTERN RANGE|WESTERN RANGE)\b", re.IGNORECASE)
_GENERIC_ADVICE = "WIDE BERTH REQUESTED."


@dataclass(frozen=True)
class _GenericBroadcast:
    subject: str
    areas: tuple[Area, ...]
    cancels: tuple[str, ...]
    valid_until: datetime | None
    indefinite: bool


def _space_authority(authority: object) -> bool:
    return isinstance(authority, str) and bool(
        _SPACE_OPERATIONS.search(authority) or _SPACE_AUTHORITY.search(authority)
    )


def _generic_broadcast(text: str, issued: datetime | None) -> _GenericBroadcast | None:
    if issued is None:
        return None
    body = _broadcast_body(text)
    if body.paragraphs:
        if (
            not _sequential_numbers(tuple(number for number, _ in body.paragraphs))
            or _after_broadcast_geography(body.preamble)
        ):
            return None
        first = body.paragraphs[0][1]
        rest = " ".join(content for _, content in body.paragraphs[1:])
    else:
        first, rest = _after_broadcast_geography(body.preamble), ""
    first, rest = " ".join(first.upper().split()), " ".join(rest.upper().split())
    subject = _GENERIC_SUBJECT.match(first)
    if subject is None:
        return None
    first = first[subject.end():].strip()
    if first.endswith(_GENERIC_ADVICE):
        first = first[:-len(_GENERIC_ADVICE)].rstrip()
        rest = f"{_GENERIC_ADVICE} {rest}".strip()
    bound, label, radius = _BOUND.search(first), _LABEL.search(first), _GENERIC_RADIUS.search(first)
    schedules: list[tuple[str, str, str]] = []
    if bound and label and label.start() < bound.start():
        labelled = _labelled(first)
        if labelled.prefix.strip():
            return None
        for letter, chunk in labelled.chunks:
            inner = _BOUND.search(chunk)
            if inner is None:
                return None
            schedules.append((letter, chunk[:inner.start()].strip(), chunk[inner.end():].strip()))
    elif bound:
        labelled = _labelled(first[bound.end():].strip())
        if labelled.chunks and labelled.prefix.strip():
            return None
        for letter, coordinates in labelled.chunks or (("1", labelled.prefix),):
            schedules.append((letter, first[:bound.start()].strip(), coordinates.strip()))
    elif radius:
        schedules.append(("1", first[:radius.start()].strip(), first[radius.end():].strip()))
    else:
        return None
    labels = [letter for letter, _, _ in schedules]
    if not _consecutive_area_labels(labels):
        return None
    indefinite = all(schedule == "UNTIL FURTHER NOTICE" for _, schedule, _ in schedules)
    areas: list[Area] = []
    try:
        for letter, schedule, coordinates in schedules:
            if indefinite:
                windows: tuple[Window, ...] = ()
            else:
                decoded = _broadcast_windows(schedule, issued)
                if not decoded.readable:
                    return None
                windows = tuple(decoded.windows)
            if not coordinates.endswith("."):
                return None
            if radius:
                point = _DM_PAIR.fullmatch(coordinates[:-1])
                if point is None or (radius[1] != "ONE" and Decimal(radius[1]) <= 0):
                    return None
                lat_d, lat_m, ns, lon_d, lon_m, ew = point.groups()
                _position(_sexagesimal(ns, lat_d, lat_m), _sexagesimal(ew, lon_d, lon_m))
            else:
                areas.append(Area(letter, _broadcast_ring(coordinates), windows, "prohibition"))
        valid_until = None
        cancels: list[str] = []
        while rest:
            if rest.startswith(_GENERIC_ADVICE):
                rest = rest[len(_GENERIC_ADVICE):].lstrip()
                continue
            own = _CANCEL_SELF.match(rest)
            other = _CANCEL_OTHER.match(rest)
            if own:
                if indefinite or valid_until is not None:
                    return None
                day, hhmm, month, year = own.groups()
                valid_until = _moment(2000 + int(year), _MONTHS.index(month) + 1, int(day), hhmm)
                if valid_until <= issued:
                    return None
                end = own.end()
            elif other:
                cancels.append(f"{other[1]} {other[2]}")
                end = other.end()
            else:
                return None
            if rest[end:end + 1] != ".":
                return None
            rest = rest[end + 1:].lstrip()
    except (ValueError, InvalidOperation):
        return None
    if not indefinite and valid_until is None:
        return None
    return _GenericBroadcast(subject[1], tuple(areas), tuple(cancels), valid_until, indefinite)


def _launch_relevance(
    text: object, *, issued: datetime | None = None, authority: object = None,
    notice_id: str | None = None,
) -> _Relevance:
    if not isinstance(text, str) or not text.strip():
        return _Relevance.UNCERTAIN
    exclusion = _AUDITED_GENERIC_EXCLUSIONS.get(notice_id) if notice_id is not None else None
    if exclusion is not None and (
        hashlib.sha256(" ".join(text.split()).encode()).hexdigest() != exclusion.body_sha256
    ):
        return _Relevance.UNCERTAIN
    if _SPACE_OPERATIONS.search(text) or _space_authority(authority):
        return _Relevance.RELEVANT
    if _UNCERTAIN_FLIGHT.search(text):
        return _Relevance.UNCERTAIN
    if exclusion is not None and _generic_broadcast(text, issued) is not None:
        return _Relevance.OTHER
    body = _broadcast_body(text)
    preamble = _after_broadcast_geography(body.preamble)
    components = ([preamble] if preamble else []) + [content for _, content in body.paragraphs]
    if not components:
        return _Relevance.UNCERTAIN
    for index, component in enumerate(components):
        operative = " ".join(_after_broadcast_geography(component).upper().split()).lstrip(" .:;?,")
        operative, generic_prefix_count = _GENERIC_MARINE.subn("", operative, count=1)
        if not _MARINE_ACTIVITY.match(operative) and not (
            index and not generic_prefix_count and _MARINE_ADVICE.match(operative)
        ):
            return _Relevance.UNCERTAIN
        subject_start = 0
        for activity in _ACTIVITY_SUBJECT.finditer(operative):
            subject = _SUBJECT_BREAK.split(operative[subject_start:activity.start()])[-1].strip()
            subject_start = activity.end()
            if not subject and activity[1].startswith("OPERATION"):
                continue
            if not _MARINE_SUBJECT.search(f"{subject} {activity[1]}"):
                return _Relevance.UNCERTAIN
    return _Relevance.OTHER


def _drop_other(notice_id: str, reason: str) -> None:
    logging.getLogger(__name__).warning("DROP_OTHER notice_id=%s reason=%s", notice_id, reason)


def _other_broadcast_notice(
    text: str, notice_id: str, source_url: str, digest: str, issued: datetime | None = None,
) -> Notice:
    _drop_other(
        notice_id,
        _AUDITED_GENERIC_EXCLUSIONS[notice_id].reason
        if notice_id in _AUDITED_GENERIC_EXCLUSIONS
        else "NON_LAUNCH_MARINE_ACTIVITY",
    )
    return Notice(
        authority="NGA", notice_id=notice_id, kind="other", domain="maritime",
        subject=_lead(" ".join(text.split())), areas=(), cancels=(), valid_until=None,
        problems=(), source_url=source_url, source_sha256=digest, valid_from=issued,
    )


def parse_broadcast_warning(
    text: str,
    notice_id: str,
    issued: datetime,
    source_url: str,
    source_sha256: str,
    *,
    strict: bool = False,
    authority: object = None,
) -> Notice:
    """Decode a warning body. Strict source confirmation requires every relevant structure."""
    relevance = _launch_relevance(text, issued=issued, authority=authority, notice_id=notice_id)
    if strict and relevance is _Relevance.OTHER:
        return _other_broadcast_notice(text, notice_id, source_url, source_sha256, issued)
    generic = _generic_broadcast(text, issued)
    if (
        generic is not None
        and _space_authority(authority)
        and generic.indefinite
        and generic.subject in {"NAVIGATION PROHIBITED", "ANCHORING PROHIBITED"}
        and generic.areas
    ):
        return Notice(
            authority="NGA", notice_id=notice_id, kind="standing_closure", domain="maritime",
            subject=generic.subject, areas=generic.areas, cancels=generic.cancels,
            valid_until=None, problems=tuple(
                f"GEOMETRY_UNDRAWN:ANTIMERIDIAN:{area.area_id}"
                for area in generic.areas if not area.drawable
            ), source_url=source_url, source_sha256=source_sha256, valid_from=issued,
        )
    body = _broadcast_body(text)
    if strict and not _sequential_numbers(tuple(number for number, _ in body.paragraphs)):
        raise NoticeError("NGA_ROW")
    paragraphs = {number: " ".join(content.split()) for number, content in body.paragraphs}
    unread_preamble = bool(body.paragraphs and _after_broadcast_geography(body.preamble))
    if strict and unread_preamble:
        raise NoticeError("NGA_ROW")
    first = paragraphs.get(1, "")
    rest = " ".join(body for number, body in paragraphs.items() if number != 1)
    cancel = _CANCEL_SELF.search(rest)
    valid_until = None
    if cancel:
        day, hhmm, month, year = cancel.groups()
        valid_until = _moment(2000 + int(year), _MONTHS.index(month) + 1, int(day), hhmm)
    cancels = tuple(f"{series} {number}" for series, number in _CANCEL_OTHER.findall(rest))
    bound = _BOUND.search(first)
    label = _LABEL.search(first)
    schedules: list[tuple[str, str, str]] = []
    problems: list[str] = ["RELEVANCE_UNCERTAIN"] if relevance is _Relevance.UNCERTAIN else []
    if unread_preamble:
        problems.append("PREAMBLE_UNPARSED")
    if bound and label and label.start() < bound.start():
        labelled = _labelled(first)
        phrase = labelled.prefix
        if _broadcast_kind(phrase.strip(" :,")) == "other":
            problems.append("GEOMETRY_UNPARSED:PREFIX")
        for letter, chunk in labelled.chunks:
            inner = _BOUND.search(chunk)
            if inner:
                schedules.append((letter, chunk[: inner.start()], chunk[inner.end() :]))
            else:
                problems.append(f"GEOMETRY_UNPARSED:{letter}")
    elif bound:
        head, tail = first[: bound.start()], first[bound.end() :]
        digit = re.search(r"\d", head)
        phrase = head[: digit.start()] if digit else head
        schedule = head[digit.start() :] if digit else ""
        labelled = _labelled(tail)
        if labelled.chunks and labelled.prefix.strip():
            problems.append("GEOMETRY_UNPARSED:PREFIX")
        for letter, chunk in labelled.chunks or (("1", labelled.prefix),):
            schedules.append((letter, schedule, chunk))
    else:
        digit = re.search(r"\d", first)
        phrase = first[: digit.start()] if digit else first
    kind = _broadcast_kind(phrase.strip(" :,"))
    if strict and kind == "other":
        raise NoticeError("NGA_ROW")
    areas: list[Area] = []
    for letter, schedule, coordinates in schedules:
        decoded = _broadcast_windows(schedule, issued)
        problems.extend(decoded.problems)
        if strict and kind != "other" and not decoded.readable:
            raise NoticeError("NGA_ROW")
        try:
            ring = _broadcast_ring(coordinates)
        except (ValueError, InvalidOperation):
            problems.append(f"GEOMETRY_UNPARSED:{letter}")
            continue
        area = Area(letter, ring, tuple(decoded.windows), "hazard")
        if not area.drawable:
            problems.append(f"GEOMETRY_UNDRAWN:ANTIMERIDIAN:{letter}")
        areas.append(area)
    if kind != "other":
        remaining = _CANCEL_OTHER.sub("", _CANCEL_SELF.sub("", rest)).strip(" ./")
        if len(_CANCEL_SELF.findall(rest)) != 1 or remaining:
            problems.append("CANCEL_UNPARSED")
        if strict and (
            not areas
            or any(not problem.startswith(("WINDOW_UNPARSED:", "GEOMETRY_UNDRAWN:"))
                   for problem in problems)
            or valid_until is None
            or valid_until <= issued
            or not _consecutive_area_labels([letter for letter, _, _ in schedules])
        ):
            raise NoticeError("NGA_ROW")
    if any(problem.startswith("GEOMETRY_UNPARSED") for problem in problems):
        areas = []
    return Notice(
        authority="NGA",
        notice_id=notice_id,
        kind=kind,
        domain="maritime",
        subject=phrase.strip(" :,"),
        areas=tuple(areas),
        cancels=cancels,
        valid_until=valid_until,
        problems=tuple(dict.fromkeys(problems)),
        source_url=source_url,
        source_sha256=source_sha256,
        valid_from=issued,
    )


_NGA_ROW_FIELDS = frozenset({
    "area", "authority", "cancelDate", "cancelMsgNumber", "cancelMsgYear", "cancelNavArea",
    "issueDate", "msgNumber", "msgYear", "navArea", "number", "status", "subregion", "text", "year",
})


def parse_nga_payload(body: bytes, source_url: str) -> list[Notice]:
    """NGA MSI ``broadcast-warn`` JSON. Unreadable rows cannot replace a snapshot."""
    if len(body) > MAX_SOURCE_BYTES:
        raise NoticeError("NGA_TOO_LARGE")
    try:
        payload = _decode_json(body)
    except (ValueError, UnicodeError) as exc:
        raise NoticeError("NGA_NOT_JSON") from exc
    rows = payload.get("broadcast-warn") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or set(payload) != {"broadcast-warn"}:
        raise NoticeError("NGA_SHAPE")
    requested_areas = parse_qs(urlsplit(source_url).query).get("navArea", [])
    requested_area = requested_areas[0] if len(requested_areas) == 1 else None
    digest = sha256_hex(body)
    notices: list[Notice] = []
    relevant_ids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise NoticeError("NGA_ROW")
        raw_area = row.get("navArea")
        nav_area = str(raw_area) if type(raw_area) in (int, str) else ""
        if requested_area is not None and nav_area != requested_area:
            raise NoticeError("NGA_ROW")
        series = _SERIES.get(nav_area)
        supported: bool | None = (
            True if series is not None
            else False if re.fullmatch(r"(?:[1-9]|1[0-9]|2[01])", nav_area)
            else None
        )
        if requested_area is not None or supported is not False:
            _known_fields(row, _NGA_ROW_FIELDS, "NGA_ROW")
        if not _readable_relevance(supported, error="NGA_ROW"):
            continue
        number, year, text = row.get("msgNumber"), row.get("msgYear"), row.get("text")
        readable_number = str(number) if type(number) is int and number > 0 else "?"
        readable_year = f"{year % 100:02d}" if type(year) is int else "?"
        notice_id = f"{series} {readable_number}/{readable_year}"
        if (
            _launch_relevance(text, authority=row.get("authority"), notice_id=notice_id)
            is _Relevance.OTHER
        ):
            notices.append(_other_broadcast_notice(
                str(text), notice_id, source_url, digest,
            ))
            continue
        issue = (
            _ISSUE.fullmatch(row["issueDate"])
            if isinstance(row.get("issueDate"), str) else None
        )
        if (
            series is None
            or type(number) is not int
            or number <= 0
            or type(year) is not int
            or not 1900 <= year <= 9999
            or not isinstance(text, str)
            or not text.strip()
            or issue is None
        ):
            raise NoticeError("NGA_ROW")
        day, hour, minute, month, issue_year = issue.groups()
        try:
            issued = _moment(int(issue_year), _MONTHS.index(month) + 1, int(day), hour + minute)
            notice = parse_broadcast_warning(
                text, notice_id, issued, source_url, digest,
                strict=True, authority=row.get("authority"),
            )
        except ValueError as exc:
            raise NoticeError("NGA_ROW") from exc
        if notice.kind != "other":
            if notice.notice_id in relevant_ids:
                raise NoticeError("NGA_ROW")
            relevant_ids.add(notice.notice_id)
        notices.append(notice)
    return notices


_USCG_HAZARD_LABEL = re.compile(r"^(HIGH RISK )?HAZARD AREA(?: ([A-Z]))?\s*:$")
_USCG_FROM = re.compile(r"^([A-Z])\. FROM (.+)$")
_USCG_NUMBERED = re.compile(r"(?m)^\d{1,2}\. ")
_USCG_GLOBAL_TIMES = re.compile(
    r"HAZARD TIMES:?|PRIMARY AND BACKUP LAUNCH DAY HAZARD PERIODS INCLUDE:"
)
_USCG_LAUNCH_SECTION = re.compile(
    r"SPACE LAUNCH OPERATIONS, WHICH MAY BE HAZARDOUS TO SURFACE VESSELS, WILL "
    r"BE CONDUCTED WITHIN PORTIONS OF THE FOLLOWING HAZARD AREAS FOR "
    r"(?:STARSHIP FLIGHT \d+|VULCAN [A-Z0-9-]+)"
)
_USCG_SHARED_SECTION = (
    "HAZARD PERIODS FOR PRIMARY LAUNCH DAY AND BACKUP LAUNCH DAYS "
    "(ALL TIMES ARE REPRESENTED AS ZULU TIME UNLESS OTHERWISE INDICATED)"
)
_USCG_DMS = re.compile(
    r"(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)([NS])[ /](\d{3})-(\d{2})-(\d{2}(?:\.\d+)?)([EW])"
)
_USCG_REGULATED_SECTION = re.compile(
    r"THE U\.S\. COAST GUARD HAS ESTABLISHED A REGULATED NAVIGATION AREA UNDER "
    r"33 CFR \d+\.\d+ TO ENCOMPASS THE WATERS BOUND BY THE COORDINATES: "
    rf"A\. FROM {_USCG_DMS.pattern}(?: TO {_USCG_DMS.pattern})+"
    r", THEN FOLLOWING THE SHORELINE BACK TO THE POINT OF ORIGIN\. "
    r"B\. MARINERS ARE ADVISED THAT THE AREA ENCOMPASSED BY THIS ZONE IS CLOSED TO "
    r"ALL VESSELS AND PERSONS EXCEPT AS AUTHORIZED BY THE COMMANDER, COAST GUARD "
    r"DISTRICT SOUTHEAST OR THE CAPTAIN OF THE PORT, JACKSONVILLE, FL BEGINNING \d+ "
    r"MINUTES PRIOR TO THE SCHEDULED LAUNCH WINDOW IN THIS NOTICE UNTIL REOPENED BY "
    r"THE CAPTAIN OF THE PORT, JACKSONVILLE, FL VIA BROADCAST ON VHF-FM CHANNEL \d+ "
    r"AND CANCELLATION OF THIS BROADCAST NOTICE TO MARINERS MESSAGE\. DETAILED "
    r"LAUNCH INFORMATION IS AVAILABLE ON THE DAY OF LAUNCH BY CONTACTING THE U\.S\. "
    r"COAST GUARD VIA VHF-FM CHANNEL \d+ AND \d+[A-Z]? OR THROUGH THE U\.S\. SPACE "
    r"FORCE LAUNCH INFORMATION HOTLINE AT [\d-]+\."
)
_USCG_RESTRICTED_SECTION = re.compile(
    r"THE U\.S\. SPACE FORCE AND KENNEDY SPACE CENTER MAY CHOOSE TO ENFORCE A "
    r"RESTRICTED AREA AS SPECIFIED IN 33 CFR \d+\.\d+ AND 33 CFR \d+\.\d+\. "
    r"PRIMARILY BEGINNING \d+ HOURS PRIOR TO THE SCHEDULED LAUNCH WINDOW OF ANY "
    r"ROCKET LAUNCHES\. THE RESTRICTED AREA WOULD REMAIN IN EFFECT UNTIL "
    r"SUSPENDED BY SPACE LAUNCH DELTA \d+\."
)
_USCG_INTRO = re.compile(
    r"(?:SPACE OPERATIONS/(?:HAZARDOUS WARNING AREA/GOVERNMENT SUPPORTED \(HAZARDOUS\)|"
    r"ACTIVE RNA/GOVERNMENT SUPPORTED \(RNA\))|"
    r"HAZARDOUS OPERATIONS WILL BE CONDUCTED FOR (?:"
    r"(?:VANDENBERG SPACE FORCE BASE, WESTERN RANGE OPERATION [A-Z0-9-]+|"
    r"SPACE X, [A-Z0-9-]+(?: LAUNCH OPERATIONS)?)\. HAZARDOUS OPERATION|"
    r"LAUNCH OPERATION, [A-Z0-9-]+ OPERATION) AREAS ARE BOUNDED BY THE FOLLOWING "
    r"COORDINATES AND TIMES:|GULF OF AMERICA - CARIBBEAN SEA --- "
    + _USCG_LAUNCH_SECTION.pattern + r":)"
)
_USCG_DECIMAL = re.compile(r"(\d{1,2}(?:\.\d+)?) ?N, -(\d{1,3}(?:\.\d+)?) ?W")
_USCG_COORDINATE_LIKE = re.compile(r"\d ?[NS][ ,/]+-?\d")
_USCG_CLOCK = rf"(\d{{1,2}})/(\d{{4}})Z? ({_MON}) (\d{{2}})"
_USCG_SLASH = re.compile(rf"^{_USCG_CLOCK} TO {_USCG_CLOCK}\.?$")
_USCG_GROUP = re.compile(
    rf"(\d{{2}})(\d{{4}}) ?Z ({_MON}) TO (\d{{2}})(\d{{4}}) ?Z ({_MON}) (\d{{4}})"
    r"(?:-+ (?:DO \d+ )?\((?:PRIMARY|BACKUP DAY)\))?\.?"
)
_USCG_YEAR_GROUP = re.compile(
    rf"(\d{{2}})(\d{{4}})Z ({_MON}) (\d{{2}}) TO "
    rf"(\d{{2}})(\d{{4}})Z ({_MON}) (\d{{2}})\.?"
)
_USCG_TIME_LIKE = re.compile(r"^(?:\d{1,2}/\d|\d{4,}[ A-Z])")
_OPERATION_WORD = re.compile(r"\b(?:LAUNCH(?:ING)?|RE-?ENTRY|SPLASHDOWN|RECOVERY|RETURN|LANDING)\b")
_USCG_ADVICE = re.compile(r"\bAVOID|\bREMAIN CLEAR")
_USCG_ADVICE_CLAUSE = re.compile(
    r"(?:MARINERS ARE (?:STRONGLY )?ADVISED TO REMAIN CLEAR OF THESE AREAS "
    r"FOR THE DURATION OF OPERATIONS\.|"
    r"NAVIGATION HAZARDS (?:WITHIN THE HAZARD AREAS|FROM ROCKET LAUNCHING ACTIVITY|"
    r"FROM ROCKET LAUNCH ACTIVITIES) MAY INCLUDE,? FREE FALLING DEBRIS AND/OR "
    r"DESCENDING VEHICLES OR VEHICLE COMPONENTS,? UNDER VARIOUS MEANS OF CONTROL\.|"
    r"SURFACE VESSELS ARE STRONGLY ADVISED TO AVOID THIS AREA DEFINED DURING "
    r"SPECIFIED DATES / TIMES\.|"
    r"DURING OPERATIONS, FRONTIER CONTROL WILL BE MANAGING HAZARDOUS AREA SURFACE "
    r"TRAFFIC ON VHF CH \d+ AND CH \d+\.|"
    r"FOR MORE DETAILS OR COMMENTS CONTACT 2 ROPS/DOS VIA TELEPHONE AT COMMERCIAL "
    r"[\d-]+ OR DSN [\d-]+, OR EMAIL: [A-Z0-9@._-]+\.|"
    r"FOR MORE DETAILS OR COMMENTS CONTACT [A-Z0-9 ]+ AT [A-Z0-9@._-]+"
    r"(?:, [\d-]+,)? OR ON VHF-FM CHAN\. \d+(?:, \d+)? OR \d+\.?|"
    r"VESSELS SHOULD OPERATE IN A HEIGHTENED STATE OF AWARENESS DURING THE LAUNCH "
    r"TIME AND AVOID ALL WATERS WITHIN ROCKET FLIGHT TRAJECTORIES ORIGINATING FROM "
    r"THE LAUNCH SITE NEAR BOCA CHICA/STARBASE, TEXAS, AND EXTENDING ACROSS THE "
    r"GULF OF AMERICA\.|"
    r"TO ENSURE RANGE CLEARANCE, MARINERS ARE REQUESTED TO AVOID THE HIGH-RISK "
    r"HAZARD AREA THREE HOURS PRIOR TO THE LAUNCH WINDOW\.|"
    r"FOR ADDITIONAL INFORMATION REGARDING THE LAUNCH, MARINERS CAN CONTACT THE "
    r"U\.S\. COAST GUARD SECTOR CORPUS CHRISTI COMMAND CENTER AT \(\d{3}\) "
    r"\d{3}-\d{4} OR ACCESS: WWW\.NAVCEN\.USCG\.GOV/MSI|"
    r"MARINERS SHOULD AVOID WATERS WITHIN THE DEFINED HAZARD AREAS DURING THE "
    r"SCHEDULED LAUNCH WINDOW\.|"
    r"THE HIGH RISK HAZARD AREA SHOULD BE AVOIDED THREE HOURS PRIOR TO THE "
    r"EARLIEST LAUNCH TO ENSURE RANGE CLEARANCE\.|"
    r"FOR ADDITIONAL INFORMATION, CONTACT THE U\.S\. COAST GUARD SECTOR CORPUS "
    r"CHRISTI COMMAND CENTER AT \(\d{3}\) \d{3}-\d{4}\.|"
    r"THE U\.S\. COAST GUARD IS PROVIDING THIS NOTICE TO ADVISE MARINERS OF THESE "
    r"HAZARDOUS AREAS IDENTIFIED BY U\.S\. SPACE FORCE AND/OR A COMMERCIAL SPACE "
    r"OPERATION, WHICH MAY IMPACT NAVIGATION INTERESTS\.|"
    r"MARINERS ARE URGED TO AVOID WATERS WITHIN ROCKET FLIGHT TRAJECTORIES/HAZARD "
    r"AREAS DURING LAUNCH WINDOWS AS DETAILED ABOVE\.|"
    r"FOR MORE INFORMATION, MARINERS MAY CONTACT THE U\.S\. SPACE FORCE LAUNCH "
    r"INFORMATION HOTLINE AT [\d-]+ OR BY VISITING WWW\.PATRICK\.SPACEFORCE\.MIL\.|"
    r"FOR NAVIGATIONAL SAFETY, MARINERS ARE ADVISED TO REFER TO WWW\.NAVCEN\.USCG\.GOV/MSI "
    r"TO VIEW THE LOCAL NOTICE TO MARINERS \(LNM\) AND THE GEOSPATIAL CHART AT "
    r"WWW\.NAVCEN\.USCG\.GOV/CHART FOR INFORMATION ON SPACE LAUNCH AND RECOVERY "
    r"OPERATIONS \(SOLAR\)\.)(?: |$)"
)
_USCG_PROSE_LAUNCH = re.compile(
    r"GULF OF AMERICA - HAZARDOUS SPACE OPERATIONS --- "
    r"ON ([A-Z]+ \d{1,2}, \d{4}), BETWEEN (\S+) AND (\S+), "
    r"ON ([A-Z]+ \d{1,2}, \d{4}), ROCKET LAUNCHING OPERATIONS "
    r"ARE SCHEDULED TO TAKE PLACE NEAR BOCA CHICA, TX\. BACK-UP LAUNCH DATES AND TIMES "
    r"INCLUDE THE FOLLOWING:$"
)
_USCG_ZONE_BODY = re.compile(
    r"(?P<header>[A-Z][A-Z0-9 /–-]+) --- FROM: (?P<first>\d{4}-\d{2}-\d{2}) "
    r"TO: (?P<last>\d{4}-\d{2}-\d{2}) --- THE U\.S\. COAST GUARD CAPTAIN OF THE "
    r"PORT [A-Z ]+ IS ESTABLISHING A SAFETY ZONE [A-Z ,]+\. (?P<schedule>.+?) "
    r"THE SAFETY ZONE CONSISTS OF ALL NAVIGABLE WATERS (?P<boundary>.+?) "
    r"ALL VESSELS ARE PROHIBITED FROM ENTERING THE SAFETY ZONE, UNLESS GRANTED "
    r"PERMISSION BY THE U\.S\. COAST GUARD\. "
    r"(?:MARINERS SHOULD MONITOR ALL MARINE RADIO BROADCASTS AND AVOID THE AREA "
    r"DURING THE SPECIFIED (?:LAUNCH AND REENTRY|REENTRY) TIMES\. )?"
    r"MARINERS WITH URGENT CONCERNS CAN CONTACT THE U\.S\. COAST GUARD SECTOR "
    r"[A-Z ]+ COMMAND CENTER AT \(\d{3}\) \d{3}-\d{4}\.",
)
_USCG_ZONE_BOUNDARY = re.compile(
    rf"(?:FROM |OF [A-Z ]+, FROM THE SURFACE TO BOTTOM, AND IS BOUND BY THE "
    rf"FOLLOWING POSITIONS: ){_USCG_DMS.pattern}"
    rf"(?:, (?:(?:TO |THEN FOLLOWING THE SHORELINE TO |AND FOLLOWING THE COAST BACK TO )?"
    rf"{_USCG_DMS.pattern}|THEN FOLLOWING THE 12 NAUTICAL MILE TERRITORIAL SEA LINE TO "
    rf"THE UNITED STATES OF AMERICA/MEXICO MARITIME BOUNDARY LINE|"
    rf"(?:AND )?FOLLOWING THE UNITED STATES OF AMERICA/MEXICO MARITIME BOUNDARY LINE "
    rf"TO POSITION {_USCG_DMS.pattern}|AND FOLLOWING THE [A-Z ]+ INTERNAL COASTLINE "
    rf"TO THE POINT OF ORIGIN))*\."
)
_USCG_LOCAL_CLOCK = r"\d{1,2}:\d{2} [AP]\.M\."
_USCG_ZONE_PRIMARY = re.compile(
    r"THE SAFETY ZONE WILL BE (?P<action>ACTIVE|ACTIVATED AGAIN)"
    r"(?: FOR (?P<activity>[A-Z0-9 /-]+))? ON (?P<day>[A-Z]+ \d{1,2}, \d{4}), "
    rf"FROM (?P<opens>{_USCG_LOCAL_CLOCK}) TO (?P<closes>{_USCG_LOCAL_CLOCK})"
    r"(?:, LOCAL TIME\.)?(?: |$)"
)
_USCG_ZONE_BACKUP = re.compile(
    r"BACK-UP DATES INCLUDE (?P<month>[A-Z]+) (?P<first>\d{1,2}) [-–] "
    r"(?:(?P<last_month>[A-Z]+) )?(?P<last>\d{1,2}), (?P<year>\d{4}), "
    rf"FROM (?P<opens>{_USCG_LOCAL_CLOCK}) TO (?P<closes>{_USCG_LOCAL_CLOCK})"
    r"(?:, EACH DAY\.)?(?: |$)"
)
_USCG_ZONE_REENTRY = re.compile(
    r"THE REENTRY AND LANDING OF [A-Z0-9 -]+ WILL TAKE PLACE APPROXIMATELY "
    r"\d+(?:\.\d+)? HOURS AFTER THE INITIAL LAUNCH\. "
)
_USCG_ZONE_ACTIVITIES = {
    "LAUNCH": True,
    "REENTRY/LANDING": False,
    "REENTRY AND LANDING": False,
    "REENTRY": False,
    "LANDING": False,
    "RECOVERY": False,
}
_USCG_GEOGRAPHIC_HEADING = (
    r"(?:GULF OF AMERICA|SOUTH BAY)"
    r"(?: [-–] (?:GIWW|PORT MANSFIELD CHANNEL|LAGUNA MADRE|CARIBBEAN SEA))*"
)
_USCG_OPERATION_HEADER = re.compile(
    _USCG_GEOGRAPHIC_HEADING + r" [-–] (?:SAFETY ZONE [-–] )?SPACE "
    r"((?:LAUNCH(?: AND REENTRY)?|REENTRY(?:/LANDING| AND LANDING| AND LAUNCH)?|"
    r"LANDING|RECOVERY)(?: OPERATION)?)"
    r"(?: SAFETY ZONE)?"
)
_USCG_REENTRY_LAUNCH_REFERENCE = re.compile(
    r"(?:THE REENTRY AND LANDING OF [A-Z0-9 -]+ WILL|"
    r"[A-Z0-9 -]+ REENTRY AND LANDING WILL) TAKE PLACE APPROXIMATELY "
    r"\d+(?:\.\d+)? HOURS AFTER THE INITIAL (?:[A-Z0-9 -]+ )?LAUNCH\."
)
_USCG_RECOVERY_BODY = re.compile(
    r"\bHAZARDOUS OPERATIONS SPACE DEBRIS DAILY FROM [A-Z]+ \d{1,2}, \d{4} "
    r"TO [A-Z]+ \d{1,2}, \d{4} BETWEEN \d{4}-\d{4} [A-Z]+ "
    r"\(\d{4}-\d{4} [A-Z]+\) "
    r"IN AN AREA BOUNDED BY THE FOLLOWING COORDINATES:|"
    r"\bHAZARDOUS OPERATIONS(?: FOR (?P<capsule>[A-Z0-9 -]+) REENTRY, INCLUDING SPLASHDOWN "
    r"IN THE [A-Z ]+ OCEAN[.,] WILL OCCUR BETWEEN|"
    r", INCLUDING THE TRUNK HAZARD ASCENDING, WILL BE CONDUCTED FOR "
    r"(?P<trunk>[A-Z0-9 -]+) REENTRY WITH A SPLASHDOWN IN THE [A-Z ]+ OCEAN FROM) "
    r"\d{6} ?[A-Z] [A-Z]{3}(?: \d{4})? (?:AND|TO) "
    r"\d{6} ?[A-Z] [A-Z]{3} \d{4}\.? "
    r"HAZARDOUS OPERATION AREAS ARE BOUNDED BY THE FOLLOWING COORDINATES:|"
    r"\bSPACE VEHICLE REENTRY OPERATIONS, WHICH MAY BE HAZARDOUS TO SURFACE VESSELS, "
    r"MAY TAKE PLACE WITHIN PORTIONS OF THE FOLLOWING HAZARD AREA FOR (?P<vehicle>[A-Z0-9 -]+):",
)
_USCG_RECOVERY_PREFIX = re.compile(
    r"(?:POTENTIAL FOR SPACE DEBRIS FROM THE REENTRY OF (?P<vehicle>[A-Z0-9 |/-]+)\. |"
    + _USCG_GEOGRAPHIC_HEADING + r" [-–] HAZARDOUS SPACE OPERATIONS --- )?"
)
_USCG_RECOVERY_DETAIL = re.compile(
    "(?:"
    + "|".join((
        r"[ ,.•]|AND |\(TO BEGINNING\)",
        r"(?:TRUNK )?HAZARD AREA(?: [A-Z ]+)?:|[A-Z]\. REENTRY HAZARD AREA:",
        _USCG_DMS.pattern,
        _USCG_DECIMAL.pattern,
        _DM_PAIR.pattern,
        _USCG_REENTRY_LAUNCH_REFERENCE.pattern,
        r"PRIMARY AND BACKUP REENTRY DAY HAZARD PERIODS INCLUDE:",
        r"\d{1,2}/\d{4}[A-Z]? [A-Z]{3} \d{2} TO \d{1,2}/\d{4}[A-Z]? [A-Z]{3} \d{2}",
        r"THE PRIMARY [A-Z0-9 -]+ VEHICLE LANDING AREA IS [A-Z0-9 -]+, "
        rf"LOCATED AT APPROXIMATE POSITION {_USCG_DMS.pattern}\.",
        r"THE ALTERNATE LANDING INCLUDES A SPLASHDOWN WITHIN PORTIONS OF THE REENTRY HAZARD AREA\.",
        r"NAVIGATION HAZARDS WITHIN THE REENTRY HAZARD AREA MAY INCLUDE FREE FALLING "
        r"DEBRIS AND/OR DESCENDING VEHICLES OR VEHICLE COMPONENTS UNDER VARIOUS MEANS OF CONTROL\.",
        r"MARINERS SHOULD AVOID WATERS WITHIN THE DEFINED REENTRY HAZARD AREA "
        r"DURING THE SCHEDULED REENTRY WINDOW\.",
        r"MARINERS ARE ADVISED TO REMAIN CLEAR OF THESE AREAS FOR THE DURATION OF OPERATIONS\.",
        r"THE IDENTIFIED LOCATIONS ABOVE ARE DESIGNATED A HAZARDOUS WARNING AREA\(S\) "
        r"FOR SPACE VEHICLE REENTRY\. A SPACE VEHICLE MAY REENTER WITHIN THIS/THESE "
        r"AREA\(S\) BETWEEN THE DATES AND TIMES LISTED\. "
        r"THE U\.S\. COAST GUARD IS ESTABLISHING THIS/THESE HAZARDOUS WARNING AREA\(S\) "
        r"TO PROTECT VESSELS AND WATERWAY USERS FROM THE POTENTIAL HAZARDS CREATED BY "
        r"REENTRY VEHICLE SPLASHDOWNS AND RECOVERY OPERATIONS\. "
        r"THE U\.S\. COAST GUARD IS PROVIDING THIS NOTICE TO ADVISE MARINERS OF "
        r"THIS/THESE HAZARDOUS AREA\(S\) WHICH MAY IMPACT NAVIGATION INTERESTS\. "
        r"NAVIGATIONS HAZARDS FROM SPACE CAPSULE REENTRY ACTIVITIES MAY INCLUDE "
        r"FREE FALLING DEBRIS AND/OR DESCENDING VEHICLES OR VEHICLE COMPONENTS "
        r"UNDER VARIOUS MEANS OF CONTROL\. MARINERS ARE URGED TO AVOID THE REENTRY "
        r"SITES DURING REENTRY WINDOWS AS DETAILED ABOVE\.",
        r"FOR MORE DETAILS OR COMMENTS CONTACT [A-Z0-9 ]+ AT [A-Z0-9@._-]+ "
        r"OR ON VHF-FM CHAN\. \d+, \d+ OR \d+\.?",
        r"FOR ADDITIONAL INFORMATION, CONTACT THE U\.S\. COAST GUARD SECTOR [A-Z ]+ "
        r"COMMAND CENTER AT \(\d{3}\) \d{3}-\d{4}\.",
    ))
    + ")*"
)


def _uscg_point(line: str) -> Position | None:
    text = re.sub(r"\s*\(?TO BEGINNING\)?$", "", line)
    text = re.sub(r"^(?:FROM|TO) ", "", text)
    text = re.sub(r"(?: AND|[.,])$", "", text).strip()
    dms = _USCG_DMS.fullmatch(text)
    if dms:
        lat_d, lat_m, lat_s, ns, lon_d, lon_m, lon_s, ew = dms.groups()
        return _position(
            _sexagesimal(ns, lat_d, lat_m, lat_s), _sexagesimal(ew, lon_d, lon_m, lon_s)
        )
    decimal = _USCG_DECIMAL.fullmatch(text)
    if decimal:
        return _position(float(decimal.group(1)), -float(decimal.group(2)))
    return None


def _uscg_window(line: str) -> Window | None:
    slash = _USCG_SLASH.fullmatch(line) or _USCG_YEAR_GROUP.fullmatch(line)
    if slash:
        day_a, time_a, month_a, year_a, day_b, time_b, month_b, year_b = slash.groups()
        return _positive_window(
            _moment(2000 + int(year_a), _MONTHS.index(month_a) + 1, int(day_a), time_a),
            _moment(2000 + int(year_b), _MONTHS.index(month_b) + 1, int(day_b), time_b),
        )
    group = _USCG_GROUP.fullmatch(line)
    if group:
        day_a, time_a, month_a, day_b, time_b, month_b, year = group.groups()
        return _positive_window(
            _moment(int(year), _MONTHS.index(month_a) + 1, int(day_a), time_a),
            _moment(int(year), _MONTHS.index(month_b) + 1, int(day_b), time_b),
        )
    return None


@dataclass
class _UscgArea:
    area_id: str
    high: bool
    points: list[Position] = field(default_factory=list)
    schedule: _Schedule = field(default_factory=_Schedule)


class _UscgSection(Enum):
    BODY = auto()
    HAZARDS = auto()
    TIMES = auto()
    EXCLUDED = auto()
    ADVICE = auto()
    UNKNOWN = auto()


class _UscgMode(Enum):
    INTRO = auto()
    COORDINATES = auto()
    LOCAL_TIMES = auto()
    SHARED_TIMES = auto()
    ADVICE = auto()


def _uscg_advice(text: str) -> bool:
    if not text:
        return False
    while text:
        clause = _USCG_ADVICE_CLAUSE.match(text)
        if clause is None:
            return False
        text = text[clause.end():]
    return True


def _uscg_sections(description: str) -> list[tuple[_UscgSection, str]]:
    sections = _USCG_NUMBERED.split(description)
    found = [(_UscgSection.BODY, sections[0])]
    for section in sections[1:]:
        header, colon, body = section.partition(":")
        header = " ".join(header.upper().split())
        flat = " ".join(section.upper().split())
        if colon and _USCG_LAUNCH_SECTION.fullmatch(header):
            found.append((_UscgSection.HAZARDS, body))
        elif colon and header == _USCG_SHARED_SECTION:
            found.append((_UscgSection.TIMES, body))
        elif _USCG_REGULATED_SECTION.fullmatch(flat) or _USCG_RESTRICTED_SECTION.fullmatch(flat):
            found.append((_UscgSection.EXCLUDED, section))
        elif _uscg_advice(flat):
            found.append((_UscgSection.ADVICE, section))
        else:
            found.append((_UscgSection.UNKNOWN, section))
    return found


def _uscg_prose_schedule(description: str) -> _Schedule:
    parts = [" ".join(part.upper().split()) for part in description.split("•")]
    schedule = _Schedule()
    primary = _USCG_PROSE_LAUNCH.fullmatch(parts[0])
    if primary is None or len(parts) < 2:
        schedule.unreadable.append("PROSE LAUNCH SCHEDULE")
        return schedule
    first, opens, closes, last = primary.groups()
    try:
        if not re.fullmatch(r"\d{4}Z", opens) or not re.fullmatch(r"\d{4}Z", closes):
            raise ValueError("time group")
        window = _positive_window(
            datetime.strptime(f"{first} {opens}", "%B %d, %Y %H%MZ").replace(tzinfo=UTC),
            datetime.strptime(f"{last} {closes}", "%B %d, %Y %H%MZ").replace(tzinfo=UTC),
        )
        schedule.add(window, primary.group(0))
    except ValueError:
        schedule.unreadable.append(primary.group(0))
    backups = _Schedule()
    for index, part in enumerate(parts[1:], start=1):
        if index == len(parts) - 1 and _uscg_advice(part):
            continue
        try:
            window = _uscg_window(part)
        except ValueError:
            window = None
        if window is None:
            backups.unreadable.append(part)
        else:
            backups.add(window, part)
    if not backups.readable:
        schedule.unreadable.append("BACKUP LAUNCH SCHEDULE")
    schedule.windows.extend(backups.windows)
    schedule.long_windows.extend(backups.long_windows)
    schedule.unreadable.extend(backups.unreadable)
    return schedule


def _uscg_local_window(first: str, last: str, opens: str, closes: str) -> Window:
    """Validate local dates and clocks without assigning or inferring a timezone."""
    form = "%B %d, %Y %I:%M %p"
    start = datetime.strptime(f"{first} {opens.replace('.', '')}", form)
    daily_end = datetime.strptime(f"{first} {closes.replace('.', '')}", form)
    end = datetime.strptime(f"{last} {closes.replace('.', '')}", form)
    _positive_window(start, daily_end)
    if end < daily_end:
        raise ValueError("local date order")
    return _positive_window(start, end)


@dataclass(frozen=True)
class _UscgZone:
    schedule: _Schedule
    relevance: bool | None


def _operation_subject(text: str) -> bool:
    return not _OPERATION_WORD.search(re.sub(r"\bLAUNCH VEHICLE\b", "", text))


def _uscg_zone_activity(activity: str | None) -> bool | None:
    if activity is None:
        return True
    text = activity.removeprefix("THE ").removesuffix(" OPERATION")
    for action, relevance in _USCG_ZONE_ACTIVITIES.items():
        if text == action or text.endswith(f" {action}") and _operation_subject(
            text[:-(len(action) + 1)],
        ):
            return relevance
    return None


def _uscg_zone(body: re.Match[str]) -> _UscgZone:
    schedule = _Schedule()
    activities: list[bool | None] = []
    try:
        header = _USCG_OPERATION_HEADER.fullmatch(body["header"])
        first = datetime.strptime(body["first"], "%Y-%m-%d")
        last = datetime.strptime(body["last"], "%Y-%m-%d")
        if header is None or last < first or not _USCG_ZONE_BOUNDARY.fullmatch(body["boundary"]):
            raise ValueError("zone body")
        for point in _USCG_DMS.finditer(body["boundary"]):
            _uscg_point(point.group())
        remaining = body["schedule"]
        preamble = _USCG_ZONE_REENTRY.match(remaining)
        if preamble:
            remaining = remaining[preamble.end():]
        for index in range(2):
            primary = _USCG_ZONE_PRIMARY.match(remaining)
            if primary is None or primary["action"].startswith("ACTIVATED") != bool(index):
                raise ValueError("primary schedule")
            activities.append(_uscg_zone_activity(primary["activity"]))
            schedule.add(
                _uscg_local_window(
                    primary["day"], primary["day"], primary["opens"], primary["closes"],
                ),
                primary.group(),
            )
            remaining = remaining[primary.end():]
            if remaining.startswith("BACK-UP"):
                backup = _USCG_ZONE_BACKUP.match(remaining)
                if backup is None:
                    raise ValueError("backup schedule")
                last_month = backup["last_month"] or backup["month"]
                schedule.add(
                    _uscg_local_window(
                        f"{backup['month']} {backup['first']}, {backup['year']}",
                        f"{last_month} {backup['last']}, {backup['year']}",
                        backup["opens"], backup["closes"],
                    ),
                    backup.group(),
                )
                remaining = remaining[backup.end():]
            if not remaining:
                relevance = None if None in activities else any(activities)
                if relevance is False and (
                    _uscg_zone_activity(header[1]) is not False
                ):
                    relevance = None
                return _UscgZone(schedule, relevance)
            reentry = _USCG_ZONE_REENTRY.match(remaining)
            if reentry is None or index:
                raise ValueError("unknown schedule")
            remaining = remaining[reentry.end():]
        raise ValueError("missing reactivation schedule")
    except ValueError:
        schedule.unreadable.append("REGULATED NOTICE BODY")
        return _UscgZone(schedule, None)


def _uscg_recovery_warning(flat: str) -> bool:
    operation = _USCG_RECOVERY_BODY.search(flat)
    if operation is None:
        return False
    prefix = _USCG_RECOVERY_PREFIX.fullmatch(flat[:operation.start()])
    complete = (
        prefix is not None
        and _USCG_RECOVERY_DETAIL.fullmatch(flat[operation.end():]) is not None
        and all(_operation_subject(subject or "") for subject in operation.groupdict().values())
        and _operation_subject(prefix["vehicle"] or "")
    )
    _readable_relevance(False if complete else None, error="USCG_ROW")
    return True


def _uscg_areas(description: str, *, strict: bool) -> tuple[list[Area], list[str]]:
    """Hazard areas of one Coast Guard notice. Other regulated areas in it are left out."""
    drafts: list[_UscgArea] = []
    shared = _Schedule()
    problems: list[str] = []
    advice: list[str] = []
    mode = _UscgMode.INTRO
    for section, body in _uscg_sections(description):
        if section == _UscgSection.EXCLUDED:
            continue
        if section == _UscgSection.UNKNOWN:
            if strict:
                raise NoticeError("USCG_ROW")
            problems.append("BODY_UNPARSED")
            continue
        if section == _UscgSection.ADVICE:
            mode = _UscgMode.ADVICE
            advice.append(body.strip())
            continue
        if section == _UscgSection.TIMES:
            body = "Hazard Times\n" + body
        for raw in body.splitlines():
            line = " ".join(raw.replace("•", " ").split()).upper()
            if not line:
                continue
            if mode == _UscgMode.INTRO and _USCG_INTRO.fullmatch(line):
                continue
            if line in ("(TO BEGINNING)", "TO BEGINNING"):
                if strict and mode != _UscgMode.COORDINATES:
                    raise NoticeError("USCG_ROW")
                continue
            label = _USCG_HAZARD_LABEL.fullmatch(line)
            start = _USCG_FROM.fullmatch(line)
            if label or start:
                if strict and (
                    start and section != _UscgSection.HAZARDS
                    or mode in (_UscgMode.SHARED_TIMES, _UscgMode.ADVICE)
                ):
                    raise NoticeError("USCG_ROW")
                drafts.append(_UscgArea(
                    (label.group(2) or ("HIGH RISK" if label.group(1) else "HAZARD"))
                    if label else start.group(1),
                    bool(label and label.group(1)),
                ))
                mode = _UscgMode.COORDINATES
                line = start.group(2) if start else ""
                if not line:
                    continue
            if _USCG_GLOBAL_TIMES.fullmatch(line):
                if strict and (
                    not drafts or mode in (_UscgMode.SHARED_TIMES, _UscgMode.ADVICE)
                    or any(
                        draft.schedule.windows or draft.schedule.long_windows
                        or draft.schedule.unreadable for draft in drafts
                    )
                ):
                    raise NoticeError("USCG_ROW")
                mode = _UscgMode.SHARED_TIMES
                continue
            if _uscg_advice(line):
                mode = _UscgMode.ADVICE
                advice.append(raw.strip())
                continue
            schedule = (
                shared if mode == _UscgMode.SHARED_TIMES or not drafts else drafts[-1].schedule
            )
            try:
                window = _uscg_window(line)
            except ValueError:
                window = None
            if window is not None or _USCG_TIME_LIKE.match(line):
                if strict and mode not in (
                    _UscgMode.COORDINATES, _UscgMode.LOCAL_TIMES, _UscgMode.SHARED_TIMES,
                ):
                    raise NoticeError("USCG_ROW")
                if window is not None:
                    schedule.add(window, line[:60])
                else:
                    schedule.unreadable.append(line[:60])
                if mode == _UscgMode.COORDINATES:
                    mode = _UscgMode.LOCAL_TIMES
                continue
            try:
                point = _uscg_point(line)
            except (ValueError, InvalidOperation):
                point = None
            if point is not None and mode == _UscgMode.COORDINATES:
                drafts[-1].points.append(point)
                continue
            if (
                point is not None or _USCG_COORDINATE_LIKE.search(line)
                or mode == _UscgMode.COORDINATES
            ):
                if strict or drafts:
                    name = drafts[-1].area_id if drafts else "BODY"
                    problems.append(f"GEOMETRY_UNPARSED:{name}")
            elif mode in (_UscgMode.LOCAL_TIMES, _UscgMode.SHARED_TIMES):
                schedule.unreadable.append(line[:60])
            elif strict:
                raise NoticeError("USCG_ROW")
            else:
                advice.append(raw.strip())
    sentences = [
        sentence.strip()
        for unit in re.split(r"(?<=:)\n", "\n".join(advice))
        for sentence in re.split(r"(?<=\w\w\.)\s+", " ".join(unit.split()))
    ]
    kept = [s for s in sentences if _USCG_ADVICE.search(s.upper()) and len(s) <= 400][:3]
    areas: list[Area] = []
    for draft in drafts:
        try:
            ring = _ring(draft.points)
        except ValueError:
            problems.append(f"GEOMETRY_UNPARSED:{draft.area_id}")
            continue
        schedule = (
            draft.schedule
            if draft.schedule.windows or draft.schedule.long_windows or draft.schedule.unreadable
            else shared
        )
        if strict and not schedule.readable:
            raise NoticeError("USCG_ROW")
        problems.extend(schedule.problems)
        windows = sorted(schedule.windows, key=lambda window: window.start)
        notes = tuple(
            s for s in kept if draft.high or "HIGH RISK" not in s.upper().replace("-", " ")
        )
        areas.append(
            Area(
                draft.area_id,
                ring,
                tuple(windows),
                "high_risk" if draft.high else "hazard",
                notes,
            )
        )
    if any(problem.startswith("GEOMETRY_UNPARSED") for problem in problems):
        if strict:
            raise NoticeError("USCG_ROW")
        areas = []
    if strict and (shared.unreadable or len({draft.area_id for draft in drafts}) != len(drafts)):
        raise NoticeError("USCG_ROW")
    return areas, list(dict.fromkeys(problems))


_USCG_FEATURE_FIELDS = frozenset({"type", "id", "properties", "geometry"})
_USCG_PROPERTY_FIELDS = frozenset({
    "ATU", "BEGIN_DATE", "COORDINATES_JSON", "COORDINATES_TYPE", "CREATE_DATE",
    "DECIMAL_LATITUDE", "DECIMAL_LONGITUDE", "DESCRIPTION", "END_DATE", "ESRI_OID",
    "MODIFIED_DATE", "MRN", "MSI_GROUP", "MSI_UID", "STATUS", "SUB_CATEGORY", "TITLE",
    "TYPE", "WATERWAY_NAME", "WTRW_UID",
})
_USCG_GEOMETRY_FIELDS = frozenset({"type", "coordinates"})


def parse_uscg_space_operations(
    body: bytes, source_url: str, *, strict: bool = True,
) -> list[Notice]:
    """Decode complete NAVCEN rows. ``strict=False`` exposes partial body diagnostics only."""
    if len(body) > MAX_SOURCE_BYTES:
        raise NoticeError("USCG_TOO_LARGE")
    try:
        payload = _decode_json(body)
    except (ValueError, UnicodeError) as exc:
        raise NoticeError("USCG_NOT_JSON") from exc
    features = payload.get("features") if isinstance(payload, dict) else None
    if (
        not isinstance(features, list)
        or not set(payload) <= {"type", "features"}
        or payload.get("type") != "FeatureCollection"
    ):
        raise NoticeError("USCG_SHAPE")
    digest = sha256_hex(body)
    notices: list[Notice] = []
    identities: set[int] = set()
    for feature in features:
        props = feature.get("properties") if isinstance(feature, dict) else None
        if not isinstance(props, dict) or feature.get("type") != "Feature":
            raise NoticeError("USCG_ROW")
        _known_fields(feature, _USCG_FEATURE_FIELDS, "USCG_ROW")
        _known_fields(props, _USCG_PROPERTY_FIELDS, "USCG_ROW")
        geometry = feature.get("geometry")
        if isinstance(geometry, dict):
            _known_fields(geometry, _USCG_GEOMETRY_FIELDS, "USCG_ROW")
        if not _readable_relevance(
            _equals_if_readable(props.get("STATUS"), "Approved", frozenset({"Draft", "Pending"})),
            _equals_if_readable(
                props.get("MSI_GROUP"), "Space Operations", frozenset({"Bridges", "Navigation"}),
            ),
            error="USCG_ROW",
        ):
            _drop_other(f"USCG LNM {props.get('MSI_UID', '?')}", "INACTIVE_OR_NONSPACE_GROUP")
            continue
        uid, description = props.get("MSI_UID"), props.get("DESCRIPTION")
        if (
            type(uid) is not int
            or uid <= 0
            or not isinstance(description, str)
            or not description.strip()
            or uid in identities
        ):
            raise NoticeError("USCG_ROW")
        identities.add(uid)
        if strict and not _sequential_numbers(tuple(
            int(match.group().partition(".")[0]) for match in _USCG_NUMBERED.finditer(description)
        )):
            raise NoticeError("USCG_ROW")
        if not _SPACE_OPERATIONS.search(description) and not any(
            _USCG_HAZARD_LABEL.fullmatch(line.strip().upper())
            for line in description.splitlines()
        ):
            raise NoticeError("USCG_ROW")
        lead = _lead(" ".join(description.split()))
        category = props.get("SUB_CATEGORY")
        if category not in ("Safety Zone", "Active RNA", "Hazardous Warning Area"):
            raise NoticeError("USCG_ROW")
        valid_from = _uscg_date(props.get("BEGIN_DATE"))
        valid_until = _uscg_date(props.get("END_DATE"))
        if valid_from >= valid_until:
            raise NoticeError("USCG_ROW")
        outline = _uscg_outline(geometry)
        flat = " ".join(description.upper().split())
        zone_body = _USCG_ZONE_BODY.fullmatch(flat)
        zone = _uscg_zone(zone_body) if zone_body else None
        if zone:
            if strict and (not zone.schedule.readable or zone.relevance is None):
                raise NoticeError("USCG_ROW")
            kind = "recovery" if zone.relevance is False else "regulated_area"
        elif _uscg_recovery_warning(flat):
            kind = "recovery"
        else:
            kind = "regulated_area" if category in ("Safety Zone", "Active RNA") else "launch"
        if kind == "regulated_area":
            lead = f"{category}. {lead}"
        prose = (
            _uscg_prose_schedule(description)
            if kind == "launch" and _USCG_PROSE_LAUNCH.fullmatch(
                " ".join(description.split("•", 1)[0].upper().split()),
            ) else None
        )
        if kind in ("regulated_area", "recovery") and zone:
            areas, problems = [], []
        elif prose is not None:
            if strict and not prose.readable:
                raise NoticeError("USCG_ROW")
            areas, problems = [], prose.problems
        else:
            areas, problems = _uscg_areas(description, strict=strict and kind != "recovery")
            if kind == "launch" and not areas and not problems:
                raise NoticeError("USCG_ROW")
        if strict and kind == "regulated_area" and not areas and not zone:
            raise NoticeError("USCG_ROW")
        notices.append(
            Notice(
                authority="USCG",
                notice_id=f"USCG LNM {uid}",
                kind=kind,
                domain="maritime",
                subject=lead,
                areas=tuple(areas),
                cancels=(),
                valid_until=valid_until,
                problems=tuple(problems),
                source_url=source_url,
                source_sha256=digest,
                valid_from=valid_from,
                outline=outline,
            )
        )
    return notices


def _lead(text: str, limit: int = 280) -> str:
    """The opening of a notice, cut at the last sentence or heading end inside the limit."""
    if len(text) <= limit:
        return text
    ends = [mark.end() for mark in re.finditer(r"(?<=\w\w)[.:](?= )", text[:limit])]
    return text[: ends[-1]] if ends and ends[-1] > 80 else text[:limit].rstrip()


def _uscg_date(value: object) -> datetime:
    if type(value) is not int or not 0 < value < 4_102_444_800_000:
        raise NoticeError("USCG_ROW")
    try:
        return datetime.fromtimestamp(value // 1000, tz=UTC)
    except (OSError, OverflowError, ValueError) as exc:
        raise NoticeError("USCG_ROW") from exc


def _uscg_outline(geometry: object) -> tuple[Position, ...]:
    """The record's own published outline. It locates a notice and is never drawn."""
    if not isinstance(geometry, dict) or geometry.get("type") != "Polygon":
        raise NoticeError("USCG_ROW")
    try:
        coordinates = geometry["coordinates"]
        if not isinstance(coordinates, list) or len(coordinates) != 1:
            raise ValueError("unsupported polygon rings")
        ring = coordinates[0]
        if not isinstance(ring, list) or any(
            not isinstance(point, list)
            or len(point) != 2
            or any(type(value) not in (int, float) for value in point)
            for point in ring
        ):
            raise ValueError("outline")
        return _ring([_position(float(lat), float(lon)) for lon, lat in ring])
    except (KeyError, IndexError, TypeError, ValueError, OverflowError) as exc:
        raise NoticeError("USCG_ROW") from exc


_FAA_NOT_LAUNCH = re.compile(r"\b(?:RECOVERY|RE-?ENTRY|RETURN|LANDING)\b")
_FAA_RECOVERY_NAME = re.compile(
    r"\d{6} (?P<operator>[A-Z0-9 .-]+?) (?:RECOVERY|RE-?ENTRY|LANDING) "
    r"(?P<vehicle>[A-Z0-9 |/-]+)"
)
_FAA_NARRATIVE_POINT = re.compile(r"(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])")
_FAA_LOCATION = r"[A-Z0-9][A-Z0-9 .'()/-]*, [A-Z]{2}"
_FAA_COORDINATION = (
    r"(?:THE )?[A-Z][A-Z .'-]* /[A-Z0-9]{3}/ ARTCC,? TEL "
    r"(?:[0-9]|\([0-9]{3}\))[0-9 ()-]*[0-9],? IS THE (?:FAA )?CDN FAC\."
)
_FAA_MARITIME_LIMIT = (
    r"EXCLUDING (?:AIRSPACE (?:OVER|BEYOND 12(?:NM| MILE) COASTAL LIMIT OVER) "
    r"INTERNATIONAL WATERS|INTERNATIONAL AIRSPACE)[.,;:]? "
)
_FAA_AIRSPACE = r"(?:PORTIONS OF )?[RW]\d{3,4}[A-Z]?"
_FAA_AIRSPACE_STATUS = (
    rf"THIS AREA ENCOMPASSES {_FAA_AIRSPACE}(?:(?:, |,? AND ){_FAA_AIRSPACE})*\. "
    r"ADDITIONAL WARNING AND RESTRICTED AREAS WILL BE ACT\. PILOTS MUST CONSULT "
    r"ALL NOTAMS REGARDING THESE OPS AND MAY CTC [A-Z]{3} FOR CURRENT AIRSPACE STATUS\. "
)
_FAA_UAS_WARNING = (
    r"UAS OPR WHO DO NOT COMPLY WITH APPLICABLE AIRSPACE "
    r"RESTRICTIONS ARE WARNED THAT PURSUANT TO 10 U\.S\.C\.SECTION 130I AND 6 "
    r"U\.S\.C\.SECTION 124N, THE DEPARTMENT OF DEFENSE \(DOD\), THE DEPARTMENT OF "
    r"HOMELAND SECURITY \(DHS\) OR THE DEPARTMENT OF JUSTICE \(DOJ\) MAY TAKE "
    r"SECURITY ACTION THAT RESULTS IN THE INTERFERENCE, DISRUPTION, SEIZURE, "
    r"DAMAGING, OR DESTRUCTION OF UNMANNED ACFT DEEMED TO POSE A CREDIBLE SAFETY "
    r"OR SECURITY THREAT TO PROTECTED PERSONNEL, FAC, OR ASSETS\. "
)
_FAA_SPACE_NARRATIVE = re.compile(
    r"!FDC (?P<number>\d/\d{4}) [A-Z]{3} [A-Z]{2}\.\.AIRSPACE "
    rf"{_FAA_LOCATION}\.\.TEMPORARY FLIGHT RESTRICTIONS\. "
    r"PURSUANT TO 14 CFR SECTION 91\.143, SPACE (?:OPS|LAUNCH VEHICLE REENTRY) AREA, "
    r"ACFT OPS ARE PROHIBITED WI AN AREA DEFINED AS "
    r"(?P<coordinates>(?:\d{6}[NS]\d{7}[EW](?: \([A-Z]{3}\d+(?:\.\d+)?\))? TO ){3,})"
    r"POINT OF ORIGIN (?P<altitude>SFC-(?:UNL|FL\d{3}|\d+FT (?:AGL|MSL))) "
    r"EFFECTIVE (?P<start>\d{10}) UTC \(\d{4} LOCAL \d{2}/\d{2}/\d{2}\) "
    r"UNTIL (?P<end>\d{10}) UTC \(\d{4} LOCAL \d{2}/\d{2}/\d{2}\)\. "
    r"(?:SPACE OPS AREA: ACFT OPS ARE PROHIBIT(?:IED|ED)\. )?"
    rf"(?:{_FAA_MARITIME_LIMIT})?(?:{_FAA_UAS_WARNING}|{_FAA_AIRSPACE_STATUS})?"
    rf"{_FAA_COORDINATION} (?P<closing_start>\d{{10}})-(?P<closing_end>\d{{10}})"
)
_FAA_NARRATIVE = re.compile(r"EFFECTIVE (\d{10}) UTC .*?UNTIL (\d{10}) UTC")
_FAA_ALTITUDE = re.compile(r"POINT OF ORIGIN (SFC-(?:UNL|FL\d{3}|\d+FT (?:AGL|MSL)))\b")
_FAA_VERTEX = re.compile(r"^(\d{1,3}(?:\.\d+)?)([NSEW])$")
_FAA_CHILDREN: dict[str, frozenset[str] | None] = {
    "XNOTAM-Update": frozenset({"Group"}),
    "Group": frozenset({"Add"}),
    "Add": frozenset({"Not"}),
    "Not": frozenset({
        "NotUid", "TfrNot", "AffLocGroup", "codeCoordFacility", "codeCoordFacilityType",
        "codeDailyOper", "codeExpirationTimeZone", "codeFacility", "codeFreeformText",
        "codeTimeZone", "dateEffective", "dateExpire", "txtAddrCoordPhone", "txtDescrModern",
        "txtDescrTraditional", "txtDescrUSNS", "txtNameCoordFacility",
    }),
    "NotUid": frozenset({
        "codeGUID", "dateIndexYear", "dateIssued", "noSeqNo", "noUSNSWorkNo", "txtLocalName",
        "txtNameAcctFac",
    }),
    "TfrNot": frozenset({"TFRAreaGroup", "TemplateType", "codeCtrlFacilityType", "codeType"}),
    "TFRAreaGroup": frozenset({
        "Aac", "InstructionsGroup", "abdMergedArea", "aseShapes", "aseTFRArea", "codeAuthATC",
        "codeIncFRD", "codeLclTime", "codeShpPrt",
    }),
    "aseTFRArea": frozenset({
        "AseUid", "Att", "ScheduleGroup", "codeDistVerLower", "codeDistVerUpper",
        "codeExclVerLower", "codeExclVerUpper", "isScheduledTfrArea", "txtName",
        "uomDistVerLower", "uomDistVerUpper", "valDistVerLower", "valDistVerUpper",
    }),
    "ScheduleGroup": frozenset({"dateEffective", "dateExpire", "isTimeSeparate"}),
    "abdMergedArea": frozenset({"AbdUid", "Avx", "txtRmk"}),
    "Avx": frozenset({"Frd", "codeDatum", "codeType", "geoLat", "geoLong"}),
    "InstructionsGroup": frozenset({"txtInstr"}),
    "AffLocGroup": None,
    "Aac": None,
    "aseShapes": None,
    "AseUid": None,
    "Att": None,
    "AbdUid": None,
    "Frd": None,
}
_FAA_ATTRIBUTES = {"XNOTAM-Update": frozenset({"created", "origin", "version"})}


def _faa_structure(element: ElementTree.Element) -> None:
    """Owned containers are closed; explicitly unused metadata subtrees are opaque."""
    children = _FAA_CHILDREN.get(element.tag, frozenset())
    if children is None:
        return
    if (
        not element.attrib.keys() <= _FAA_ATTRIBUTES.get(element.tag, frozenset())
        or element.tag == "XNOTAM-Update" and element.get("version", "0.1") != "0.1"
    ):
        raise NoticeError("FAA_ROW")
    if children and (element.text or "").strip():
        raise NoticeError("FAA_ROW")
    for child in element:
        if child.tag not in children or (child.tail or "").strip():
            raise NoticeError("FAA_ROW")
        _faa_structure(child)


def _faa_text(node: ElementTree.Element | None, path: str) -> str:
    found = node.find(path) if node is not None else None
    return (found.text or "").strip() if found is not None else ""


def _faa_required(node: ElementTree.Element, path: str) -> str:
    found = node.findall(path)
    if len(found) != 1 or len(found[0]) or not (found[0].text or "").strip():
        raise NoticeError("FAA_ROW")
    return found[0].text.strip()


def _faa_degrees(token: str, positive: str, negative: str) -> float:
    match = _FAA_VERTEX.match(token)
    if not match or match.group(2) not in positive + negative:
        raise ValueError("vertex")
    value = float(match.group(1))
    return -value if match.group(2) == negative else value


def _faa_instant(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)


def _faa_ring_signature(ring: tuple[Position, ...]) -> tuple[tuple[int, int], ...]:
    """Compare complete rings at the narrative's whole-second coordinate precision."""
    seconds = tuple(
        tuple(
            int((Decimal(str(value)) * 3600).quantize(Decimal(1), ROUND_HALF_UP))
            for value in point
        )
        for point in ring
    )
    return min(
        points[offset:] + points[:offset]
        for points in (seconds, seconds[::-1]) for offset in range(len(points))
    )


def parse_faa_tfr(body: bytes, source_url: str) -> Notice:
    """Decode XNOTAM with a complete space-operation restriction and readable metadata.

    Its primary identity, whole polygon, and both UTC period representations must
    agree with the XML. Unsupported narrative remains diagnostic, never confirmation.
    """
    if len(body) > MAX_SOURCE_BYTES:
        raise NoticeError("FAA_TOO_LARGE")
    try:
        text = body.decode("utf-8-sig")
    except UnicodeError as exc:
        raise NoticeError("FAA_NOT_TEXT") from exc
    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        raise NoticeError("FAA_XML_ENTITY")
    try:
        root = ElementTree.fromstring(text)  # noqa: S314  entity declarations are refused above
    except ElementTree.ParseError as exc:
        raise NoticeError("FAA_NOT_XML") from exc
    if root.tag != "XNOTAM-Update":
        raise NoticeError("FAA_SHAPE")
    _faa_structure(root)
    records = root.findall("./Group/Add/Not")
    if len(records) > 1 or len(list(root.iter("Not"))) != len(records):
        raise NoticeError("FAA_ROW")
    notam = records[0] if records else None
    year, sequence = _faa_text(notam, "NotUid/dateIndexYear"), _faa_text(notam, "NotUid/noSeqNo")
    if notam is None or not re.fullmatch(r"\d{4}", year) or not re.fullmatch(r"\d{1,5}", sequence):
        raise NoticeError("FAA_SHAPE")
    if len(notam.findall("NotUid/dateIndexYear")) != 1 or len(notam.findall("NotUid/noSeqNo")) != 1:
        raise NoticeError("FAA_ROW")
    number = f"{year[-1]}/{sequence}"
    code = _faa_required(notam, "TfrNot/codeType")
    if not re.fullmatch(r"\d{2}\.\d{3}", code):
        raise NoticeError("FAA_ROW")
    declared_space = code == "91.143"
    name = (
        _faa_required(notam, "NotUid/txtLocalName")
        if declared_space else _faa_text(notam, "NotUid/txtLocalName")
    )
    narrative = " ".join((
        _faa_required(notam, "txtDescrUSNS") if declared_space else _faa_text(notam, "txtDescrUSNS")
    ).split())
    relevance = _launch_relevance(narrative)
    if not declared_space:
        relevance = _Relevance.OTHER
        _drop_other(f"TFR {number}", f"NONSPACE_FAA_TYPE:{code}")
    elif relevance is _Relevance.OTHER:
        relevance = _Relevance.UNCERTAIN
    relevant = relevance is not _Relevance.OTHER
    frame = _FAA_SPACE_NARRATIVE.fullmatch(narrative.upper())
    if not relevant:
        kind = "other"
    elif _FAA_NOT_LAUNCH.search(name.upper()):
        operation = _FAA_RECOVERY_NAME.fullmatch(name.upper())
        known_recovery = operation is not None and all(
            _operation_subject(operation[part]) for part in ("operator", "vehicle")
        ) and frame is not None
        _readable_relevance(False if known_recovery else None, error="FAA_ROW")
        kind = "recovery"
    else:
        kind = "launch"
    problems: list[str] = []
    if relevant and frame is None:
        problems.append("NARRATIVE_UNPARSED")
    if not narrative.startswith(f"!FDC {number} "):
        problems.append("NUMBER_CONFLICT")
    diagnostic_time = _FAA_NARRATIVE.search(narrative) if frame is None else None
    diagnostic_altitude = _FAA_ALTITUDE.search(narrative) if frame is None else None
    stated = (
        (frame["start"], frame["end"]) if frame is not None
        else diagnostic_time.groups() if diagnostic_time is not None else None
    )
    altitude = (
        frame["altitude"] if frame is not None
        else diagnostic_altitude[1] if diagnostic_altitude is not None else None
    )
    if frame is not None and stated != (frame["closing_start"], frame["closing_end"]):
        problems.append("WINDOW_CONFLICT")
    groups = notam.findall("TfrNot/TFRAreaGroup")
    if relevant and not groups:
        raise NoticeError("FAA_ROW")
    if relevant and len(groups) != 1:
        problems.append("NARRATIVE_UNPARSED")
    areas: list[Area] = []
    area_ids: set[str] = set()
    last_end: datetime | None = None
    for group in groups:
        raw_name = (
            _faa_required(group, "aseTFRArea/txtName")
            if relevant else _faa_text(group, "aseTFRArea/txtName")
        )
        letter = raw_name.removeprefix("Area ").strip()
        if relevant and not letter:
            raise NoticeError("FAA_ROW")
        area_id = number if len(groups) == 1 else letter
        if relevant and area_id in area_ids:
            raise NoticeError("FAA_ROW")
        area_ids.add(area_id)
        windows: list[Window] = []
        schedules = group.findall("aseTFRArea/ScheduleGroup")
        if relevant and not schedules:
            raise NoticeError("FAA_ROW")
        for schedule in schedules:
            if relevant:
                raw_start = _faa_required(schedule, "dateEffective")
                raw_end = _faa_required(schedule, "dateExpire")
                try:
                    _faa_instant(raw_start)
                    _faa_instant(raw_end)
                except ValueError as exc:
                    raise NoticeError("FAA_ROW") from exc
            try:
                start = _faa_instant(_faa_text(schedule, "dateEffective"))
                end = _faa_instant(_faa_text(schedule, "dateExpire"))
                if stated is None or (start, end) != tuple(
                    datetime.strptime(group, "%y%m%d%H%M").replace(tzinfo=UTC)
                    for group in stated
                ):
                    raise ValueError("narrative")
                windows.append(_window(start, end))
            except ValueError:
                problems.append("WINDOW_CONFLICT")
        try:
            vertices = group.findall("abdMergedArea/Avx")
            if relevant:
                if len(vertices) < 3:
                    raise NoticeError("FAA_ROW")
                for vertex in vertices:
                    for path in ("codeType", "geoLat", "geoLong"):
                        _faa_required(vertex, path)
            if any(_faa_text(vertex, "codeType") != "GRC" for vertex in vertices):
                raise ValueError("arc")
            ring = _ring(
                [
                    _position(
                        _faa_degrees(_faa_text(vertex, "geoLat"), "N", "S"),
                        _faa_degrees(_faa_text(vertex, "geoLong"), "E", "W"),
                    )
                    for vertex in vertices
                ]
            )
            if relevant and frame is not None:
                narrated_ring = _ring([
                    _position(
                        _sexagesimal(ns, lat_d, lat_m, lat_s),
                        _sexagesimal(ew, lon_d, lon_m, lon_s),
                    )
                    for lat_d, lat_m, lat_s, ns, lon_d, lon_m, lon_s, ew
                    in _FAA_NARRATIVE_POINT.findall(frame["coordinates"])
                ])
                if _faa_ring_signature(ring) != _faa_ring_signature(narrated_ring):
                    raise ValueError("narrative polygon")
        except NoticeError:
            raise
        except ValueError:
            problems.append(f"GEOMETRY_UNPARSED:{area_id}")
            continue
        instruction = " ".join(
            _faa_text(group, "InstructionsGroup/txtInstr").split("\n\n")[0].split()
        )
        notes = tuple(
            part for part in (f"{altitude}." if altitude else "", instruction) if part
        )
        areas.append(Area(area_id, ring, tuple(windows), "restricted_airspace", notes))
        last_end = max(
            [last_end, *(w.end for w in windows)],
            key=lambda t: t or datetime.min.replace(tzinfo=UTC),
        )
    if any(problem.startswith("GEOMETRY_UNPARSED") for problem in problems):
        areas = []
    return Notice(
        authority="FAA",
        notice_id=f"TFR {number}",
        kind=kind,
        domain="airspace",
        subject=name,
        areas=tuple(areas),
        cancels=(),
        valid_until=last_end,
        problems=tuple(dict.fromkeys(problems)),
        source_url=source_url,
        source_sha256=sha256_hex(body),
    )
