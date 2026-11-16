"""Synthetic XNOTAM frames for sites absent from the captured FAA detail set.

The fixtures use the captured polygon restriction structure with invented local
coordinates, identifiers, schedules and telephone numbers. They are not captures.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_notices import parse_faa_tfr
from generator.hazard_sources import FAA_DETAIL_URL, FAA_LIST_URL, STATE_NAME, refresh_sources
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests.test_hazard_refresh import NOW, Web, _output

FIXTURES = Path(__file__).parent / "fixtures/hazards_r3"
SITES = (("vandenberg", "7991"), ("wallops", "7992"))


def _web(site: str, sequence: str) -> Web:
    web = Web(complete=True)
    listing = json.loads(web.pages[FAA_LIST_URL])
    listing.append({"type": "SPACE OPERATIONS", "notam_id": f"6/{sequence}"})
    web.pages[FAA_LIST_URL] = json.dumps(listing).encode()
    web.pages[FAA_DETAIL_URL.format(year="6", sequence=sequence)] = (
        FIXTURES / f"faa-{site}.xml"
    ).read_bytes()
    return web


@pytest.mark.parametrize(("site", "sequence"), SITES)
def test_other_launch_sites_confirm_their_whole_restriction(site: str, sequence: str) -> None:
    raw = (FIXTURES / f"faa-{site}.xml").read_bytes()
    notice = parse_faa_tfr(raw, "fixture")
    assert notice.problems == ()
    assert notice.kind == "launch" and notice.notice_id == f"TFR 6/{sequence}"
    expected = (
        ((-120.75, 34.75), (-120.5, 34.75), (-120.5, 34.5), (-120.75, 34.5))
        if site == "vandenberg"
        else ((-75.5, 38.0), (-75.0, 38.0), (-75.0, 37.5), (-75.5, 37.5))
    )
    assert notice.areas[0].ring == expected
    window = notice.areas[0].windows[0]
    assert window.start.isoformat() == "2026-11-13T22:30:00+00:00"
    assert window.end.isoformat() == "2026-11-14T00:40:00+00:00"


@pytest.mark.parametrize(("site", "sequence"), SITES)
def test_other_launch_site_source_can_publish(tmp_path: Path, site: str, sequence: str) -> None:
    web = _web(site, sequence)
    cache = tmp_path / "cache"
    sources = refresh_sources(cache, NOW, fetch=web, pause=lambda _: None)
    assert sources["faa"]["error"] is None
    assert f"TFR 6/{sequence}" in {row["notice_id"] for row in sources["faa"]["notices"]}
    output = _output(tmp_path)
    uploads: list[bytes] = []
    report = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None,
        publication=PublicationTarget(
            "r2:test", lambda path, *_: uploads.append(path.read_bytes()),
        ),
    )
    assert report["ok"] and report["published"]
    assert uploads == [(output / ARTIFACT).read_bytes()]
    assert (output / PUBLICATION_RECEIPT).is_file()


@pytest.mark.parametrize(("old", "new"), (
    (b"WALLOPS ISLAND, VA", b"PACIFIC SPACEPORT COMPLEX - ALASKA, AK"),
    (b"WASHINGTON /ZDC/ ARTCC, TEL 703-555-0100,", b"ANCHORAGE /ZAN/ ARTCC TEL 907-555-0100"),
    (b"WASHINGTON /ZDC/ ARTCC, TEL 703-555-0100,", b"ANCHORAGE /ZAN/ ARTCC TEL (907) 555-0100"),
))
def test_location_and_facility_labels_do_not_define_launch_restrictions(
    old: bytes, new: bytes,
) -> None:
    raw = (FIXTURES / "faa-wallops.xml").read_bytes()
    assert old in raw
    assert parse_faa_tfr(raw.replace(old, new), "fixture").problems == ()


@pytest.mark.parametrize(("site", "sequence"), SITES)
@pytest.mark.parametrize(("damage", "problem"), (
    ("identity", "NUMBER_CONFLICT"),
    ("geometry", "GEOMETRY_UNPARSED"),
    ("xml_schedule", "WINDOW_CONFLICT"),
    ("closing_schedule", "WINDOW_CONFLICT"),
    ("unknown_tail", "NARRATIVE_UNPARSED"),
))
def test_other_launch_site_conflicts_preserve_publication(
    tmp_path: Path, site: str, sequence: str, damage: str, problem: str,
) -> None:
    web = _web(site, sequence)
    cache = tmp_path / "cache"
    output = _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("r2:test", lambda path, *_: uploads.append(path.read_bytes()))
    assert refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )["published"]
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    url = FAA_DETAIL_URL.format(year="6", sequence=sequence)
    raw = web.pages[url]
    geometry_change = (b"34.75N", b"34.8N") if site == "vandenberg" else (b"38.0N", b"38.1N")
    old, new = {
        "identity": (b"!FDC 6/", b"!FDC 5/"),
        "geometry": geometry_change,
        "xml_schedule": (
            b"<dateExpire>2026-11-14T00:40:00", b"<dateExpire>2026-11-14T01:40:00",
        ),
        "closing_schedule": (b"2611132230-2611140040", b"2611132230-2611140140"),
        "unknown_tail": (
            b"2611132230-2611140040",
            b"2611132230-2611140040 UNKNOWN OPERATIONS IN PROGRESS.",
        ),
    }[damage]
    assert old in raw
    web.pages[url] = raw.replace(old, new, 1)
    notice = parse_faa_tfr(web.pages[url], "fixture")
    assert any(value.startswith(problem) for value in notice.problems)
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=16), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    assert report["degraded"] and not report["published"] and not report["written"]
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]
    sources = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    assert sources["faa"]["error"] == "FAA_ROW"
