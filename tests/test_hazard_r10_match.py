from __future__ import annotations

import json
from pathlib import Path

import pytest

from generator.hazard_match import Sighting, build_bundle, validate_bundle
from generator.hazard_notices import parse_nga_payload, parse_uscg_space_operations
from generator.hazard_sources import (
    NGA_URL,
    USCG_FILE_URL,
    refresh_sources,
    sightings_from_state,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_r6_sources import _page
from tests.test_hazard_refresh import NOW, Web

AVOID_LAUNCH_WINDOW = (
    "Mariners should avoid waters within the defined hazard areas during the scheduled launch window."
)
AVOID_THREE_HOURS = (
    "The high risk hazard area should be avoided three hours prior to the earliest launch "
    "to ensure range clearance."
)


def _ordinary_headings(description: str) -> str:
    return description.replace("High Risk Hazard Area:", "Hazard Area A:").replace(
        "\nHazard Area:", "\nHazard Area B:",
    )


def _confirmed_pair(
    tmp_path: Path, original_description: str, alias_description: str,
) -> list[Sighting]:
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    original = next(
        feature for feature in payload["features"]
        if feature["properties"]["MSI_UID"] == 58067
    )
    alias = json.loads(json.dumps(original))
    original["properties"]["DESCRIPTION"] = original_description
    alias["properties"].update(MSI_UID=58066, DESCRIPTION=alias_description)
    payload["features"] = [original, alias]
    web = Web(complete=True)
    web.pages[USCG_FILE_URL.format(part=1)] = json.dumps(payload).encode()
    sources = refresh_sources(tmp_path / "cache", NOW, fetch=web, pause=lambda _: None)
    assert sources["uscg"]["error"] is None
    assert sources["uscg"]["checked_at"] == "2026-11-13T23:40:00Z"
    sightings = [
        sighting for sighting in sightings_from_state(sources, NOW)
        if sighting.notice.authority == "USCG"
    ]
    assert {sighting.notice.notice_id for sighting in sightings} == {
        "USCG LNM 58066", "USCG LNM 58067",
    }
    assert all(sighting.notice.kind == "launch" and not sighting.notice.problems for sighting in sightings)
    return sightings


def _bundle(sightings: list[Sighting]) -> dict:
    bundle, _ = build_bundle([fx.item(fx.STARSHIP)], sightings, NOW)
    validate_bundle(bundle)
    return fx.launch(bundle, fx.STARSHIP)


def test_confirmed_ordinary_copy_preserves_captured_high_risk_and_three_hour_warning(
    tmp_path: Path,
) -> None:
    description = fx.uscg_description(58067)
    sightings = _confirmed_pair(tmp_path, description, _ordinary_headings(description))
    alone = _bundle([sighting for sighting in sightings if sighting.notice.notice_id == "USCG LNM 58067"])
    entry = _bundle(sightings)
    assert [(row["notice_id"], row["area_id"], row["restriction_class"]) for row in entry["notices"]] == [
        ("USCG LNM 58066", "A", "hazard"),
        ("USCG LNM 58066", "B", "hazard"),
        ("USCG LNM 58067", "HIGH RISK", "high_risk"),
    ]
    high_risk = entry["notices"][2]
    assert high_risk == next(row for row in alone["notices"] if row["area_id"] == "HIGH RISK")
    assert high_risk["instructions"] == [AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS]
    assert high_risk["also"] == []
    assert entry["notices"][1]["also"] == ["USCG LNM 58067"]
    assert [(feature["properties"]["notice_id"], feature["properties"]["restriction_class"]) for feature in entry["geojson"]["features"]] == [
        ("USCG LNM 58066", "hazard"),
        ("USCG LNM 58066", "hazard"),
        ("USCG LNM 58067", "high_risk"),
    ]


@pytest.mark.parametrize("difference", ("restriction_class", "instructions"))
def test_confirmed_same_geometry_keeps_each_differing_warning_field(
    tmp_path: Path, difference: str,
) -> None:
    description = fx.uscg_description(58067)
    if difference == "restriction_class":
        description = description.replace(AVOID_THREE_HOURS, "")
        alias_description = _ordinary_headings(description)
        alias_area = "A"
    else:
        alias_description = description.replace(AVOID_THREE_HOURS, "")
        alias_area = "HIGH RISK"
    sightings = _confirmed_pair(tmp_path, description, alias_description)
    entry = _bundle(sightings)
    original = [row for row in entry["notices"] if row["notice_id"] == "USCG LNM 58067"]
    assert [(row["area_id"], row["restriction_class"]) for row in original] == [("HIGH RISK", "high_risk")]
    alias = next(row for row in entry["notices"] if row["area_id"] == alias_area)
    assert original[0]["windows"] == alias["windows"]
    assert original[0]["valid_until"] == alias["valid_until"]
    assert original[0]["also"] == []
    if difference == "restriction_class":
        assert original[0]["instructions"] == alias["instructions"] == [AVOID_LAUNCH_WINDOW]
        assert alias["restriction_class"] == "hazard"
    else:
        assert original[0]["restriction_class"] == alias["restriction_class"] == "high_risk"
        assert original[0]["instructions"] == [AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS]
        assert alias["instructions"] == [AVOID_LAUNCH_WINDOW]


def test_confirmed_identical_heading_copy_still_aliases_both_areas(tmp_path: Path) -> None:
    description = fx.uscg_description(58067)
    entry = _bundle(_confirmed_pair(tmp_path, description, description))
    assert [(row["notice_id"], row["area_id"], row["restriction_class"]) for row in entry["notices"]] == [
        ("USCG LNM 58066", "HAZARD", "hazard"),
        ("USCG LNM 58066", "HIGH RISK", "high_risk"),
    ]
    assert [row["also"] for row in entry["notices"]] == [["USCG LNM 58067"], ["USCG LNM 58067"]]
    assert entry["notices"][0]["instructions"] == [AVOID_LAUNCH_WINDOW]
    assert entry["notices"][1]["instructions"] == [AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS]
    assert len(entry["geojson"]["features"]) == 2


def test_known_limit_uscg_final_complete_area_deletion_leaves_valid_prefix() -> None:
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    feature = next(row for row in payload["features"] if row["properties"]["MSI_UID"] == 58217)
    description = feature["properties"]["DESCRIPTION"]
    start = description.index("Hazard Area C:")
    end = description.index("Mariners are advised", start)
    feature["properties"]["DESCRIPTION"] = description[:start] + description[end:]
    notices = parse_uscg_space_operations(
        json.dumps(payload).encode(), USCG_FILE_URL.format(part=1), strict=True,
    )
    notice = next(row for row in notices if row.notice_id == "USCG LNM 58217")
    assert tuple(area.area_id for area in notice.areas) == ("A", "B")
    assert [len(area.windows) for area in notice.areas] == [7, 7]
    assert notice.problems == ()
    assert all(area.instructions for area in notice.areas)


def test_known_limit_nga_final_complete_area_deletion_leaves_valid_prefix() -> None:
    description = fx.broadcast_body("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 801/26")
    start = description.index("   C. ")
    end = description.index("2. CANCEL", start)
    (notice,) = parse_nga_payload(
        _page(description[:start] + description[end:]), NGA_URL.format(area="12"),
    )
    assert tuple(area.area_id for area in notice.areas) == ("A", "B")
    assert [len(area.windows) for area in notice.areas] == [7, 7]
    assert notice.cancels == ("NAVAREA XII 785/26",)
    assert notice.valid_until is not None and notice.valid_until.isoformat() == "2026-11-24T07:34:00+00:00"
    assert notice.problems == ()
