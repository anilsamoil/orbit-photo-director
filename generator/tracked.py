"""Extra vehicles published beside the ISS track.

Element sets come only from CelesTrak GP or SupGP text. A miss, a stale
epoch, or a failed lookup becomes a status row.
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
    """One extra vehicle. Match by catalog number, designator, or name."""

    id: str
    label: str
    color: str
    name_patterns: tuple[re.Pattern[str], ...]
    name_queries: tuple[str, ...]
    max_age_hours: float
    catnr: int | None = None
    intldes: str | None = None


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
class TrackedElements:
    id: str
    label: str
    color: str
    elements: ElementSet
    age_hours: float
    from_cache: bool


@dataclass(frozen=True)
class TrackedUnavailable:
    id: str
    label: str
    color: str
    reason: str


def _unavailable(spec: TrackedSpec, reason: str) -> TrackedUnavailable:
    return TrackedUnavailable(spec.id, spec.label, spec.color, reason)


TrackedRecord = TrackedElements | TrackedUnavailable

_STARSHIP_NAME = re.compile(r"^STARSHIP(?:[\s-]|$)", re.IGNORECASE)
_SHIP_NAME = re.compile(r"^SHIP[\s-]+\d+\b", re.IGNORECASE)
SAME_DAY_MAX_AGE_HOURS = 12.0

STARSHIP = TrackedSpec(
    id="starship",
    label="Starship",
    color="#ff5c5c",
    name_patterns=(_STARSHIP_NAME, _SHIP_NAME),
    name_queries=("STARSHIP", "SHIP"),
    max_age_hours=SAME_DAY_MAX_AGE_HOURS,
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


def resolve_spec(
    spec: TrackedSpec,
    cache_dir: Path,
    now: datetime,
    sources: TleSources,
) -> TrackedRecord:
    candidates: list[ElementSet] = []
    saw_error = False
    for source, url in query_urls(spec):
        reply = sources.ask(
            url,
            _reply_judge(source),
            budget_s=TRACKED_QUERY_BUDGET_SECONDS,
        )
        if isinstance(reply, Answered):
            candidates.extend(element for element in reply.value if _matches(spec, element))
            continue
        if isinstance(reply, Throttled):
            continue
        if isinstance(reply, BackedOff):
            saw_error = True
            continue
        if not isinstance(reply, Failed):
            raise RuntimeError(f"unexpected TLE reply {type(reply).__name__}")
        log.warning("tracked query failed for %s: %s", url, reply.reason)
        saw_error = True

    chosen: TrackedRecord | None = None
    if candidates:
        chosen = _select(spec, candidates, now)
        if isinstance(chosen, TrackedElements):
            kept = _newer_cached(spec, cache_dir, chosen.elements, now)
            if kept is not None:
                return TrackedElements(
                    id=spec.id,
                    label=spec.label,
                    color=spec.color,
                    elements=kept,
                    age_hours=_age_hours(kept.epoch, now),
                    from_cache=True,
                )
            _write_cache(_cache_path(cache_dir, spec.id), chosen.elements)
            return chosen

    cached = _read_cache(_cache_path(cache_dir, spec.id))
    if cached is not None and _matches(spec, cached):
        age = _age_hours(cached.epoch, now)
        if age <= spec.max_age_hours:
            return TrackedElements(
                id=spec.id,
                label=spec.label,
                color=spec.color,
                elements=cached,
                age_hours=age,
                from_cache=True,
            )
        if chosen is not None:
            return chosen
        return _unavailable(spec, "aged_out")

    if chosen is not None:
        return chosen
    if saw_error:
        return _unavailable(spec, "lookup_failed")
    return _unavailable(spec, "no_public_orbit")


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


def _newer_cached(
    spec: TrackedSpec,
    cache_dir: Path,
    winner: ElementSet,
    now: datetime,
) -> ElementSet | None:
    cached = _read_cache(_cache_path(cache_dir, spec.id))
    if cached is None or not _matches(spec, cached):
        return None
    if _age_hours(cached.epoch, now) > spec.max_age_hours:
        return None
    if cached.epoch <= winner.epoch:
        return None
    return cached


def _dump(records: list[tuple[TrackedSpec, TrackedRecord]]) -> str:
    rows = [{**_to_json(record), "lookup": lookup_json(spec)} for spec, record in records]
    return json.dumps({"objects": rows}, indent=2) + "\n"


def lookup_json(spec: TrackedSpec) -> dict[str, object]:
    """How a browser may repeat this lookup against the same two feeds."""
    lookup: dict[str, object] = {
        "names": list(spec.name_queries),
        "patterns": [pattern.pattern for pattern in spec.name_patterns],
        "max_age_hours": spec.max_age_hours,
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
    element = record.elements
    payload: dict[str, object] = {
        "id": record.id,
        "label": record.label,
        "color": record.color,
        "state": "elements",
        "source": element.source,
        "name": element.name,
        "norad": element.norad,
        "intldes": element.intldes,
        "line1": element.line1,
        "line2": element.line2,
        "epoch": utcnow_iso(element.epoch),
        "age_hours": round(record.age_hours, 2),
    }
    if record.from_cache:
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


def _select(
    spec: TrackedSpec,
    candidates: list[ElementSet],
    now: datetime,
) -> TrackedRecord:
    usable = [
        element
        for element in candidates
        if _age_hours(element.epoch, now) <= spec.max_age_hours
    ]
    if not usable:
        return _unavailable(spec, "aged_out")
    best = max(usable, key=lambda element: (element.epoch, element.source == "supgp"))
    return TrackedElements(
        id=spec.id,
        label=spec.label,
        color=spec.color,
        elements=best,
        age_hours=_age_hours(best.epoch, now),
        from_cache=False,
    )


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


def _write_cache(path: Path, element: ElementSet) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "name": element.name,
                "line1": element.line1,
                "line2": element.line2,
                "source": element.source,
            }
        )
    )


def _read_cache(path: Path) -> ElementSet | None:
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None
    if not isinstance(raw, dict):
        return None
    try:
        return _element(
            str(raw["name"]),
            str(raw["line1"]),
            str(raw["line2"]),
            str(raw.get("source", "gp")),
        )
    except (KeyError, TypeError, ValueError):
        return None
