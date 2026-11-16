from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Literal

import pytest

from generator.hazard_notices import NoticeError, parse_faa_tfr, parse_uscg_space_operations
from generator.hazard_sources import STATE_NAME, refresh_sources
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_r7_coverage import _publish_catalog
from tests.test_hazard_r12_parsers import FAA_URL
from tests.test_hazard_r13_uscg import USCG_URL, _payload
from tests.test_hazard_refresh import NOW, Web

Source = Literal["uscg", "faa"]
USCG_CONTACT_WARNING = (
    "For more details or comments contact MARINERS MUST STAY OUT FOR SIX HOURS PRIOR TO LAUNCH "
    "at OPS@EXAMPLE.COM or on VHF-FM Chan. 16 or 22."
)
FAA_WARNINGS = (
    "ACFT OPS ARE RESTRICTED FOR THREE HOURS BEFORE THE PUBLISHED START TIME",
    "ACFT OPS ARE BANNED FOR THREE HOURS BEFORE THE PUBLISHED START TIME",
    "ACFT LEAVE THIS AREA THREE HOURS BEFORE THE PUBLISHED START TIME",
)


def _r14_body(source: Source, warning: str) -> bytes:
    if source == "uscg":
        return _payload(58067, fx.uscg_description(58067) + "\n" + warning)
    return (fx.NOTICES / "faa-tfr-6-7129.xml").read_bytes().replace(
        b"AIRSPACE STARBASE, TX", f"AIRSPACE STARBASE AND {warning}, TX".encode(),
    )


@pytest.mark.parametrize("strict", (True, False))
def test_r14_uscg_contact_warning_fails_closed_in_both_modes(strict: bool) -> None:
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(_r14_body("uscg", USCG_CONTACT_WARNING), USCG_URL, strict=strict)


@pytest.mark.parametrize("warning", FAA_WARNINGS)
def test_r14_faa_location_restrictions_fail_closed(warning: str) -> None:
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(_r14_body("faa", warning), FAA_URL)


@pytest.mark.parametrize(("source", "warning"), (
    ("uscg", USCG_CONTACT_WARNING),
    *(("faa", warning) for warning in FAA_WARNINGS),
))
def test_r14_metadata_failure_keeps_last_good_publication(
    tmp_path: Path, source: Source, warning: str,
) -> None:
    web = Web(complete=True)
    if source == "uscg":
        web.pages[USCG_URL] = _payload(58067, fx.uscg_description(58067))
    output, cache = tmp_path / "output", tmp_path / "cache"
    items = fx.catalog_items()
    next(item for item in items if item["event_id"] == fx.STARSHIP)["schedule"]["window_end"] = (
        "2026-11-14T00:30:00Z"
    )
    _publish_catalog(output, items)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    first = refresh_hazards(cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication)
    assert first["ok"] and first["published"]
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    web.pages[USCG_URL if source == "uscg" else FAA_URL] = _r14_body(source, warning)

    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )

    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    assert after["error"] == ("USCG_ROW" if source == "uscg" else "FAA_ROW")
    assert after["notices"] == before["notices"]
    assert after["checked_at"] == before["checked_at"]
    assert (report["ok"], report["degraded"], report["written"], report["published"]) == (
        False, True, False, False,
    )
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]


@pytest.mark.parametrize("uid", (58114, 58116, *range(58119, 58128), 58204, 58306))
def test_r14_real_recovery_rows_keep_empty_diagnostics(uid: int) -> None:
    notice = fx.uscg_notice(uid)
    assert (notice.kind, notice.areas, notice.problems) == ("recovery", (), ())


@dataclass(frozen=True)
class MetadataField:
    name: str
    source: Source
    fixture: int | str
    original: str
    replacement: str
    appended: str = ""
    baseline_replacement: tuple[str, str] | None = None
    baseline_problems: tuple[str, ...] = ()
    confirmation_only: bool = False


OPERATIVE = "ACFT OPS ARE RESTRICTED FOR THREE HOURS BEFORE THE PUBLISHED START TIME"
CONTACT = (
    "For more details or comments contact Space X at OPS@EXAMPLE.COM, 805-606-8825, "
    "or on VHF-FM Chan. 05, 06 or 16."
)
ROPS_CONTACT = (
    "For more details or comments contact 2 ROPS/DOS via telephone at commercial "
    "805-606-8825 or DSN 276-8825, or email: OPS@EXAMPLE.COM."
)

METADATA_FIELDS = (
    MetadataField("launch-section-vehicle", "uscg", 58224, "FOR VULCAN KV-01:",
                  f"for Vulcan KV-01 AND {OPERATIVE}:"),
    MetadataField("launch-intro-western-range", "uscg", 57935, "Western Range Operation W6407",
                  f"Western Range Operation {OPERATIVE}"),
    MetadataField("launch-intro-r-mission", "uscg", 58217, "Space X, R-6 Launch Operations",
                  f"Space X, {OPERATIVE} launch operations"),
    MetadataField("launch-intro-th-mission", "uscg", 58218, "Space X, TH-3",
                  f"Space X, {OPERATIVE}"),
    MetadataField("launch-intro-operation", "uscg", 58219, "INGRID operation", f"{OPERATIVE} operation",
                  baseline_problems=("WINDOW_UNPARSED:221400Z NOV TO 242000Z NOV 2026",)),
    MetadataField("regulated-contact-hotline", "uscg", 58224,
                  "LAUNCH INFORMATION HOTLINE AT 1-800-470-7232.",
                  f"LAUNCH INFORMATION HOTLINE AT {OPERATIVE}."),
    MetadataField("launch-advice-hotline", "uscg", 58224,
                  "INFORMATION HOTLINE AT 1-800-470-7232 OR BY VISITING",
                  f"INFORMATION HOTLINE AT {OPERATIVE} OR BY VISITING"),
    MetadataField("recovery-prefix-vehicle", "uscg", 58114, "of the Starship-Super Heavy Starship",
                  f"of {OPERATIVE} the Starship-Super Heavy Starship"),
    MetadataField("recovery-first-month", "uscg", 58114, "from November 14", f"from {OPERATIVE} 14"),
    MetadataField("recovery-last-month", "uscg", 58114, "to November 21", f"to {OPERATIVE} 21"),
    MetadataField("recovery-local-zone", "uscg", 58114, "1544 HST", f"1544 {OPERATIVE}"),
    MetadataField("recovery-utc-zone", "uscg", 58114, "0144 UTC", f"0144 {OPERATIVE}"),
    MetadataField("recovery-capsule", "uscg", 58119, "for Space X CRS-35 reentry",
                  f"for Space X CRS-35 AND {OPERATIVE} reentry"),
    MetadataField("recovery-capsule-ocean", "uscg", 58119, "Pacific Ocean", f"Pacific AND {OPERATIVE} Ocean"),
    MetadataField("recovery-trunk", "uscg", 58127, "for SpaceX CRS- 35 reentry",
                  f"for SpaceX CRS- 35 AND {OPERATIVE} reentry"),
    MetadataField("recovery-trunk-ocean", "uscg", 58127, "Pacific Ocean", f"Pacific AND {OPERATIVE} Ocean"),
    MetadataField("recovery-vehicle", "uscg", 58204, "for Starship Flight 15:",
                  f"for Starship Flight 15 AND {OPERATIVE}:"),
    MetadataField("recovery-return-subject", "uscg", 58204, "Starship reentry and landing will",
                  f"Starship AND {OPERATIVE} reentry and landing will"),
    MetadataField("recovery-return-vehicle", "uscg", 58204, "landing of Starship will",
                  f"landing of Starship AND {OPERATIVE} will", baseline_replacement=(
                      "Starship reentry and landing will", "The reentry and landing of Starship will",
                  )),
    MetadataField("recovery-initial-vehicle", "uscg", 58204, "initial Starship Flight 15 launch",
                  f"initial Starship Flight 15 AND {OPERATIVE} launch"),
    MetadataField("recovery-landing-vehicle", "uscg", 58204, "primary Starship vehicle",
                  f"primary Starship AND {OPERATIVE} vehicle"),
    MetadataField("recovery-landing-site", "uscg", 58204, "area is Starbase Tower 2,",
                  f"area is Starbase Tower 2 AND {OPERATIVE},"),
    MetadataField("recovery-contact-name", "uscg", 58119, "contact Space X at",
                  f"contact {OPERATIVE} at"),
    MetadataField("recovery-contact-email", "uscg", 58119, "regulatory@spacex.com", OPERATIVE),
    MetadataField("recovery-contact-channel", "uscg", 58119, "Chan. 05, 06 or 16", f"Chan. {OPERATIVE}"),
    MetadataField("recovery-contact-sector", "uscg", 58204, "Sector Corpus Christi Command",
                  f"Sector Corpus Christi AND {OPERATIVE} Command"),
    MetadataField("zone-port", "uscg", 58306, "Port Corpus Christi is", f"Port {OPERATIVE} is"),
    MetadataField("zone-sector", "uscg", 58306, "Sector Corpus Christi Command",
                  f"Sector {OPERATIVE} Command"),
    MetadataField("zone-location", "uscg", 58306, "Zone in portions of the Gulf",
                  f"Zone in {OPERATIVE} portions of the Gulf"),
    MetadataField("zone-reentry-vehicle", "uscg", 58306, "landing of Starship Flight 15 will",
                  f"landing of Starship Flight 15 AND {OPERATIVE} will"),
    MetadataField("zone-activity", "uscg", 58306, "for the reentry and landing on",
                  f"for the {OPERATIVE} reentry and landing on"),
    MetadataField("zone-activity-vehicle", "uscg", 58298, "for the Starship Flight 15 launch on",
                  f"for the Starship Flight 15 AND {OPERATIVE} launch on"),
    MetadataField("zone-boundary-place", "uscg", 58298, "waters of South Bay,",
                  f"waters of South Bay AND {OPERATIVE},"),
    MetadataField("zone-boundary-coastline", "uscg", 58298, "the South Bay internal coastline",
                  f"the South Bay AND {OPERATIVE} internal coastline"),
    MetadataField("launch-contact-name", "uscg", 58067, "contact Space X at",
                  f"contact {OPERATIVE} at", CONTACT),
    MetadataField("launch-contact-email", "uscg", 58067, "OPS@EXAMPLE.COM", OPERATIVE, CONTACT),
    MetadataField("launch-contact-phone", "uscg", 58067, "805-606-8825", OPERATIVE, CONTACT),
    MetadataField("launch-contact-channel", "uscg", 58067, "Chan. 05, 06 or 16",
                  f"Chan. {OPERATIVE}", CONTACT),
    MetadataField("launch-commercial-phone", "uscg", 58067, "805-606-8825", OPERATIVE, ROPS_CONTACT),
    MetadataField("launch-dsn-phone", "uscg", 58067, "276-8825", OPERATIVE, ROPS_CONTACT),
    MetadataField("launch-rops-email", "uscg", 58067, "OPS@EXAMPLE.COM", OPERATIVE, ROPS_CONTACT),
    MetadataField("launch-contact-url", "uscg", 58067, "www.navcen.uscg.gov/msi", OPERATIVE,
                  "For additional information regarding the launch, mariners can contact the U.S. Coast Guard "
                  "Sector Corpus Christi Command Center at (361) 939-0450 or access: www.navcen.uscg.gov/msi"),
    MetadataField("faa-location", "faa", "faa-tfr-6-7129.xml", "AIRSPACE STARBASE, TX",
                  f"AIRSPACE STARBASE AND {OPERATIVE}, TX"),
    MetadataField("faa-coordination", "faa", "faa-tfr-6-7129.xml", "THE HOUSTON /ZHU/",
                  f"THE HOUSTON AND {OPERATIVE} /ZHU/"),
    MetadataField("faa-operator", "faa", "faa-tfr-6-7131.xml", "SpaceX Recovery",
                  f"SpaceX AND {OPERATIVE} Recovery"),
    MetadataField("faa-recovery-vehicle", "faa", "faa-tfr-6-7131.xml", "Recovery Starship 15",
                  f"Recovery Starship 15 AND {OPERATIVE}"),
    MetadataField("faa-launch-title", "faa", "faa-tfr-6-7129.xml", "Launch Starship 15",
                  f"Launch Starship 15 AND {OPERATIVE}"),
    MetadataField("faa-coordination-name", "faa", "faa-tfr-6-7129.xml",
                  "<txtNameCoordFacility>HOUSTON</txtNameCoordFacility>",
                  f"<txtNameCoordFacility>HOUSTON AND {OPERATIVE}</txtNameCoordFacility>"),
    MetadataField("faa-coordination-phone", "faa", "faa-tfr-6-7129.xml",
                  "<txtAddrCoordPhone>281-230-5560</txtAddrCoordPhone>",
                  f"<txtAddrCoordPhone>{OPERATIVE}</txtAddrCoordPhone>"),
    MetadataField("faa-narrative-phone", "faa", "faa-tfr-6-7129.xml", "TEL 281-230-5560",
                  f"TEL {OPERATIVE}", confirmation_only=True),
    MetadataField("faa-area-name", "faa", "faa-tfr-6-7129.xml", "<txtName>Area A</txtName>",
                  f"<txtName>Area A AND {OPERATIVE}</txtName>"),
)


@pytest.mark.parametrize("field", METADATA_FIELDS, ids=lambda field: field.name)
def test_r14_every_metadata_field_rejects_operative_prose(field: MetadataField, tmp_path: Path) -> None:
    if field.source == "uscg":
        assert isinstance(field.fixture, int)
        description = fx.uscg_description(field.fixture)
        if field.baseline_replacement:
            old, new = field.baseline_replacement
            assert old in description
            description = description.replace(old, new)
        if field.appended:
            description += "\n" + field.appended
        assert field.original in description
        (baseline,) = parse_uscg_space_operations(_payload(field.fixture, description), USCG_URL)
        assert baseline.problems == field.baseline_problems
        with pytest.raises(NoticeError, match="^USCG_ROW$"):
            parse_uscg_space_operations(
                _payload(field.fixture, description.replace(field.original, field.replacement)), USCG_URL,
            )
    else:
        assert isinstance(field.fixture, str)
        body = (fx.NOTICES / field.fixture).read_bytes()
        assert field.original.encode() in body
        assert parse_faa_tfr(body, FAA_URL).problems == ()
        damaged = body.replace(field.original.encode(), field.replacement.encode())
        if field.confirmation_only:
            assert parse_faa_tfr(damaged, FAA_URL).problems == ("NARRATIVE_UNPARSED",)
            web = Web(complete=True)
            web.pages[FAA_URL] = body
            before = refresh_sources(tmp_path, NOW, fetch=web, pause=lambda _: None)["faa"]
            assert before["error"] is None
            web.pages[FAA_URL] = damaged
            after = refresh_sources(
                tmp_path, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
            )["faa"]
            assert after["error"] == "FAA_ROW"
            assert after["notices"] == before["notices"]
            assert after["checked_at"] == before["checked_at"]
        else:
            with pytest.raises(NoticeError, match="^FAA_ROW$"):
                parse_faa_tfr(damaged, FAA_URL)


@pytest.mark.parametrize("address", ("LAUNCH@spacex.com", "OPS+PUBLIC@EXAMPLE.COM", "range.ops@example.com"))
def test_r14_complete_email_shapes_remain_contact_metadata(address: str) -> None:
    description = fx.uscg_description(58119).replace("regulatory@spacex.com", address)
    (notice,) = parse_uscg_space_operations(_payload(58119, description), USCG_URL)
    assert (notice.kind, notice.areas, notice.problems) == ("recovery", (), ())
