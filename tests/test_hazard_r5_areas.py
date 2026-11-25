from __future__ import annotations

import json
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_match import Sighting, build_bundle, launches_from_catalog, pad_distance_km
from generator.hazard_notices import notice_from_record, notice_record, parse_nga_payload
from generator.hazard_sources import NGA_URL, STATE_NAME
from scripts.hazard_refresh import ARTIFACT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web, _output
from tests.test_hazard_relevance import _payload, _xii_rows

DATELINE_RING = ((179.0, 29.0), (-179.0, 29.0), (179.0, 28.0))


def _dateline_801() -> bytes:
    row = next(row for row in _xii_rows() if row["msgNumber"] == 801)
    text = str(row["text"])
    start = text.index("29-02.00N 117-59.00W")
    end = text.index("2. CANCEL")
    row["text"] = (
        text[:start]
        + "29-00.00N 179-00.00E, 29-00.00N 179-00.00W, 28-00.00N 179-00.00E.\n"
        + text[end:]
    )
    return _payload([row])


def test_dateline_area_retains_validated_vertices_and_its_own_schedule() -> None:
    original = fx.broadcast_notice(
        "navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 801/26",
    )
    (notice,) = parse_nga_payload(_dateline_801(), NGA_URL.format(area="12"))
    assert [area.area_id for area in notice.areas] == ["A", "B", "C"]
    assert notice.areas[:2] == original.areas[:2]
    assert notice.areas[2].ring == DATELINE_RING
    assert notice.areas[2].windows == original.areas[2].windows
    assert notice.problems == ("GEOMETRY_UNDRAWN:ANTIMERIDIAN:C",)
    assert notice_from_record(notice_record(notice)) == notice


def test_dateline_area_keeps_drawable_siblings_and_a_launch_card_listing() -> None:
    (notice,) = parse_nga_payload(_dateline_801(), NGA_URL.format(area="12"))
    bundle, decisions = build_bundle(
        [fx.item(fx.USSF_317)], [Sighting(notice, NOW)], NOW,
    )
    assert len(bundle["launches"]) == 1
    launch = fx.launch(bundle, fx.USSF_317)
    assert [entry["area_id"] for entry in launch["notices"]] == ["A", "B"]
    assert [feature["properties"]["area_id"] for feature in launch["geojson"]["features"]] == [
        "A", "B",
    ]
    assert [(entry["notice_id"], entry["reason"]) for entry in launch["listed"]] == [
        ("NAVAREA XII 801/26", "not_drawn"),
    ]
    assert "C" in launch["listed"][0]["text"]
    assert "ANTIMERIDIAN" in launch["listed"][0]["text"].upper()
    assert decisions[0]["decision"] == "matched"


def test_dateline_area_survives_disk_cache_and_publication(tmp_path: Path) -> None:
    web = Web(complete=True)
    web.pages[NGA_URL.format(area="12")] = _dateline_801()
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget(
        "offline:test", lambda path, *_: uploads.append(path.read_bytes()),
    )
    checks = (NOW, NOW + timedelta(minutes=1), NOW + timedelta(minutes=31))
    for index, checked in enumerate(checks):
        report = refresh_hazards(
            cache, output, checked, fetch=web, pause=lambda _: None, publication=publication,
        )
        assert report["ok"] and not report["degraded"]
        assert report["published"] is (index != 1)
        state = json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:12"]
        assert state["error"] is None
        assert [area["area_id"] for area in state["notices"][0]["areas"]] == ["A", "B", "C"]
        launch = fx.launch(json.loads((output / ARTIFACT).read_bytes()), fx.USSF_317)
        assert [
            entry["area_id"] for entry in launch["notices"]
            if entry["notice_id"] == "NAVAREA XII 801/26"
        ] == ["A", "B"]
        assert any(
            entry["notice_id"] == "NAVAREA XII 801/26" and entry["reason"] == "not_drawn"
            for entry in launch["listed"]
        )
    assert len(uploads) == 2
    assert uploads[-1] == (output / ARTIFACT).read_bytes()


def test_dateline_crossing_on_only_the_closing_edge_is_also_withheld() -> None:
    body = _dateline_801().replace(
        b"29-00.00N 179-00.00W", b"29-00.00N 000-00.00E",
    ).replace(b"28-00.00N 179-00.00E", b"28-00.00N 179-00.00W")
    (notice,) = parse_nga_payload(body, NGA_URL.format(area="12"))
    bundle, _ = build_bundle([fx.item(fx.USSF_317)], [Sighting(notice, NOW)], NOW)
    launch = fx.launch(bundle, fx.USSF_317)
    assert [entry["area_id"] for entry in launch["notices"]] == ["A", "B"]
    assert "C" in launch["listed"][0]["text"]


@pytest.mark.parametrize("longitude", (179.5, -179.5))
def test_all_undrawn_areas_can_still_locate_a_notice_at_the_dateline(longitude: float) -> None:
    (notice,) = parse_nga_payload(_dateline_801(), NGA_URL.format(area="12"))
    assert len(notice.areas) == 3
    notice = replace(notice, areas=(notice.areas[2],))
    item = fx.item(fx.USSF_317)
    item["site"].update(lat=28.75, lon=longitude)
    bundle, _ = build_bundle([item], [Sighting(notice, NOW)], NOW)
    assert len(bundle["launches"]) == 1
    launch = fx.launch(bundle, fx.USSF_317)
    assert launch["notices"] == [] and launch["geojson"]["features"] == []
    assert launch["listed"][0]["reason"] == "not_drawn"


def test_dateline_area_does_not_anchor_to_an_antipodal_pad() -> None:
    item = fx.item(fx.USSF_317)
    item["site"].update(lat=28.75, lon=0)
    (launch,) = launches_from_catalog([item], NOW)
    assert pad_distance_km(launch, DATELINE_RING) > 25


def test_old_cache_with_discarded_dateline_areas_requires_a_fresh_source(tmp_path: Path) -> None:
    web = Web(complete=True)
    url = NGA_URL.format(area="12")
    web.pages[url] = _dateline_801()
    cache, output = tmp_path / "cache", _output(tmp_path)
    assert refresh_hazards(cache, output, NOW, fetch=web, pause=lambda _: None)["ok"]
    state_path = cache / STATE_NAME
    state = json.loads(state_path.read_bytes())
    state["sources"]["nga:12"]["notices"][0]["areas"] = []
    state_path.write_text(json.dumps(state))
    web.asked.clear()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=1), fetch=web, pause=lambda _: None,
    )
    assert url in web.asked
    assert report["ok"]
    source = json.loads(state_path.read_bytes())["sources"]["nga:12"]
    assert [area["area_id"] for area in source["notices"][0]["areas"]] == ["A", "B", "C"]


def test_many_undrawn_areas_keep_every_area_id_in_one_listing() -> None:
    (notice,) = parse_nga_payload(_dateline_801(), NGA_URL.format(area="12"))
    names = "CDEFGHIJK"
    notice = replace(notice, areas=(
        *notice.areas[:2], *(replace(notice.areas[2], area_id=name) for name in names),
    ))
    bundle, _ = build_bundle([fx.item(fx.USSF_317)], [Sighting(notice, NOW)], NOW)
    listings = fx.launch(bundle, fx.USSF_317)["listed"]
    assert len(listings) == 1
    for name in names:
        assert name in listings[0]["text"]


def test_undrawn_listings_over_the_schema_limit_fail_without_omitting_notices() -> None:
    (notice,) = parse_nga_payload(_dateline_801(), NGA_URL.format(area="12"))
    sightings = [
        Sighting(replace(notice, notice_id=f"NAVAREA XII {number}/26"), NOW)
        for number in range(801, 810)
    ]
    with pytest.raises(ValueError, match="^HAZARD_LISTED$"):
        build_bundle([fx.item(fx.USSF_317)], sightings, NOW)
