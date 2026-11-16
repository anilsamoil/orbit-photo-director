from __future__ import annotations

import json
import re
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_faa_tfr
from generator.hazard_sources import STATE_NAME, refresh_sources
from scripts.hazard_refresh import (
    ARTIFACT,
    PUBLICATION_RECEIPT,
    PublicationTarget,
    refresh_hazards,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_r7_coverage import _publish_catalog
from tests.test_hazard_r12_parsers import (
    FAA_AVOIDANCE,
    FAA_RESTRICTION,
    FAA_URL,
    _faa_payload,
)
from tests.test_hazard_refresh import NOW, Web


def _uas_boilerplate() -> str:
    text = (fx.NOTICES / "faa-tfr-6-7129.xml").read_text()
    start = text.index("<txtInstr>") + len("<txtInstr>")
    end = text.index("</txtInstr>", start)
    instructions = " ".join(text[start:end].split())
    return instructions.removeprefix(FAA_RESTRICTION + " ")


def _missing_faa_restriction(case: str) -> bytes:
    if case == "missing-group":
        return re.sub(
            rb"<InstructionsGroup>.*?</InstructionsGroup>", b"",
            (fx.NOTICES / "faa-tfr-6-7129.xml").read_bytes(), flags=re.S,
        )
    if case == "boilerplate-only":
        return _faa_payload(_uas_boilerplate())
    if case == "missing-prohibition":
        return _faa_payload("EXCLUDING AIRSPACE OVER INTERNATIONAL WATERS.")
    return _faa_payload("SPACE OPS AREA: ACFT OPS ARE PROHIBITIED.")


@pytest.mark.parametrize("case", (
    "missing-group", "boilerplate-only", "missing-prohibition", "missing-maritime-limit",
))
def test_faa_narrative_restrictions_must_be_present_in_instructions(case: str) -> None:
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(_missing_faa_restriction(case), FAA_URL)


@pytest.mark.parametrize("case", ("missing-group", "boilerplate-only"))
def test_faa_missing_narrative_warning_keeps_last_good_publication(
    tmp_path: Path, case: str,
) -> None:
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
    web.pages[FAA_URL] = _missing_faa_restriction(case)

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


def test_faa_boilerplate_with_same_paragraph_avoidance_is_never_skipped() -> None:
    body = _faa_payload(FAA_RESTRICTION, _uas_boilerplate() + " " + FAA_AVOIDANCE)
    try:
        notice = parse_faa_tfr(body, FAA_URL)
    except NoticeError as exc:
        assert str(exc) == "FAA_ROW"
    else:
        assert any(FAA_AVOIDANCE in instruction for area in notice.areas for instruction in area.instructions)


@pytest.mark.parametrize("name", fx.FAA)
def test_faa_captured_narrative_equivalents_keep_exact_instruction_strings(name: str) -> None:
    expected = (
        ("EXCLUDING AIRSPACE BEYOND 12 MILE COASTAL LIMIT OVER INTERNATIONAL WATERS.",)
        if name in {"faa-tfr-6-7111.xml", "faa-tfr-6-7112.xml"}
        else (FAA_RESTRICTION,)
    )
    notice = parse_faa_tfr((fx.NOTICES / name).read_bytes(), fx.manifest(name)["source_url"])
    assert notice.problems == ()
    assert notice.areas[0].instructions[1:] == expected


@pytest.mark.parametrize("name", (
    "261114 SpaceX Launch Recovery Starship 15",
    "261114 SpaceX Recovery Starship 15 Launch",
    "261114 SpaceX Recovery Starship 15 Landing and Launch",
))
def test_faa_recovery_title_cannot_hide_launch_operation_words(name: str) -> None:
    body = (fx.NOTICES / "faa-tfr-6-7131.xml").read_bytes().replace(
        b"261114 SpaceX Recovery Starship 15", name.encode(),
    )
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(body, fx.manifest("faa-tfr-6-7131.xml")["source_url"])


def test_faa_recovery_narrative_cannot_hide_an_appended_launch_area() -> None:
    body = (fx.NOTICES / "faa-tfr-6-7131.xml").read_bytes().replace(
        b"</txtDescrUSNS>",
        b" HAZARD AREA FOR LAUNCH OPERATIONS: 255600N0971000W TO 260100N0971200W "
        b"TO 260400N0970700W FROM 2611142230 TO 2611150040. "
        b"AIRCRAFT MUST AVOID THIS AREA FOR THREE HOURS BEFORE THE PUBLISHED START TIME.</txtDescrUSNS>",
    )
    with pytest.raises(NoticeError, match="^FAA_ROW$"):
        parse_faa_tfr(body, fx.manifest("faa-tfr-6-7131.xml")["source_url"])


def test_faa_space_list_detail_cannot_downgrade_to_a_nonspace_kind(tmp_path: Path) -> None:
    web = Web(complete=True)
    web.pages[FAA_URL] = web.pages[FAA_URL].replace(
        b"<codeType>91.143</codeType>", b"<codeType>91.137</codeType>",
    )
    sources = refresh_sources(tmp_path / "cache", NOW, fetch=web, pause=lambda _: None)
    assert sources["faa"]["error"] == "FAA_ROW"
    assert "notices" not in sources["faa"]
