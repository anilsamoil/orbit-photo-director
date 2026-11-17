from __future__ import annotations

from pathlib import Path
from xml.sax.saxutils import escape

import pytest

from generator.hazard_match import Sighting, build_bundle, validate_bundle
from generator.hazard_notices import (
    Notice,
    NoticeError,
    notice_from_record,
    notice_record,
    parse_faa_tfr,
    parse_uscg_space_operations,
)
from generator.hazard_sources import (
    FAA_DETAIL_URL,
    SourceError,
    refresh_sources,
    sightings_from_state,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_r10_match import AVOID_THREE_HOURS
from tests.test_hazard_r11_warnings import USCG_URL, _uscg_payload, _with_advice
from tests.test_hazard_refresh import NOW, Web

CONTACT = (
    "For additional information regarding the launch, mariners can contact the U.S. Coast Guard "
    "Sector Corpus Christi Command Center at (361) 939-0450 or access: www.navcen.uscg.gov/msi"
)
VESSEL_AVOIDANCE = (
    "Vessels should operate in a heightened state of awareness during the launch time and avoid "
    "all waters within rocket flight trajectories originating from the launch site near Boca "
    "Chica/Starbase, Texas, and extending across the Gulf of America."
)
FAA_URL = FAA_DETAIL_URL.format(year="6", sequence="7129")
FAA_RESTRICTION = (
    "SPACE OPS AREA: ACFT OPS ARE PROHIBITIED. EXCLUDING AIRSPACE OVER INTERNATIONAL WATERS."
)
FAA_AVOIDANCE = (
    "AIRCRAFT MUST AVOID THIS AREA FOR THREE HOURS BEFORE THE PUBLISHED START TIME."
)


def _faa_payload(*paragraphs: str) -> bytes:
    body = (fx.NOTICES / "faa-tfr-6-7129.xml").read_text()
    start = body.index("<txtInstr>") + len("<txtInstr>")
    end = body.index("</txtInstr>", start)
    return (body[:start] + escape("\n\n".join(paragraphs)) + body[end:]).encode()


def _published_instructions(notice: Notice) -> list[str]:
    restored = notice_from_record(notice_record(notice))
    bundle, _ = build_bundle([fx.item(fx.STARSHIP)], [Sighting(restored, NOW)], NOW)
    validate_bundle(bundle)
    return [
        instruction
        for row in fx.launch(bundle, fx.STARSHIP)["notices"]
        for instruction in row["instructions"]
    ]


@pytest.mark.parametrize("vessel_variant", (False, True))
def test_supported_uscg_clauses_cannot_hide_later_avoidance(vessel_variant: bool) -> None:
    description = (
        fx.uscg_description(58067).replace(AVOID_THREE_HOURS, CONTACT + "\n" + VESSEL_AVOIDANCE)
        if vessel_variant else _with_advice(CONTACT, CONTACT)
    )
    payload = _uscg_payload(description)
    notice = next(
        row for row in parse_uscg_space_operations(payload, USCG_URL, strict=True)
        if row.notice_id == "USCG LNM 58067"
    )
    assert notice.problems == ()
    published = _published_instructions(notice)
    assert (VESSEL_AVOIDANCE if vessel_variant else AVOID_THREE_HOURS) in published


def test_overlength_uscg_instruction_is_retained_with_a_diagnostic() -> None:
    instruction = "Mariners must avoid " + "these hazardous waters " * 20 + "during launch."
    payload = _uscg_payload(fx.uscg_description(58067).replace(
        AVOID_THREE_HOURS, "\n" + instruction + "\n" + AVOID_THREE_HOURS,
    ))
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(payload, USCG_URL, strict=True)
    notice = next(
        row for row in parse_uscg_space_operations(payload, USCG_URL, strict=False)
        if row.notice_id == "USCG LNM 58067"
    )
    assert "INSTRUCTION_TOO_LONG:HIGH RISK" in notice.problems
    assert "INSTRUCTION_TOO_LONG:HAZARD" in notice.problems
    assert all(instruction in area.instructions for area in notice.areas)


@pytest.mark.parametrize("strict", (True, False))
def test_overlength_uscg_contact_name_fails_closed(strict: bool) -> None:
    instruction = (
        "For more details or comments contact AVOID " + "WATERS " * 60
        + "at OPS@EXAMPLE.COM or on VHF-FM Chan. 16 or 22."
    )
    payload = _uscg_payload(_with_advice(instruction))
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(payload, USCG_URL, strict=strict)


@pytest.mark.parametrize("before", (False, True))
def test_every_faa_operative_paragraph_survives_cache_and_bundle(before: bool) -> None:
    paragraphs = (FAA_AVOIDANCE, FAA_RESTRICTION) if before else (FAA_RESTRICTION, FAA_AVOIDANCE)
    notice = parse_faa_tfr(_faa_payload(*paragraphs), FAA_URL)
    assert notice.problems == ()
    assert notice.areas[0].instructions == ("SFC-UNL.", *paragraphs)
    assert _published_instructions(notice) == ["SFC-UNL.", *paragraphs]


@pytest.mark.parametrize("paragraphs", (
    (FAA_RESTRICTION, "UNSUPPORTED ADDITIONAL OPERATING CONDITION."),
    (FAA_RESTRICTION, FAA_AVOIDANCE, FAA_AVOIDANCE, FAA_AVOIDANCE),
    (FAA_RESTRICTION, "AIRCRAFT MUST AVOID " + "THE AREA " * 50 + "DURING LAUNCH."),
    (FAA_RESTRICTION, " ".join([FAA_AVOIDANCE] * 6)),
))
def test_unsupported_or_overflowing_faa_instructions_fail_confirmation(
    tmp_path: Path, paragraphs: tuple[str, ...],
) -> None:
    web = Web(complete=True)
    web.pages[FAA_URL] = _faa_payload(*paragraphs)
    sources = refresh_sources(tmp_path / "cache", NOW, fetch=web, pause=lambda _: None)
    assert sources["faa"]["error"] == "FAA_ROW"
    assert "notices" not in sources["faa"]
    with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
        sightings_from_state(sources, NOW)


@pytest.mark.parametrize("uid", (
    58114, 58116, 58119, 58120, 58121, 58122, 58123, 58124, 58125, 58126, 58127, 58204,
))
def test_recovery_bodies_keep_baseline_diagnostics(uid: int) -> None:
    notice = fx.uscg_notice(uid)
    assert notice.kind == "recovery"
    assert notice.areas == ()
    assert notice.problems == ()
    assert notice_record(notice)["problems"] == []
