from __future__ import annotations

import json
import re
from datetime import timedelta
from pathlib import Path

import pytest

from generator.hazard_sources import (
    FAA_DETAIL_URL,
    FAA_LIST_URL,
    NGA_URL,
    STATE_NAME,
    USCG_FILE_URL,
    USCG_INDEX_URL,
    refresh_sources,
)
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web, _output


def _nga_page(area: str) -> bytes:
    _, issued, text = fx.broadcast_blocks("navarea-xii-785-26.txt")[0]
    return json.dumps({"broadcast-warn": [{
        "navArea": area, "msgNumber": 785, "msgYear": 2026,
        "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(), "text": text,
    }]}).encode()


@pytest.fixture
def published(tmp_path: Path):
    web = Web(complete=True)
    for area in ("4", "12", "A", "P"):
        web.pages[NGA_URL.format(area=area)] = _nga_page(area)
    cache = tmp_path / "cache"
    output = _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("r2:test", lambda path, *_: uploads.append(path.read_bytes()))
    report = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    assert report["ok"] and report["published"] and uploads == [artifact]
    assert len(before["faa"]["notices"]) == 5 and len(before["uscg"]["notices"]) == 23
    return web, cache, output, publication, uploads, before, artifact, receipt


def _retains_publication(published, source: str):
    web, cache, output, publication, uploads, before, artifact, receipt = published
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    assert after[source]["error"], source
    assert after[source]["notices"] == before[source]["notices"]
    assert after[source]["checked_at"] == before[source]["checked_at"]
    assert after[source]["attempted_at"] == "2026-11-14T00:11:00Z"
    assert all(entry["error"] is None for key, entry in after.items() if key != source)
    assert report["degraded"] and not report["ok"]
    assert not report["written"] and not report["published"]
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]


def _publishes_source(published, source: str, notice_ids: set[str]) -> None:
    web, cache, output, publication, uploads, _, _, _ = published
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert {notice["notice_id"] for notice in after["notices"]} == notice_ids
    assert len(uploads) == 2 and uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("damage", (
    "start_zone", "end_zone", "start_digits", "unknown_schedule", "schedule_suffix",
    "missing_schedule_and_invalid_other", "missing_schedule_and_long_other",
    "area_heading", "area_heading_letter", "coordinate_line", "coordinate_outside_area",
))
def test_unreadable_uscg_body_cannot_renew_or_publish(published, damage: str):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == 58217)
    text = row["DESCRIPTION"]
    if damage.startswith("missing_schedule"):
        head, tail = text.split("Hazard Area C:")
        tail = "\n".join(line for line in tail.splitlines() if not re.match(r"\s*\d{6}Z", line))
        text = head + "Hazard Area C:" + tail
        if damage.endswith("invalid_other"):
            text = text.replace("130423Z NOV TO 130846Z", "990423Z NOV TO 130846Z")
        else:
            text = text.replace("130423Z NOV TO 130846Z", "130423Z NOV TO 160846Z")
    else:
        old, new = {
            "start_zone": ("140409Z NOV TO 140852Z", "140409X NOV TO 140852Z"),
            "end_zone": ("140409Z NOV TO 140852Z", "140409Z NOV TO 140852X"),
            "start_digits": ("140409Z NOV TO 140852Z", "40409Z NOV TO 140852Z"),
            "unknown_schedule": ("140409Z NOV TO 140852Z", "UNREADABLE NOV TO 140852Z"),
            "schedule_suffix": ("140409Z NOV TO 140852Z NOV 2026", "140409Z NOV TO 140852Z NOV 2026 OR LATER"),
            "area_heading": ("Hazard Area C:", "Hazard Area C."),
            "area_heading_letter": ("Hazard Area C:", "Hazard Area C?:"),
            "coordinate_line": ("29.03333333N, -117.98333333W", "UNREADABLE COORDINATE"),
            "coordinate_outside_area": ("Hazard Area C:", "Unknown area C:"),
        }[damage]
        assert old in text
        text = text.replace(old, new)
    row["DESCRIPTION"] = text
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize(("uid", "old", "new"), (
    (58060, "142245Z NOV 26 to 150040Z", "142245X NOV 26 to 150040Z"),
    (58060, "between 2245Z and 0040Z", "between 2545Z and 0040Z"),
    (58067, "Primary and backup launch day hazard periods include:",
     "Primary and backup launch day hazard periods include 990423Z NOV TO 130846Z NOV 2026:"),
    (58217, "140409Z NOV TO 140852Z NOV 2026---- (BACKUP DAY)",
     "1. 140409X NOV TO 140852Z NOV 2026---- (BACKUP DAY)"),
    (58217, "140409Z NOV TO 140852Z NOV 2026---- (BACKUP DAY)",
     "Mariners: 140409X NOV TO 140852Z NOV 2026---- (BACKUP DAY)"),
    (58217, "140409Z NOV TO 140852Z NOV 2026---- (BACKUP DAY)",
     "Hazard Times\n140409Z NOV TO 140852Z NOV 2026---- (BACKUP DAY)"),
))
def test_uscg_section_words_cannot_discard_schedule_fragments(published, uid, old, new):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == uid)
    assert old in row["DESCRIPTION"]
    row["DESCRIPTION"] = row["DESCRIPTION"].replace(old, new)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


def test_a_prose_primary_schedule_cannot_mask_empty_backup_section(published):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == 58060)
    parts = row["DESCRIPTION"].split("•")
    assert len(parts) == 8
    row["DESCRIPTION"] = parts[0] + "•" + parts[-1]
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("uid", (58224, 58225))
def test_a_uscg_section_needs_explicit_exclusion_before_its_points_are_ignored(published, uid):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == uid)
    row["DESCRIPTION"] = row["DESCRIPTION"].replace("FOLLOWING HAZARD AREAS", "FOLLOWING HAZRD AREAS")
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("uid", (58060, 58296, 58298, 58306, 58119))
def test_a_uscg_listing_needs_a_readable_body_not_one_space_keyword(published, uid):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == uid)
    row["DESCRIPTION"] = "SPACE RECOVERY" if uid in (58306, 58119) else "SPACE"
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("damage", (
    "one_bound", "one_label", "one_schedule", "cancel_zone", "cancel_missing", "cancel_heading",
    "cancel_extra", "unexplained_paragraph",
))
def test_every_nga_source_requires_the_complete_relevant_body(published, area, damage):
    web = published[0]
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    row = payload["broadcast-warn"][0]
    text = row["text"]
    if damage == "one_bound":
        head, tail = text.split("C. 130423Z")
        text = head + "C. 130423Z" + tail.replace("IN AREA BOUND BY", "WITHIN THESE LOCATIONS")
    elif damage == "cancel_missing":
        text = text[:text.index("2. CANCEL")]
    else:
        old, new = {
            "one_label": ("C. 130423Z", "C? 130423Z"),
            "one_schedule": ("140409Z TO 140852Z", "140409X TO 140852Z"),
            "cancel_zone": ("CANCEL THIS MSG 190843Z", "CANCEL THIS MSG 190843X"),
            "cancel_heading": ("2. CANCEL THIS MSG", "2. CANCELL THIS MSG"),
            "cancel_extra": ("NOV 26.//", "NOV 26. AND CANCEL UNREADABLE.//"),
            "unexplained_paragraph": ("2. CANCEL", "2. ADDITIONAL HAZARD AREA UNREADABLE.\n3. CANCEL"),
        }[damage]
        assert old in text
        text = text.replace(old, new)
    row["text"] = text
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, f"nga:{area}")


@pytest.mark.parametrize("case", (
    "faa_field", "uscg_collection", "uscg_field", "uscg_index", "uscg_counter",
    "nga4_collection", "nga12_collection", "ngaA_collection", "ngaP_collection", "nga_field",
))
def test_duplicate_json_keys_cannot_discard_relevant_input(published, case):
    web = published[0]
    if case == "faa_field":
        source, url = "faa", FAA_LIST_URL
        web.pages[url] = b'[{"type":"SPACE OPERATIONS","type":"SECURITY","notam_id":"6/7111"}]'
    elif case == "uscg_index":
        source, url = "uscg", USCG_INDEX_URL
        web.pages[url] = b'{"spaceOpsPoly_":{"counter":1},"spaceOpsPoly_":{"counter":0}}'
    elif case == "uscg_counter":
        source, url = "uscg", USCG_INDEX_URL
        web.pages[url] = b'{"spaceOpsPoly_":{"counter":1,"counter":0}}'
    elif case == "uscg_collection":
        source, url = "uscg", USCG_FILE_URL.format(part=1)
        page = json.loads(web.pages[url])
        web.pages[url] = (
            b'{"type":"FeatureCollection","features":' + json.dumps(page["features"]).encode()
            + b',"features":[' + json.dumps(page["features"][0]).encode() + b']}'
        )
    elif case == "uscg_field":
        source, url = "uscg", USCG_FILE_URL.format(part=1)
        page = json.dumps(json.loads(web.pages[url])).encode()
        assert b'"STATUS": "Approved"' in page
        web.pages[url] = page.replace(b'"STATUS": "Approved"', b'"STATUS":"Approved","STATUS":"Draft"')
    else:
        area = "12" if case == "nga_field" else case[3:].split("_")[0]
        source, url = f"nga:{area}", NGA_URL.format(area=area)
        if case == "nga_field":
            web.pages[url] = web.pages[url].replace(b'"text":', b'"text":"UNREADABLE","text":')
        else:
            web.pages[url] = web.pages[url][:-1] + b',"broadcast-warn":[]}'
    _retains_publication(published, source)


def test_duplicate_cached_source_keys_are_not_a_confirmation(published):
    web, cache, _, _, _, _, _, _ = published
    path = cache / STATE_NAME
    state = path.read_bytes()
    path.write_bytes(state.replace(b'"sources":', b'"sources":{"faa":null},"sources":', 1))
    web.pages.clear()
    after = refresh_sources(cache, NOW + timedelta(minutes=1), fetch=web, pause=lambda _: None)
    assert all(entry["error"] == "HTTP_503" for entry in after.values())
    assert all("checked_at" not in entry and "notices" not in entry for entry in after.values())


def test_supported_long_window_and_prose_only_notice_still_confirm(published):
    web, cache, output, publication, uploads, _, _, _ = published
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    state = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    notices = {row["notice_id"]: row for row in state["uscg"]["notices"]}
    assert report["ok"] and report["published"] and len(uploads) == 2
    assert notices["USCG LNM 58219"]["problems"] == ["WINDOW_UNPARSED:221400Z NOV TO 242000Z NOV 2026"]
    assert notices["USCG LNM 58219"]["areas"][0]["windows"] == []
    assert notices["USCG LNM 58060"]["areas"] == []
    assert notices["USCG LNM 58060"]["problems"] == []


_ZONE_PRIMARY_CLAUSES = (
    (58296, "The Safety Zone will be active on November 13, 2026, from 2:00 p.m. to 9:00 p.m., local time."),
    (58298, "The Safety Zone will be active for the Starship Flight 15 launch on November 13, 2026, from 2:00 p.m. to 9:00 p.m., local time."),
    (58298, "The Safety Zone will be activated again for the Starship Flight 15 reentry/landing operation on November 14, 2026, from 1:00 p.m. to 8:00 p.m."),
)
_ZONE_BACKUP_CLAUSES = (
    (58296, "Back-up dates include November 14 - November 19, 2026, from 2:00 p.m. to 9:00 p.m., each day."),
    (58298, "Back-up dates include November 14 - November 19, 2026, from 2:00 p.m. to 9:00 p.m., each day."),
    (58298, "Back-up dates include November 15 – 20, 2026, from 1:00 p.m. to 8:00 p.m."),
)


@pytest.mark.parametrize(("uid", "clause"), (*_ZONE_PRIMARY_CLAUSES, *_ZONE_BACKUP_CLAUSES))
@pytest.mark.parametrize("damage", (
    "date_day", "date_month", "date_year", "open_hour", "open_minute", "open_meridiem",
    "close_hour", "close_minute", "close_meridiem", "empty", "suffix",
))
def test_regulated_schedule_fields_must_be_read_before_confirmation(published, uid, clause, damage):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == uid)
    assert row["DESCRIPTION"].count(clause) == 1
    if damage == "date_day":
        changed = re.sub(r"November \d+", "November 99", clause, count=1)
    elif damage == "date_month":
        changed = clause.replace("November", "Neverber", 1)
    elif damage == "date_year":
        changed = clause.replace("2026", "0000")
    elif damage.startswith(("open_", "close_")):
        prefix = "from " if damage.startswith("open_") else "to "
        clock = re.search(prefix + r"(\d+):(\d+) ([ap])\.m\.", clause)
        assert clock is not None
        hour, minute, meridiem = clock.groups()
        field = damage.split("_", 1)[1]
        replacement = (
            f"{prefix}{'13' if field == 'hour' else hour}:"
            f"{'60' if field == 'minute' else minute} "
            f"{'x' if field == 'meridiem' else meridiem}.m."
        )
        changed = clause[:clock.start()] + replacement + clause[clock.end():]
    elif damage == "empty":
        changed = (
            "Back-up dates include ." if clause.startswith("Back-up")
            else re.sub(r"on November .+", "on .", clause)
        )
    else:
        changed = clause + " Additional activation on November XX, 2026."
    assert changed != clause
    row["DESCRIPTION"] = row["DESCRIPTION"].replace(clause, changed)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")
    state = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]
    assert state["uscg"]["error"] == "USCG_ROW"


@pytest.mark.parametrize(("uid", "clause"), _ZONE_BACKUP_CLAUSES)
@pytest.mark.parametrize("damage", ("last_day", "last_month", "reversed", "empty_end"))
def test_every_regulated_backup_bound_must_be_read(published, uid, clause, damage):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == uid)
    assert row["DESCRIPTION"].count(clause) == 1
    start, end = re.split(r" [-–] ", clause, maxsplit=1)
    if damage == "last_day":
        end = re.sub(r"\d+", "99", end, count=1)
    elif damage == "last_month":
        end = end.replace("November", "Neverber") if "November" in end else "Neverber " + end
    elif damage == "reversed":
        end = re.sub(r"\d+", "1", end, count=1)
    else:
        end = end[end.index(","):]
    changed = start + " - " + end
    assert changed != clause
    row["DESCRIPTION"] = row["DESCRIPTION"].replace(clause, changed)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")
    state = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]
    assert state["uscg"]["error"] == "USCG_ROW"


@pytest.mark.parametrize("extra", (
    [[None, -117.8]],
    [[-117.8, 29.0], [-117.7, 29.0], [-117.7, 29.1], [-117.8, 29.0]],
))
def test_unsupported_polygon_rings_cannot_renew_or_publish(published, extra):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    feature = next(f for f in payload["features"] if f["properties"]["MSI_UID"] == 58217)
    assert len(feature["geometry"]["coordinates"]) == 1
    feature["geometry"]["coordinates"].append(extra)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")
    state = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]
    assert state["uscg"]["error"] == "USCG_ROW"


def test_supported_regulated_notices_keep_their_utc_metadata_and_listings(published):
    web, cache, output, publication, uploads, before, _, _ = published
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["uscg"]
    assert report["ok"] and report["published"] and len(uploads) == 2
    assert after["notices"] == before["uscg"]["notices"]
    assert len(after["notices"]) == 23
    notices = {notice["notice_id"]: notice for notice in after["notices"]}
    for uid in (58225, 58296, 58298):
        assert notices[f"USCG LNM {uid}"]["kind"] == "regulated_area"
    assert notices["USCG LNM 58296"]["valid_from"] == "2026-11-12T00:00:00Z"
    assert notices["USCG LNM 58296"]["valid_until"] == "2026-11-20T23:59:59Z"
    bundle = json.loads((output / ARTIFACT).read_bytes())
    listed = {
        item["notice_id"] for launch in bundle["launches"] for item in launch["listed"]
    }
    assert "USCG LNM 58225" in listed


@pytest.mark.parametrize("damage", (
    "area_group", "vertex", "schedule", "scalar_child",
    "unknown_XNOTAM-Update", "unknown_Group", "unknown_Add", "unknown_Not",
    "unknown_NotUid", "unknown_TfrNot", "unknown_TFRAreaGroup", "unknown_aseTFRArea",
    "unknown_ScheduleGroup", "unknown_abdMergedArea", "unknown_Avx", "unknown_InstructionsGroup",
))
def test_faa_xml_children_cannot_disappear_before_confirmation(tmp_path: Path, damage: str):
    web = Web(complete=True)
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    original = web.pages[url]
    if damage == "area_group":
        area = re.search(rb"<TFRAreaGroup>[\s\S]+?</TFRAreaGroup>", original).group()
        second = area.replace(b"<txtName>Area A</txtName>", b"<txtName>Area B</txtName>")
        second = second.replace(b"28.85444444N", b"28.85544444N")
        assert second != area
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("r2:test", lambda path, *_: uploads.append(path.read_bytes()))
    report = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    artifact, receipt = (output / ARTIFACT).read_bytes(), (output / PUBLICATION_RECEIPT).read_bytes()
    assert report["ok"] and report["published"] and uploads == [artifact]
    notice = next(n for n in before["faa"]["notices"] if n["notice_id"] == "TFR 6/7111")
    assert len(notice["areas"]) == 1
    assert len(notice["areas"][0]["ring"]) == 36
    if damage == "area_group":
        changed = original.replace(area, area + second.replace(b"TFRAreaGroup", b"TFRAreaGroux"), 1)
    elif damage == "vertex":
        merged = re.search(rb"<abdMergedArea>[\s\S]+?</abdMergedArea>", original).group()
        changed = original.replace(
            merged, merged.replace(b"<Avx>", b"<Avxx>", 1).replace(b"</Avx>", b"</Avxx>", 1), 1,
        )
    elif damage == "schedule":
        changed = original.replace(
            b"</aseTFRArea>",
            b"<ScheduleGroux><dateEffective>UNREADABLE</dateEffective></ScheduleGroux></aseTFRArea>", 1,
        )
    elif damage == "scalar_child":
        changed = original.replace(b"<codeType>91.143</codeType>", b"<codeType>91.143<unreadable/></codeType>")
    else:
        tag = damage.removeprefix("unknown_").encode()
        changed = re.sub(rb"(<" + tag + rb"\b[^>]*>)", rb"\1<unreadable/>", original, count=1)
    assert changed != original
    web.pages[url] = changed
    _retains_publication((web, cache, output, publication, uploads, before, artifact, receipt), "faa")
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    assert after["faa"]["error"] == "FAA_ROW"


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("fixture", ("navarea-iv-1078-26.txt", "navarea-xii-785-26.txt"))
@pytest.mark.parametrize("damage", ("A", "B", "C", "prefix"))
def test_nga_labels_cannot_discard_any_prefix_or_area(tmp_path, area, fixture, damage):
    web = Web(complete=True)
    _, issued, text = fx.broadcast_blocks(fixture)[0]
    number = 1078 if "1078" in fixture else 785
    row = {
        "navArea": area, "msgNumber": number, "msgYear": 2026,
        "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(), "text": text,
    }
    url = NGA_URL.format(area=area)
    web.pages[url] = json.dumps({"broadcast-warn": [row]}).encode()
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("r2:test", lambda path, *_: uploads.append(path.read_bytes()))
    report = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    artifact, receipt = (output / ARTIFACT).read_bytes(), (output / PUBLICATION_RECEIPT).read_bytes()
    source = f"nga:{area}"
    assert report["ok"] and report["published"] and uploads == [artifact]
    assert [entry["area_id"] for entry in before[source]["notices"][0]["areas"]] == ["A", "B", "C"]
    if number == 1078 and area == "4":
        features = fx.launch(json.loads(artifact), fx.VULCAN)["geojson"]["features"]
        assert {entry["properties"]["area_id"] for entry in features if entry["properties"]["notice_id"] == "NAVAREA IV 1078/26"} == {"A", "B", "C"}
    if damage == "prefix":
        row["text"] = text.replace("   A. ", "   UNREADABLE AREA\n   A. ", 1)
    else:
        row["text"] = text.replace(f"   {damage}. ", f"   {damage}? ", 1)
    assert row["text"] != text
    web.pages[url] = json.dumps({"broadcast-warn": [row]}).encode()
    _retains_publication((web, cache, output, publication, uploads, before, artifact, receipt), source)
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    assert after[source]["error"] == "NGA_ROW"


@pytest.mark.parametrize("damage", ("A", "B", "C", "prefix"))
def test_nga_diagnostics_reject_the_whole_geometry_after_unreadable_labels(damage):
    from generator.hazard_notices import parse_broadcast_warning

    notice_id, issued, text = fx.broadcast_blocks("navarea-iv-1078-26.txt")[0]
    changed = (
        text.replace("   A. ", "   UNREADABLE AREA\n   A. ", 1) if damage == "prefix"
        else text.replace(f"   {damage}. ", f"   {damage}? ", 1)
    )
    assert changed != text
    notice = parse_broadcast_warning(changed, notice_id, issued, "fixture", "fixture")
    assert not notice.areas
    assert any(problem.startswith("GEOMETRY_UNPARSED:") for problem in notice.problems)


@pytest.fixture
def published_starship(tmp_path):
    from hashlib import sha256

    from generator.launch_evidence import canonical_bytes
    from generator.launch_publish import publish_launch_catalog

    catalog = json.loads((fx.FIXTURES / "launch-catalog-2026-11-13.json").read_bytes())
    starship = next(item for item in fx.catalog_items() if item["event_id"] == fx.STARSHIP)
    catalog["items"].append(starship)
    catalog["coverage"]["listed"] += 1
    catalog["coverage"]["received"] += 1
    catalog["coverage"]["tier_counts"][starship["tier"]] += 1
    catalog["revision"] = sha256(canonical_bytes({
        key: value for key, value in catalog.items() if key != "revision"
    })).hexdigest()[:24]
    cache, output, web = tmp_path / "cache", tmp_path / "launch-output", Web(complete=True)
    publish_launch_catalog(catalog, output)
    uploads: list[bytes] = []
    publication = PublicationTarget("r2:test", lambda path, *_: uploads.append(path.read_bytes()))
    report = refresh_hazards(
        cache, output, NOW - timedelta(minutes=30), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    artifact, receipt = (output / ARTIFACT).read_bytes(), (output / PUBLICATION_RECEIPT).read_bytes()
    assert report["ok"] and report["published"] and uploads == [artifact]
    listed = {entry["notice_id"] for entry in fx.launch(json.loads(artifact), fx.STARSHIP)["listed"]}
    assert {"USCG LNM 58296", "USCG LNM 58298"} <= listed
    return web, cache, output, publication, uploads, before, artifact, receipt


@pytest.mark.parametrize("category", ("Safety Zone", "Active RNA"))
@pytest.mark.parametrize("title", (
    "Space Launch and Reentry", "Space Recovery", "Space Reentry and Launch",
))
def test_mixed_zone_activities_keep_the_launch_listing(published_starship, category, title):
    web, cache, output, publication, uploads, _, _, _ = published_starship
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == 58298)
    row["SUB_CATEGORY"] = category
    row["DESCRIPTION"] = row["DESCRIPTION"].replace("Space Launch ---", title + " ---", 1)
    web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=1), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    notices = {entry["notice_id"]: entry for entry in after["uscg"]["notices"]}
    assert report["ok"] and report["published"] and len(uploads) == 2
    assert after["uscg"]["checked_at"] == "2026-11-13T23:41:00Z"
    assert notices["USCG LNM 58298"]["kind"] == "regulated_area"
    listed = {entry["notice_id"] for entry in fx.launch(json.loads((output / ARTIFACT).read_bytes()), fx.STARSHIP)["listed"]}
    assert {"USCG LNM 58296", "USCG LNM 58298"} <= listed
    assert "USCG LNM 58306" not in listed
    assert notices["USCG LNM 58306"]["kind"] == "recovery"
    assert next(entry for entry in after["faa"]["notices"] if entry["notice_id"] == "TFR 6/7131")["kind"] == "recovery"


@pytest.mark.parametrize("damage", ("primary", "backup", "secondary", "secondary_backup", "unknown_activity"))
def test_mixed_zone_title_cannot_bypass_any_operative_body_validation(published, damage):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == 58298)
    row["DESCRIPTION"] = row["DESCRIPTION"].replace("Space Launch ---", "Space Launch and Reentry ---", 1)
    old, new = {
        "primary": ("on November 13, 2026", "on November 99, 2026"),
        "backup": ("November 14 - November 19", "November 14 - November XX"),
        "secondary": ("on November 14, 2026", "on November 99, 2026"),
        "secondary_backup": ("November 15 – 20", "November 15 – XX"),
        "unknown_activity": ("for the Starship Flight 15 launch on", "for an unreadable operation on"),
    }[damage]
    assert old in row["DESCRIPTION"]
    row["DESCRIPTION"] = row["DESCRIPTION"].replace(old, new, 1)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize(("uid", "old", "new"), (
    (58119, "Space X CRS-35 reentry", "Space X CRS-35 launch and reentry"),
    (58119, "Space X CRS-35 reentry", "Space X CRS-35 reentry and launch"),
    (58306, "for the reentry and landing on", "for the launch and reentry on"),
    (58306, "for the reentry and landing on", "for an unreadable operation on"),
))
def test_an_ambiguous_operative_activity_cannot_be_excluded(published, uid, old, new):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == uid)
    assert old in row["DESCRIPTION"]
    row["DESCRIPTION"] = row["DESCRIPTION"].replace(old, new, 1)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("name", (
    "261114 SpaceX Launch and Recovery Starship 15",
    "261114 SpaceX Recovery and Launch Starship 15",
    "261114 SpaceX Launch Starship 15 Recovery",
))
def test_a_faa_mixed_operation_name_cannot_be_excluded(published, name):
    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence="7130")
    old = b"261114 SpaceX Launch Starship 15"
    assert old in web.pages[url]
    web.pages[url] = web.pages[url].replace(old, name.encode(), 1)
    _retains_publication(published, "faa")


@pytest.mark.parametrize("uid", (58114, 58119, 58122, 58204))
@pytest.mark.parametrize("position", ("prefix", "suffix"))
def test_recovery_classification_requires_all_operative_text(published, uid, position):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == uid)
    unknown = "Additional hazardous operations are unreadable.\n"
    row["DESCRIPTION"] = (
        unknown + row["DESCRIPTION"] if position == "prefix" else row["DESCRIPTION"] + unknown
    )
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("activity", ("Launch", "Launch and Reentry", "Operations"))
def test_pure_reentry_body_cannot_override_an_unresolved_operation_header(published, activity):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == 58306)
    old = "Space Reentry Operation Safety Zone ---"
    assert old in row["DESCRIPTION"]
    row["DESCRIPTION"] = row["DESCRIPTION"].replace(old, f"Space {activity} Safety Zone ---", 1)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("name", (
    "261114 SpaceX Return to Flight", "261114 SpaceX Return Starship 15",
))
def test_a_faa_return_name_does_not_prove_nonlaunch_relevance(published, name):
    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence="7130")
    old = b"261114 SpaceX Launch Starship 15"
    assert old in web.pages[url]
    web.pages[url] = web.pages[url].replace(old, name.encode(), 1)
    _retains_publication(published, "faa")


def test_a_faa_recovery_name_cannot_override_an_explicit_launch_body(published):
    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence="7131")
    old = b"SPACE OPS AREA, ACFT OPS"
    assert old in web.pages[url]
    web.pages[url] = web.pages[url].replace(old, b"SPACE LAUNCH OPERATIONS AREA, ACFT OPS", 1)
    _retains_publication(published, "faa")


def test_launch_vehicle_subjects_do_not_invent_launch_activities(published):
    web, cache, output, publication, _, _, _, _ = published
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    for feature in payload["features"]:
        row = feature["properties"]
        if row["MSI_UID"] == 58119:
            row["DESCRIPTION"] = row["DESCRIPTION"].replace("Space X CRS-35 reentry", "Space X CRS-35 launch vehicle reentry", 1)
        if row["MSI_UID"] == 58306:
            row["DESCRIPTION"] = row["DESCRIPTION"].replace("for the reentry and landing on", "for the launch vehicle reentry and landing on", 1)
    web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["uscg"]
    assert report["ok"] and report["published"]
    for uid in (58119, 58306):
        assert next(entry for entry in after["notices"] if entry["notice_id"] == f"USCG LNM {uid}")["kind"] == "recovery"


@pytest.mark.parametrize("fixture", ("navarea-iv-1078-26.txt", "navarea-xii-785-26.txt"))
def test_strict_broadcast_bodies_reject_an_unclassified_launch_prefix(fixture):
    from generator.hazard_notices import NoticeError, parse_broadcast_warning

    notice_id, issued, text = fx.broadcast_blocks(fixture)[0]
    changed = text.replace("   A. ", "   A? ", 1)
    assert changed != text
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_broadcast_warning(changed, notice_id, issued, "fixture", "fixture", strict=True)


def test_faa_launch_vehicle_wording_is_not_a_launch_operation(published):
    web, cache, output, publication, _, _, _, _ = published
    url = FAA_DETAIL_URL.format(year="6", sequence="7131")
    old = b"SPACE OPS AREA, ACFT OPS"
    assert old in web.pages[url]
    web.pages[url] = web.pages[url].replace(old, b"SPACE LAUNCH VEHICLE REENTRY AREA, ACFT OPS", 1)
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["faa"]
    assert report["ok"] and report["published"]
    assert next(entry for entry in after["notices"] if entry["notice_id"] == "TFR 6/7131")["kind"] == "recovery"


def _preamble_published(tmp_path, area, fixture, kind="launch"):
    web = Web(complete=True)
    web.pages[FAA_LIST_URL] = b"[]"
    web.pages[USCG_INDEX_URL] = b'{"spaceOpsPoly_":{"counter":0}}'
    _, issued, text = fx.broadcast_blocks(fixture)[0]
    if kind == "space_debris":
        text = text.replace("ROCKET LAUNCHING", "SPACE DEBRIS")
    row = {
        "navArea": area, "msgNumber": 1078 if "1078" in fixture else 785, "msgYear": 2026,
        "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(), "text": text,
    }
    web.pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    cache, output = tmp_path / "cache", _output(tmp_path)
    uploads: list[bytes] = []
    publication = PublicationTarget("r2:test", lambda path, *_: uploads.append(path.read_bytes()))
    report = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    artifact, receipt = (output / ARTIFACT).read_bytes(), (output / PUBLICATION_RECEIPT).read_bytes()
    assert report["ok"] and report["published"] and uploads == [artifact]
    assert [item["area_id"] for item in before[f"nga:{area}"]["notices"][0]["areas"]] == ["A", "B", "C"]
    if fixture == "navarea-iv-1078-26.txt" and area == "4" and kind == "launch":
        assert {
            item["properties"]["area_id"]
            for item in fx.launch(json.loads(artifact), fx.VULCAN)["geojson"]["features"]
        } == {"A", "B", "C"}
    return (web, cache, output, publication, uploads, before, artifact, receipt), row


def _move_nga_first_area_to_preamble(text, damage):
    geographic, marker, first = text.partition("1. ")
    assert marker
    head, marker, tail = first.partition("   A. ")
    assert marker
    area_a, marker, rest = tail.partition("   B. ")
    assert marker
    moved = head + "   A. " + area_a
    if damage == "moved_time":
        moved, changes = re.subn(r"(\d{4})Z", r"\1X", moved, count=1)
        assert changes == 1
    elif damage == "moved_coordinate":
        moved, changes = re.subn(r"(\d{2}-\d{2}\.\d{2})[NS]", r"\1X", moved, count=1)
        assert changes == 1
    return geographic + moved + "\n1. " + head + "   B. " + rest


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("fixture", ("navarea-iv-1078-26.txt", "navarea-xii-785-26.txt"))
@pytest.mark.parametrize("kind", ("launch", "space_debris"))
@pytest.mark.parametrize("damage", (
    "moved_area", "moved_time", "moved_coordinate", "extra_area", "unknown_uppercase",
))
def test_nga_preamble_cannot_discard_operative_content(tmp_path, area, fixture, kind, damage):
    published, row = _preamble_published(tmp_path, area, fixture, kind)
    original = row["text"]
    if damage.startswith("moved_"):
        row["text"] = _move_nga_first_area_to_preamble(original, damage)
    else:
        prefix = (
            "HAZARD AREA X: 130423X TO 130846Z NOV.\n"
            if damage == "extra_area" else "UNKNOWN OPERATIONS IN PROGRESS.\n"
        )
        row["text"] = original.replace("1. ", prefix + "1. ", 1)
    assert row["text"] != original
    published[0].pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    _retains_publication(published, f"nga:{area}")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert after["error"] == "NGA_ROW"
    assert [item["area_id"] for item in after["notices"][0]["areas"]] == ["A", "B", "C"]


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("fixture", ("navarea-iv-1078-26.txt", "navarea-xii-785-26.txt"))
@pytest.mark.parametrize("kind", ("launch", "space_debris"))
def test_nga_supported_geographic_preamble_keeps_all_areas(tmp_path, area, fixture, kind):
    published, row = _preamble_published(tmp_path, area, fixture, kind)
    web, cache, output, publication, uploads, before, _, _ = published
    row["text"] = row["text"].replace("1. ", "CHART 25600, 25550.\n1. ", 1)
    web.pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert report["ok"] and not report["degraded"]
    assert report["published"] is (kind == "launch")
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert after["notices"][0]["areas"] == before[f"nga:{area}"]["notices"][0]["areas"]
    assert len(uploads) == (2 if report["published"] else 1)
    assert uploads[-1] == (output / ARTIFACT).read_bytes()
    assert json.loads((output / PUBLICATION_RECEIPT).read_bytes())


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("position", ("before_number", "inside_number", "unnumbered"))
@pytest.mark.parametrize("prefix", (
    "UNKNOWN OPERATIONS IN PROGRESS.\n",
    "UNKNOWN OPERATIONS IN PROGRESS ",
    "130423X TO 130846Z NOV.\n",
    "32-05.00X 119-08.00W.\n",
    "NEW GEOGRAPHIC NAME.\n",
))
def test_a_later_nonspace_subject_cannot_hide_an_unknown_prefix(tmp_path, area, position, prefix):
    published, row = _preamble_published(tmp_path, area, "navarea-iv-1078-26.txt")
    geographic = "WESTERN CARIBBEAN SEA.\nCOLOMBIA.\n"
    operative = "COVE ROJO LIGHTHOUSE 12-30.95N 081-43.77W UNLIT.\n"
    if position == "before_number":
        row["text"] = geographic + prefix + "1. " + operative
    elif position == "inside_number":
        row["text"] = geographic + "1. " + prefix + operative
    else:
        row["text"] = geographic + prefix + operative
    published[0].pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    _retains_publication(published, f"nga:{area}")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert after["error"] == "NGA_ROW"


def test_supported_archived_nga_geographic_preambles_still_confirm(tmp_path):
    from generator.hazard_notices import parse_nga_payload

    published, _ = _preamble_published(tmp_path, "4", "navarea-iv-1078-26.txt")
    web, cache, output, publication, uploads, _, _, _ = published
    raw = (fx.NOTICES / fx.NGA_2023).read_bytes()
    rows = json.loads(raw)["broadcast-warn"]
    unnumbered = {
        f"NAVAREA IV {row['msgNumber']}/{row['msgYear'] % 100:02d}"
        for row in rows if not re.search(r"(?m)^\s*\d{1,2}\. ", row["text"])
    }
    assert len(rows) == 85 and len(unnumbered) == 56
    rows = [row for row in rows if (row["msgNumber"], row["msgYear"])
            not in {(1100, 2023), (329, 2023), (222, 2023)}]
    unnumbered -= {"NAVAREA IV 1100/23", "NAVAREA IV 222/23"}
    raw = json.dumps({"broadcast-warn": rows}).encode()
    web.pages[NGA_URL.format(area="4")] = raw
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:4"]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    parsed = parse_nga_payload(raw, NGA_URL.format(area="4"))
    assert len(parsed) == 82 and len(unnumbered) == 54
    assert {item.notice_id for item in parsed if item.notice_id in unnumbered and item.kind == "other"} == unnumbered
    assert {item["notice_id"] for item in after["notices"]} == {"NAVAREA IV 1231/23", "NAVAREA IV 1130/23"}
    assert len(uploads) == 2 and uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("prefix", ("UNKNOWN OPERATIONS IN PROGRESS.\n", "HAZARD AREA X: 130423X TO 130846Z NOV.\n"))
@pytest.mark.parametrize("fixture", ("navarea-iv-1078-26.txt", "navarea-xii-785-26.txt"))
def test_strict_broadcast_parser_requires_consumed_geographic_preamble(prefix, fixture):
    from generator.hazard_notices import NoticeError, parse_broadcast_warning

    notice_id, issued, text = fx.broadcast_blocks(fixture)[0]
    changed = text.replace("1. ", prefix + "1. ", 1)
    with pytest.raises(NoticeError, match="^NGA_ROW$"):
        parse_broadcast_warning(changed, notice_id, issued, "fixture", "fixture", strict=True)


@pytest.mark.parametrize("numbered", (True, False))
def test_nonspace_operative_header_excludes_unreadable_nonlaunch_details(tmp_path, numbered):
    published, row = _preamble_published(tmp_path, "4", "navarea-iv-1078-26.txt")
    row["text"] = (
        "WESTERN NORTH ATLANTIC.\nFLORIDA.\n" + ("1. " if numbered else "")
        + "SURVEY OPERATIONS IN PROGRESS UNTIL UNREADABLE.\n"
        + "IN AREA BOUND BY UNREADABLE COORDINATES.\n"
    )
    published[0].pages[NGA_URL.format(area="4")] = json.dumps({"broadcast-warn": [row]}).encode()
    _publishes_source(published, "nga:4", set())


@pytest.mark.parametrize("numbered", (True, False))
def test_nonspace_operative_header_cannot_exclude_a_mixed_space_notice(tmp_path, numbered):
    published, row = _preamble_published(tmp_path, "4", "navarea-iv-1078-26.txt")
    row["text"] = (
        "WESTERN NORTH ATLANTIC.\nFLORIDA.\n" + ("1. " if numbered else "")
        + "SURVEY OPERATIONS IN PROGRESS.\n"
        + "HAZARDOUS OPERATIONS, ROCKET LAUNCHING UNREADABLE.\n"
    )
    published[0].pages[NGA_URL.format(area="4")] = json.dumps({"broadcast-warn": [row]}).encode()
    _retains_publication(published, "nga:4")


@pytest.mark.parametrize("owner", ("feature", "properties", "geometry"))
@pytest.mark.parametrize("field", ("DESCRIPTION_CONTINUED", "extraPayload", "new_metadata"))
def test_uscg_unknown_json_record_field_cannot_discard_area(published, owner, field):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    feature = next(f for f in payload["features"] if f["properties"]["MSI_UID"] == 58217)
    props = feature["properties"]
    remaining, marker, area_c = props["DESCRIPTION"].partition("Hazard Area C:")
    assert marker
    props["DESCRIPTION"] = remaining
    record = feature if owner == "feature" else feature[owner]
    record[field] = marker + area_c
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]["uscg"]
    assert after["error"] == "USCG_ROW"
    notice = next(row for row in after["notices"] if row["notice_id"] == "USCG LNM 58217")
    assert [area["area_id"] for area in notice["areas"]] == ["A", "B", "C"]


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("fixture", ("navarea-iv-1078-26.txt", "navarea-xii-785-26.txt"))
@pytest.mark.parametrize("field", ("textContinuation", "extraPayload", "new_metadata"))
@pytest.mark.parametrize("first", (True, False))
def test_nga_unknown_json_record_field_cannot_discard_area(tmp_path, area, fixture, field, first):
    published, row = _preamble_published(tmp_path, area, fixture)
    head, marker, tail = row["text"].partition("   A. ")
    assert marker
    area_a, next_marker, rest = tail.partition("   B. ")
    assert next_marker
    row["text"] = head + next_marker + rest
    moved = {field: marker + area_a}
    row = moved | row if first else row | moved
    published[0].pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    _retains_publication(published, f"nga:{area}")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert after["error"] == "NGA_ROW"
    assert [item["area_id"] for item in after["notices"][0]["areas"]] == ["A", "B", "C"]


@pytest.mark.parametrize("kind", ("SPACE OPERATIONS", "SECURITY"))
@pytest.mark.parametrize("field", ("notam_ids", "extraPayload", "new_metadata"))
def test_faa_unknown_json_record_field_prevents_confirmation(published, kind, field):
    web = published[0]
    listing = json.loads(web.pages[FAA_LIST_URL])
    row = next(row for row in listing if row["type"] == kind)
    row[field] = {"notam_id": "6/7111", "type": "SPACE OPERATIONS"}
    web.pages[FAA_LIST_URL] = json.dumps(listing).encode()
    _retains_publication(published, "faa")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]["faa"]
    assert after["error"] == "FAA_ROW"


@pytest.mark.parametrize("owner", ("feature", "properties", "geometry"))
@pytest.mark.parametrize("exclusion", ({"MSI_GROUP": "Navigation"}, {"STATUS": "Pending"}))
def test_uscg_unknown_json_record_shape_precedes_field_exclusion(published, owner, exclusion):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    feature = next(f for f in payload["features"] if f["properties"]["MSI_UID"] == 58217)
    record = feature if owner == "feature" else feature[owner]
    record["unknownPayload"] = feature["properties"]["DESCRIPTION"]
    feature["properties"].update(exclusion)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]["uscg"]
    assert after["error"] == "USCG_ROW"


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
def test_nga_unknown_json_record_field_precedes_nonspace_exclusion(tmp_path, area):
    published, row = _preamble_published(tmp_path, area, "navarea-iv-1078-26.txt")
    row["textContinuation"] = row["text"]
    row["text"] = "WESTERN NORTH ATLANTIC.\nFLORIDA.\nSURVEY OPERATIONS IN PROGRESS.\n"
    published[0].pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    _retains_publication(published, f"nga:{area}")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert after["error"] == "NGA_ROW"


def test_known_json_metadata_is_opaque_and_optional_fields_stay_optional(published):
    web, cache, output, publication, uploads, before, _, _ = published
    metadata = {"provider_specific": [None, "unused"]}
    listing = json.loads(web.pages[FAA_LIST_URL])
    for row in listing:
        for field in ("creation_date", "description", "facility", "state"):
            row[field] = metadata
    listing.append({"type": "SECURITY"})
    web.pages[FAA_LIST_URL] = json.dumps(listing).encode()
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    for feature in payload["features"]:
        feature["id"] = metadata
        for field in (
            "ATU", "COORDINATES_JSON", "COORDINATES_TYPE", "CREATE_DATE", "DECIMAL_LATITUDE",
            "DECIMAL_LONGITUDE", "ESRI_OID", "MODIFIED_DATE", "MRN", "TITLE", "TYPE",
            "WATERWAY_NAME", "WTRW_UID",
        ):
            feature["properties"][field] = metadata
    payload["features"].extend([
        {"type": "Feature", "properties": {"MSI_GROUP": "Navigation"}},
        {"type": "Feature", "properties": {"STATUS": "Pending"}},
    ])
    web.pages[url] = json.dumps(payload).encode()
    for area in ("4", "12", "A", "P"):
        url = NGA_URL.format(area=area)
        payload = json.loads(web.pages[url])
        for row in payload["broadcast-warn"]:
            for field in (
                "area", "authority", "cancelDate", "cancelMsgNumber", "cancelMsgYear",
                "cancelNavArea", "number", "status", "subregion", "year",
            ):
                row[field] = metadata
        web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    assert report["ok"] and not report["degraded"] and report["published"]
    for source, entry in after.items():
        assert entry["error"] is None and entry["checked_at"] == "2026-11-14T00:11:00Z"
        assert [notice["notice_id"] for notice in entry["notices"]] == [
            notice["notice_id"] for notice in before[source]["notices"]
        ]
        assert [notice["areas"] for notice in entry["notices"]] == [
            notice["areas"] for notice in before[source]["notices"]
        ]
    assert len(uploads) == 2 and uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("scoped", (True, False))
def test_unknown_json_record_fields_respect_only_explicit_unscoped_nga_area_exclusion(scoped):
    from generator.hazard_notices import NoticeError, parse_nga_payload

    body = b'{"broadcast-warn":[{"navArea":"1","unknownPayload":{"text":"unreadable"}}]}'
    url = NGA_URL.format(area="1") if scoped else "fixture"
    if scoped:
        with pytest.raises(NoticeError, match="^NGA_ROW$"):
            parse_nga_payload(body, url)
    else:
        assert parse_nga_payload(body, url) == []


@pytest.mark.parametrize("header", (
    "THE U.S. COAST GUARD HAS ESTABLISHED A REGULATED NAVIGATION AREA UNDER "
    "33 CFR 165.777 TO ENCOMPASS THE WATERS BOUND BY THE COORDINATES:",
    "THE U.S. SPACE FORCE AND KENNEDY SPACE CENTER MAY CHOOSE TO ENFORCE A "
    "RESTRICTED AREA AS SPECIFIED IN 33 CFR 165.777 AND 33 CFR 165.778.",
))
def test_component_exclusion_header_cannot_hide_a_uscg_hazard(published, header):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == 58217)
    row["DESCRIPTION"] = row["DESCRIPTION"].replace("Hazard Area C:", f"1. {header}\nHazard Area C:")
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("fragment", (
    "Hazard Area C: UNREADABLE", "HAZARD AREA C DETAILS UNAVAILABLE",
    "ADDITIONAL OPERATIONS ARE UNREADABLE", "UNCLASSIFIED GEOGRAPHIC HEADING",
))
@pytest.mark.parametrize("position", ("before_header", "before_area", "after_advice"))
def test_component_uscg_intro_and_advice_require_complete_known_text(published, fragment, position):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == 58217)
    text, marker, _ = row["DESCRIPTION"].partition("Hazard Area C:")
    assert marker
    if position == "before_header":
        text = fragment + "\n" + text
    elif position == "before_area":
        text = text.replace("Hazard Area A:", fragment + "\nHazard Area A:")
    else:
        text += "\nMariners are advised to remain clear of these areas for the duration of operations. " + fragment
    row["DESCRIPTION"] = text
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("prefix", ("complete_area", "unreadable_area", "unclassified"))
def test_component_uscg_prose_cannot_skip_earlier_text(published, prefix):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    rows = {f["properties"]["MSI_UID"]: f["properties"] for f in payload["features"]}
    _, marker, body = rows[58217]["DESCRIPTION"].partition("Hazard Area C:")
    assert marker
    prefix_text = {
        "complete_area": marker + body,
        "unreadable_area": "Hazard Area C: UNREADABLE\n",
        "unclassified": "UNCLASSIFIED GEOGRAPHIC HEADING --- ",
    }[prefix]
    rows[58217]["DESCRIPTION"] = prefix_text + rows[58060]["DESCRIPTION"]
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("component", ("regulated", "restricted", "prose_advice"))
@pytest.mark.parametrize("fragment", ("Hazard Area C: UNREADABLE", "ADDITIONAL OPERATIONS ARE UNREADABLE"))
def test_component_known_uscg_section_cannot_hide_unknown_suffix(published, component, fragment):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    uid = 58060 if component == "prose_advice" else 58224
    row = next(f["properties"] for f in payload["features"] if f["properties"]["MSI_UID"] == uid)
    if component == "prose_advice":
        row["DESCRIPTION"] += " " + fragment
    else:
        next_section = "4. THE U.S." if component == "regulated" else "5. THE U.S."
        assert next_section in row["DESCRIPTION"]
        row["DESCRIPTION"] = row["DESCRIPTION"].replace(next_section, fragment + "\n" + next_section)
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


@pytest.mark.parametrize("clause", (
    "ROCKET LAUNCH FROM CAPE CANAVERAL IS SCHEDULED DURING THE RESTRICTION.",
    "ROCKETS WILL LAUNCH DURING THE RESTRICTION.",
    "THE LAUNCH VEHICLE WILL LAUNCH DURING THE RESTRICTION.",
    "ADDITIONAL OPERATIONS ARE UNREADABLE.",
))
@pytest.mark.parametrize("position", ("prefix", "suffix"))
def test_component_faa_recovery_requires_the_whole_compatible_narrative(published, clause, position):
    from xml.etree import ElementTree

    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  trusted fixture bytes
    root.find("./Group/Add/Not/NotUid/txtLocalName").text = "261114 ULA Recovery Vulcan KV-01"
    narrative = root.find("./Group/Add/Not/txtDescrUSNS")
    narrative.text = clause + " " + narrative.text if position == "prefix" else narrative.text + " " + clause
    web.pages[url] = ElementTree.tostring(root)
    _retains_publication(published, "faa")


@pytest.mark.parametrize("code", ("91.137", "91.141"))
def test_component_faa_space_list_cannot_confirm_nonspace_detail(published, code):
    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    web.pages[url] = web.pages[url].replace(b"<codeType>91.143</codeType>", f"<codeType>{code}</codeType>".encode())
    _retains_publication(published, "faa")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]["faa"]
    assert after["error"] == "FAA_ROW"


@pytest.mark.parametrize("path", (
    ".", "./Group", "./Group/Add/Not", "./Group/Add/Not/NotUid",
    "./Group/Add/Not/TfrNot/codeType", "./Group/Add/Not/TfrNot/TFRAreaGroup",
    "./Group/Add/Not/TfrNot/TFRAreaGroup/aseTFRArea/ScheduleGroup",
    "./Group/Add/Not/TfrNot/TFRAreaGroup/abdMergedArea",
    "./Group/Add/Not/TfrNot/TFRAreaGroup/abdMergedArea/Avx",
    "./Group/Add/Not/TfrNot/TFRAreaGroup/abdMergedArea/Avx/geoLat",
))
def test_component_faa_unknown_owned_attribute_cannot_hide_a_vertex(published, path):
    from xml.etree import ElementTree

    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  trusted fixture bytes
    owner = root.find(path)
    geometry = root.find("./Group/Add/Not/TfrNot/TFRAreaGroup/abdMergedArea")
    vertex = geometry.findall("Avx")[1]
    owner.set("vertexContinuation", ElementTree.tostring(vertex, encoding="unicode"))
    geometry.remove(vertex)
    web.pages[url] = ElementTree.tostring(root)
    _retains_publication(published, "faa")


def test_component_faa_unknown_xml_version_cannot_confirm(published):
    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    web.pages[url] = web.pages[url].replace(b'version="0.1"', b'version="0.2"')
    _retains_publication(published, "faa")


def test_component_faa_known_metadata_attributes_remain_opaque(published):
    from xml.etree import ElementTree

    web, cache, output, publication, _, before, _, _ = published
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  trusted fixture bytes
    opaque = {"AffLocGroup", "Aac", "aseShapes", "AseUid", "Att", "AbdUid", "Frd"}
    for node in root.iter():
        if node.tag in opaque:
            node.set("providerMetadata", "unused")
    web.pages[url] = ElementTree.tostring(root)
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    assert report["ok"] and report["published"]
    assert [row["areas"] for row in after["faa"]["notices"]] == [row["areas"] for row in before["faa"]["notices"]]


@pytest.mark.parametrize("source", ("faa", "uscg", "nga:4", "nga:12", "nga:A", "nga:P"))
@pytest.mark.parametrize("field", ("kind", "domain"))
@pytest.mark.parametrize("recovered", (True, False))
def test_component_cached_source_kind_and_domain_are_revalidated(published, source, field, recovered):
    from generator.hazard_sources import SourceError

    web, cache, output, publication, uploads, before, artifact, receipt = published
    path = cache / STATE_NAME
    state = json.loads(path.read_bytes())
    notice = state["sources"][source]["notices"][0]
    notice[field] = "other" if field == "kind" else "maritime" if source == "faa" else "airspace"
    path.write_text(json.dumps(state))
    requested = []

    def fetch(url):
        requested.append(url)
        if not recovered:
            raise OSError("offline")
        return web(url)

    if recovered:
        report = refresh_hazards(
            cache, output, NOW + timedelta(minutes=1), fetch=fetch, pause=lambda _: None,
            publication=publication,
        )
        assert report["ok"] and not report["degraded"]
    else:
        with pytest.raises(SourceError, match="^SOURCE_STATE_INCOMPLETE$"):
            refresh_hazards(
                cache, output, NOW + timedelta(minutes=1), fetch=fetch, pause=lambda _: None,
                publication=publication,
            )
    assert requested
    after = json.loads(path.read_bytes())["sources"]
    if recovered:
        assert after[source]["notices"] == before[source]["notices"]
        assert after[source]["checked_at"] == "2026-11-13T23:41:00Z"
    else:
        assert "checked_at" not in after[source] and "notices" not in after[source]
        assert (output / ARTIFACT).read_bytes() == artifact
        assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
        assert uploads == [artifact]


@pytest.mark.parametrize("replacement", (58119, 58204, 58296, 58306))
@pytest.mark.parametrize("header", ("HAZARD AREA C DETAILS UNAVAILABLE", "UNCLASSIFIED GEOGRAPHIC HEADING"))
def test_component_uscg_operation_header_requires_known_geography(published, replacement, header):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    rows = {f["properties"]["MSI_UID"]: f["properties"] for f in payload["features"]}
    replacement_row = rows[replacement]
    rows[58217]["DESCRIPTION"] = (
        header + (" - " if replacement in (58204, 58296, 58306) else " --- ")
        + replacement_row["DESCRIPTION"]
    )
    rows[58217]["SUB_CATEGORY"] = replacement_row["SUB_CATEGORY"]
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, "uscg")


def test_component_uscg_known_regulated_boundary_values_do_not_become_launch_geometry(published):
    web, cache, output, publication, _, before, _, _ = published
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    for row in (feature["properties"] for feature in payload["features"]):
        if row["MSI_UID"] in (58224, 58225):
            assert "A. FROM 28-38-35N/080-37-24W" in row["DESCRIPTION"]
            row["DESCRIPTION"] = row["DESCRIPTION"].replace("A. FROM 28-38-35N/080-37-24W", "A. FROM 99-99-99N/999-99-99W")
    web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["uscg"]
    assert report["ok"] and report["published"] and after["error"] is None
    assert [notice["areas"] for notice in after["notices"]] == [notice["areas"] for notice in before["uscg"]["notices"]]


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("subject", (
    "HAZARDOUS OPERATIONS IN PROGRESS",
    "MISSILE OPERATIONS IN PROGRESS",
    "NAVIGATION PROHIBITED IN THESE AREAS",
    "ANCHORING PROHIBITED UNTIL FURTHER NOTICE",
    "SURVEY OPERATIONS IN PROGRESS. HAZARDOUS OPERATIONS IN PROGRESS",
    "CABLE LAYING OPERATIONS IN PROGRESS. HAZARDOUS OPERATIONS IN PROGRESS",
))
def test_nga_nonlaunch_subject_does_not_require_strict_body_parsing(tmp_path, area, subject):
    published, row = _preamble_published(tmp_path, area, "navarea-xii-785-26.txt")
    row["text"] = row["text"].replace("HAZARDOUS OPERATIONS, ROCKET LAUNCHING", subject)
    published[0].pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    _publishes_source(published, f"nga:{area}", set())


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("subject", (
    "PIPELINE OPERATIONS IN PROGRESS. UNKNOWN ACTIVITY",
    "UNDERWATER OPERATIONS IN PROGRESS. UNKNOWN ACTIVITY",
    "COVE ROJO LIGHTHOUSE 12-30.95N 081-43.77W UNLIT. UNKNOWN ACTIVITY",
    "VESSEL AGROUND IN 16-24.43N 061-32.25W. UNKNOWN ACTIVITY",
    "DEPTHS LESS THAN CHARTED. UNKNOWN ACTIVITY",
    "NAVAREA IV WARNINGS IN FORCE AS OF 131700Z NOV. UNKNOWN ACTIVITY",
))
def test_nga_nonlaunch_subject_cannot_hide_uncertain_activity(tmp_path, area, subject):
    published, row = _preamble_published(tmp_path, area, "navarea-xii-785-26.txt")
    before = row["text"]
    row["text"] = before.replace("HAZARDOUS OPERATIONS, ROCKET LAUNCHING", subject)
    assert row["text"] != before and row["text"].count("IN AREA BOUND BY") == 3
    published[0].pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    _retains_publication(published, f"nga:{area}")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert after["error"] == "NGA_ROW" and len(after["notices"][0]["areas"]) == 3


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("paragraph", (False, True))
def test_nga_nonspace_clause_does_not_own_an_unknown_tail(tmp_path, area, paragraph):
    published, row = _preamble_published(tmp_path, area, "navarea-xii-785-26.txt")
    row["text"] = (
        "WESTERN CARIBBEAN SEA.\nCOLOMBIA.\n"
        "1. COVE ROJO LIGHTHOUSE 12-30.95N 081-43.77W UNLIT.\n"
        + ("2. " if paragraph else "") + "UNKNOWN OPERATIONS IN PROGRESS.\n"
    )
    published[0].pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    _retains_publication(published, f"nga:{area}")


@pytest.mark.parametrize("number", (1100, 329, 222))
def test_nga_archived_nonlaunch_activity_allows_publication(tmp_path, number):
    published, _ = _preamble_published(tmp_path, "4", "navarea-xii-785-26.txt")
    rows = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    row = next(row for row in rows if row["msgNumber"] == number and row["msgYear"] == 2023)
    published[0].pages[NGA_URL.format(area="4")] = json.dumps({"broadcast-warn": [row]}).encode()
    _publishes_source(published, "nga:4", set())


def test_nga_unfiltered_archived_source_allows_publication(tmp_path):
    published, _ = _preamble_published(tmp_path, "4", "navarea-xii-785-26.txt")
    published[0].pages[NGA_URL.format(area="4")] = (fx.NOTICES / fx.NGA_2023).read_bytes()
    _publishes_source(published, "nga:4", {"NAVAREA IV 1231/23", "NAVAREA IV 1130/23"})


@pytest.mark.parametrize("number", (1215, 1212, 1178, 1118, 1198, 1142, 274, 1244, 1204))
def test_nga_complete_archived_nonspace_activity_allows_withdrawal(tmp_path, number):
    published, _ = _preamble_published(tmp_path, "4", "navarea-xii-785-26.txt")
    web, cache, output, publication, uploads, _, _, _ = published
    rows = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    row = next(row for row in rows if row["msgNumber"] == number and row["msgYear"] == 2023)
    web.pages[NGA_URL.format(area="4")] = json.dumps({"broadcast-warn": [row]}).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["nga:4"]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert after["notices"] == [] and len(uploads) == 2
    assert json.loads((output / ARTIFACT).read_bytes())["launches"] == []


@pytest.mark.parametrize("sequence", ("7129", "7130", "7131", "7111", "7112"))
@pytest.mark.parametrize("damage", ("removed_vertices", "moved_vertex", "narrative_vertex"))
def test_faa_narrative_and_xml_polygon_must_agree_before_publication(published, sequence, damage):
    from xml.etree import ElementTree

    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence=sequence)
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  committed fixture
    notam = root.find("./Group/Add/Not")
    merged = notam.find("TfrNot/TFRAreaGroup/abdMergedArea")
    vertices = merged.findall("Avx")
    narrative = notam.find("txtDescrUSNS")
    original_tokens = re.findall(r"\b\d{6}[NS]\d{7}[EW]\b", narrative.text)
    assert len(vertices) == len(original_tokens) + 1
    if damage == "removed_vertices":
        for vertex in vertices[3:-1]:
            merged.remove(vertex)
        assert len(merged.findall("Avx")) == 4
    elif damage == "moved_vertex":
        latitude = vertices[1].find("geoLat")
        latitude.text = str(float(latitude.text[:-1]) + 0.01) + latitude.text[-1]
    else:
        token = original_tokens[1]
        narrative.text = narrative.text.replace(token, "270100N0971200W", 1)
    web.pages[url] = ElementTree.tostring(root)
    _retains_publication(published, "faa")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]["faa"]
    assert after["error"] == "FAA_ROW"


@pytest.mark.parametrize("sequence", ("7129", "7130", "7131", "7111", "7112"))
@pytest.mark.parametrize("representation", ("unchanged", "rotated", "reversed", "no_closing_repeat"))
def test_faa_complete_equivalent_polygon_representations_still_publish(published, sequence, representation):
    from xml.etree import ElementTree

    web, cache, output, publication, uploads, before, _, _ = published
    url = FAA_DETAIL_URL.format(year="6", sequence=sequence)
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  committed fixture
    merged = root.find("./Group/Add/Not/TfrNot/TFRAreaGroup/abdMergedArea")
    vertices = merged.findall("Avx")
    for vertex in vertices:
        merged.remove(vertex)
    unclosed = vertices[:-1]
    if representation == "rotated":
        unclosed = unclosed[2:] + unclosed[:2]
    elif representation == "reversed":
        unclosed = list(reversed(unclosed))
    for vertex in unclosed:
        merged.append(vertex)
    if representation != "no_closing_repeat":
        merged.append(ElementTree.fromstring(ElementTree.tostring(unclosed[0])))  # noqa: S314
    web.pages[url] = ElementTree.tostring(root)
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["faa"]
    assert report["ok"] and report["published"] and len(uploads) == 2
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    old = next(row for row in before["faa"]["notices"] if row["notice_id"] == f"TFR 6/{sequence}")
    new = next(row for row in after["notices"] if row["notice_id"] == f"TFR 6/{sequence}")
    assert len(new["areas"]) == len(old["areas"]) == 1
    assert sorted(new["areas"][0]["ring"]) == sorted(old["areas"][0]["ring"])


@pytest.mark.parametrize("sequence", ("7129", "7130", "7131", "7111", "7112"))
def test_faa_primary_narrative_identity_cannot_be_replaced_by_a_later_reference(published, sequence):
    from xml.etree import ElementTree

    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence=sequence)
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  committed fixture
    narrative = root.find("./Group/Add/Not/txtDescrUSNS")
    header = f"!FDC 6/{sequence} "
    assert narrative.text.startswith(header)
    narrative.text = narrative.text.replace(header, "!FDC 6/7999 ", 1) + f" SEE {header}FOR COMPARISON."
    web.pages[url] = ElementTree.tostring(root)
    _retains_publication(published, "faa")


@pytest.mark.parametrize("sequence", ("7129", "7130", "7131", "7111", "7112"))
@pytest.mark.parametrize("damage", ("additional_period", "unknown_tail", "unknown_prefix", "final_period", "extra_area"))
def test_faa_complete_narrative_owns_every_operational_clause(published, sequence, damage):
    from copy import deepcopy
    from xml.etree import ElementTree

    web = published[0]
    url = FAA_DETAIL_URL.format(year="6", sequence=sequence)
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  committed fixture
    narrative = root.find("./Group/Add/Not/txtDescrUSNS")
    if damage == "additional_period":
        narrative.text += " ADDITIONAL PERIOD EFFECTIVE 2611151722 UTC UNTIL 2611151911 UTC."
    elif damage == "unknown_tail":
        narrative.text += " UNKNOWN OPERATIONS IN PROGRESS."
    elif damage == "unknown_prefix":
        narrative.text = "UNKNOWN OPERATIONS IN PROGRESS. " + narrative.text
    elif damage == "final_period":
        narrative.text = re.sub(r"\d{10}-\d{10}$", "2611151722-2611151911", narrative.text)
    else:
        tfr = root.find("./Group/Add/Not/TfrNot")
        extra = deepcopy(tfr.find("TFRAreaGroup"))
        extra.find("aseTFRArea/txtName").text = "Area B"
        tfr.append(extra)
    web.pages[url] = ElementTree.tostring(root)
    _retains_publication(published, "faa")


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("damage", (
    "missing_second", "out_of_order", "duplicate", "missing_first", "later_gap",
))
def test_nga_paragraph_sequence_cannot_confirm_a_partial_body(published, area, damage):
    web = published[0]
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    row = payload["broadcast-warn"][0]
    text = row["text"]
    first = text.index("1. ")
    second = text.index("2. CANCEL")
    if damage == "missing_second":
        changed = text[:second] + text[second:].replace("2. CANCEL", "3. CANCEL", 1)
    elif damage == "out_of_order":
        changed = text[:first] + text[second:] + "\n" + text[first:second]
    elif damage == "duplicate":
        changed = text + "\n" + text[second:]
    elif damage == "missing_first":
        changed = text[:first] + text[first:].replace("1. ", "2. ", 1)
        changed = changed[:second] + changed[second:].replace("2. CANCEL", "3. CANCEL", 1)
    else:
        changed = text[:second] + "2. CANCEL NAVAREA XII 784/26.\n" + text[second:].replace("2. CANCEL", "4. CANCEL", 1)
    assert changed != text
    row["text"] = changed
    web.pages[url] = json.dumps(payload).encode()
    web.pages[FAA_LIST_URL] = b"[]"
    _retains_publication(published, f"nga:{area}")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]
    assert after[f"nga:{area}"]["error"] == "NGA_ROW"
    assert after["faa"]["notices"] == []
    assert after["faa"]["checked_at"] == "2026-11-14T00:11:00Z"
    assert sum(len(launch["geojson"]["features"]) for launch in json.loads(published[6])["launches"]) == 5


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("count", (2, 3))
def test_nga_consecutive_paragraphs_still_allow_healthy_withdrawal(published, area, count):
    web, cache, output, publication, uploads, before, _, _ = published
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    row = payload["broadcast-warn"][0]
    if count == 3:
        row["text"] = row["text"].replace(
            "2. CANCEL", "2. CANCEL NAVAREA XII 784/26.\n3. CANCEL", 1,
        )
    web.pages[url] = json.dumps(payload).encode()
    web.pages[FAA_LIST_URL] = b"[]"
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    source = f"nga:{area}"
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after[source]["error"] is None
    assert after[source]["checked_at"] == "2026-11-14T00:11:00Z"
    assert after[source]["notices"][0]["areas"] == before[source]["notices"][0]["areas"]
    assert after["faa"]["notices"] == [] and len(uploads) == 2
    assert uploads[-1] == (output / ARTIFACT).read_bytes()
    assert sum(len(launch["geojson"]["features"]) for launch in json.loads(uploads[-1])["launches"]) == 4


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("text", (
    "WESTERN CARIBBEAN SEA.\nCOLOMBIA.\nCOVE ROJO LIGHTHOUSE 12-30.95N 081-43.77W UNLIT.\n",
    "CABLE LAYING OPERATIONS IN PROGRESS.\n",
))
def test_nga_unnumbered_known_nonspace_body_still_confirms(published, area, text):
    web, cache, output, publication, uploads, _, _, _ = published
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    payload["broadcast-warn"][0]["text"] = text
    web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert after["notices"] == [] and len(uploads) == 2
    assert uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("uid", (58224, 58225))
@pytest.mark.parametrize("damage", (
    "missing_middle", "out_of_order", "duplicate", "missing_first", "later_gap",
))
def test_uscg_numbered_sections_cannot_confirm_a_partial_body(published, uid, damage):
    web = published[0]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(feature["properties"] for feature in payload["features"] if feature["properties"]["MSI_UID"] == uid)
    text = row["DESCRIPTION"]
    assert re.findall(r"(?m)^(\d+)\. ", text) == ["1", "2", "3", "4", "5", "6"]
    if damage == "missing_middle":
        changed = re.sub(r"(?ms)^3\. .*?(?=^4\. )", "", text, count=1)
    elif damage == "out_of_order":
        changed = text.replace("\n3. ", "\n4. ", 1).replace("\n4. THE U.S. SPACE", "\n3. THE U.S. SPACE", 1)
    elif damage == "duplicate":
        changed = text.replace("\n3. ", "\n2. ", 1)
    elif damage == "missing_first":
        changed = text.replace("\n1. ", "\n0. ", 1)
    else:
        changed = text.replace("\n6. ", "\n7. ", 1)
    assert changed != text
    row["DESCRIPTION"] = changed
    web.pages[url] = json.dumps(payload).encode()
    web.pages[FAA_LIST_URL] = b"[]"
    _retains_publication(published, "uscg")
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]
    assert after["uscg"]["error"] == "USCG_ROW"
    assert after["faa"]["notices"] == []
    assert after["faa"]["checked_at"] == "2026-11-14T00:11:00Z"


@pytest.mark.parametrize("uid", (58224, 58225))
def test_uscg_consecutive_numbered_sections_still_allow_healthy_withdrawal(published, uid):
    web, cache, output, publication, uploads, before, _, _ = published
    notice = next(item for item in before["uscg"]["notices"] if item["notice_id"] == f"USCG LNM {uid}")
    assert notice["areas"] and notice["problems"] == []
    web.pages[FAA_LIST_URL] = b"[]"
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["uscg"]["error"] is None and after["uscg"]["notices"] == before["uscg"]["notices"]
    assert after["faa"]["notices"] == [] and len(uploads) == 2
    assert uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("uid", (58224, 58225))
@pytest.mark.parametrize(("field", "value"), (("MSI_GROUP", "Navigation"), ("STATUS", "Draft")))
def test_uscg_excluded_group_or_status_does_not_require_body_numbering(published, uid, field, value):
    web, cache, output, publication, uploads, _, _, _ = published
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(feature["properties"] for feature in payload["features"] if feature["properties"]["MSI_UID"] == uid)
    row[field] = value
    row["DESCRIPTION"] = row["DESCRIPTION"].replace("\n6. ", "\n7. ", 1)
    web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]["uscg"]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["error"] is None and len(uploads) == 2
    assert all(notice["notice_id"] != f"USCG LNM {uid}" for notice in after["notices"])


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("text", (
    "1. CABLE LAYING OPERATIONS IN PROGRESS. 3. CANCEL NAVAREA XII 784/26.",
    "1. CABLE LAYING OPERATIONS IN PROGRESS. 3.CANCEL NAVAREA XII 784/26.",
    "1. CABLE LAYING OPERATIONS IN PROGRESS. 1. CANCEL NAVAREA XII 784/26.",
    "1. CABLE LAYING OPERATIONS IN PROGRESS. 1.CANCEL NAVAREA XII 784/26.",
    "CABLE LAYING OPERATIONS IN PROGRESS. 3. CANCEL NAVAREA XII 784/26.",
    "CABLE LAYING OPERATIONS IN PROGRESS. 3.CANCEL NAVAREA XII 784/26.",
    "1. CABLE LAYING OPERATIONS IN PROGRESS.\n3.CANCEL THIS MSG 150001Z NOV 26.",
    "1. CABLE LAYING OPERATIONS IN PROGRESS. 3. CANCEL NAVAREA XII 784/26. "
    "2. CANCEL THIS MSG 150001Z NOV 26.",
    "1. CABLE LAYING OPERATIONS IN PROGRESS. 2. CANCEL NAVAREA XII 784/26. "
    "4. CANCEL THIS MSG 150001Z NOV 26.",
    "1. CABLE LAYING OPERATIONS IN PROGRESS. 2..CANCEL NAVAREA XII 784/26.",
    "1. CABLE LAYING OPERATIONS IN PROGRESS. 2?. CANCEL NAVAREA XII 784/26.",
))
def test_nga_nonlaunch_inline_ordinal_damage_does_not_freeze_publication(published, area, text):
    web = published[0]
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    payload["broadcast-warn"][0]["text"] = text
    web.pages[url] = json.dumps(payload).encode()
    web.pages[FAA_LIST_URL] = b"[]"
    _publishes_source(published, f"nga:{area}", set())
    after = json.loads((published[1] / STATE_NAME).read_bytes())["sources"]
    assert after["faa"]["notices"] == []
    assert after["faa"]["checked_at"] == "2026-11-14T00:11:00Z"


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("space", ("", " ", "\t", "\n"))
@pytest.mark.parametrize("tail", ("\n", " \t\n", " 3.CANCEL NAVAREA XII 783/26."))
def test_nga_consecutive_inline_ordinals_and_cancellation_years_still_confirm(
    published, area, space, tail,
):
    web, cache, output, publication, uploads, _, _, _ = published
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    payload["broadcast-warn"][0]["text"] = (
        "1. CABLE LAYING OPERATIONS IN PROGRESS. "
        f"2.{space}CANCEL THIS MSG 150001Z NOV 26.{tail}"
    )
    web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert after["notices"] == [] and len(uploads) == 2
    assert uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("text", (
    "WESTERN CARIBBEAN SEA.\nCHART 28210.\n"
    "1. COVE ROJO LIGHTHOUSE 12-30.95N 081-43.77W UNLIT. "
    "2.CANCEL NAVAREA XII 784/26.",
    "1. 6.5 METER SHOAL REPORTED IN 12-30.95N 081-43.77W. "
    "2.CANCEL NAVAREA XII 784/26.",
    "1. NAVAREA IV MOBILE OFFSHORE DRILLING UNITS POSITIONS AT 181300Z OCT: "
    "A. RIG 50 12-30.95N 081-43.77W. "
    "2. TO REPORT A MOBILE OFFSHORE DRILLING UNIT AS PER IMO RESOLUTION "
    "A.1023(26), PARAGRAPH 11.5.1, CONTACT NAVSAFETY@NGA.MIL SUBJ: MODU REPORT. "
    "3.CANCEL NAVAREA IV 1121/23.",
))
def test_nga_inline_structure_preserves_numeric_body_fields(published, area, text):
    web, cache, output, publication, uploads, _, _, _ = published
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    payload["broadcast-warn"][0]["text"] = text
    web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert after["notices"] == [] and len(uploads) == 2
    assert uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("count", (2, 3))
@pytest.mark.parametrize("space", ("", " "))
def test_nga_inline_launch_schedule_bounds_and_cancellations_still_confirm(
    published, area, count, space,
):
    web, cache, output, publication, uploads, before, _, _ = published
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    text = " ".join(payload["broadcast-warn"][0]["text"].split())
    if count == 3:
        text = text.replace("2. CANCEL", "2. CANCEL NAVAREA XII 784/26. 3. CANCEL", 1)
    if not space:
        text = re.sub(r"(?<!\S)([123])\. ", r"\1.", text)
    payload["broadcast-warn"][0]["text"] = text
    web.pages[url] = json.dumps(payload).encode()
    web.pages[FAA_LIST_URL] = b"[]"
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"]
    source = f"nga:{area}"
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after[source]["error"] is None
    assert after[source]["checked_at"] == "2026-11-14T00:11:00Z"
    assert after[source]["notices"][0]["areas"] == before[source]["notices"][0]["areas"]
    assert after[source]["notices"][0]["valid_until"] == before[source]["notices"][0]["valid_until"]
    assert after[source]["notices"][0]["cancels"] == (["NAVAREA XII 784/26"] if count == 3 else [])
    assert after["faa"]["notices"] == [] and len(uploads) == 2
    assert uploads[-1] == (output / ARTIFACT).read_bytes()
    assert sum(len(launch["geojson"]["features"]) for launch in json.loads(uploads[-1])["launches"]) == 4


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("space", ("", " "))
@pytest.mark.parametrize("damage", ("gap", "duplicate", "out_of_order"))
def test_nga_inline_launch_ordinals_cannot_discard_body_structure(published, area, space, damage):
    web = published[0]
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    text = " ".join(payload["broadcast-warn"][0]["text"].split())
    if damage == "gap":
        text = text.replace("2. CANCEL", "3. CANCEL", 1)
    elif damage == "duplicate":
        text = text.replace("2. CANCEL", "1. CANCEL", 1)
    else:
        first = text.index("1. ")
        second = text.index("2. CANCEL")
        text = text[:first] + text[second:] + " " + text[first:second]
    if not space:
        text = re.sub(r"(?<!\S)([123])\. ", r"\1.", text)
    payload["broadcast-warn"][0]["text"] = text
    web.pages[url] = json.dumps(payload).encode()
    _retains_publication(published, f"nga:{area}")


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("inline", (False, True))
def test_nga_nonlaunch_archived_cancellation_ordinal_does_not_freeze(published, area, inline):
    rows = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())["broadcast-warn"]
    row = next(row for row in rows if row["msgNumber"] == 1118 and row["msgYear"] == 2023)
    assert "\n2.CANCEL THIS MSG 010001Z JAN 24." in row["text"]
    row["text"] = row["text"].replace("\n2.CANCEL", "\n3.CANCEL", 1)
    if inline:
        row["text"] = " ".join(row["text"].split())
    row["navArea"] = area
    published[0].pages[NGA_URL.format(area=area)] = json.dumps({"broadcast-warn": [row]}).encode()
    _publishes_source(published, f"nga:{area}", set())


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
def test_nga_wrapped_cancellation_fields_keep_their_year_value(published, area):
    web, cache, output, publication, uploads, _, _, _ = published
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    payload["broadcast-warn"][0]["text"] = (
        "1. CABLE LAYING OPERATIONS IN PROGRESS. 2.CANCEL\nTHIS MSG 150001Z\nNOV\n"
        "26. \t\n3.CANCEL NAVAREA XII 784/26."
    )
    web.pages[url] = json.dumps(payload).encode()
    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][f"nga:{area}"]
    assert report["ok"] and report["published"] and not report["degraded"]
    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert after["notices"] == [] and len(uploads) == 2
    assert uploads[-1] == (output / ARTIFACT).read_bytes()


@pytest.mark.parametrize("space", ("", " "))
def test_nga_diagnostic_reader_retains_best_effort_inline_numbering(space):
    from generator.hazard_notices import parse_broadcast_warning

    notice_id, issued, text = fx.broadcast_blocks("navarea-xii-785-26.txt")[0]
    text = " ".join(text.split()).replace("2. CANCEL", f"3.{space}CANCEL", 1)
    notice = parse_broadcast_warning(text, notice_id, issued, "https://example.invalid/", "0" * 64)
    assert notice.kind == "launch" and len(notice.areas) == 3
    assert notice.valid_until is not None
