"""Hazard notice parsers against the original notice text of four real launches."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from generator.hazard_match import Sighting, build_bundle
from generator.hazard_notices import (
    NoticeError,
    notice_from_record,
    notice_record,
    parse_broadcast_warning,
    parse_faa_tfr,
    parse_nga_payload,
    parse_uscg_space_operations,
)
from tests import hazard_fixtures as fx


def _utc(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)


def _spans(area) -> list[tuple[datetime, datetime]]:
    return [(window.start, window.end) for window in area.windows]


def _ring(area) -> list[tuple[Decimal, Decimal]]:
    return [(Decimal(str(lon)), Decimal(str(lat))) for lon, lat in area.ring]


def _reparse(name: str, notice_id: str, old: str, new: str):
    body = fx.broadcast_body(name, notice_id)
    assert old in body
    issued = next(when for found, when, _ in fx.broadcast_blocks(name) if found == notice_id)
    return parse_broadcast_warning(body.replace(old, new), notice_id, issued, "https://example.invalid/", "0" * 64)


def test_starship_navarea_vertices_and_windows_come_from_the_notice_text():
    name = "navarea-iv-1080-26.txt"
    body = fx.broadcast_body(name, "NAVAREA IV 1080/26")
    notice = fx.broadcast_notice(name)
    assert (notice.authority, notice.kind, notice.domain) == ("NGA", "launch", "maritime")
    assert notice.subject == "HAZARDOUS OPERATIONS, ROCKET LAUNCHING"
    assert notice.problems == () and notice.cancels == ()
    assert notice.source_sha256 == fx.file_sha256(name)
    area_a, area_b = notice.areas
    assert (area_a.area_id, area_b.area_id) == ("A", "B")
    assert _ring(area_a) == fx.read_dm_pairs(fx.between(body, "A. ", "B. "))
    assert _ring(area_b) == fx.read_dm_pairs(fx.between(body, "B. ", "2. CANCEL"))
    assert (len(area_a.ring), len(area_b.ring)) == (30, 16)
    assert _spans(area_a) == _spans(area_b) == [
        (_utc(f"2026-11-{day}T22:45"), _utc(f"2026-11-{day + 1}T00:40")) for day in range(13, 20)
    ]
    assert notice.valid_until == _utc("2026-11-20T01:40")
    assert notice.valid_from == _utc("2026-11-09T07:53") and notice.outline == ()


def test_a_vertex_moved_one_hundredth_of_a_minute_moves_the_parsed_ring():
    original = fx.broadcast_notice("navarea-iv-1080-26.txt")
    moved = _reparse("navarea-iv-1080-26.txt", "NAVAREA IV 1080/26", "25-41.00N 093-29.00W", "25-41.01N 093-29.00W")
    assert moved.areas[0].ring != original.areas[0].ring
    assert moved.areas[0].ring[6] == (-93.48333, 25.68350)
    assert original.areas[0].ring[6] == (-93.48333, 25.68333)
    assert moved.areas[1].ring == original.areas[1].ring


def test_coast_guard_text_for_starship_names_the_same_areas_as_the_navarea():
    description = fx.uscg_description(58067)
    notice = fx.uscg_notice(58067)
    navarea = fx.broadcast_notice("navarea-iv-1080-26.txt")
    high, hazard = notice.areas
    assert (notice.kind, notice.problems) == ("launch", ())
    assert (high.area_id, high.restriction_class) == ("HIGH RISK", "high_risk")
    assert (hazard.area_id, hazard.restriction_class) == ("HAZARD", "hazard")
    assert _ring(high) == fx.read_dms_pairs(fx.between(description, "High Risk Hazard Area:", "\nHazard Area:"))
    assert _ring(hazard) == fx.read_dms_pairs(fx.between(description, "\nHazard Area:", "Primary and backup"))
    assert high.ring == navarea.areas[1].ring and hazard.ring == navarea.areas[0].ring
    assert _spans(high) == _spans(hazard) == _spans(navarea.areas[0])
    avoid = "Mariners should avoid waters within the defined hazard areas during the scheduled launch window."
    lead = "The high risk hazard area should be avoided three hours prior to the earliest launch to ensure range clearance."
    assert avoid in description and lead in description
    assert hazard.instructions == (avoid,)
    assert high.instructions == (avoid, lead)


def test_vulcan_amendment_cancels_the_first_issue_and_reports_its_malformed_groups():
    first = fx.broadcast_notice("navarea-iv-1078-26.txt")
    amended = fx.broadcast_notice("navarea-iv-1099-26.txt")
    body = fx.broadcast_body("navarea-iv-1099-26.txt", "NAVAREA IV 1099/26")
    assert first.cancels == () and first.problems == ()
    assert amended.cancels == ("NAVAREA IV 1078/26",)
    assert [area.area_id for area in amended.areas] == ["A", "B", "C"]
    assert _ring(amended.areas[0]) == fx.read_dm_pairs(fx.between(body, "A. ", "B. "))
    assert _ring(amended.areas[1]) == fx.read_dm_pairs(fx.between(body, "B. ", "C. "))
    assert _ring(amended.areas[2]) == fx.read_dm_pairs(fx.between(body, "C. ", "2. CANCEL"))
    assert [len(area.ring) for area in amended.areas] == [12, 4, 6]
    assert set(amended.areas[1].ring) == set(first.areas[1].ring)
    assert len(first.areas[0].windows) == 7
    assert (_utc("2026-11-16T16:50"), _utc("2026-11-16T18:28")) in _spans(first.areas[0])
    assert "1616550Z TO 161828," in body and "141732Z TO 1911Z NOV" in body
    assert amended.problems == ("WINDOW_UNPARSED:1616550Z TO 161828",)
    assert _spans(amended.areas[0]) == [
        (_utc("2026-11-14T17:32"), _utc("2026-11-14T19:11")),
        (_utc("2026-11-15T17:11"), _utc("2026-11-15T18:50")),
        (_utc("2026-11-17T16:28"), _utc("2026-11-17T18:07")),
        (_utc("2026-11-18T16:07"), _utc("2026-11-18T17:46")),
        (_utc("2026-11-19T15:46"), _utc("2026-11-19T17:24")),
    ]
    assert all(window.start.day != 16 for window in amended.areas[0].windows)
    assert amended.valid_until == _utc("2026-11-19T18:24")


def test_vandenberg_falcon_9_notice_carries_one_schedule_per_area():
    name = "navarea-xii-785-26.txt"
    body = fx.broadcast_body(name, "NAVAREA XII 785/26")
    notice = fx.broadcast_notice(name)
    chunks = body.split("IN AREA BOUND BY")[1:]
    assert notice.kind == "launch" and notice.problems == ()
    assert [area.area_id for area in notice.areas] == ["A", "B", "C"]
    for area, chunk in zip(notice.areas, chunks, strict=True):
        assert _ring(area) == fx.read_dm_pairs(chunk)
    assert [len(area.ring) for area in notice.areas] == [10, 6, 11]
    nov18 = [next(w for w in area.windows if w.start == _utc("2026-11-18T03:14")).end for area in notice.areas]
    assert nov18 == [_utc("2026-11-18T07:37"), _utc("2026-11-18T07:38"), _utc("2026-11-18T07:57")]
    assert all(len(area.windows) == 7 for area in notice.areas)


def test_in_force_bulletin_holds_the_vandenberg_amendment_and_unrelated_operations():
    name = "navarea-xii-in-force-2026-11-13.txt"
    by_id = {notice.notice_id: notice for notice in fx.broadcast_notices(name)}
    amended = by_id["NAVAREA XII 801/26"]
    body = fx.broadcast_body(name, "NAVAREA XII 801/26")
    assert amended.kind == "launch" and amended.cancels == ("NAVAREA XII 785/26",)
    for area, chunk in zip(amended.areas, body.split("IN AREA BOUND BY")[1:], strict=True):
        assert _ring(area) == fx.read_dm_pairs(chunk)
    assert _spans(amended.areas[0])[0] == (_utc("2026-11-18T03:14"), _utc("2026-11-18T07:37"))
    assert _spans(amended.areas[0])[-1] == (_utc("2026-11-24T03:46"), _utc("2026-11-24T06:14"))
    kinds = {name: notice.kind for name, notice in by_id.items()}
    assert kinds["NAVAREA XII 794/26"] == "launch"
    assert kinds["NAVAREA XII 789/26"] == "other" and by_id["NAVAREA XII 789/26"].subject == "MISSILE OPERATIONS"
    assert kinds["NAVAREA XII 795/26"] == "other" and by_id["NAVAREA XII 795/26"].subject == "HAZARDOUS OPERATIONS"
    assert kinds["NAVAREA XII 799/26"] == "space_debris"
    assert by_id["NAVAREA XII 802/26"].areas == ()
    assert len(by_id["NAVAREA XII 789/26"].areas[0].windows) == 3
    assert by_id["NAVAREA XII 761/26"].kind == "other" and by_id["NAVAREA XII 761/26"].areas == ()


def test_published_text_the_grammar_does_not_cover_is_reported_not_repaired():
    by_id = {notice.notice_id: notice for notice in fx.broadcast_notices("navarea-xii-in-force-2026-11-13.txt")}
    crossing = by_id["NAVAREA XII 788/26"]
    assert crossing.areas == () and crossing.problems == ("GEOMETRY_UNPARSED:1",)
    typo = by_id["NAVAREA XII 787/26"]
    assert "WINDOW_UNPARSED:2217Z TO 0144Z DAILY 14 THR 20 NOV" in typo.problems
    month_long = by_id["NAVAREA XII 752/26"]
    assert month_long.problems == ("WINDOW_UNPARSED:010800Z NOV TO 010800Z DEC",)
    assert month_long.areas[0].windows == ()


@pytest.mark.parametrize(("old", "new"), [
    ("26-02.00N 097-13.00W,", "26-60.00N 097-13.00W,"),
    ("26-02.00N 097-13.00W,", "26-02.00N 097-13.00W THENCE"),
    ("26-02.00N 097-13.00W,", "96-02.00N 097-13.00W,"),
    ("26-02.00N 097-13.00W,", "25-58.00N 097-13.00W,"),
])
def test_one_bad_vertex_rejects_the_whole_notice_geometry(old: str, new: str):
    notice = _reparse("navarea-iv-1080-26.txt", "NAVAREA IV 1080/26", old, new)
    assert notice.areas == ()
    assert notice.problems == ("GEOMETRY_UNPARSED:A", "GEOMETRY_UNPARSED:B")


def test_a_bad_vertex_in_one_area_also_withholds_the_readable_area():
    notice = _reparse("navarea-iv-1080-26.txt", "NAVAREA IV 1080/26", "26-06.00N 097-04.00W", "26-66.00N 097-04.00W")
    assert notice.problems == ("GEOMETRY_UNPARSED:A",)
    assert notice.areas == ()
    assert len(notice.cancels) == 0 and notice.valid_until is not None


def test_a_time_group_with_a_digit_too_many_or_no_zone_letter_is_not_read_as_another():
    name, notice_id = "navarea-iv-1099-26.txt", "NAVAREA IV 1099/26"
    long_start = _reparse(name, notice_id, "1616550Z TO 161828,", "1616550Z TO 161828Z,")
    assert long_start.problems == ("WINDOW_UNPARSED:1616550Z TO 161828Z",)
    assert all(window.start.day != 16 for window in long_start.areas[0].windows)
    no_zone = _reparse(name, notice_id, "151711Z TO 151850Z,", "151711 TO 151850Z,")
    assert "WINDOW_UNPARSED:151711 TO 151850Z" in no_zone.problems
    assert all(window.start.day != 15 for window in no_zone.areas[0].windows)
    long_end = _reparse(name, notice_id, "171628Z TO 171807Z,", "171628Z TO 1718070Z,")
    assert "WINDOW_UNPARSED:171628Z TO 1718070Z" in long_end.problems
    assert all(window.start.day != 17 for window in long_end.areas[0].windows)


def test_time_groups_resolve_month_and_year_from_the_notice_itself():
    issued = datetime(2026, 12, 28, 9, 0, tzinfo=UTC)

    def windows(schedule: str):
        text = f"1. HAZARDOUS OPERATIONS, ROCKET LAUNCHING\n   {schedule}\n   IN AREA BOUND BY\n   28-00.00N 080-00.00W, 28-00.00N 079-00.00W,\n   27-00.00N 079-00.00W.\n2. CANCEL THIS MSG 050300Z JAN 27.\n"
        notice = parse_broadcast_warning(text, "NAVAREA IV 1/27", issued, "https://example.invalid/", "0" * 64)
        return _spans(notice.areas[0]), notice.problems

    assert windows("302300Z DEC TO 310200Z DEC, ALTERNATE 312300Z DEC TO 010200Z JAN") == ([
        (_utc("2026-12-30T23:00"), _utc("2026-12-31T02:00")),
        (_utc("2026-12-31T23:00"), _utc("2027-01-01T02:00")),
    ], ())
    assert windows("2300Z TO 0200Z DAILY 30 DEC THRU 01 JAN") == ([
        (_utc("2026-12-30T23:00"), _utc("2026-12-31T02:00")),
        (_utc("2026-12-31T23:00"), _utc("2027-01-01T02:00")),
        (_utc("2027-01-01T23:00"), _utc("2027-01-02T02:00")),
    ], ())
    assert windows("312300Z TO 010200Z JAN") == ([(_utc("2026-12-31T23:00"), _utc("2027-01-01T02:00"))], ())
    assert windows("302300Z TO 310200Z") == ([], ("WINDOW_UNPARSED:302300Z TO 310200Z",))
    assert windows("312300Z TO 310200Z DEC") == ([], ("WINDOW_UNPARSED:312300Z TO 310200Z DEC",))
    assert windows("0200Z TO 0300Z DAILY 05 THRU 02 JAN") == ([], ("WINDOW_UNPARSED:0200Z TO 0300Z DAILY 05 THRU 02 JAN",))
    assert windows("302300Z DEC TO 310200Z DEC OR LATER") == (
        [(_utc("2026-12-30T23:00"), _utc("2026-12-31T02:00"))], ("WINDOW_UNPARSED:OR LATER",),
    )


def test_archived_nga_answer_holds_the_falcon_9_cape_canaveral_warning():
    raw = (fx.NOTICES / fx.NGA_2023).read_bytes()
    rows = json.loads(raw)["broadcast-warn"]
    notices = parse_nga_payload(raw, "https://msi.nga.mil/api/publications/broadcast-warn")
    assert len(rows) == len(notices) == 85
    by_id = {notice.notice_id: notice for notice in notices}
    launch = by_id["NAVAREA IV 1231/23"]
    text = next(row["text"] for row in rows if row["msgNumber"] == 1231)
    assert "HAZARDOUS OPERATIONS, ROCKET LAUNCHING" in text and "FLORIDA." in text
    assert launch.kind == "launch" and launch.problems == ()
    assert launch.source_sha256 == fx.file_sha256(fx.NGA_2023)
    assert _ring(launch.areas[0]) == fx.read_dm_pairs(fx.between(text, "A. ", "B. "))
    assert _ring(launch.areas[1]) == fx.read_dm_pairs(fx.between(text, "B. ", "2. CANCEL"))
    assert _spans(launch.areas[0])[2:5] == [
        (_utc("2023-10-30T22:23"), _utc("2023-10-31T02:54")),
        (_utc("2023-10-31T21:57"), _utc("2023-11-01T02:28")),
        (_utc("2023-11-01T21:32"), _utc("2023-11-02T02:03")),
    ]
    assert launch.valid_until == _utc("2023-11-04T02:13")
    assert [notice.notice_id for notice in notices if notice.kind == "launch"] == ["NAVAREA IV 1231/23"]
    debris = by_id["NAVAREA IV 1130/23"]
    assert debris.kind == "space_debris" and len(debris.areas[0].windows) == 31
    assert _spans(debris.areas[0])[-1] == (_utc("2023-11-04T00:36"), _utc("2023-11-04T02:06"))
    prohibited = by_id["NAVAREA IV 329/23"]
    assert prohibited.kind == "other" and prohibited.cancels == ("NAVAREA IV 326/23",)


def test_nga_rows_from_an_unsupported_area_are_skipped_and_a_wrong_document_is_refused():
    payload = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())
    rows = payload["broadcast-warn"][:4]
    irrelevant = {**rows[1], "navArea": "1"}
    notices = parse_nga_payload(json.dumps({"broadcast-warn": [irrelevant, rows[3]]}).encode(), "https://msi.nga.mil/x")
    assert [notice.notice_id for notice in notices] == ["NAVAREA IV 1217/23"]
    for body, code in ((b"<html>", "NGA_NOT_JSON"), (b"[]", "NGA_SHAPE"), (b" " * 4_000_001, "NGA_TOO_LARGE")):
        with pytest.raises(NoticeError, match=code):
            parse_nga_payload(body, "https://msi.nga.mil/x")


@pytest.mark.parametrize(("field", "value"), [
    ("issueDate", "yesterday"),
    ("issueDate", "310933Z FEB 2023"),
    ("issueDate", None),
    ("msgNumber", "1231"),
    ("msgYear", None),
    ("text", None),
    ("text", ""),
    ("navArea", "Z"),
    ("navArea", None),
])
def test_nga_refuses_unreadable_launch_rows(field, value):
    rows = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    launch = next(row for row in rows if row["msgNumber"] == 1231)
    body = json.dumps({"broadcast-warn": [{**launch, field: value}]}).encode()
    with pytest.raises(NoticeError, match="NGA_ROW"):
        parse_nga_payload(body, "https://msi.nga.mil/x")


def test_nga_refuses_a_row_whose_relevance_cannot_be_read():
    with pytest.raises(NoticeError, match="NGA_ROW"):
        parse_nga_payload(b'{"broadcast-warn": ["text"]}', "https://msi.nga.mil/x")


@pytest.mark.parametrize("area", ["1", "12", "A"])
def test_nga_area_specific_answer_refuses_a_conflicting_row_area(area):
    rows = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    launch = next(row for row in rows if row["msgNumber"] == 1231)
    body = json.dumps({"broadcast-warn": [{**launch, "navArea": area}]}).encode()
    with pytest.raises(NoticeError, match="NGA_ROW"):
        parse_nga_payload(body, "https://msi.nga.mil/x?navArea=4&status=active&output=json")


def test_faa_starship_restriction_matches_its_xml_and_its_own_narrative():
    name = "faa-tfr-6-7129.xml"
    xml = (fx.NOTICES / name).read_text(encoding="utf-8-sig")
    notice = fx.faa_notice(name)
    assert (notice.authority, notice.notice_id, notice.kind, notice.domain) == ("FAA", "TFR 6/7129", "launch", "airspace")
    assert notice.subject == "261113 SpaceX Launch Starship 15" and notice.problems == ()
    (area,) = notice.areas
    assert area.area_id == "6/7129" and area.restriction_class == "restricted_airspace"
    assert _ring(area) == fx.read_tfr_ring(xml) and len(area.ring) == 6
    assert "2611132230 UTC" in xml and "2611140040 UTC" in xml and "SFC-UNL" in xml
    assert _spans(area) == [(_utc("2026-11-13T22:30"), _utc("2026-11-14T00:40"))]
    assert area.instructions == (
        "SFC-UNL.",
        "SPACE OPS AREA: ACFT OPS ARE PROHIBITIED. EXCLUDING AIRSPACE OVER INTERNATIONAL WATERS.",
    )
    assert area.instructions[1] in " ".join(xml.split())
    assert notice.valid_until == _utc("2026-11-14T00:40")
    assert notice.source_sha256 == fx.file_sha256(name)


def test_faa_cape_restriction_for_vulcan_and_the_starship_recovery_notice():
    vulcan = fx.faa_notice("faa-tfr-6-7111.xml")
    xml = (fx.NOTICES / "faa-tfr-6-7111.xml").read_text(encoding="utf-8-sig")
    assert vulcan.kind == "launch" and vulcan.subject == "261114 ULA Vulcan KV-01 (A1174)"
    assert _ring(vulcan.areas[0]) == fx.read_tfr_ring(xml) and len(vulcan.areas[0].ring) == 36
    assert _spans(vulcan.areas[0]) == [(_utc("2026-11-14T17:22"), _utc("2026-11-14T19:11"))]
    assert vulcan.areas[0].instructions == (
        "SFC-FL180.",
        "EXCLUDING AIRSPACE BEYOND 12 MILE COASTAL LIMIT OVER INTERNATIONAL WATERS.",
    )
    twin = fx.faa_notice("faa-tfr-6-7112.xml")
    assert twin.notice_id == "TFR 6/7112" and twin.areas[0].ring == vulcan.areas[0].ring
    recovery = fx.faa_notice("faa-tfr-6-7131.xml")
    assert recovery.subject == "261114 SpaceX Recovery Starship 15" and recovery.kind == "recovery"
    assert recovery.areas[0].ring == fx.faa_notice("faa-tfr-6-7130.xml").areas[0].ring


@pytest.mark.parametrize("pinned", [False, True])
def test_faa_file_that_disagrees_with_itself_loses_the_disputed_part(pinned):
    raw = (fx.NOTICES / "faa-tfr-6-7129.xml").read_bytes()

    def parse(old: bytes, new: bytes):
        assert old in raw
        return parse_faa_tfr(raw.replace(old, new), "https://tfr.faa.gov/x")

    shifted = parse(b"<dateEffective>2026-11-13T22:30:00</dateEffective>", b"<dateEffective>2026-11-13T21:30:00</dateEffective>")
    assert shifted.problems == ("WINDOW_CONFLICT",) and shifted.areas[0].windows == ()
    assert parse(b"EFFECTIVE 2611132230 UTC", b"EFFECTIVE DAILY").areas[0].windows == ()
    conflicted = parse(b"!FDC 6/7129 ", b"!FDC 6/7128 ")
    assert conflicted.problems == ("NUMBER_CONFLICT",)
    clean = parse_faa_tfr(raw, "https://tfr.faa.gov/x")
    clean_bundle, _ = build_bundle(fx.catalog_items(), [Sighting(clean, fx.SCENARIO_NOW)], fx.SCENARIO_NOW)
    assert fx.launch(clean_bundle, fx.STARSHIP)["geojson"]["features"]
    overrides = {"pin": {"TFR 6/7129": fx.STARSHIP}} if pinned else None
    bundle, log = build_bundle(fx.catalog_items(), [Sighting(conflicted, fx.SCENARIO_NOW)], fx.SCENARIO_NOW, overrides)
    assert bundle["launches"] == []
    assert log[0]["decision"] == "rejected" and log[0]["reasons"] == ["NUMBER_CONFLICT"]
    arc = parse(b"<codeType>GRC</codeType>", b"<codeType>CWA</codeType>")
    assert arc.areas == () and arc.problems == ("GEOMETRY_UNPARSED:6/7129",)
    assert parse(b"<geoLat>26.1N</geoLat>", b"<geoLat>26.1X</geoLat>").areas == ()
    assert parse(b"<codeType>91.143</codeType>", b"<codeType>91.137</codeType>").kind == "other"
    assert parse(b"POINT OF ORIGIN SFC-UNL", b"POINT OF ORIGIN").areas[0].instructions == (
        "SPACE OPS AREA: ACFT OPS ARE PROHIBITIED. EXCLUDING AIRSPACE OVER INTERNATIONAL WATERS.",
    )
    for body, code in (
        (b"<!DOCTYPE x [<!ENTITY a 'b'>]>" + raw, "FAA_XML_ENTITY"),
        (b"<XNOTAM-Update>", "FAA_NOT_XML"),
        (b"<XNOTAM-Update/>", "FAA_SHAPE"),
        (b"\xff\xfe\x00", "FAA_NOT_TEXT"),
        (b" " * 4_000_001, "FAA_TOO_LARGE"),
    ):
        with pytest.raises(NoticeError, match=code):
            parse_faa_tfr(body, "https://tfr.faa.gov/x")


def test_coast_guard_styles_from_three_districts_parse_from_their_own_text():
    falcon = fx.uscg_notice(58217)
    navarea = fx.broadcast_notice("navarea-xii-785-26.txt")
    assert falcon.kind == "launch" and [area.area_id for area in falcon.areas] == ["A", "B", "C"]
    for coast_guard, nga in zip(falcon.areas, navarea.areas, strict=True):
        assert [(round(lon, 5), round(lat, 5)) for lon, lat in coast_guard.ring] == list(nga.ring)
        assert _spans(coast_guard) == _spans(nga)
    assert falcon.areas[0].ring[0] == (-119.13333333, 32.08333333)
    assert falcon.areas[0].instructions == (
        "Mariners are advised to remain clear of these areas for the duration of operations.",
    )
    range_operation = fx.uscg_notice(57935)
    assert "Western Range Operation W6407" in fx.uscg_description(57935)
    assert [len(area.ring) for area in range_operation.areas] == [6, 4]
    assert _spans(range_operation.areas[0]) == _spans(range_operation.areas[1]) == [
        (_utc("2026-11-18T06:31"), _utc("2026-11-18T13:37")),
        (_utc("2026-11-19T06:31"), _utc("2026-11-19T13:37")),
    ]
    vulcan = fx.uscg_notice(58224)
    description = fx.uscg_description(58224)
    hazard_paragraph = fx.between(description, "FOR VULCAN KV-01:", "2. HAZARD PERIODS")
    assert vulcan.kind == "launch" and len(vulcan.areas) == 1
    assert _ring(vulcan.areas[0]) == fx.read_dms_pairs(hazard_paragraph) and len(vulcan.areas[0].ring) == 12
    assert "28-47-53.9N/080-27-52.3W" in description and "FOLLOWING THE SHORELINE" in description
    assert all(abs(lat - 28.79831) > 0.01 for _, lat in vulcan.areas[0].ring)
    assert (_utc("2026-11-16T16:50"), _utc("2026-11-16T18:28")) in _spans(vulcan.areas[0])
    assert vulcan.areas[0].instructions == (
        "MARINERS ARE URGED TO AVOID WATERS WITHIN ROCKET FLIGHT TRAJECTORIES/HAZARD AREAS DURING LAUNCH WINDOWS AS DETAILED ABOVE.",
    )


def test_coast_guard_notices_that_are_not_launch_hazard_areas_are_classified_so():
    kinds = {notice.notice_id: notice.kind for notice in fx.uscg_notices()}
    assert len(kinds) == 23
    assert kinds["USCG LNM 58204"] == kinds["USCG LNM 58114"] == kinds["USCG LNM 58119"] == "recovery"
    assert kinds["USCG LNM 58296"] == kinds["USCG LNM 58298"] == kinds["USCG LNM 58225"] == "regulated_area"
    assert kinds["USCG LNM 58306"] == "recovery"
    zone = fx.uscg_notice(58296)
    assert zone.areas == () and len(zone.outline) == 10
    assert (zone.valid_from, zone.valid_until) == (_utc("2026-11-12T00:00"), datetime(2026, 11, 20, 23, 59, 59, tzinfo=UTC))
    assert zone.subject == (
        "Safety Zone. Gulf of America \u2013 Safety Zone \u2013 Space Launch --- From: 2026-11-13 To: 2026-11-19 --- "
        "The U.S. Coast Guard Captain of the Port Corpus Christi is establishing a Safety Zone in the near shore "
        "region of the space launch hazard area in the Gulf of America."
    )
    assert zone.subject.removeprefix("Safety Zone. ") in " ".join(fx.uscg_description(58296).split())
    assert fx.uscg_notice(58225).subject.endswith("HAZARD AREAS FOR VULCAN KV-01:")
    assert sorted(name for name, kind in kinds.items() if kind == "launch") == [
        "USCG LNM 57935", "USCG LNM 58060", "USCG LNM 58067", "USCG LNM 58217",
        "USCG LNM 58218", "USCG LNM 58219", "USCG LNM 58224",
    ]
    prose_only = fx.uscg_notice(58060)
    assert prose_only.areas == () and prose_only.problems == ()
    air_launch = fx.uscg_notice(58219)
    assert air_launch.problems == ("WINDOW_UNPARSED:221400Z NOV TO 242000Z NOV 2026",)
    assert air_launch.areas[0].windows == ()
    stray = fx.uscg_notice(58218).areas[1].windows[0]
    assert "212250Z OCT TO 220333Z OCT 2026" in fx.uscg_description(58218)
    assert (stray.start, stray.end) == (_utc("2026-10-21T22:50"), _utc("2026-10-22T03:33"))


def test_coast_guard_area_with_an_unreadable_line_is_not_drawn_short():
    payload = json.loads((fx.NOTICES / fx.USCG).read_text())

    def reparse(uid: int, old: str, new: str, **props):
        feature = json.loads(json.dumps(next(f for f in payload["features"] if f["properties"]["MSI_UID"] == uid)))
        assert old in feature["properties"]["DESCRIPTION"]
        feature["properties"]["DESCRIPTION"] = feature["properties"]["DESCRIPTION"].replace(old, new)
        feature["properties"].update(props)
        return parse_uscg_space_operations(json.dumps({"features": [feature, {"properties": None}, 7]}).encode(), "https://navcen.uscg.gov/x")

    (bad,) = reparse(58067, "26-04-00N 096-49-00W", "26-04-00N 096-49-00")
    assert bad.areas == () and bad.problems == ("GEOMETRY_UNPARSED:HIGH RISK",)
    (short,) = reparse(58067, "26-04-00N 096-49-00W\n26-04-00N 097-04-00W", "26-04-00N 096-49-00W\n26-64-00N 097-04-00W")
    assert short.areas == () and short.problems == ("GEOMETRY_UNPARSED:HIGH RISK",)
    (odd_time,) = reparse(58067, "13/2245Z Nov 26 to 14/0040Z Nov 26", "13/2245Z Nov 26 to 13/2245Z Nov 26")
    assert odd_time.problems == ("WINDOW_UNPARSED:13/2245Z NOV 26 TO 13/2245Z NOV 26",)
    assert len(odd_time.areas[0].windows) == 6
    assert reparse(58067, "Gulf", "Gulf", STATUS="Draft") == []
    assert reparse(58067, "Gulf", "Gulf", MSI_GROUP="Bridges") == []
    assert reparse(58067, "Gulf", "Gulf", END_DATE="soon")[0].valid_until is None
    assert reparse(58067, "Gulf", "Gulf", BEGIN_DATE=True)[0].valid_from is None
    assert len(reparse(58067, "Gulf", "Gulf")[0].outline) > 20
    payload["features"][0]["geometry"] = {"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]}
    payload["features"][1]["geometry"] = {"type": "Point", "coordinates": [0, 0]}
    payload["features"][2]["geometry"] = {"type": "Polygon", "coordinates": "none"}
    reread = parse_uscg_space_operations(json.dumps(payload).encode(), "https://navcen.uscg.gov/x")
    assert [notice.outline for notice in reread[:3]] == [(), (), ()]
    for body, code in ((b"{", "USCG_NOT_JSON"), (b"{}", "USCG_SHAPE"), (b" " * 4_000_001, "USCG_TOO_LARGE")):
        with pytest.raises(NoticeError, match=code):
            parse_uscg_space_operations(body, "https://navcen.uscg.gov/x")


def test_a_notice_survives_the_state_file_unchanged():
    for notice in (
        fx.broadcast_notice("navarea-iv-1099-26.txt"),
        fx.faa_notice("faa-tfr-6-7111.xml"),
        fx.uscg_notice(58067),
        fx.broadcast_notice("navarea-xii-in-force-2026-11-13.txt", "NAVAREA XII 745/26"),
    ):
        record = json.loads(json.dumps(notice_record(notice)))
        assert notice_from_record(record) == notice
