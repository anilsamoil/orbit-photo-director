from __future__ import annotations

import json
from pathlib import Path

import pytest

from generator.hazard_match import Sighting, build_bundle, validate_bundle
from generator.hazard_notices import NoticeError, parse_uscg_space_operations
from generator.hazard_sources import (
    NGA_URL,
    USCG_FILE_URL,
    refresh_sources,
    sightings_from_state,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_r5_relevance import _retains_publication
from tests.test_hazard_r10_match import (
    AVOID_LAUNCH_WINDOW,
    AVOID_THREE_HOURS,
    _ordinary_headings,
)
from tests.test_hazard_refresh import NOW, Web

REMAIN_CLEAR = (
    "Mariners are advised to remain clear of these areas for the duration of operations."
)
AVOID_SPECIFIED_TIMES = (
    "Surface vessels are strongly advised to avoid this area defined during specified dates / times."
)
STRONGLY_REMAIN_CLEAR = (
    "Mariners are strongly advised to remain clear of these areas for the duration of operations."
)
USCG_URL = USCG_FILE_URL.format(part=1)


def _uscg_payload(description: str, alias_description: str | None = None) -> bytes:
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    feature = next(
        row for row in payload["features"] if row["properties"]["MSI_UID"] == 58067
    )
    feature["properties"]["DESCRIPTION"] = description
    if alias_description is not None:
        alias = json.loads(json.dumps(feature))
        alias["properties"].update(MSI_UID=58068, DESCRIPTION=alias_description)
        payload["features"].append(alias)
    return json.dumps(payload).encode()


def _with_advice(*sentences: str) -> str:
    description = fx.uscg_description(58067)
    assert description.count(AVOID_THREE_HOURS) == 1
    return description.replace(AVOID_THREE_HOURS, "\n".join((*sentences, AVOID_THREE_HOURS)))


def _confirmed(tmp_path: Path, payload: bytes) -> list[Sighting]:
    web = Web(complete=True)
    _, issued, text = fx.broadcast_blocks("navarea-iv-1080-26.txt")[0]
    web.pages[NGA_URL.format(area="4")] = json.dumps({"broadcast-warn": [{
        "navArea": "4", "msgNumber": 1080, "msgYear": 2026, "text": text,
        "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(),
    }]}).encode()
    web.pages[USCG_URL] = payload
    sources = refresh_sources(tmp_path / "cache", NOW, fetch=web, pause=lambda _: None)
    assert sources["uscg"]["error"] is None
    assert sources["nga:4"]["error"] is None
    sightings = [
        sighting for sighting in sightings_from_state(sources, NOW)
        if sighting.notice.notice_id in {
            "NAVAREA IV 1080/26", "USCG LNM 58067", "USCG LNM 58068",
        }
    ]
    assert all(sighting.notice.kind == "launch" and not sighting.notice.problems for sighting in sightings)
    return sightings


def _bundle(sightings: list[Sighting]) -> dict:
    bundle, _ = build_bundle([fx.item(fx.STARSHIP)], sightings, NOW)
    validate_bundle(bundle)
    return fx.launch(bundle, fx.STARSHIP)


@pytest.mark.parametrize("difference", ("restriction_class", "instructions"))
@pytest.mark.parametrize("reverse_input", (False, True))
def test_nga_first_uscg_fill_keeps_later_differing_warnings_separate(
    tmp_path: Path, difference: str, reverse_input: bool,
) -> None:
    description = fx.uscg_description(58067)
    alias = (
        _ordinary_headings(description) if difference == "restriction_class"
        else description.replace(AVOID_THREE_HOURS, "")
    )
    sightings = _confirmed(tmp_path, _uscg_payload(description, alias))
    assert {sighting.notice.notice_id for sighting in sightings} == {
        "NAVAREA IV 1080/26", "USCG LNM 58067", "USCG LNM 58068",
    }
    if reverse_input:
        sightings.reverse()
    entry = _bundle(sightings)
    enriched = next(row for row in entry["notices"] if row["area_id"] == "B")
    assert enriched["notice_id"] == "NAVAREA IV 1080/26"
    assert enriched["restriction_class"] == "high_risk"
    assert enriched["instructions"] == [AVOID_LAUNCH_WINDOW, AVOID_THREE_HOURS]
    original = next(sighting.notice for sighting in sightings if sighting.notice.notice_id == "USCG LNM 58067")
    assert enriched["cross_check_sha256"] == original.source_sha256
    separate = [row for row in entry["notices"] if row["notice_id"] == "USCG LNM 58068"]
    assert len(separate) == 1
    assert separate[0]["area_id"] == ("A" if difference == "restriction_class" else "HIGH RISK")
    assert separate[0]["restriction_class"] == ("hazard" if difference == "restriction_class" else "high_risk")
    assert separate[0]["instructions"] == [AVOID_LAUNCH_WINDOW]
    assert any(
        feature["properties"]["notice_id"] == "USCG LNM 58068"
        for feature in entry["geojson"]["features"]
    )


def test_four_applicable_uscg_instructions_survive_strict_confirmation_and_bundle(
    tmp_path: Path,
) -> None:
    payload = _uscg_payload(_with_advice(REMAIN_CLEAR, AVOID_SPECIFIED_TIMES))
    notices = parse_uscg_space_operations(payload, USCG_URL, strict=True)
    notice = next(row for row in notices if row.notice_id == "USCG LNM 58067")
    assert notice.problems == ()
    high, hazard = notice.areas
    expected = (AVOID_LAUNCH_WINDOW, REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, AVOID_THREE_HOURS)
    assert high.instructions == expected
    assert hazard.instructions == expected[:-1]
    entry = _bundle(_confirmed(tmp_path, payload))
    enriched = next(row for row in entry["notices"] if row["area_id"] == "B")
    assert enriched["restriction_class"] == "high_risk"
    assert enriched["instructions"] == list(expected)


def test_uscg_instruction_limit_applies_after_area_filtering() -> None:
    description = _ordinary_headings(_with_advice(
        REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, STRONGLY_REMAIN_CLEAR,
    ))
    notices = parse_uscg_space_operations(_uscg_payload(description), USCG_URL, strict=True)
    notice = next(row for row in notices if row.notice_id == "USCG LNM 58067")
    assert notice.problems == ()
    assert all(area.instructions == (
        AVOID_LAUNCH_WINDOW, REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, STRONGLY_REMAIN_CLEAR,
    ) for area in notice.areas)


def test_five_applicable_uscg_instructions_fail_strictly() -> None:
    payload = _uscg_payload(_with_advice(
        REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, STRONGLY_REMAIN_CLEAR,
    ))
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(payload, USCG_URL, strict=True)


def test_five_applicable_uscg_instructions_have_non_strict_diagnostic() -> None:
    payload = _uscg_payload(_with_advice(
        REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, STRONGLY_REMAIN_CLEAR,
    ))
    notices = parse_uscg_space_operations(payload, USCG_URL, strict=False)
    notice = next(row for row in notices if row.notice_id == "USCG LNM 58067")
    assert "INSTRUCTIONS_OVERFLOW:HIGH RISK" in notice.problems
    high = next(area for area in notice.areas if area.area_id == "HIGH RISK")
    assert high.instructions == (
        AVOID_LAUNCH_WINDOW, REMAIN_CLEAR, AVOID_SPECIFIED_TIMES,
        STRONGLY_REMAIN_CLEAR, AVOID_THREE_HOURS,
    )


def test_uscg_instruction_overflow_preserves_warm_artifact_receipt_and_uploads(
    tmp_path: Path,
) -> None:
    _retains_publication(
        tmp_path, "uscg", USCG_URL,
        _uscg_payload(fx.uscg_description(58067)),
        _uscg_payload(_with_advice(
            REMAIN_CLEAR, AVOID_SPECIFIED_TIMES, STRONGLY_REMAIN_CLEAR,
        )),
        "USCG LNM 58067",
    )
