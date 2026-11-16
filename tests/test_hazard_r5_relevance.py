from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_nga_payload, parse_uscg_space_operations
from generator.hazard_sources import NGA_URL, STATE_NAME, USCG_FILE_URL
from scripts.hazard_refresh import (
    ARTIFACT,
    PUBLICATION_RECEIPT,
    RUN_LOG,
    PublicationTarget,
    refresh_hazards,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web, _output
from tests.test_hazard_relevance import _payload, _xii_rows


def _iv_row(number: int) -> dict:
    rows = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    return next(row for row in rows if row["msgNumber"] == number)


def _retains_publication(
    tmp_path: Path, source: str, url: str, original: bytes, damaged: bytes,
    notice_id: str,
) -> None:
    web = Web(complete=True)
    web.pages[url] = original
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget(
        "offline:test", lambda path, *_: uploads.append(path.read_bytes()),
    )
    first = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    assert first["ok"] and first["published"]
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    assert notice_id in {notice["notice_id"] for notice in before["notices"]}
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    web.pages[url] = damaged

    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )

    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    assert after["error"] == ("USCG_ROW" if source == "uscg" else "NGA_ROW")
    assert after["notices"] == before["notices"]
    assert after["checked_at"] == before["checked_at"]
    assert (report["ok"], report["degraded"], report["written"], report["published"]) == (
        False, True, False, False,
    )
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]
    run = json.loads((output / RUN_LOG).read_bytes())
    assert run["degraded"] and not run["published"]
    assert run["revision"] == json.loads(artifact)["revision"]
    assert notice_id in {decision["notice_id"] for decision in run["decisions"]}


@pytest.mark.parametrize("number", (1231, 1078))
@pytest.mark.parametrize("trim", (0, 1, 2))
def test_truncated_nga_hazard_prefix_retains_warm_publication(
    tmp_path: Path, number: int, trim: int,
) -> None:
    if number == 1231:
        row = _iv_row(number)
    else:
        _, issued, text = fx.broadcast_blocks("navarea-iv-1078-26.txt")[0]
        row = {
            "navArea": "4", "msgNumber": number, "msgYear": 2026, "text": text,
            "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(),
        }
    original = _payload([row])
    row["text"] = row["text"][:row["text"].index("ROCKET") - trim]
    _retains_publication(
        tmp_path, "nga:4", NGA_URL.format(area="4"), original, _payload([row]),
        f"NAVAREA IV {number}/{row['msgYear'] % 100:02d}",
    )


@pytest.mark.parametrize("cut", ("will be conducted", "for Vandenberg", "Vandenberg"))
def test_truncated_approved_uscg_hazard_prefix_retains_warm_publication(
    tmp_path: Path, cut: str,
) -> None:
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    feature = next(row for row in payload["features"] if row["properties"]["MSI_UID"] == 57935)
    payload["features"] = [feature]
    original = json.dumps(payload).encode()
    props = feature["properties"]
    assert (props["STATUS"], props["MSI_GROUP"]) == ("Approved", "Space Operations")
    props["DESCRIPTION"] = props["DESCRIPTION"][:props["DESCRIPTION"].index(cut)]
    _retains_publication(
        tmp_path, "uscg", USCG_FILE_URL.format(part=1), original, json.dumps(payload).encode(),
        "USCG LNM 57935",
    )


@pytest.mark.parametrize("prohibition", ("NAVIGATION PROHIBITED", "ANCHORING PROHIBITED"))
def test_generic_prohibition_cannot_withdraw_a_warm_launch_notice(
    tmp_path: Path, prohibition: str,
) -> None:
    row = _iv_row(1231)
    original = _payload([row])
    row["text"] = "WESTERN NORTH ATLANTIC.\n1. " + prohibition
    _retains_publication(
        tmp_path, "nga:4", NGA_URL.format(area="4"), original, _payload([row]),
        "NAVAREA IV 1231/23",
    )


@pytest.mark.parametrize("advice", (
    "VESSELS MUST KEEP CLEAR.", "MARINERS MUST KEEP CLEAR.",
    "CANCEL THIS MSG 010900Z DEC 26.",
))
def test_generic_later_operation_cannot_use_advice_to_prove_its_cause(
    tmp_path: Path, advice: str,
) -> None:
    row = _iv_row(1231)
    original = _payload([row])
    row["text"] = (
        "1. SCIENTIFIC MOORINGS AT DEPTH 15 METERS.\n"
        f"2. HAZARDOUS OPERATIONS, {advice}\n"
    )
    _retains_publication(
        tmp_path, "nga:4", NGA_URL.format(area="4"), original, _payload([row]),
        "NAVAREA IV 1231/23",
    )


def test_space_launch_delta_prohibition_requires_strict_confirmation() -> None:
    row = _iv_row(329)
    assert row["authority"].startswith("SPACE LAUNCH DELTA")
    (notice,) = parse_nga_payload(_payload([row]), NGA_URL.format(area="4"))
    assert notice.kind == "standing_closure"
    assert [area.area_id for area in notice.areas] == ["A", "B"]
    assert all(not area.windows for area in notice.areas)
    assert notice.valid_until is None and notice.cancels == ("NAVAREA IV 326/23",)


def test_space_authority_conflicts_with_an_otherwise_nonspace_body() -> None:
    row = _iv_row(329)
    row["text"] = "1. SCIENTIFIC MOORINGS AT DEPTH 15 METERS."
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area="4"))


def test_approved_space_group_conflicts_with_an_otherwise_nonspace_body() -> None:
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    feature = next(row for row in payload["features"] if row["properties"]["MSI_UID"] == 57935)
    feature["properties"]["DESCRIPTION"] = "SCIENTIFIC MOORINGS AT DEPTH 15 METERS."
    payload["features"] = [feature]
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(json.dumps(payload).encode(), "https://example.invalid/")


@pytest.mark.parametrize("number", (802, 795, 752, 751, 750))
def test_complete_captured_generic_hazards_are_excluded(number: int) -> None:
    row = next(row for row in _xii_rows() if row["msgNumber"] == number)
    (notice,) = parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))
    assert notice.kind == "other"


@pytest.mark.parametrize("number", (1100, 222))
def test_complete_captured_generic_hazard_or_prohibition_is_excluded(number: int) -> None:
    (notice,) = parse_nga_payload(_payload([_iv_row(number)]), NGA_URL.format(area="4"))
    assert notice.kind == "other"


def test_captured_missile_mooring_and_grounded_vessel_causes_remain_excluded() -> None:
    rows = [row for row in _xii_rows() if row["msgNumber"] in (789, 745, 639)]
    notices = parse_nga_payload(_payload(rows), NGA_URL.format(area="12"))
    notices += parse_nga_payload(_payload([_iv_row(274)]), NGA_URL.format(area="4"))
    assert {notice.notice_id for notice in notices} == {
        "NAVAREA XII 789/26", "NAVAREA XII 745/26", "NAVAREA XII 639/26", "NAVAREA IV 274/23",
    }
    assert all(notice.kind == "other" for notice in notices)


@pytest.mark.parametrize("text", (
    "1. HAZARDOUS OPERATIONS, MISSILE FIRING OPERATIONS IN PROGRESS.",
    "1. HAZARDOUS OPERATIONS, SCIENTIFIC MOORINGS AT DEPTH 15 METERS.",
    "1. NAVIGATION PROHIBITED DUE TO MISSILE FIRING OPERATIONS IN PROGRESS.",
    "1. NAVIGATION PROHIBITED DUE TO SCIENTIFIC MOORINGS AT DEPTH 15 METERS.",
    "1. ANCHORING PROHIBITED DUE TO CABLE LAYING OPERATIONS IN PROGRESS.",
))
def test_generic_prefix_with_a_named_nonspace_cause_can_still_be_excluded(text: str) -> None:
    row = _iv_row(1231)
    row.pop("authority")
    row["text"] = text
    notices = parse_nga_payload(_payload([row]), NGA_URL.format(area="4"))
    assert len(notices) == 1 and notices[0].kind == "other"


@pytest.mark.parametrize("authority", (
    "SPACE LAUNCH DELTA 0/23", "EASTERN RANGE 0/23", "WESTERN RANGE 0/23", "LAUNCH RANGE 0/23",
))
def test_space_metadata_prevents_a_complete_timed_generic_body_from_being_dropped(
    authority: str,
) -> None:
    row = next(row for row in _xii_rows() if row["msgNumber"] == 795)
    row["authority"] = authority
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))
