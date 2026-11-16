from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_faa_tfr, parse_uscg_space_operations
from generator.hazard_sources import STATE_NAME
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_r5_relevance import _retains_publication
from tests.test_hazard_r7_coverage import _publish_catalog
from tests.test_hazard_r12_parsers import FAA_URL
from tests.test_hazard_r13_uscg import USCG_URL, _payload
from tests.test_hazard_refresh import NOW, Web


def _landing_advice() -> str:
    return fx.uscg_description(58204).replace(
        "area is Starbase Tower 2,",
        "area is Starbase Tower 2 AND MARINERS MUST AVOID THE LAUNCH VEHICLE HAZARD AREA,",
    )


@pytest.mark.parametrize("strict", (True, False))
def test_recovery_landing_site_cannot_hide_launch_vehicle_avoidance(strict: bool) -> None:
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(_payload(58204, _landing_advice()), USCG_URL, strict=strict)


def test_recovery_subject_advice_keeps_last_good_publication(tmp_path: Path) -> None:
    _retains_publication(
        tmp_path, "uscg", USCG_URL, _payload(58067, fx.uscg_description(58067)),
        _payload(58067, _landing_advice()), "USCG LNM 58067",
    )


@pytest.mark.parametrize("strict", (True, False))
@pytest.mark.parametrize(("uid", "old", "new"), (
    (58204, "area is Starbase Tower 2,", "area is Starbase Tower 2 AND 25-56-00N 097-10-00W "
     "TO 26-01-00N 097-12-00W 132245Z NOV 2026 TO 140040Z NOV 2026,"),
    (58119, "Space X CRS-35 reentry", "Space X CRS-35 AND 25-56-00N 097-10-00W "
     "TO 26-01-00N 097-12-00W 132245Z NOV 2026 TO 140040Z NOV 2026 reentry"),
    (58119, "contact Space X at", "contact 255600N0971000W TO 260100N0971200W "
     "2611142245 TO 2611150040 at"),
))
def test_recovery_subjects_cannot_hide_coordinate_window_blocks(
    strict: bool, uid: int, old: str, new: str,
) -> None:
    description = fx.uscg_description(uid)
    assert old in description
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(
            _payload(uid, description.replace(old, new)), USCG_URL, strict=strict,
        )


def test_recovery_subject_coordinates_keep_last_good_publication(tmp_path: Path) -> None:
    changed = fx.uscg_description(58204).replace(
        "area is Starbase Tower 2,", "area is Starbase Tower 2 AND 25-56-00N 097-10-00W "
        "TO 26-01-00N 097-12-00W 132245Z NOV 2026 TO 140040Z NOV 2026,",
    )
    _retains_publication(
        tmp_path, "uscg", USCG_URL, _payload(58067, fx.uscg_description(58067)),
        _payload(58067, changed), "USCG LNM 58067",
    )


@pytest.mark.parametrize(("uid", "old", "new"), (
    (58119, "Pacific Ocean", "PACIFIC AND LAUNCH VEHICLE OPERATIONS Ocean"),
    (58119, "Pacific Ocean", "LAUNCH VEHICLE Ocean"),
    (58119, "contact Space X at", "contact LAUNCH VEHICLE at"),
    (58119, "Space X CRS-35 reentry", "MARINERS MUST AVOID THE LAUNCH VEHICLE reentry"),
    (58204, "area is Starbase Tower 2,", "area is ACTIVE LAUNCH VEHICLE HAZARD AREA,"),
    (58204, "primary Starship vehicle", "primary MARINERS MUST AVOID LAUNCH VEHICLE vehicle"),
    (58306, "Port Corpus Christi is", "Port LAUNCH VEHICLE is"),
    (58306, "Sector Corpus Christi Command", "Sector LAUNCH VEHICLE Command"),
    (58306, "landing of Starship Flight 15 will", "landing of MARINERS MUST AVOID LAUNCH VEHICLE will"),
    (58306, "for the reentry and landing on", "for MARINERS MUST AVOID LAUNCH VEHICLE reentry and landing on"),
    (58204, "primary Starship vehicle", "primary STARSHIP LAUNCHES vehicle"),
    (58204, "primary Starship vehicle", "primary STARSHIP LAUNCHED vehicle"),
))
def test_recovery_subject_slots_do_not_erase_operational_content(uid: int, old: str, new: str) -> None:
    description = fx.uscg_description(uid)
    assert old in description
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(_payload(uid, description.replace(old, new)), USCG_URL)


@pytest.mark.parametrize("name", (
    "261114 MARINERS MUST AVOID LAUNCH VEHICLE Recovery Starship 15",
    "261114 SpaceX Recovery MARINERS MUST AVOID LAUNCH VEHICLE",
    "261114 SpaceX Recovery ACTIVE LAUNCH VEHICLE HAZARD AREA",
    "261114 SpaceX Recovery 255600N0971000W TO 260100N0971200W 2611142245 TO 2611150040",
))
def test_faa_recovery_subjects_do_not_erase_launch_vehicle_advice(name: str) -> None:
    body = (fx.NOTICES / "faa-tfr-6-7131.xml").read_bytes().replace(
        b"261114 SpaceX Recovery Starship 15", name.encode(),
    )
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(body, fx.manifest("faa-tfr-6-7131.xml")["source_url"])


@pytest.mark.parametrize(("uid", "old", "new"), (
    (58119, "Space X CRS-35 reentry", "Space X CRS-35 launch vehicle reentry"),
    (58306, "for the reentry and landing on", "for the launch vehicle reentry and landing on"),
))
def test_legitimate_terminal_launch_vehicle_subject_remains_recovery(uid: int, old: str, new: str) -> None:
    description = fx.uscg_description(uid)
    assert old in description
    (notice,) = parse_uscg_space_operations(_payload(uid, description.replace(old, new)), USCG_URL)
    assert notice.kind == "recovery"
    assert notice.problems == ()


def _faa_metadata_body(name: str, field: str) -> bytes:
    body = (fx.NOTICES / name).read_bytes()
    if field == "coordination":
        return body.replace(
            b"THE HOUSTON /ZHU/",
            b"THE HOUSTON AND AIRCRAFT MUST AVOID THE LAUNCH VEHICLE HAZARD AREA /ZHU/",
        )
    content = (
        b"STARBASE 255600N0971000W TO 260100N0971200W 2611142245 TO 2611150040"
        if field == "location-coordinates" else
        b"STARBASE HAZARD AREA FOR LAUNCH OPERATIONS 255600N0971000W TO 260100N0971200W "
        b"13/2245Z NOV 26 TO 14/0040Z NOV 26 AIRCRAFT MUST AVOID THIS LAUNCH AREA"
    )
    return body.replace(b"AIRSPACE STARBASE, TX", b"AIRSPACE " + content + b", TX")


@pytest.mark.parametrize("field", ("location", "location-coordinates", "coordination"))
def test_faa_narrative_metadata_cannot_hide_a_launch_area(field: str) -> None:
    name = "faa-tfr-6-7131.xml"
    changed = _faa_metadata_body(name, field)
    assert changed != (fx.NOTICES / name).read_bytes()
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(changed, fx.manifest(name)["source_url"])


@pytest.mark.parametrize("field", ("location", "coordination"))
def test_faa_metadata_launch_content_keeps_last_good_publication(tmp_path: Path, field: str) -> None:
    web = Web(complete=True)
    output, cache = tmp_path / "output", tmp_path / "cache"
    items = fx.catalog_items()
    next(item for item in items if item["event_id"] == fx.STARSHIP)["schedule"]["window_end"] = "2026-11-14T00:30:00Z"
    _publish_catalog(output, items)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    first = refresh_hazards(cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication)
    assert first["ok"] and first["published"]
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"]["faa"]
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    web.pages[FAA_URL] = _faa_metadata_body("faa-tfr-6-7129.xml", field)

    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )

    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["faa"]
    assert after["error"] == "FAA_ROW"
    assert after["notices"] == before["notices"]
    assert after["checked_at"] == before["checked_at"]
    assert (report["ok"], report["degraded"], report["written"], report["published"]) == (False, True, False, False)
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]
