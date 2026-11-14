"""Launch hazard notices as their agencies publish them.

NGA broadcast warnings, U.S. Coast Guard space-operations notices and FAA flight
restrictions are read into polygons and UTC windows. Text the grammar does not cover
is reported in ``problems``. Nothing is repaired or inferred.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
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
    """A source document that cannot be read at all."""


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime


@dataclass(frozen=True)
class Area:
    """One published polygon. The ring is open, (lon, lat), in published order."""

    area_id: str
    ring: tuple[Position, ...]
    windows: tuple[Window, ...]
    restriction_class: str
    instructions: tuple[str, ...] = ()


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


def _ring(points: list[Position]) -> tuple[Position, ...]:
    """Drop a repeated closing vertex. Refuse a ring the map cannot draw as published."""
    if len(points) >= 2 and points[0] == points[-1]:
        points = points[:-1]
    if not 3 <= len(points) <= MAX_VERTICES or len(set(points)) != len(points):
        raise ValueError("ring size")
    closed = [*points, points[0]]
    if any(abs(b[0] - a[0]) > 180 for a, b in zip(closed, closed[1:], strict=False)):
        raise ValueError("ring crosses the antimeridian")
    return tuple(points)


def _moment(year: int, month: int, day: int, hhmm: str) -> datetime:
    return datetime(year, month, day, int(hhmm[:2]), int(hhmm[2:]), tzinfo=UTC)


def _window(start: datetime, end: datetime) -> Window:
    if not timedelta(0) < end - start <= MAX_WINDOW:
        raise ValueError("window length")
    return Window(start, end)


_DM_PAIR = re.compile(r"(\d{2})-(\d{2}(?:\.\d+)?)([NS])\s+(\d{3})-(\d{2}(?:\.\d+)?)([EW])")
_PARAGRAPH = re.compile(r"(?m)^[ \t]*(\d{1,2})\.[ \t]+")
_LABEL = re.compile(r"(?:^| )([A-Z])\. (?=\d)")
_BOUND = re.compile(r"\bIN AREAS? BOUND BY:?")
_ISSUE = re.compile(rf"^(\d{{2}})(\d{{2}})(\d{{2}})Z ({_MON}) (\d{{4}})$")
_CANCEL_SELF = re.compile(rf"CANCEL THIS MSG (\d{{2}})(\d{{4}})Z ({_MON}) (\d{{2}})\b")
_CANCEL_OTHER = re.compile(r"CANCEL (NAVAREA (?:IV|XII)|HYDROLANT|HYDROPAC|HYDROARC) (\d+/\d{2})")
_TIME_GROUP = re.compile(
    rf"(?<![\dA-Z])(?:"
    rf"(?P<opens>\d{{4}})Z TO (?P<closes>\d{{4}})Z DAILY (?P<first_day>\d{{1,2}})"
    rf"(?: (?P<first_month>{_MON}))? THRU (?P<last_day>\d{{1,2}}) (?P<last_month>{_MON})"
    rf"|(?P<start_day>\d{{2}})(?P<start_time>\d{{4}})Z(?: (?P<start_month>{_MON}))?"
    rf" TO (?P<end_day>\d{{2}})?(?P<end_time>\d{{4}})Z(?: (?P<end_month>{_MON}))?"
    rf")(?![\dA-Z])"
)
_BETWEEN_GROUPS = re.compile(r"\b(?:AND|ALTERNATE)\b|[\s,.:]")


def _year_for(issued: datetime, month: int, day: int, hhmm: str) -> datetime:
    """A group carries no year. It belongs to the first such date not long before issue."""
    moment = _moment(issued.year, month, day, hhmm)
    if moment < issued - timedelta(days=45):
        moment = _moment(issued.year + 1, month, day, hhmm)
    return moment


def _broadcast_windows(text: str, issued: datetime) -> tuple[list[Window], list[str]]:
    """Time groups of one schedule. A month applies to the groups written before it.

    Text between groups that is not a separator is returned as it stands.
    """
    flat = " ".join(text.upper().split())
    groups = list(_TIME_GROUP.finditer(flat))
    edges = [0, *(edge for group in groups for edge in group.span()), len(flat)]
    gaps = [flat[edges[index] : edges[index + 1]] for index in range(0, len(edges), 2)]
    unparsed = [gap.strip(" ,.:") for gap in gaps if _BETWEEN_GROUPS.sub("", gap)]
    windows: list[Window] = []
    month_after: str | None = None
    for group in reversed(groups):
        try:
            found, month_after = _group_windows(group, issued, month_after)
        except ValueError:
            unparsed.append(group.group(0))
            continue
        windows.extend(found)
    windows.sort(key=lambda window: window.start)
    return windows, unparsed


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
    return [_window(start, end)], start_month


def _broadcast_ring(text: str) -> tuple[Position, ...]:
    if _DM_PAIR.sub("", text).strip(" ,.\t\n"):
        raise ValueError("text between coordinates")
    points = [
        _position(_sexagesimal(ns, lat_d, lat_m), _sexagesimal(ew, lon_d, lon_m))
        for lat_d, lat_m, ns, lon_d, lon_m, ew in _DM_PAIR.findall(text)
    ]
    return _ring(points)


def _labelled(text: str) -> list[tuple[str, str]]:
    marks = list(_LABEL.finditer(text))
    return [
        (
            mark.group(1),
            text[mark.end() : (marks[index + 1].start() if index + 1 < len(marks) else len(text))],
        )
        for index, mark in enumerate(marks)
    ]


def _broadcast_kind(phrase: str) -> str:
    if phrase == "HAZARDOUS OPERATIONS, ROCKET LAUNCHING":
        return "launch"
    if phrase == "HAZARDOUS OPERATIONS, SPACE DEBRIS":
        return "space_debris"
    return "other"


def parse_broadcast_warning(
    text: str,
    notice_id: str,
    issued: datetime,
    source_url: str,
    source_sha256: str,
) -> Notice:
    """One NAVAREA or HYDRO warning body, without its date-time group and number lines."""
    pieces = _PARAGRAPH.split(text)
    paragraphs = {
        int(pieces[index]): " ".join(pieces[index + 1].split())
        for index in range(1, len(pieces) - 1, 2)
    }
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
    if bound and label and label.start() < bound.start():
        phrase = first[: label.start()]
        for letter, chunk in _labelled(first):
            inner = _BOUND.search(chunk)
            if inner:
                schedules.append((letter, chunk[: inner.start()], chunk[inner.end() :]))
    elif bound:
        head, tail = first[: bound.start()], first[bound.end() :]
        digit = re.search(r"\d", head)
        phrase = head[: digit.start()] if digit else head
        schedule = head[digit.start() :] if digit else ""
        for letter, chunk in _labelled(tail) or [("1", tail)]:
            schedules.append((letter, schedule, chunk))
    else:
        digit = re.search(r"\d", first)
        phrase = first[: digit.start()] if digit else first
    areas: list[Area] = []
    problems: list[str] = []
    for letter, schedule, coordinates in schedules:
        windows, unparsed = _broadcast_windows(schedule, issued)
        problems.extend(f"WINDOW_UNPARSED:{fragment}" for fragment in unparsed)
        try:
            ring = _broadcast_ring(coordinates)
        except (ValueError, InvalidOperation):
            problems.append(f"GEOMETRY_UNPARSED:{letter}")
            continue
        areas.append(Area(letter, ring, tuple(windows), "hazard"))
    if any(problem.startswith("GEOMETRY_UNPARSED") for problem in problems):
        areas = []
    return Notice(
        authority="NGA",
        notice_id=notice_id,
        kind=_broadcast_kind(phrase.strip(" :,")),
        domain="maritime",
        subject=phrase.strip(" :,"),
        areas=tuple(areas),
        cancels=cancels,
        valid_until=valid_until,
        problems=tuple(dict.fromkeys(problems)),
        source_url=source_url,
        source_sha256=source_sha256,
    )


def parse_nga_payload(body: bytes, source_url: str) -> list[Notice]:
    """NGA MSI ``broadcast-warn`` JSON. A row without its identifying fields is skipped."""
    if len(body) > MAX_SOURCE_BYTES:
        raise NoticeError("NGA_TOO_LARGE")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as exc:
        raise NoticeError("NGA_NOT_JSON") from exc
    rows = payload.get("broadcast-warn") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise NoticeError("NGA_SHAPE")
    digest = sha256_hex(body)
    notices: list[Notice] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        series = _SERIES.get(str(row.get("navArea")))
        number, year, text = row.get("msgNumber"), row.get("msgYear"), row.get("text")
        issue = _ISSUE.match(row["issueDate"]) if isinstance(row.get("issueDate"), str) else None
        if (
            series is None
            or type(number) is not int
            or type(year) is not int
            or not isinstance(text, str)
            or issue is None
        ):
            continue
        day, hour, minute, month, issue_year = issue.groups()
        try:
            issued = _moment(int(issue_year), _MONTHS.index(month) + 1, int(day), hour + minute)
        except ValueError:
            continue
        notices.append(
            parse_broadcast_warning(
                text,
                f"{series} {number}/{year % 100:02d}",
                issued,
                source_url,
                digest,
            )
        )
    return notices


_USCG_HAZARD_LABEL = re.compile(r"^(HIGH RISK )?HAZARD AREA(?: ([A-Z]))?\s*:$")
_USCG_FROM = re.compile(r"^([A-Z])\. FROM (.+)$")
_USCG_NUMBERED = re.compile(r"^\d{1,2}\. ")
_USCG_GLOBAL_TIMES = re.compile(r"HAZARD (?:PERIODS|TIMES)")
_USCG_DMS = re.compile(
    r"(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)([NS])[ /](\d{3})-(\d{2})-(\d{2}(?:\.\d+)?)([EW])"
)
_USCG_DECIMAL = re.compile(r"(\d{1,2}(?:\.\d+)?) ?N, -(\d{1,3}(?:\.\d+)?) ?W")
_USCG_COORDINATE_LIKE = re.compile(r"\d ?[NS][ ,/]+-?\d")
_USCG_CLOCK = rf"(\d{{1,2}})/(\d{{4}})Z? ({_MON}) (\d{{2}})"
_USCG_SLASH = re.compile(rf"^{_USCG_CLOCK} TO {_USCG_CLOCK}\.?$")
_USCG_GROUP = re.compile(
    rf"^(\d{{2}})(\d{{4}}) ?Z ({_MON}) TO (\d{{2}})(\d{{4}}) ?Z ({_MON}) (\d{{4}})(?:\b|-)"
)
_USCG_TIME_LIKE = re.compile(r"^(?:\d{1,2}/\d{4}|\d{6} ?Z)")
_USCG_NOT_LAUNCH = re.compile(r"RE-?ENTRY|SPLASHDOWN|SPACE DEBRIS|RECOVERY")
_USCG_ADVICE = re.compile(r"\bAVOID|\bREMAIN CLEAR")


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
    slash = _USCG_SLASH.match(line)
    if slash:
        day_a, time_a, month_a, year_a, day_b, time_b, month_b, year_b = slash.groups()
        return _window(
            _moment(2000 + int(year_a), _MONTHS.index(month_a) + 1, int(day_a), time_a),
            _moment(2000 + int(year_b), _MONTHS.index(month_b) + 1, int(day_b), time_b),
        )
    group = _USCG_GROUP.match(line)
    if group:
        day_a, time_a, month_a, day_b, time_b, month_b, year = group.groups()
        return _window(
            _moment(int(year), _MONTHS.index(month_a) + 1, int(day_a), time_a),
            _moment(int(year), _MONTHS.index(month_b) + 1, int(day_b), time_b),
        )
    return None


def _uscg_areas(description: str) -> tuple[list[Area], list[str]]:
    """Hazard areas of one Coast Guard notice. Other regulated areas in it are left out."""
    drafts: list[dict] = []
    shared: list[Window] = []
    problems: list[str] = []
    advice: list[str] = []
    intro = ""
    mode = "prose"
    shared_times = False
    for raw in description.splitlines():
        line = " ".join(raw.replace("•", " ").split()).upper()
        if not line or line in ("(TO BEGINNING)", "TO BEGINNING"):
            continue
        if _USCG_NUMBERED.match(line):
            intro, mode = line, "prose"
        label = _USCG_HAZARD_LABEL.match(line)
        start = _USCG_FROM.match(line)
        if label or start:
            if start and "HAZARD AREA" not in intro:
                mode = "other"
                continue
            drafts.append(
                {
                    "id": (label.group(2) or ("HIGH RISK" if label.group(1) else "HAZARD"))
                    if label
                    else start.group(1),
                    "high": bool(label and label.group(1)),
                    "points": [],
                    "windows": [],
                }
            )
            mode, shared_times = "area", False
            line = start.group(2) if start else ""
            if not line:
                continue
        if _USCG_GLOBAL_TIMES.search(line) and not label:
            shared_times, mode = True, "prose"
            continue
        if _USCG_TIME_LIKE.match(line):
            try:
                window = _uscg_window(line)
            except ValueError:
                window = None
            if window is None:
                problems.append(f"WINDOW_UNPARSED:{line[:60]}")
            elif shared_times or not drafts:
                shared.append(window)
            else:
                drafts[-1]["windows"].append(window)
            continue
        try:
            point = _uscg_point(line)
        except (ValueError, InvalidOperation):
            point = None
        if mode == "area" and point is not None:
            drafts[-1]["points"].append(point)
            continue
        if mode == "area" and _USCG_COORDINATE_LIKE.search(line):
            problems.append(f"GEOMETRY_UNPARSED:{drafts[-1]['id']}")
        if mode == "other":
            continue
        if not _USCG_NUMBERED.match(line) and mode == "prose":
            intro = f"{intro} {line}"
        if mode == "area":
            mode = "prose"
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
            ring = _ring(draft["points"])
        except ValueError:
            problems.append(f"GEOMETRY_UNPARSED:{draft['id']}")
            continue
        windows = sorted(draft["windows"] or shared, key=lambda window: window.start)
        notes = tuple(
            s for s in kept if draft["high"] or "HIGH RISK" not in s.upper().replace("-", " ")
        )
        areas.append(
            Area(
                draft["id"],
                ring,
                tuple(windows),
                "high_risk" if draft["high"] else "hazard",
                notes,
            )
        )
    if any(problem.startswith("GEOMETRY_UNPARSED") for problem in problems):
        areas = []
    return areas, list(dict.fromkeys(problems))


def parse_uscg_space_operations(body: bytes, source_url: str) -> list[Notice]:
    """NAVCEN ``spaceOpsPoly`` GeoJSON. Polygons come from each notice's own text."""
    if len(body) > MAX_SOURCE_BYTES:
        raise NoticeError("USCG_TOO_LARGE")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as exc:
        raise NoticeError("USCG_NOT_JSON") from exc
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        raise NoticeError("USCG_SHAPE")
    digest = sha256_hex(body)
    notices: list[Notice] = []
    for feature in features:
        props = feature.get("properties") if isinstance(feature, dict) else None
        if not isinstance(props, dict):
            continue
        uid, description, ends = (
            props.get("MSI_UID"),
            props.get("DESCRIPTION"),
            props.get("END_DATE"),
        )
        if (
            type(uid) is not int
            or not isinstance(description, str)
            or props.get("STATUS") != "Approved"
        ):
            continue
        if props.get("MSI_GROUP") != "Space Operations":
            continue
        if _USCG_NOT_LAUNCH.search(" ".join(description.split())[:300].upper()):
            kind = "recovery"
        elif props.get("SUB_CATEGORY") != "Hazardous Warning Area":
            kind = "other"
        else:
            kind = "launch"
        areas, problems = _uscg_areas(description)
        valid_until = None
        if type(ends) is int and 0 < ends < 4_102_444_800_000:
            valid_until = datetime.fromtimestamp(ends // 1000, tz=UTC)
        notices.append(
            Notice(
                authority="USCG",
                notice_id=f"USCG LNM {uid}",
                kind=kind,
                domain="maritime",
                subject=" ".join(description.split())[:160],
                areas=tuple(areas),
                cancels=(),
                valid_until=valid_until,
                problems=tuple(problems),
                source_url=source_url,
                source_sha256=digest,
            )
        )
    return notices


_FAA_NOT_LAUNCH = re.compile(r"RECOVERY|RE-?ENTRY|RETURN|LANDING")
_FAA_NARRATIVE = re.compile(r"EFFECTIVE (\d{10}) UTC .*?UNTIL (\d{10}) UTC")
_FAA_ALTITUDE = re.compile(r"POINT OF ORIGIN (SFC-(?:UNL|FL\d{3}|\d+FT (?:AGL|MSL)))\b")
_FAA_VERTEX = re.compile(r"^(\d{1,3}(?:\.\d+)?)([NSEW])$")


def _faa_text(node: ElementTree.Element | None, path: str) -> str:
    found = node.find(path) if node is not None else None
    return (found.text or "").strip() if found is not None else ""


def _faa_degrees(token: str, positive: str, negative: str) -> float:
    match = _FAA_VERTEX.match(token)
    if not match or match.group(2) not in positive + negative:
        raise ValueError("vertex")
    value = float(match.group(1))
    return -value if match.group(2) == negative else value


def _faa_instant(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)


def parse_faa_tfr(body: bytes, source_url: str) -> Notice:
    """One FAA temporary flight restriction detail file (XNOTAM-Update)."""
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
    notam = root.find("./Group/Add/Not")
    year, sequence = _faa_text(notam, "NotUid/dateIndexYear"), _faa_text(notam, "NotUid/noSeqNo")
    if notam is None or not re.fullmatch(r"\d{4}", year) or not re.fullmatch(r"\d{1,5}", sequence):
        raise NoticeError("FAA_SHAPE")
    number = f"{year[-1]}/{sequence}"
    name = _faa_text(notam, "NotUid/txtLocalName")
    narrative = " ".join(_faa_text(notam, "txtDescrUSNS").split())
    if _faa_text(notam, "TfrNot/codeType") != "91.143":
        kind = "other"
    elif _FAA_NOT_LAUNCH.search(name.upper()):
        kind = "recovery"
    else:
        kind = "launch"
    problems: list[str] = []
    if f"!FDC {number} " not in narrative:
        problems.append("NUMBER_CONFLICT")
    stated = _FAA_NARRATIVE.search(narrative)
    altitude = _FAA_ALTITUDE.search(narrative)
    groups = notam.findall("TfrNot/TFRAreaGroup")
    areas: list[Area] = []
    last_end: datetime | None = None
    for group in groups:
        letter = _faa_text(group, "aseTFRArea/txtName").removeprefix("Area ").strip()
        area_id = number if len(groups) == 1 else letter
        windows: list[Window] = []
        for schedule in group.findall("aseTFRArea/ScheduleGroup"):
            try:
                start = _faa_instant(_faa_text(schedule, "dateEffective"))
                end = _faa_instant(_faa_text(schedule, "dateExpire"))
                if stated is None or (start, end) != tuple(
                    datetime.strptime(group, "%y%m%d%H%M").replace(tzinfo=UTC)
                    for group in stated.groups()
                ):
                    raise ValueError("narrative")
                windows.append(_window(start, end))
            except ValueError:
                problems.append("WINDOW_CONFLICT")
        try:
            vertices = group.findall("abdMergedArea/Avx")
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
        except ValueError:
            problems.append(f"GEOMETRY_UNPARSED:{area_id}")
            continue
        instruction = " ".join(
            _faa_text(group, "InstructionsGroup/txtInstr").split("\n\n")[0].split()
        )
        notes = tuple(
            part for part in (f"{altitude.group(1)}." if altitude else "", instruction) if part
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
