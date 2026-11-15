"""Fetch the public hazard notice sources and keep each one's last good notices.

A source that fails keeps the notices and the checked time of its last success.
Confirmed snapshots obey source intervals. A damaged snapshot is refreshed before reuse.
"""

from __future__ import annotations

import fcntl
import json
import re
import time
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from pathlib import Path

import requests

from .hazard_match import Sighting
from .hazard_notices import (
    MAX_SOURCE_BYTES,
    Notice,
    NoticeError,
    _position,
    _ring,
    _window,
    notice_from_record,
    notice_record,
    parse_faa_tfr,
    parse_nga_payload,
    parse_uscg_space_operations,
)
from .launch_data import _atomic_write, _parse_iso8601_z
from .launch_evidence import utc

FAA_LIST_URL = "https://tfr.faa.gov/tfrapi/exportTfrList"
FAA_DETAIL_URL = "https://tfr.faa.gov/download/detail_{year}_{sequence}.xml"
USCG_INDEX_URL = "https://navcen.uscg.gov/sites/default/files/msi/fileIndexNew.json"
USCG_FILE_URL = "https://navcen.uscg.gov/sites/default/files/msi/spaceOpsPoly_{part}.geojson"
NGA_URL = (
    "https://msi.nga.mil/api/publications/broadcast-warn?navArea={area}&status=active&output=json"
)
SOURCES = ("faa", "uscg", "nga:4", "nga:12", "nga:A", "nga:P")
MIN_INTERVAL = {
    "faa": timedelta(minutes=15),
    "uscg": timedelta(minutes=30),
    "nga": timedelta(minutes=30),
}
TIMEOUT_SECONDS = 20
PAUSE_SECONDS = 0.5
USER_AGENT = "launch-hazard-notices/1"
STATE_NAME = "hazard-notices.json"
_MAX_FAA_DETAILS = 40
_MAX_USCG_PARTS = 8

Fetch = Callable[[str], bytes]


class SourceError(RuntimeError):
    """A source response or cached snapshot could not be used."""


def http_fetch(url: str) -> bytes:
    response = requests.get(
        url,
        timeout=TIMEOUT_SECONDS,
        allow_redirects=False,
        headers={"User-Agent": USER_AGENT},
    )
    if response.status_code != 200:
        raise SourceError(f"HTTP_{response.status_code}")
    if len(response.content) > MAX_SOURCE_BYTES:
        raise SourceError("TOO_LARGE")
    return response.content


def _json(body: bytes) -> object:
    try:
        return json.loads(body)
    except (ValueError, UnicodeError) as exc:
        raise SourceError("NOT_JSON") from exc


def _faa(fetch: Fetch, pause: Callable[[float], None]) -> list[Notice]:
    """Every space-operations restriction on the FAA list, each from its own detail file."""
    rows = _json(fetch(FAA_LIST_URL))
    if not isinstance(rows, list):
        raise SourceError("FAA_LIST_SHAPE")
    numbers = [
        row["notam_id"]
        for row in rows
        if isinstance(row, dict)
        and row.get("type") == "SPACE OPERATIONS"
        and isinstance(row.get("notam_id"), str)
        and re.fullmatch(r"\d/\d{4}", row["notam_id"])
    ]
    if len(numbers) > _MAX_FAA_DETAILS:
        raise SourceError("FAA_LIST_TOO_LONG")
    notices = []
    for number in numbers:
        pause(PAUSE_SECONDS)
        year, sequence = number.split("/")
        url = FAA_DETAIL_URL.format(year=year, sequence=sequence)
        notice = parse_faa_tfr(fetch(url), url)
        if notice.notice_id != f"TFR {number}":
            raise SourceError("FAA_DETAIL_MISMATCH")
        notices.append(notice)
    return notices


def _uscg(fetch: Fetch, pause: Callable[[float], None]) -> list[Notice]:
    index = _json(fetch(USCG_INDEX_URL))
    entry = index.get("spaceOpsPoly_") if isinstance(index, dict) else None
    parts = entry.get("counter") if isinstance(entry, dict) else None
    if type(parts) is not int or not 0 <= parts <= _MAX_USCG_PARTS:
        raise SourceError("USCG_INDEX_SHAPE")
    notices: list[Notice] = []
    for part in range(1, parts + 1):
        pause(PAUSE_SECONDS)
        url = USCG_FILE_URL.format(part=part)
        notices.extend(parse_uscg_space_operations(fetch(url), url))
    return notices


def _nga(area: str, fetch: Fetch) -> list[Notice]:
    url = NGA_URL.format(area=area)
    return [notice for notice in parse_nga_payload(fetch(url), url) if notice.kind != "other"]


def _read_state(path: Path) -> dict:
    try:
        state = json.loads(path.read_bytes())
    except (OSError, ValueError, UnicodeError):
        return {}
    sources = state.get("sources") if isinstance(state, dict) else None
    return sources if (
        isinstance(sources, dict)
        and type(state.get("schema_version")) is int
        and state["schema_version"] == 1
    ) else {}


def _cached_notice(record: object) -> Notice:
    if not isinstance(record, dict):
        raise ValueError("notice record")
    notice = notice_from_record(record)
    if (
        any(not isinstance(value, str) for value in (
            notice.authority, notice.notice_id, notice.kind, notice.domain, notice.subject,
            notice.source_url, notice.source_sha256,
        ))
        or not notice.notice_id
        or notice.kind not in {"launch", "space_debris", "recovery", "regulated_area", "other"}
        or notice.domain not in {"maritime", "airspace"}
        or not re.fullmatch(r"[a-f0-9]{64}", notice.source_sha256)
        or any(not isinstance(value, str) for value in (*notice.cancels, *notice.problems))
        or notice_record(notice) != record
    ):
        raise ValueError("notice fields")
    for area in notice.areas:
        if (
            not isinstance(area.area_id, str)
            or not isinstance(area.restriction_class, str)
            or any(not isinstance(value, str) for value in area.instructions)
        ):
            raise ValueError("area fields")
        for window in area.windows:
            _window(window.start, window.end)
    rings = [area["ring"] for area in record["areas"]]
    if record["outline"]:
        rings.append(record["outline"])
    for ring in rings:
        if any(type(value) not in (int, float) for point in ring for value in point):
            raise ValueError("coordinates")
        points = [_position(lat, lon) for lon, lat in ring]
        if tuple(points) != _ring(points):
            raise ValueError("open ring")
    return notice


def _confirmed_sightings(name: str, entry: object, now: datetime) -> list[Sighting]:
    try:
        if not isinstance(entry, dict) or not isinstance(entry.get("notices"), list):
            raise ValueError("source snapshot")
        checked = _parse_iso8601_z(entry["checked_at"])
        if checked > now:
            raise ValueError("future confirmation")
        notices = [_cached_notice(record) for record in entry["notices"]]
        if any(
            notice.authority != name.split(":")[0].upper()
            or (name.startswith("nga:") and notice.source_url != NGA_URL.format(area=name[4:]))
            for notice in notices
        ):
            raise ValueError("source authority")
        return [Sighting(notice, checked) for notice in notices]
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError) as exc:
        raise SourceError("SOURCE_STATE_INCOMPLETE") from exc


def refresh_sources(
    cache_dir: Path,
    now: datetime,
    *,
    fetch: Fetch = http_fetch,
    pause: Callable[[float], None] = time.sleep,
) -> dict:
    """Ask each source that is due. Returns the per-source state after the attempts."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / STATE_NAME
    with (cache_dir / f"{STATE_NAME}.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SourceError("SOURCE_CACHE_BUSY") from exc
        sources = _read_state(path)
        for name in SOURCES:
            entry = sources.get(name) if isinstance(sources.get(name), dict) else {}
            try:
                _confirmed_sightings(name, entry, now)
            except SourceError:
                if "checked_at" in entry or "notices" in entry or entry.get("error") is None:
                    entry = {}
            attempted = entry.get("attempted_at")
            if isinstance(attempted, str):
                try:
                    waited = now - _parse_iso8601_z(attempted)
                except ValueError:
                    waited = None
                if waited is not None and timedelta(0) <= waited < MIN_INTERVAL[name.split(":")[0]]:
                    continue
            entry["attempted_at"] = utc(now)
            sources[name] = entry
            _atomic_write(path, json.dumps({"schema_version": 1, "sources": sources}))
            try:
                if name == "faa":
                    notices = _faa(fetch, pause)
                elif name == "uscg":
                    notices = _uscg(fetch, pause)
                else:
                    notices = _nga(name.split(":")[1], fetch)
            except (SourceError, NoticeError, requests.RequestException, OSError) as exc:
                entry["error"] = (
                    str(exc) if isinstance(exc, (SourceError, NoticeError)) else type(exc).__name__
                )
                continue
            entry.update(
                checked_at=utc(now),
                error=None,
                notices=[notice_record(notice) for notice in notices],
            )
        _atomic_write(path, json.dumps({"schema_version": 1, "sources": sources}))
        return sources


def sightings_from_state(sources: Mapping[str, object], now: datetime) -> list[Sighting]:
    """All required sources must have confirmed, fully decoded snapshots."""
    found: list[Sighting] = []
    for name in SOURCES:
        found.extend(_confirmed_sightings(name, sources.get(name), now))
    return found
