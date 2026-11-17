from __future__ import annotations

import json
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_uscg_space_operations
from generator.hazard_sources import STATE_NAME, USCG_FILE_URL
from scripts.hazard_refresh import refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_r5_relevance import _retains_publication
from tests.test_hazard_refresh import NOW, Web, _output


def _uscg_payload(uid: int, description: str) -> bytes:
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    row = next(row for row in payload["features"] if row["properties"]["MSI_UID"] == uid)
    row["properties"]["DESCRIPTION"] = description
    return json.dumps(payload).encode()


def _missing_58217_area(area: str, following: str) -> bytes:
    description = fx.uscg_description(58217)
    start = description.index(f"Hazard Area {area}:")
    end = description.index(f"Hazard Area {following}:")
    return _uscg_payload(58217, description[:start] + description[end:])


def _numbered_from_areas(labels: tuple[str, ...]) -> bytes:
    description = fx.uscg_description(58224)
    start = description.index("A. FROM ")
    end = description.index("\n2. HAZARD PERIODS")
    block = description[start:end]
    areas = "".join(block.replace("A. FROM ", f"{label}. FROM ", 1) for label in labels)
    return _uscg_payload(58224, description[:start] + areas + description[end:])


@pytest.mark.parametrize(
    ("uid", "labels"),
    ((58217, ("A", "B", "C")), (58224, ("A",)), (58067, ("HIGH RISK", "HAZARD"))),
)
def test_captured_uscg_area_groups_confirm(uid: int, labels: tuple[str, ...]) -> None:
    notices = parse_uscg_space_operations(
        (fx.NOTICES / fx.USCG).read_bytes(), USCG_FILE_URL.format(part=1), strict=True,
    )
    notice = next(notice for notice in notices if notice.notice_id == f"USCG LNM {uid}")
    assert tuple(area.area_id for area in notice.areas) == labels
    assert notice.kind == "launch" and notice.problems == ()


def test_captured_uscg_area_groups_refresh(tmp_path: Path) -> None:
    cache, output = tmp_path / "cache", _output(tmp_path)
    report = refresh_hazards(cache, output, NOW, fetch=Web(complete=True), pause=lambda _: None)
    source = json.loads((cache / STATE_NAME).read_bytes())["sources"]["uscg"]
    assert report["ok"] and not report["degraded"]
    assert source["error"] is None and source["checked_at"] == "2026-11-13T23:40:00Z"
    areas = {
        notice["notice_id"]: tuple(area["area_id"] for area in notice["areas"])
        for notice in source["notices"]
    }
    assert areas["USCG LNM 58217"] == ("A", "B", "C")
    assert areas["USCG LNM 58067"] == ("HIGH RISK", "HAZARD")


@pytest.mark.parametrize(("area", "following"), (("A", "B"), ("B", "C")))
def test_uscg_missing_complete_lettered_area_rejects(area: str, following: str) -> None:
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(
            _missing_58217_area(area, following), USCG_FILE_URL.format(part=1), strict=True,
        )


@pytest.mark.parametrize(
    ("old", "new"),
    (
        ("Hazard Area B:", "Hazard Area A:"),
        ("Hazard Area A:", "Hazard Area D:"),
        ("Hazard Area B:", "Hazard Area D:"),
    ),
    ids=("duplicate", "starts-after-A", "out-of-order"),
)
def test_uscg_invalid_lettered_area_sequence_rejects(old: str, new: str) -> None:
    description = fx.uscg_description(58217)
    assert description.count(old) == 1
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(
            _uscg_payload(58217, description.replace(old, new)), USCG_FILE_URL.format(part=1),
            strict=True,
        )


def test_uscg_numbered_from_missing_middle_area_rejects() -> None:
    notices = parse_uscg_space_operations(
        _numbered_from_areas(("A", "B", "C")), USCG_FILE_URL.format(part=1), strict=True,
    )
    notice = next(notice for notice in notices if notice.notice_id == "USCG LNM 58224")
    assert tuple(area.area_id for area in notice.areas) == ("A", "B", "C")
    assert notice.problems == ()
    with pytest.raises(NoticeError, match="^USCG_ROW$"):
        parse_uscg_space_operations(
            _numbered_from_areas(("A", "C")), USCG_FILE_URL.format(part=1), strict=True,
        )


def test_uscg_missing_area_preserves_diagnostic_parse() -> None:
    notices = parse_uscg_space_operations(
        _missing_58217_area("B", "C"), USCG_FILE_URL.format(part=1), strict=False,
    )
    notice = next(notice for notice in notices if notice.notice_id == "USCG LNM 58217")
    assert tuple(area.area_id for area in notice.areas) == ("A", "C")
    assert notice.problems == ()


def test_uscg_missing_middle_area_retains_warm_publication(tmp_path: Path) -> None:
    _retains_publication(
        tmp_path, "uscg", USCG_FILE_URL.format(part=1),
        (fx.NOTICES / fx.USCG).read_bytes(), _missing_58217_area("B", "C"),
        "USCG LNM 58217",
    )
