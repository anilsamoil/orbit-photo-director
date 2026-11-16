from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_match import Sighting, build_bundle, launches_from_catalog, match_notices
from generator.hazard_notices import parse_nga_payload
from generator.hazard_sources import NGA_URL
from generator.launch_evidence import canonical_bytes, utc
from generator.launch_publish import publish_launch_catalog
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web
from tests.test_hazard_relevance import _payload


def _window_row(number: int, count: int, *, first: int = 0) -> dict:
    day = NOW.replace(day=15, hour=0, minute=0)
    windows = []
    for index in range(first, first + count):
        start = day + timedelta(minutes=15 * index)
        end = start + timedelta(minutes=10)
        windows.append(f"{start:%d%H%M}Z TO {end:%d%H%M}Z NOV")
    return {
        "navArea": "12",
        "msgNumber": number,
        "msgYear": 2026,
        "issueDate": "130014Z NOV 2026",
        "text": (
            "NORTH PACIFIC.\nCALIFORNIA.\n"
            "1. HAZARDOUS OPERATIONS, ROCKET LAUNCHING:\n"
            f"   {', ALTERNATE '.join(windows)} IN AREA BOUND BY\n"
            "   34-30.00N 120-40.00W, 34-50.00N 120-40.00W,\n"
            "   34-50.00N 120-20.00W, 34-30.00N 120-20.00W.\n"
            "2. CANCEL THIS MSG 160001Z NOV 26.\n"
        ),
    }


def _item(index: int) -> dict:
    start = NOW.replace(day=15, hour=0, minute=0) + timedelta(minutes=15 * index)
    item = fx.item(
        fx.USSF_317,
        net=utc(start + timedelta(minutes=5)),
        window_start=utc(start),
        window_end=utc(start + timedelta(minutes=10)),
    )
    item["event_id"] = f"launch-{index:02d}"
    return item


def _publish_catalog(output: Path, items: list[dict]) -> None:
    catalog = json.loads((fx.FIXTURES / "launch-catalog-2026-11-13.json").read_bytes())
    catalog["items"] = items
    coverage = catalog["coverage"]
    coverage.update(listed=len(items), received=len(items), evaluated=len(items))
    coverage["tier_counts"] = {
        tier: sum(item["tier"] == tier for item in items)
        for tier in coverage["tier_counts"]
    }
    catalog["revision"] = hashlib.sha256(canonical_bytes({
        key: value for key, value in catalog.items() if key != "revision"
    })).hexdigest()[:24]
    publish_launch_catalog(catalog, output)


def _sightings(rows: list[dict]) -> list[Sighting]:
    notices = parse_nga_payload(_payload(rows), NGA_URL.format(area="12"))
    assert all(notice.kind == "launch" and not notice.problems for notice in notices)
    return [Sighting(notice, NOW) for notice in notices]


def test_sixteen_disjoint_windows_publish_including_the_matching_last_window() -> None:
    sightings = _sightings([_window_row(900, 16)])
    bundle, log = build_bundle([_item(15)], sightings, NOW)
    assert [(entry["decision"], entry["event_id"]) for entry in log] == [
        ("matched", "launch-15"),
    ]
    windows = bundle["launches"][0]["notices"][0]["windows"]
    assert len(windows) == 16
    assert windows[-1] == {"start": "2026-11-15T03:45:00Z", "end": "2026-11-15T03:55:00Z"}


def test_seventeen_disjoint_windows_reject_instead_of_dropping_the_matching_window() -> None:
    sightings = _sightings([_window_row(900, 17)])
    assert len(sightings[0].notice.areas[0].windows) == 17
    items = [_item(16)]
    matched, _, log = match_notices(launches_from_catalog(items, NOW), sightings, NOW)
    assert list(matched) == ["launch-16"] and log[0]["decision"] == "matched"
    with pytest.raises(ValueError, match="^HAZARD_WINDOWS$"):
        build_bundle(items, sightings, NOW)


def test_thirty_two_matched_launches_publish_including_the_last_launch() -> None:
    items = [_item(index) for index in range(32)]
    sightings = _sightings([_window_row(900 + index, 1, first=index) for index in range(32)])
    bundle, log = build_bundle(items, sightings, NOW)
    assert len(log) == 32 and all(entry["decision"] == "matched" for entry in log)
    assert [launch["event_id"] for launch in bundle["launches"]] == [
        f"launch-{index:02d}" for index in range(32)
    ]


def test_thirty_three_matched_launches_reject_instead_of_dropping_the_last_launch() -> None:
    items = [_item(index) for index in range(33)]
    sightings = _sightings([_window_row(900 + index, 1, first=index) for index in range(33)])
    matched, _, log = match_notices(launches_from_catalog(items, NOW), sightings, NOW)
    assert len(matched) == len(log) == 33
    assert all(entry["decision"] == "matched" for entry in log)
    with pytest.raises(ValueError, match="^HAZARD_LAUNCHES$"):
        build_bundle(items, sightings, NOW)


@pytest.mark.parametrize("overflow", ["windows", "launches"])
def test_overflow_retains_the_warm_artifact_and_receipt_without_upload(
    tmp_path: Path, overflow: str,
) -> None:
    web = Web(complete=True)
    url = NGA_URL.format(area="12")
    if overflow == "windows":
        items = [_item(16)]
        initial_rows = [_window_row(900, 1, first=16)]
        changed_rows = [_window_row(900, 17)]
        code = "HAZARD_WINDOWS"
    else:
        items = [_item(index) for index in range(33)]
        initial_rows = [_window_row(900 + index, 1, first=index) for index in range(32)]
        changed_rows = [*initial_rows, _window_row(932, 1, first=32)]
        code = "HAZARD_LAUNCHES"
    cache, output = tmp_path / "cache", tmp_path / "launch-output"
    _publish_catalog(output, items)
    web.pages[url] = _payload(initial_rows)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    report = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    assert report["ok"] and report["published"] and uploads == [artifact]
    assert report["launches"] == len(initial_rows)

    web.pages[url] = _payload(changed_rows)
    with pytest.raises(ValueError, match=f"^{code}$"):
        refresh_hazards(
            cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
            publication=publication,
        )

    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]
