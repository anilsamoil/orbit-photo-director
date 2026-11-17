from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta

import pytest

from generator.hazard_match import Sighting, build_bundle
from generator.hazard_notices import (
    NoticeError,
    _launch_relevance,
    parse_broadcast_warning,
    parse_faa_tfr,
    parse_nga_payload,
    parse_uscg_space_operations,
)
from generator.hazard_sources import NGA_URL, STATE_NAME
from scripts.hazard_refresh import PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web, _output
from tests.test_hazard_relevance import _payload, _retains_source, _xii_rows


def _generic_rows() -> list[dict]:
    rows = _xii_rows()
    rows += json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    return [row for row in rows if (str(row["navArea"]), row["msgNumber"]) in {
        ("12", 802), ("12", 795), ("12", 752), ("12", 751), ("12", 750),
        ("4", 1100), ("4", 222),
    }]


@pytest.mark.parametrize("row", _generic_rows(), ids=lambda row: str(row["msgNumber"]))
def test_complete_generic_captured_rows_are_other(row: dict) -> None:
    notices = parse_nga_payload(_payload([row]), NGA_URL.format(area=row["navArea"]))
    assert len(notices) == 1 and notices[0].kind == "other"


@pytest.mark.parametrize("row", _generic_rows(), ids=lambda row: str(row["msgNumber"]))
@pytest.mark.parametrize("damage", ("mid_coordinate", "before_validity_end", "garbled_time"))
def test_damaged_generic_captured_rows_retain_warm_publication(tmp_path, row: dict, damage: str):
    row = dict(row)
    text = row["text"]
    if damage == "mid_coordinate":
        coordinate = re.search(r"\d{2}-\d{2}\.\d{2}N", text)
        assert coordinate is not None
        row["text"] = text[:coordinate.start() + 6]
    elif damage == "before_validity_end":
        marker = "2. CANCEL" if "2. CANCEL" in text else "UNTIL"
        row["text"] = text[:text.index(marker)]
    else:
        row["text"] = (
            text.replace("181600Z", "181660Z").replace("161600Z", "161660Z")
            .replace("010800Z", "010860Z").replace("FURTHER NOTICE", "FURTHER UNKNOWN")
            .replace("FURTHER\nNOTICE", "FURTHER\nUNKNOWN")
        )
        assert row["text"] != text
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area=row["navArea"]))
    _retains_source(
        tmp_path, f"nga:{row['navArea']}", NGA_URL.format(area=row["navArea"]), _payload([row]),
    )


@pytest.mark.parametrize("number", (1100, 222))
@pytest.mark.parametrize("issue", (None, "yesterday"))
def test_indefinite_generic_rows_require_a_readable_issue_date(tmp_path, number: int, issue):
    row = dict(next(row for row in _generic_rows() if row["msgNumber"] == number))
    if issue is None:
        row.pop("issueDate")
    else:
        row["issueDate"] = issue
    _retains_source(tmp_path, "nga:4", NGA_URL.format(area="4"), _payload([row]))


_BROADCAST_ROWS = [
    pytest.param(name, notice_id, issued, text, id=f"{name}:{notice_id}")
    for name in fx.BROADCAST
    for notice_id, issued, text in fx.broadcast_blocks(name)
]


@pytest.mark.parametrize(("name", "notice_id", "issued", "text"), _BROADCAST_ROWS)
def test_every_real_broadcast_row_has_a_known_confirmation_outcome(
    name: str, notice_id: str, issued: datetime, text: str,
) -> None:
    if notice_id == "NAVAREA IV 1099/26":
        assert "1616550Z TO 161828" in text
        with pytest.raises(NoticeError, match="^NGA_ROW$"):
            parse_broadcast_warning(text, notice_id, issued, "https://example.invalid/", "a" * 64,
                                    strict=True)
        notice = parse_broadcast_warning(
            text, notice_id, issued, "https://example.invalid/", "a" * 64,
        )
        assert notice.kind == "launch" and any(
            problem.startswith("WINDOW_UNPARSED:") for problem in notice.problems
        )
        return
    notice = parse_broadcast_warning(
        text, notice_id, issued, fx.manifest(name)["source_url"], fx.file_sha256(name), strict=True,
    )
    assert notice.notice_id == notice_id


def test_every_real_archived_nga_row_confirms() -> None:
    notices = parse_nga_payload(
        (fx.NOTICES / fx.NGA_2023).read_bytes(), NGA_URL.format(area="4"),
    )
    assert len(notices) == 85


def test_no_real_nga_capture_is_uncertain() -> None:
    rows = [
        (text, issued, None, notice_id)
        for name in fx.BROADCAST for notice_id, issued, text in fx.broadcast_blocks(name)
    ]
    rows += [
        (row["text"], datetime.strptime(row["issueDate"], "%d%H%MZ %b %Y").replace(tzinfo=UTC),
         row.get("authority"), f"NAVAREA IV {row['msgNumber']}/{row['msgYear'] % 100:02d}")
        for row in json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    ]
    assert len(rows) == 120
    assert not [
        text for text, issued, authority, notice_id in rows
        if _launch_relevance(text, issued=issued, authority=authority, notice_id=notice_id).name
        == "UNCERTAIN"
    ]


def test_every_real_uscg_row_confirms() -> None:
    notices = parse_uscg_space_operations(
        (fx.NOTICES / fx.USCG).read_bytes(), fx.manifest(fx.USCG)["source_url"], strict=True,
    )
    features = json.loads((fx.NOTICES / fx.USCG).read_bytes())["features"]
    assert {notice.notice_id for notice in notices} == {
        f"USCG LNM {row['properties']['MSI_UID']}" for row in features
    }


@pytest.mark.parametrize("name", fx.FAA)
def test_every_real_faa_detail_confirms(name: str) -> None:
    notice = parse_faa_tfr((fx.NOTICES / name).read_bytes(), fx.manifest(name)["source_url"])
    assert notice.kind in {"launch", "recovery"} and notice.areas


@pytest.mark.parametrize("pinned", (False, True))
def test_standing_space_closure_preserves_geometry_without_launch_attachment(pinned: bool) -> None:
    rows = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    row = next(row for row in rows if row["msgNumber"] == 329)
    (notice,) = parse_nga_payload(_payload([row]), NGA_URL.format(area="4"))
    assert notice.kind == "standing_closure"
    assert [area.area_id for area in notice.areas] == ["A", "B"]
    assert [len(area.ring) for area in notice.areas] == [4, 8]
    assert fx.same_ring(
        [list(point) for point in (*notice.areas[0].ring, notice.areas[0].ring[0])],
        fx.read_dm_pairs(fx.between(row["text"], "A. ", "B. ")),
    )
    assert all(not area.windows for area in notice.areas)
    candidate = fx.item(fx.USSF_317)
    candidate["site"].update(lat=28.3, lon=-74.6)
    overrides = {"pin": {notice.notice_id: fx.USSF_317}} if pinned else None
    bundle, decisions = build_bundle([candidate], [Sighting(notice, NOW)], NOW, overrides)
    assert bundle["launches"] == []
    assert len(decisions) == 1
    assert decisions[0]["decision"] == "unmatched" and decisions[0]["event_id"] is None
    assert decisions[0]["reasons"] == ["STANDING_CLOSURE_NO_LAUNCH_WINDOW"]


def test_standing_space_closure_survives_disk_cache_without_refetch(tmp_path) -> None:
    web = Web(complete=True)
    web.pages[NGA_URL.format(area="4")] = (fx.NOTICES / fx.NGA_2023).read_bytes()
    cache, output = tmp_path / "cache", _output(tmp_path)
    publication = PublicationTarget("offline:test", lambda *_: None)
    first = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    assert first["ok"] and first["published"] and not first["degraded"]
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:4"]
    standing = next(row for row in before["notices"] if row["notice_id"] == "NAVAREA IV 329/23")
    assert standing["kind"] == "standing_closure" and len(standing["areas"]) == 2
    asked = len(web.asked)
    second = refresh_hazards(
        cache, output, NOW + timedelta(minutes=1), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    assert second["ok"] and not second["degraded"]
    assert len(web.asked) == asked
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:4"]
    assert after == before
