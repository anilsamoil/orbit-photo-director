from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_nga_payload
from generator.hazard_sources import NGA_URL, STATE_NAME
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web, _output

BULLETIN = "navarea-xii-in-force-2026-11-13.txt"


def _page(mooring_text: str | None = None) -> bytes:
    rows: list[dict[str, object]] = []
    for notice_id, issued, text in fx.broadcast_blocks(BULLETIN):
        if notice_id not in {"NAVAREA XII 639/26", "NAVAREA XII 801/26"}:
            continue
        rows.append({
            "navArea": "12",
            "msgNumber": int(notice_id.split()[2].split("/")[0]),
            "msgYear": 2026,
            "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(),
            "text": mooring_text if notice_id.endswith("639/26") and mooring_text else text,
        })
    assert len(rows) == 2
    return json.dumps({"broadcast-warn": rows}).encode()


def test_strict_nga_source_keeps_launch_beside_scientific_moorings() -> None:
    notices = parse_nga_payload(_page(), NGA_URL.format(area="12"))
    assert {notice.notice_id: notice.kind for notice in notices} == {
        "NAVAREA XII 639/26": "other", "NAVAREA XII 801/26": "launch",
    }
    moorings = next(notice for notice in notices if notice.kind == "other")
    assert moorings.valid_until is None and not moorings.areas and not moorings.problems
    launch = next(notice for notice in notices if notice.kind == "launch")
    assert [area.area_id for area in launch.areas] == ["A", "B", "C"]
    assert [len(area.windows) for area in launch.areas] == [7, 7, 7]


@pytest.mark.parametrize("text", (
    "1. MOORING, AT DEPTH 25 METERS, ESTABLISHED IN 60-10.00N 160-10.00W.\n",
    "1. SCIENTIFIC MOORINGS, AT DEPTH 12.5 METERS, TEMPORARILY ESTABLISHED IN:\n"
    "   A. 60-10.00N 160-10.00W.\n   B. 60-20.00N 160-20.00W.\n",
    "1. CABLE LAYING OPERATIONS IN PROGRESS. "
    "COVE ROJO LIGHTHOUSE 12-30.95N 081-43.77W UNLIT.\n",
))
def test_readable_nonspace_components_do_not_require_launch_fields(text: str) -> None:
    notices = parse_nga_payload(_page(text), NGA_URL.format(area="12"))
    assert next(notice for notice in notices if notice.notice_id.endswith("639/26")).kind == "other"


@pytest.mark.parametrize("damage", (
    "15 METERS, ESTABLISHED IN:\n   A. 65-46.86N 168-34.06W. UNKNOWN ACTIVITY.\n",
    "15 METERS, ESTABLISHED IN:\n   A. 65-46.86N 168-34.06W.\n"
    "2. HAZARDOUS OPERATIONS, ROCKET LAUNCHING UNREADABLE.\n",
))
def test_ambiguous_or_launch_mooring_rows_still_fail_the_source(damage: str) -> None:
    text = "BERING STRAIT.\nALASKA.\n1. SCIENTIFIC MOORINGS, AT DEPTH " + damage
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_page(text), NGA_URL.format(area="12"))


def test_nonlaunch_mooring_geometry_does_not_freeze_the_source() -> None:
    text = "BERING STRAIT.\nALASKA.\n1. SCIENTIFIC MOORINGS, AT DEPTH "
    text += "15 METERS, ESTABLISHED IN:\n   A. UNREADABLE.\n"
    notices = parse_nga_payload(_page(text), NGA_URL.format(area="12"))
    assert {notice.notice_id: notice.kind for notice in notices} == {
        "NAVAREA XII 639/26": "other", "NAVAREA XII 801/26": "launch",
    }


@pytest.mark.parametrize("legacy_version", (None, 1, 2, 3))
def test_moorings_beside_launch_allow_publication_and_legacy_refresh(
    tmp_path: Path, legacy_version: int | None,
) -> None:
    web = Web(complete=True)
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []

    def upload(path: Path, *_: object) -> None:
        uploads.append(path.read_bytes())

    publication = PublicationTarget("r2:test", upload)
    now = NOW
    if legacy_version is not None:
        first = refresh_hazards(
            cache, output, now, fetch=web, pause=lambda _: None, publication=publication,
        )
        assert first["ok"] and first["published"]
        state_path = cache / STATE_NAME
        state = json.loads(state_path.read_bytes())
        state["schema_version"] = legacy_version
        state_path.write_text(json.dumps(state))
        now += timedelta(minutes=1)
        web.asked.clear()
    web.pages[NGA_URL.format(area="12")] = _page()
    report = refresh_hazards(
        cache, output, now, fetch=web, pause=lambda _: None, publication=publication,
    )
    state = json.loads((cache / STATE_NAME).read_bytes())
    assert report["ok"] and report["published"] and not report["degraded"]
    assert state["schema_version"] == 5
    assert all(entry["error"] is None for entry in state["sources"].values())
    source = state["sources"]["nga:12"]
    assert source["checked_at"] == now.strftime("%Y-%m-%dT%H:%M:%SZ")
    assert [notice["notice_id"] for notice in source["notices"]] == ["NAVAREA XII 801/26"]
    assert len(source["notices"][0]["areas"]) == 3
    assert uploads[-1] == (output / ARTIFACT).read_bytes()
    assert json.loads((output / PUBLICATION_RECEIPT).read_bytes())
    assert NGA_URL.format(area="12") in web.asked
