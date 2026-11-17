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

WARNINGS = (
    "AIRCRAFT MUST NOT ENTER THE ROCKET EXCLUSION ZONE",
    "ENTRY INTO THE ROCKET EXCLUSION ZONE IS PROHIBITED",
    "ENTRY INTO THIS ZONE IS PROHIBITED",
    "NAVIGATION IN THIS ZONE IS FORBIDDEN",
    "KEEP OUT OF THIS ZONE",
    "KEEP CLEAR OF THIS ZONE",
    "STAY AWAY FROM THESE WATERS",
    "PERSONNEL SHALL NOT ENTER THIS ZONE",
    "VESSELS SHOULD KEEP CLEAR OF THIS ZONE",
    "ACCESS IS NOT PERMITTED",
)


def _uscg_warning(warning: str) -> str:
    return fx.uscg_description(58204).replace(
        "area is Starbase Tower 2,", f"area is Starbase Tower 2 AND {warning},",
    )


def _faa_warning(name: str, warning: str, field: str) -> bytes:
    body = (fx.NOTICES / name).read_bytes()
    if field == "location":
        return body.replace(b"AIRSPACE STARBASE, TX", f"AIRSPACE STARBASE {warning}, TX".encode())
    if field == "coordination":
        return body.replace(b"THE HOUSTON /ZHU/", f"THE HOUSTON AND {warning} /ZHU/".encode())
    title = (
        f"261114 SpaceX AND {warning} Recovery Starship 15"
        if field == "operator" else f"261114 SpaceX Recovery Starship 15 AND {warning}"
    )
    return body.replace(b"261114 SpaceX Recovery Starship 15", title.encode())


@pytest.mark.parametrize("warning", WARNINGS)
@pytest.mark.parametrize("strict", (True, False))
def test_uscg_recovery_subject_rejects_complete_operative_clauses(warning: str, strict: bool) -> None:
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(_payload(58204, _uscg_warning(warning)), USCG_URL, strict=strict)


@pytest.mark.parametrize("warning", WARNINGS)
@pytest.mark.parametrize("field", ("location", "coordination", "operator", "vehicle"))
def test_faa_recovery_subject_rejects_complete_operative_clauses(warning: str, field: str) -> None:
    name = "faa-tfr-6-7131.xml"
    changed = _faa_warning(name, warning, field)
    assert changed != (fx.NOTICES / name).read_bytes()
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(changed, fx.manifest(name)["source_url"])


@pytest.mark.parametrize("marker", (
    "ROCKET", "BOOSTER", "SATELLITE", "STAGE", "SPACECRAFT", "AIRCRAFT", "AERIAL", "ORBITAL", "FLIGHT",
))
@pytest.mark.parametrize("source", ("uscg", "faa"))
def test_metadata_subject_uses_complete_source_relevance_vocabulary(marker: str, source: str) -> None:
    warning = marker + " DANGER"
    if source == "uscg":
        with pytest.raises(NoticeError, match="^USCG_ROW$"):
            parse_uscg_space_operations(_payload(58204, _uscg_warning(warning)), USCG_URL)
    else:
        name = "faa-tfr-6-7131.xml"
        with pytest.raises(NoticeError, match="^FAA_ROW$"):
            parse_faa_tfr(_faa_warning(name, warning, "location"), fx.manifest(name)["source_url"])


@pytest.mark.parametrize("source", ("uscg", "faa"))
@pytest.mark.parametrize("warning", WARNINGS[:2])
def test_operative_metadata_retains_last_good_publication(
    tmp_path: Path, source: str, warning: str,
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
    if source == "uscg":
        web.pages[USCG_URL] = _payload(58067, _uscg_warning(warning))
    else:
        web.pages[FAA_URL] = _faa_warning("faa-tfr-6-7129.xml", warning, "location")

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


@pytest.mark.parametrize(("uid", "old", "new"), (
    (58119, "Space X CRS-35 reentry", "SPACEX CRS-35 reentry"),
    (58119, "Space X CRS-35 reentry", "SPACE X CRS-35 launch vehicle reentry"),
    (58204, "Starship reentry and landing", "STARSHIP FLIGHT 16 reentry and landing"),
    (58306, "for the reentry and landing on", "for the launch vehicle reentry and landing on"),
))
def test_supported_vehicle_entity_phrases_remain_recovery(uid: int, old: str, new: str) -> None:
    description = fx.uscg_description(uid)
    assert old in description
    (notice,) = parse_uscg_space_operations(_payload(uid, description.replace(old, new)), USCG_URL)
    assert notice.kind == "recovery"
    assert notice.problems == ()


@pytest.mark.parametrize("name", ("VANDENBERG SPACE FORCE BASE, CA", "PACIFIC SPACEPORT COMPLEX - ALASKA, AK"))
def test_supported_institution_location_names_remain_launches(name: str) -> None:
    body = (Path(__file__).parent / "fixtures/hazards_r3/faa-vandenberg.xml").read_bytes()
    body = body.replace(b"VANDENBERG SPACE FORCE BASE, CA", name.encode())
    notice = parse_faa_tfr(body, "fixture")
    assert notice.kind == "launch"
    assert notice.problems == ()
