"""Extra vehicles published beside the ISS track.

Element sets come only from CelesTrak GP or SupGP text. A miss, an epoch
past the grace, or a failed lookup becomes a status row.
"""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

from .manifest import utcnow_iso
from .orbit import TLE
from .tle_sources import Answered, BackedOff, Failed, Throttled, TleSources

log = logging.getLogger(__name__)

GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
SUPGP_URL = "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php"
TRACKED_QUERY_BUDGET_SECONDS = 15.0


@dataclass(frozen=True)
class TrackedSpec:
    """One extra vehicle. Match by catalog number, designator, or name.

    A set is fresh until `max_age_hours` after its epoch and is published
    until `grace_hours`. An unset grace is the fresh window.
    """

    id: str
    label: str
    color: str
    name_patterns: tuple[re.Pattern[str], ...]
    name_queries: tuple[str, ...]
    max_age_hours: float
    catnr: int | None = None
    intldes: str | None = None
    last_good_hours: float | None = None

    @property
    def grace_hours(self) -> float:
        return max(self.max_age_hours, self.last_good_hours or 0.0)


@dataclass(frozen=True)
class ElementSet:
    name: str
    line1: str
    line2: str
    epoch: datetime
    norad: int
    intldes: str
    source: str


@dataclass(frozen=True)
class LiveObject:
    elements: ElementSet
    age_hours: float
    from_cache: bool


@dataclass(frozen=True)
class TrackedElements:
    """`elements` is the object drawn. `also` is every other live match."""

    id: str
    label: str
    color: str
    elements: ElementSet
    age_hours: float
    from_cache: bool
    also: tuple[LiveObject, ...] = ()


@dataclass(frozen=True)
class TrackedUnavailable:
    id: str
    label: str
    color: str
    reason: str


def _unavailable(spec: TrackedSpec, reason: str) -> TrackedUnavailable:
    return TrackedUnavailable(spec.id, spec.label, spec.color, reason)


TrackedRecord = TrackedElements | TrackedUnavailable

_STARSHIP_NAME = re.compile(r"^STARSHIP(?:[\s-]|$)(?!.*\bDEB\b)", re.IGNORECASE)
_SHIP_NAME = re.compile(r"^SHIP[\s-]+\d+\b(?!.*\bDEB\b)", re.IGNORECASE)
_ROCKET_BODY = re.compile(r"\bR/B\b", re.IGNORECASE)
_LAUNCH = re.compile(r"(\d{2})(\d{3})")
# A Starship set is fresh for 12 h after its epoch. Past that it is still
# published, and the browser labels it stale, until 72 h: a feed outage or a
# late update must not erase a ship that still propagates and has not
# reentered. `frontend/src/tracked.ts` mirrors both values.
STARSHIP_FRESH_HOURS = 12.0
STARSHIP_GRACE_HOURS = 72.0
REENTRY_PERIGEE_KM = 80.0
EARTH_MU_KM3_S2 = 398600.4418
EARTH_RADIUS_KM = 6378.137

STARSHIP = TrackedSpec(
    id="starship",
    label="Starship",
    color="#ff5c5c",
    name_patterns=(_STARSHIP_NAME, _SHIP_NAME),
    name_queries=("STARSHIP", "SHIP"),
    max_age_hours=STARSHIP_FRESH_HOURS,
    last_good_hours=STARSHIP_GRACE_HOURS,
)

TRACKED_SPECS: tuple[TrackedSpec, ...] = (STARSHIP,)
ADDED_MAX_AGE_HOURS = 48.0
ADDED_COLOR = "#ff5c5c"
_SPEC_ID = re.compile(r"^[a-z0-9-]+$")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def load_tracked_specs(path: Path) -> tuple[TrackedSpec, ...]:
    """The built-in vehicles plus the operator's `tracked-objects.json`.

    Each entry names an object by catalog number, designator, or name. A
    missing file adds nothing. An unreadable entry is skipped.
    """
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return TRACKED_SPECS
    except (OSError, json.JSONDecodeError, UnicodeError) as exc:
        log.warning("tracked objects file %s is unreadable: %s", path, exc)
        return TRACKED_SPECS
    entries = raw.get("objects") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        log.warning("tracked objects file %s has no objects list", path)
        return TRACKED_SPECS
    specs = list(TRACKED_SPECS)
    taken = {spec.id for spec in specs}
    for entry in entries:
        spec = _spec_from_entry(entry)
        if spec is None or spec.id in taken:
            log.warning("skipping tracked object entry %r", entry)
            continue
        taken.add(spec.id)
        specs.append(spec)
    return tuple(specs)


def _spec_from_entry(entry: object) -> TrackedSpec | None:
    if not isinstance(entry, dict):
        return None
    spec_id = entry.get("id")
    label = entry.get("label")
    if not isinstance(spec_id, str) or not _SPEC_ID.fullmatch(spec_id):
        return None
    if not isinstance(label, str) or not label.strip():
        return None
    catnr = entry.get("catnr")
    if catnr is not None and (isinstance(catnr, bool) or not isinstance(catnr, int) or catnr <= 0):
        return None
    intldes = entry.get("intldes")
    if intldes is not None and (not isinstance(intldes, str) or not intldes.strip()):
        return None
    names = entry.get("names", [])
    if not isinstance(names, list) or not all(isinstance(n, str) and n.strip() for n in names):
        return None
    if catnr is None and intldes is None and not names:
        return None
    color = entry.get("color", ADDED_COLOR)
    if not isinstance(color, str) or not _COLOR.fullmatch(color):
        return None
    max_age = entry.get("max_age_hours", ADDED_MAX_AGE_HOURS)
    if isinstance(max_age, bool) or not isinstance(max_age, int | float):
        return None
    if not math.isfinite(max_age) or max_age <= 0:
        return None
    queries = tuple(name.strip().upper() for name in names)
    return TrackedSpec(
        id=spec_id,
        label=label.strip(),
        color=color,
        name_patterns=tuple(
            re.compile(rf"^{re.escape(query)}(?:[\s-]|$)", re.IGNORECASE) for query in queries
        ),
        name_queries=queries,
        max_age_hours=float(max_age),
        catnr=catnr,
        intldes=intldes.strip() if intldes else None,
    )


def canonical_intldes(value: str) -> str:
    """COSPAR `2026-159A` and TLE `26159A` compare as the same designator."""
    text = re.sub(r"\s+", "", value.strip().upper())
    cospar = re.fullmatch(r"(\d{4})-(\d{1,3})([A-Z]{1,3})", text)
    if cospar:
        year = int(cospar.group(1)) % 100
        number = int(cospar.group(2))
        return f"{year:02d}{number:03d}{cospar.group(3)}"
    tle = re.fullmatch(r"(\d{2})(\d{3})([A-Z]{1,3})", text)
    if tle:
        return f"{tle.group(1)}{tle.group(2)}{tle.group(3)}"
    return text


def parse_element_sets(text: str, source: str) -> list[ElementSet]:
    """Every 2LE or 3LE in a CelesTrak body. The name line is kept."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    found: list[ElementSet] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        nxt = lines[index + 1] if index + 1 < len(lines) else ""
        if line.startswith("1 ") and nxt.startswith("2 "):
            name = ""
            if index > 0 and not lines[index - 1].startswith(("1 ", "2 ")):
                name = lines[index - 1]
            try:
                found.append(_element(name, line, nxt, source))
            except ValueError:
                log.warning("skipping unreadable element set in %s body", source)
            index += 2
            continue
        index += 1
    return found


def query_urls(spec: TrackedSpec) -> list[tuple[str, str]]:
    urls: list[tuple[str, str]] = []

    def add(source: str, **params: object) -> None:
        base = SUPGP_URL if source == "supgp" else GP_URL
        urls.append((source, f"{base}?{urlencode({**params, 'FORMAT': 'TLE'})}"))

    if spec.catnr is not None:
        add("supgp", CATNR=spec.catnr)
        add("gp", CATNR=spec.catnr)
    if spec.intldes:
        add("supgp", INTDES=spec.intldes)
        add("gp", INTDES=spec.intldes)
    for name in spec.name_queries:
        add("supgp", NAME=name)
        add("gp", NAME=name)
    return urls


def reentered(element: ElementSet, now: datetime) -> bool:
    """A perigee this low does not survive its next pass.

    The set is real until then, so a suborbital flight-day set still draws
    for its first revolution. An unreadable field counts as not reentered.
    """
    eccentricity = element.line2[26:33]
    try:
        motion = float(element.line2[52:63])
    except ValueError:
        return False
    if not eccentricity.isdigit() or not math.isfinite(motion) or motion <= 0:
        return False
    period_s = 86400.0 / motion
    rate = 2.0 * math.pi / period_s
    semi_major_km = (EARTH_MU_KM3_S2 / rate**2) ** (1.0 / 3.0)
    perigee_km = semi_major_km * (1.0 - float(f"0.{eccentricity}")) - EARTH_RADIUS_KM
    return perigee_km < REENTRY_PERIGEE_KM and (now - element.epoch).total_seconds() > period_s


def _rank(obj: LiveObject) -> tuple[bool, float, float, int]:
    """Ships before rocket bodies, then the newest launch.

    Epoch is left out, so the first object does not flip between two live
    ships as each gets a fresh set. A blank designator is a launch not yet
    catalogued, which is the newest.
    """
    element = obj.elements
    launch = _LAUNCH.match(element.intldes)
    year, number = math.inf, math.inf
    if launch:
        two_digit = int(launch.group(1))
        year = two_digit + (2000 if two_digit < 57 else 1900)
        number = int(launch.group(2))
    return (bool(_ROCKET_BODY.search(element.name)), -year, -number, -element.norad)


def resolve_spec(
    spec: TrackedSpec,
    cache_dir: Path,
    now: datetime,
    sources: TleSources,
) -> TrackedRecord:
    fresh: list[ElementSet] = []
    all_answered = True
    saw_error = False
    for source, url in query_urls(spec):
        reply = sources.ask(
            url,
            _reply_judge(source),
            budget_s=TRACKED_QUERY_BUDGET_SECONDS,
        )
        if isinstance(reply, Answered):
            fresh.extend(element for element in reply.value if _matches(spec, element))
            continue
        all_answered = False
        if isinstance(reply, Throttled):
            continue
        if isinstance(reply, BackedOff):
            saw_error = True
            continue
        if not isinstance(reply, Failed):
            raise RuntimeError(f"unexpected TLE reply {type(reply).__name__}")
        log.warning("tracked query failed for %s: %s", url, reply.reason)
        saw_error = True

    cache_path = _cache_path(cache_dir, spec.id)
    cached = [element for element in _read_cache(cache_path) if _matches(spec, element)]
    # CelesTrak drops a decayed object. When every query answered, an object
    # missing from the answers is gone and must not come back from the cache.
    pool = [LiveObject(element, _age_hours(element.epoch, now), False) for element in fresh]
    if not all_answered:
        pool += [LiveObject(element, _age_hours(element.epoch, now), True) for element in cached]

    newest: dict[int, LiveObject] = {}
    for obj in pool:
        held = newest.get(obj.elements.norad)
        if held is None or _newness(obj) > _newness(held):
            newest[obj.elements.norad] = obj
    kept = [obj for obj in newest.values() if obj.age_hours <= spec.grace_hours]
    live = sorted((obj for obj in kept if not reentered(obj.elements, now)), key=_rank)

    if live:
        if [obj.elements for obj in live] != cached:
            _write_cache(cache_path, [obj.elements for obj in live])
        first = live[0]
        return TrackedElements(
            id=spec.id,
            label=spec.label,
            color=spec.color,
            elements=first.elements,
            age_hours=first.age_hours,
            from_cache=first.from_cache,
            also=tuple(live[1:]),
        )
    if all_answered:
        cache_path.unlink(missing_ok=True)
    if kept:
        return _unavailable(spec, "reentered")
    # A feed that failed may hold a newer set, so sets past the grace do not
    # make this an answer.
    if saw_error:
        return _unavailable(spec, "lookup_failed")
    if pool:
        return _unavailable(spec, "aged_out")
    return _unavailable(spec, "no_public_orbit")


def _newness(obj: LiveObject) -> tuple[datetime, bool, bool]:
    return (obj.elements.epoch, obj.elements.source == "supgp", not obj.from_cache)


def write_tracked_artifact(
    cache_dir: Path,
    now: datetime,
    dest: Path,
    sources: TleSources | None = None,
    specs: tuple[TrackedSpec, ...] = TRACKED_SPECS,
) -> None:
    client = sources if sources is not None else TleSources(cache_dir)
    records = [(spec, _resolve_one(spec, cache_dir, now, client)) for spec in specs]
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(_dump(records))


def unavailable_artifact_text(specs: tuple[TrackedSpec, ...] = TRACKED_SPECS) -> str:
    return _dump([(spec, _unavailable(spec, "lookup_failed")) for spec in specs])


def _resolve_one(
    spec: TrackedSpec,
    cache_dir: Path,
    now: datetime,
    sources: TleSources,
) -> TrackedRecord:
    try:
        return resolve_spec(spec, cache_dir, now, sources)
    except OSError as exc:
        log.warning("tracked resolve failed for %s: %s", spec.id, exc)
        return _unavailable(spec, "lookup_failed")


def _reply_judge(source: str):
    def judge(status: int, text: str) -> list[ElementSet]:
        kind = _classify(status, text)
        if kind == "empty":
            return []
        if kind == "error":
            raise ValueError(f"HTTP {status}")
        found = parse_element_sets(text, source)
        if not found:
            raise ValueError("no readable element sets")
        return found

    return judge


def _dump(records: list[tuple[TrackedSpec, TrackedRecord]]) -> str:
    rows = [{**_to_json(record), "lookup": lookup_json(spec)} for spec, record in records]
    return json.dumps({"objects": rows}, indent=2) + "\n"


def lookup_json(spec: TrackedSpec) -> dict[str, object]:
    """How a browser may repeat this lookup against the same two feeds."""
    lookup: dict[str, object] = {
        "names": list(spec.name_queries),
        "patterns": [pattern.pattern for pattern in spec.name_patterns],
        "max_age_hours": spec.max_age_hours,
        "grace_hours": spec.grace_hours,
    }
    if spec.catnr is not None:
        lookup["catnr"] = spec.catnr
    if spec.intldes:
        lookup["intldes"] = spec.intldes
    return lookup


def _to_json(record: TrackedRecord) -> dict[str, object]:
    if isinstance(record, TrackedUnavailable):
        return {
            "id": record.id,
            "label": record.label,
            "color": record.color,
            "state": "unavailable",
            "reason": record.reason,
        }
    payload: dict[str, object] = {
        "id": record.id,
        "label": record.label,
        "color": record.color,
        "state": "elements",
        **_object_json(LiveObject(record.elements, record.age_hours, record.from_cache)),
    }
    if record.also:
        payload["also"] = [_object_json(obj) for obj in record.also]
    return payload


def _object_json(obj: LiveObject) -> dict[str, object]:
    element = obj.elements
    payload: dict[str, object] = {
        "source": element.source,
        "name": element.name,
        "norad": element.norad,
        "intldes": element.intldes,
        "line1": element.line1,
        "line2": element.line2,
        "epoch": utcnow_iso(element.epoch),
        "age_hours": round(obj.age_hours, 2),
    }
    if obj.from_cache:
        payload["from_cache"] = True
    return payload


def _element(name: str, line1: str, line2: str, source: str) -> ElementSet:
    tle = TLE.from_text(f"{line1}\n{line2}")
    return ElementSet(
        name=name.strip(),
        line1=tle.line1,
        line2=tle.line2,
        epoch=tle.epoch,
        norad=int(tle.line1[2:7]),
        intldes=tle.line1[9:17].strip(),
        source=source if source in ("gp", "supgp") else "gp",
    )


def _matches(spec: TrackedSpec, element: ElementSet) -> bool:
    if spec.catnr is not None and element.norad == spec.catnr:
        return True
    if spec.intldes and canonical_intldes(element.intldes) == canonical_intldes(spec.intldes):
        return True
    name = re.sub(r"\s+", " ", element.name).strip()
    return any(pattern.search(name) for pattern in spec.name_patterns)


def _classify(status: int, text: str) -> str:
    if status == 404:
        return "empty"
    if status != 200:
        return "error"
    lowered = text.lower()
    if "no gp data found" in lowered or "no supgp data found" in lowered:
        return "empty"
    return "body"


def _age_hours(epoch: datetime, now: datetime) -> float:
    return (now - epoch).total_seconds() / 3600.0


def _cache_path(cache_dir: Path, spec_id: str) -> Path:
    return cache_dir / f"tracked-{spec_id}.json"


def _write_cache(path: Path, elements: list[ElementSet]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    objects = [
        {
            "name": element.name,
            "line1": element.line1,
            "line2": element.line2,
            "source": element.source,
        }
        for element in elements
    ]
    path.write_text(json.dumps({"objects": objects}))


def _read_cache(path: Path) -> list[ElementSet]:
    """The live list of the last run. A file from before the list held one object."""
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError, UnicodeError):
        return []
    if not isinstance(raw, dict):
        return []
    rows = raw.get("objects", [raw])
    found: list[ElementSet] = []
    for row in rows if isinstance(rows, list) else []:
        try:
            found.append(
                _element(
                    str(row["name"]),
                    str(row["line1"]),
                    str(row["line2"]),
                    str(row.get("source", "gp")),
                )
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
    return found
