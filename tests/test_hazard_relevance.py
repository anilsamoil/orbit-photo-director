from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_notices import NoticeError, parse_faa_tfr, parse_nga_payload
from generator.hazard_sources import FAA_DETAIL_URL, NGA_URL, STATE_NAME, USCG_FILE_URL
from scripts.hazard_refresh import (
    ARTIFACT,
    PUBLICATION_RECEIPT,
    RUN_LOG,
    PublicationTarget,
    refresh_hazards,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_faa_r3 import _web
from tests.test_hazard_refresh import NOW, Web, _output

BULLETIN = "navarea-xii-in-force-2026-11-13.txt"
XII_OTHER = (802, 795, 789, 752, 751, 750, 745)
IV_OTHER = (1100, 222, 329)


def _xii_rows() -> list[dict[str, object]]:
    return [
        {
            "navArea": "12",
            "msgNumber": int(notice_id.split()[2].split("/")[0]),
            "msgYear": 2000 + int(notice_id[-2:]),
            "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(),
            "text": text,
        }
        for notice_id, issued, text in fx.broadcast_blocks(BULLETIN)
    ]


def _payload(rows: list[dict[str, object]]) -> bytes:
    return json.dumps({"broadcast-warn": rows}).encode()


def _retains_source(tmp_path: Path, source: str, url: str, body: bytes) -> None:
    web = Web(complete=True)
    web.pages[NGA_URL.format(area="12")] = _payload([
        next(row for row in _xii_rows() if row["msgNumber"] == 801),
    ])
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    assert refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )["ok"]
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    artifact, receipt = (output / ARTIFACT).read_bytes(), (output / PUBLICATION_RECEIPT).read_bytes()
    web.pages[url] = body
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    assert after["error"] == ("USCG_ROW" if source == "uscg" else "NGA_ROW")
    assert after["notices"] == before["notices"] and after["checked_at"] == before["checked_at"]
    assert report["degraded"] and not report["published"] and not report["written"]
    assert (output / ARTIFACT).read_bytes() == artifact and uploads == [artifact]
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt


@pytest.mark.parametrize(("area", "dropped"), (("12", XII_OTHER), ("4", IV_OTHER)))
@pytest.mark.parametrize("warm", (False, True))
def test_complete_nga_capture_publishes_and_records_nonlaunch_drops(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, area: str,
    dropped: tuple[int, ...], warm: bool,
) -> None:
    web = Web(complete=True)
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("offline:test", lambda path, *_: uploads.append(path.read_bytes()))
    now = NOW
    if warm:
        assert refresh_hazards(
            cache, output, now, fetch=web, pause=lambda _: None, publication=publication,
        )["ok"]
        now += timedelta(minutes=31)
    raw = _payload(_xii_rows()) if area == "12" else (fx.NOTICES / fx.NGA_2023).read_bytes()
    assert len(json.loads(raw)["broadcast-warn"]) == (27 if area == "12" else 85)
    web.pages[NGA_URL.format(area=area)] = raw
    report = refresh_hazards(
        cache, output, now, fetch=web, pause=lambda _: None, publication=publication,
    )
    assert report["ok"] and report["published"] and not report["degraded"]
    state = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    assert all(source["error"] is None for source in state.values())
    notices = {row["notice_id"]: row for row in state[f"nga:{area}"]["notices"]}
    if area == "12":
        assert "NAVAREA XII 801/26" in notices
        for number in (788, 787):
            notice = notices[f"NAVAREA XII {number}/26"]
            assert notice["kind"] == "space_debris"
            assert notice["areas"] or any(
                problem.startswith("GEOMETRY_UNDRAWN:") for problem in notice["problems"]
            )
            assert not any("UNPARSED" in problem for problem in notice["problems"])
    else:
        assert set(notices) == {"NAVAREA IV 1231/23", "NAVAREA IV 1130/23"}
    series, year = ("NAVAREA XII", "26") if area == "12" else ("NAVAREA IV", "23")
    for number in dropped:
        notice_id = f"{series} {number}/{year}"
        assert notice_id not in notices
        assert any(
            notice_id in record.getMessage() and "DROP_OTHER" in record.getMessage()
            and "reason=" in record.getMessage()
            for record in caplog.records
        ), notice_id
    assert uploads[-1] == (output / ARTIFACT).read_bytes()
    log = json.loads((output / RUN_LOG).read_bytes())
    assert not log["degraded"] and log["published"]
    if area == "12":
        assert any(row["notice_id"] == "NAVAREA XII 788/26" for row in log["decisions"])


@pytest.mark.parametrize("number", (788, 787))
@pytest.mark.parametrize("damage", (
    "minutes", "longitude", "coordinate_tail", "time", "reversed_days", "numbering",
))
def test_dateline_notice_damage_still_keeps_last_good(
    tmp_path: Path, number: int, damage: str,
) -> None:
    row = next(row for row in _xii_rows() if row["msgNumber"] == number)
    coordinate = "144-37.00E" if number == 788 else "153-46.00E"
    time = "0130Z TO 0501Z" if number == 788 else "2217Z TO 0144Z"
    through = "THRU" if number == 788 else "THR"
    old, new = {
        "minutes": (coordinate, coordinate[:4] + "76.00E"),
        "longitude": (coordinate, "2" + coordinate[1:]),
        "coordinate_tail": (coordinate, coordinate + " UNKNOWN"),
        "time": (time, "0" + time),
        "reversed_days": (f"14 {through} 20 NOV", f"20 {through} 14 NOV"),
        "numbering": ("2. CANCEL THIS MSG", "3. CANCEL THIS MSG"),
    }[damage]
    text = str(row["text"])
    assert old in text
    row["text"] = text.replace(old, new, 1)
    _retains_source(tmp_path, "nga:12", NGA_URL.format(area="12"), _payload([row]))


@pytest.mark.parametrize("activity", (
    "UNIDENTIFIED FLIGHT ACTIVITY ALSO PLANNED.",
    "EXPERIMENTAL FLIGHT OPERATIONS ALSO PLANNED.",
    "MARINERS SHOULD AVOID THE AREA DURING UNIDENTIFIED FLIGHT ACTIVITY.",
    "AN UNIDENTIFIED OBJECT WILL FALL FROM ORBIT INTO THE AREA.",
    "UNKNOWN FLIGHT TEST PLANNED.",
    "EXPERIMENTAL FLIGHT HAZARDOUS OPERATIONS ALSO PLANNED.",
    "SATELLITES WILL REENTER THE ATMOSPHERE.",
    "AN UNIDENTIFIED OBJECT WILL DEORBIT INTO THE AREA.",
    "EXPERIMENTAL FLIGHTS ALSO PLANNED.",
    "ORBITING OBJECTS WILL FALL INTO THE AREA.",
))
@pytest.mark.parametrize("paragraph", (False, True))
def test_uncertain_activity_inside_a_captured_nonlaunch_row_keeps_last_good(
    tmp_path: Path, activity: str, paragraph: bool,
) -> None:
    row = next(row for row in _xii_rows() if row["msgNumber"] == 802)
    text = str(row["text"])
    row["text"] = (
        text + f"\n3. {activity}\n" if paragraph
        else text.replace("IN AREA WITHIN", activity + " IN AREA WITHIN", 1)
    )
    _retains_source(tmp_path, "nga:12", NGA_URL.format(area="12"), _payload([row]))


@pytest.mark.parametrize(("field", "value"), (("issueDate", "UNREADABLE"), ("msgYear", None)))
def test_captured_nonlaunch_row_does_not_require_launch_metadata(
    caplog: pytest.LogCaptureFixture, field: str, value: object,
) -> None:
    row = next(row for row in _xii_rows() if row["msgNumber"] == 802)
    row[field] = value
    notices = parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))
    assert all(notice.kind == "other" for notice in notices)
    assert any("DROP_OTHER" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize("other_first", (False, True))
def test_other_notice_identity_cannot_collide_with_a_launch(other_first: bool) -> None:
    launch = next(row for row in _xii_rows() if row["msgNumber"] == 801)
    other = next(row for row in _xii_rows() if row["msgNumber"] == 802)
    other["msgNumber"] = 801
    rows = [other, launch] if other_first else [launch, other]
    notices = parse_nga_payload(_payload(rows), NGA_URL.format(area="12"))
    assert [notice.notice_id for notice in notices if notice.kind == "launch"] == [
        "NAVAREA XII 801/26",
    ]


def test_duplicate_relevant_notice_identity_still_fails_confirmation() -> None:
    launch = next(row for row in _xii_rows() if row["msgNumber"] == 801)
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([launch, launch]), NGA_URL.format(area="12"))


@pytest.mark.parametrize("heading", ("HAZARD AREA A:", "HAZARD AREA A.", "HIGH RISK HAZARD AREA:"))
def test_uscg_space_hazard_structure_cannot_be_dropped_as_generic_operations(
    tmp_path: Path, heading: str,
) -> None:
    payload = json.loads((fx.NOTICES / fx.USCG).read_bytes())
    row = payload["features"][0]
    row["properties"]["DESCRIPTION"] = f"HAZARDOUS OPERATIONS\n{heading}\nUNREADABLE"
    _retains_source(
        tmp_path, "uscg", USCG_FILE_URL.format(part=1),
        json.dumps({"type": "FeatureCollection", "features": [row]}).encode(),
    )


@pytest.mark.parametrize("keyword", (
    "ROCKET", "LAUNCH", "SPACE DEBRIS", "BOOSTER", "STAGE", "REENTRY", "SPACE VEHICLE",
))
def test_launch_keyword_in_other_captured_row_prevents_exclusion(keyword: str) -> None:
    row = next(row for row in _xii_rows() if row["msgNumber"] == 745)
    row["text"] = str(row["text"]) + f"\n5. {keyword} OPERATIONS UNREADABLE.\n"
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_nga_payload(_payload([row]), NGA_URL.format(area="12"))


@pytest.mark.parametrize("punctuation", ("", ".", ",", ";", ":"))
def test_faa_published_international_airspace_exclusion_confirms(
    tmp_path: Path, punctuation: str,
) -> None:
    web = _web("vandenberg", "7991")
    url = FAA_DETAIL_URL.format(year="6", sequence="7991")
    old = b"EXCLUDING AIRSPACE BEYOND 12NM COASTAL LIMIT OVER INTERNATIONAL WATERS."
    assert old in web.pages[url]
    web.pages[url] = web.pages[url].replace(
        old, f"EXCLUDING INTERNATIONAL AIRSPACE{punctuation}".encode(),
    )
    notice = parse_faa_tfr(web.pages[url], url)
    assert notice.problems == () and notice.kind == "launch"
    report = refresh_hazards(
        tmp_path / "cache", _output(tmp_path), NOW, fetch=web, pause=lambda _: None,
        publication=PublicationTarget("offline:test", lambda *_: None),
    )
    assert report["ok"] and report["published"]


@pytest.mark.parametrize("sequence", ("7129", "7130", "7131", "7111", "7112"))
@pytest.mark.parametrize("punctuation", ("", ".", ",", ";", ":"))
def test_captured_faa_frames_confirm_with_reported_airspace_wording(
    tmp_path: Path, sequence: str, punctuation: str,
) -> None:
    web = Web(complete=True)
    url = FAA_DETAIL_URL.format(year="6", sequence=sequence)
    raw = web.pages[url]
    for clause in (
        b"EXCLUDING AIRSPACE OVER INTERNATIONAL WATERS.",
        b"EXCLUDING AIRSPACE BEYOND 12NM COASTAL LIMIT OVER INTERNATIONAL WATERS.",
    ):
        raw = raw.replace(clause, f"EXCLUDING INTERNATIONAL AIRSPACE{punctuation}".encode())
    assert raw != web.pages[url]
    web.pages[url] = raw
    assert parse_faa_tfr(raw, url).problems == ()
    report = refresh_hazards(
        tmp_path / "cache", _output(tmp_path), NOW, fetch=web, pause=lambda _: None,
        publication=PublicationTarget("offline:test", lambda *_: None),
    )
    assert report["ok"] and report["published"]


@pytest.mark.parametrize(("old", "new"), (
    (b"!FDC 6/7991", b"!FDC 6/7992"),
    (b"34.75N", b"34.8N"),
    (b"2611132230-2611140040", b"2611132230-2611140140"),
    (b"EXCLUDING INTERNATIONAL AIRSPACE", b"EXCLUDING INTERNATIONAL AIRSPACE UNKNOWN"),
))
def test_faa_airspace_exclusion_does_not_relax_the_rest_of_the_notice(
    tmp_path: Path, old: bytes, new: bytes,
) -> None:
    web = _web("vandenberg", "7991")
    url = FAA_DETAIL_URL.format(year="6", sequence="7991")
    web.pages[url] = web.pages[url].replace(
        b"EXCLUDING AIRSPACE BEYOND 12NM COASTAL LIMIT OVER INTERNATIONAL WATERS.",
        b"EXCLUDING INTERNATIONAL AIRSPACE.",
    )
    assert old in web.pages[url]
    web.pages[url] = web.pages[url].replace(old, new, 1)
    assert parse_faa_tfr(web.pages[url], url).problems
