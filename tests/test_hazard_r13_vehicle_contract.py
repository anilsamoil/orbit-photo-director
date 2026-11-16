from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_faa_tfr, parse_uscg_space_operations
from generator.hazard_sources import STATE_NAME
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_r7_coverage import _publish_catalog
from tests.test_hazard_r12_parsers import FAA_URL
from tests.test_hazard_r13_uscg import USCG_URL, _payload
from tests.test_hazard_refresh import NOW, Web

COMMANDS = (
    "DO NOT APPROACH", "NEVER APPROACH", "KEEP AWAY FROM", "REMAIN OUTSIDE",
    "SHUN", "TURN AWAY FROM", "STAY OUT OF",
)
IDENTIFIERS = ("LAUNCH VEHICLE", "STARSHIP FLIGHT 16", "STARSHIP STAGE 2")


def _uscg_subject(subject: str) -> str:
    return fx.uscg_description(58204).replace(
        "Starship reentry and landing", subject + " reentry and landing",
    )


def _faa_subject(subject: str, *, launch: bool = False) -> bytes:
    filename, old, day = (
        ("faa-tfr-6-7129.xml", "261113 SpaceX Launch Starship 15", "261113")
        if launch else ("faa-tfr-6-7131.xml", "261114 SpaceX Recovery Starship 15", "261114")
    )
    return (fx.NOTICES / filename).read_bytes().replace(
        old.encode(), f"{day} SpaceX Recovery {subject}".encode(),
    )


@pytest.mark.parametrize("strict", (True, False))
def test_uscg_vehicle_noun_cannot_hide_exact_negative_imperative(strict: bool) -> None:
    subject = "Starship AND DO NOT APPROACH THE LAUNCH VEHICLE"
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(_payload(58204, _uscg_subject(subject)), USCG_URL, strict=strict)


def test_faa_vehicle_noun_cannot_hide_exact_negative_imperative() -> None:
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(_faa_subject("Starship 15 AND DO NOT APPROACH THE LAUNCH VEHICLE"), FAA_URL)


@pytest.mark.parametrize("source", ("uscg", "faa"))
@pytest.mark.parametrize("position", ("before", "after"))
@pytest.mark.parametrize("identifier", IDENTIFIERS)
@pytest.mark.parametrize("command", COMMANDS)
def test_vehicle_exemptions_require_a_complete_identifier(
    source: str, position: str, identifier: str, command: str,
) -> None:
    subject = (
        f"STARSHIP AND {command} THE {identifier}"
        if position == "before" else f"{identifier} AND {command} THIS AREA"
    )
    if source == "uscg":
        with pytest.raises(NoticeError, match="^USCG_ROW$"):
            parse_uscg_space_operations(_payload(58204, _uscg_subject(subject)), USCG_URL)
    else:
        with pytest.raises(NoticeError, match="^FAA_ROW$"):
            parse_faa_tfr(_faa_subject(subject), FAA_URL)


@pytest.mark.parametrize("source", ("uscg", "faa"))
@pytest.mark.parametrize("command", COMMANDS)
def test_entity_names_cannot_hide_nonvehicle_commands(source: str, command: str) -> None:
    if source == "uscg":
        description = fx.uscg_description(58204).replace(
            "area is Starbase Tower 2,", f"area is {command} THE SPACE X SITE,",
        )
        with pytest.raises(NoticeError, match="^USCG_ROW$"):
            parse_uscg_space_operations(_payload(58204, description), USCG_URL)
    else:
        name = "faa-tfr-6-7131.xml"
        body = (fx.NOTICES / name).read_bytes().replace(
            b"AIRSPACE STARBASE, TX", f"AIRSPACE {command} SPACE X, TX".encode(),
        )
        with pytest.raises(NoticeError, match="^FAA_ROW$"):
            parse_faa_tfr(body, fx.manifest(name)["source_url"])


@pytest.mark.parametrize("source", ("uscg", "faa"))
def test_negative_imperative_vehicle_subject_keeps_last_good_publication(
    tmp_path: Path, source: str,
) -> None:
    web = Web(complete=True)
    output, cache = tmp_path / "output", tmp_path / "cache"
    items = fx.catalog_items()
    next(item for item in items if item["event_id"] == fx.STARSHIP)["schedule"]["window_end"] = "2026-11-14T00:30:00Z"
    _publish_catalog(output, items)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    if source == "uscg":
        web.pages[USCG_URL] = _payload(58067, fx.uscg_description(58067))
    first = refresh_hazards(cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication)
    assert first["ok"] and first["published"]
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    subject = "Starship 15 AND DO NOT APPROACH THE LAUNCH VEHICLE"
    if source == "uscg":
        web.pages[USCG_URL] = _payload(58067, _uscg_subject(subject))
    else:
        web.pages[FAA_URL] = _faa_subject(subject, launch=True)

    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )

    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    assert after["error"] == ("USCG_ROW" if source == "uscg" else "FAA_ROW")
    assert after["notices"] == before["notices"]
    assert after["checked_at"] == before["checked_at"]
    assert (report["ok"], report["degraded"], report["written"], report["published"]) == (False, True, False, False)
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]


@pytest.mark.parametrize("subject", (
    "STARSHIP FLIGHT 16", "STARSHIP 16 LAUNCH VEHICLE", "STARSHIP STAGE 3",
    "SPACE X CRS-36 LAUNCH VEHICLE", "SPACEX CRS- 36 LAUNCH VEHICLE", "LAUNCH VEHICLE",
))
def test_complete_supported_vehicle_identifiers_remain_recovery(subject: str) -> None:
    (notice,) = parse_uscg_space_operations(_payload(58204, _uscg_subject(subject)), USCG_URL)
    assert (notice.kind, notice.areas, notice.problems) == ("recovery", (), ())


def test_complete_composite_vehicle_identifier_remains_recovery() -> None:
    description = fx.uscg_description(58114).replace("FLIGHT 15", "FLIGHT 16").replace("STAGE 2", "STAGE 3")
    (notice,) = parse_uscg_space_operations(_payload(58114, description), USCG_URL)
    assert (notice.kind, notice.areas, notice.problems) == ("recovery", (), ())
