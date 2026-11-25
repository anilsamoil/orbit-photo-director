from __future__ import annotations

import json
import re
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from xml.etree import ElementTree

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
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web

MISSING = object()


@pytest.mark.parametrize("damage", ("signal_only", "missing_times", "partial_times"))
def test_uscg_launch_requires_readable_body_and_each_area_schedule(confirmed, damage):
    web, _, _ = confirmed
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    props = next(
        feature["properties"] for feature in payload["features"]
        if feature["properties"]["MSI_UID"] == 58217
    )
    if damage == "signal_only":
        props["DESCRIPTION"] = "SPACE"
    else:
        prefix, separator, tail = props["DESCRIPTION"].partition("Hazard Area C:")
        if damage == "missing_times":
            prefix, separator, tail = "", "", props["DESCRIPTION"]
        props["DESCRIPTION"] = prefix + separator + "\n".join(
            line for line in tail.splitlines() if not re.match(r"\s*\d{6}Z", line)
        )
    web.pages[url] = json.dumps(payload).encode()
    _keeps_source(confirmed, "uscg", "USCG_ROW")


@pytest.fixture
def confirmed(tmp_path: Path):
    web = Web(complete=True)
    payload = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())
    payload["broadcast-warn"] = [
        next(row for row in payload["broadcast-warn"] if row["msgNumber"] == 1231),
    ]
    web.pages[NGA_URL.format(area="4")] = json.dumps(payload).encode()
    cache = tmp_path / "cache"
    before = refresh_sources(cache, NOW, fetch=web, pause=lambda _: None)
    assert all(entry["error"] is None for entry in before.values())
    assert len(before["faa"]["notices"]) == 5
    assert len(before["uscg"]["notices"]) == 23
    assert len(before["nga:4"]["notices"][0]["areas"]) == 2
    return web, cache, before


def _keeps_source(confirmed, source: str, code: str | None = None):
    web, cache, before = confirmed
    after = refresh_sources(
        cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
    )
    entry = after[source]
    assert entry["error"]
    if code:
        assert entry["error"] == code
    assert entry["notices"] == before[source]["notices"]
    assert entry["checked_at"] == before[source]["checked_at"] == "2026-11-13T23:40:00Z"
    assert entry["attempted_at"] == "2026-11-14T00:11:00Z"
    assert all(entry["error"] is None for key, entry in after.items() if key != source)
    assert json.loads((cache / STATE_NAME).read_bytes())["sources"] == after


@pytest.mark.parametrize("row", (
    None, 4, [], {}, {"type": None}, {"type": " "}, {"type": 7},
    {"type": "UNKNOWN", "notam_id": "6/7111"},
    {"type": "SPACE OPERATIONS"},
    *({"type": "SPACE OPERATIONS", "notam_id": value} for value in (
        None, 7111, True, "", " ", "6/711x", "../../x",
    )),
))
def test_unreadable_faa_list_row_preserves_the_confirmed_source(confirmed, row):
    web, _, _ = confirmed
    listing = json.loads(web.pages[FAA_LIST_URL])
    index = next(i for i, value in enumerate(listing) if value["notam_id"] == "6/7111")
    listing[index] = row
    web.pages[FAA_LIST_URL] = json.dumps(listing).encode()
    _keeps_source(confirmed, "faa", "FAA_ROW")


@pytest.mark.parametrize(("field", "value"), (
    ("feature", None), ("feature", 4), ("feature", []),
    ("properties", MISSING), ("properties", None),
    ("STATUS", MISSING), ("STATUS", None), ("STATUS", " "), ("STATUS", 4), ("STATUS", "Unknown"),
    ("MSI_GROUP", MISSING), ("MSI_GROUP", None), ("MSI_GROUP", " "), ("MSI_GROUP", "Unknown"),
    ("MSI_UID", MISSING), ("MSI_UID", None), ("MSI_UID", True), ("MSI_UID", -1), ("MSI_UID", "58217"),
    ("DESCRIPTION", MISSING), ("DESCRIPTION", None), ("DESCRIPTION", " \n\t"),
    ("SUB_CATEGORY", MISSING), ("SUB_CATEGORY", None), ("SUB_CATEGORY", " "), ("SUB_CATEGORY", "Unknown"),
    ("BEGIN_DATE", MISSING), ("BEGIN_DATE", None), ("BEGIN_DATE", "yesterday"), ("BEGIN_DATE", True),
    ("END_DATE", MISSING), ("END_DATE", None), ("END_DATE", -1), ("END_DATE", 4_102_444_800_001),
    ("geometry", MISSING), ("geometry", None),
    ("geometry", {"type": "Point", "coordinates": [-80, 28]}),
    ("geometry", {"type": "Polygon", "coordinates": []}),
    ("geometry", {"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]}),
))
def test_unreadable_uscg_feature_preserves_the_confirmed_source(confirmed, field, value):
    web, _, _ = confirmed
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    index = next(
        i for i, feature in enumerate(payload["features"])
        if feature["properties"]["MSI_UID"] == 58217
    )
    feature = payload["features"][index]
    if field == "feature":
        payload["features"][index] = value
    else:
        target = feature if field in {"properties", "geometry"} else feature["properties"]
        if value is MISSING:
            target.pop(field)
        else:
            target[field] = value
    web.pages[url] = json.dumps(payload).encode()
    _keeps_source(confirmed, "uscg", "USCG_ROW")


@pytest.mark.parametrize("path", (
    "NotUid/txtLocalName", "txtDescrUSNS", "TfrNot/codeType", "TfrNot/TFRAreaGroup",
    "TfrNot/TFRAreaGroup/aseTFRArea", "TfrNot/TFRAreaGroup/aseTFRArea/txtName",
    "TfrNot/TFRAreaGroup/aseTFRArea/ScheduleGroup",
    "TfrNot/TFRAreaGroup/aseTFRArea/ScheduleGroup/dateEffective",
    "TfrNot/TFRAreaGroup/aseTFRArea/ScheduleGroup/dateExpire",
    "TfrNot/TFRAreaGroup/abdMergedArea",
    "TfrNot/TFRAreaGroup/abdMergedArea/Avx/codeType",
    "TfrNot/TFRAreaGroup/abdMergedArea/Avx/geoLat",
    "TfrNot/TFRAreaGroup/abdMergedArea/Avx/geoLong",
))
def test_missing_required_faa_detail_field_preserves_the_confirmed_source(confirmed, path):
    web, _, _ = confirmed
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  committed fixture, no external XML
    notam = root.find("./Group/Add/Not")
    parent_path, _, name = path.rpartition("/")
    parent = notam.find(parent_path) if parent_path else notam
    found = parent.findall(name)
    assert found
    for node in found:
        parent.remove(node)
    web.pages[url] = ElementTree.tostring(root)
    _keeps_source(confirmed, "faa", "FAA_ROW")


@pytest.mark.parametrize(("count", "code"), ((0, "FAA_SHAPE"), (2, "FAA_ROW")))
def test_faa_detail_requires_exactly_one_notice(confirmed, count, code):
    web, _, _ = confirmed
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  committed fixture, no external XML
    parent = root.find("./Group/Add")
    notam = parent.find("Not")
    if count == 0:
        parent.remove(notam)
    else:
        parent.append(deepcopy(notam))
    web.pages[url] = ElementTree.tostring(root)
    _keeps_source(confirmed, "faa", code)


@pytest.mark.parametrize(("source", "extra"), (
    ("nga:4", {"hasMore": True}), ("nga:4", {"total": 85}),
    ("nga:4", {"continuationToken": "next"}), ("nga:4", {"unexpected": None}),
    ("uscg", {"exceededTransferLimit": True}), ("uscg", {"next": "part2"}),
    ("uscg", {"unexpected": None}),
))
def test_changed_envelopes_cannot_confirm_a_partial_source(confirmed, source, extra):
    web, _, _ = confirmed
    url = NGA_URL.format(area="4") if source == "nga:4" else USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    payload.update(extra)
    web.pages[url] = json.dumps(payload).encode()
    _keeps_source(confirmed, source)


@pytest.mark.parametrize("kind", (MISSING, None, "", "Feature"))
def test_uscg_part_must_identify_its_feature_collection(confirmed, kind):
    web, _, _ = confirmed
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    if kind is MISSING:
        payload.pop("type")
    else:
        payload["type"] = kind
    web.pages[url] = json.dumps(payload).encode()
    _keeps_source(confirmed, "uscg")


def test_an_indexed_empty_uscg_part_cannot_confirm_the_source(confirmed):
    web, _, _ = confirmed
    web.pages[USCG_FILE_URL.format(part=1)] = b'{"type":"FeatureCollection","features":[]}'
    _keeps_source(confirmed, "uscg")


def test_a_later_unreadable_uscg_part_preserves_the_whole_source(confirmed):
    web, _, _ = confirmed
    web.pages[USCG_INDEX_URL] = b'{"spaceOpsPoly_":{"counter":2}}'
    first = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[first])
    payload["features"] = [
        feature for feature in payload["features"] if feature["properties"]["MSI_UID"] != 58217
    ]
    web.pages[first] = json.dumps(payload).encode()
    web.pages[USCG_FILE_URL.format(part=2)] = b'{"type":"FeatureCollection","features":[null]}'
    web.asked.clear()
    _keeps_source(confirmed, "uscg", "USCG_ROW")
    assert first in web.asked
    assert USCG_FILE_URL.format(part=2) in web.asked


def test_a_later_unreadable_faa_detail_preserves_the_whole_source(confirmed):
    web, _, _ = confirmed
    listing = json.loads(web.pages[FAA_LIST_URL])
    web.pages[FAA_LIST_URL] = json.dumps([
        next(row for row in listing if row["notam_id"] == number)
        for number in ("6/7112", "6/7111")
    ]).encode()
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    web.pages[url] = web.pages[url].replace(b"<codeType>91.143</codeType>", b"<codeType />")
    web.asked.clear()
    _keeps_source(confirmed, "faa", "FAA_ROW")
    assert web.asked[:3] == [FAA_LIST_URL, FAA_DETAIL_URL.format(year="6", sequence="7112"), url]


@pytest.mark.parametrize(("old", "new"), (
    ("040213Z NOV 23", "990213Z NOV 23"),
    ("HAZARDOUS OPERATIONS, ROCKET LAUNCHING", "HAZARDOUS OPERATIONS ROCKET LAUNCHING"),
    ("1. HAZARDOUS", "HAZARDOUS"), ("IN AREAS BOUND BY", "WITHIN THESE LOCATIONS"),
    (None, "unreadable"),
))
def test_unreadable_nga_launch_text_preserves_the_confirmed_source(confirmed, old, new):
    web, _, _ = confirmed
    url = NGA_URL.format(area="4")
    payload = json.loads(web.pages[url])
    row = payload["broadcast-warn"][0]
    if old is None:
        row["text"] = new
    else:
        assert old in row["text"]
        row["text"] = row["text"].replace(old, new)
    web.pages[url] = json.dumps(payload).encode()
    _keeps_source(confirmed, "nga:4", "NGA_ROW")


@pytest.mark.parametrize(("path", "old", "new"), (
    ("TfrNot/TFRAreaGroup/abdMergedArea/Avx/geoLat", "28.85444444N", "unreadable"),
    ("TfrNot/TFRAreaGroup/aseTFRArea/ScheduleGroup/dateExpire", "19:11:00", "19:12:00"),
    ("txtDescrUSNS", "!FDC 6/7111", "!FDC 6/9999"),
))
def test_reported_faa_parse_failure_cannot_confirm_a_source(confirmed, path, old, new):
    web, _, _ = confirmed
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    root = ElementTree.fromstring(web.pages[url])  # noqa: S314  committed fixture, no external XML
    field = root.find(f"./Group/Add/Not/{path}")
    assert old in field.text
    field.text = field.text.replace(old, new)
    web.pages[url] = ElementTree.tostring(root)
    _keeps_source(confirmed, "faa", "FAA_ROW")


def test_reported_nga_geometry_failure_cannot_confirm_a_source(confirmed):
    web, _, _ = confirmed
    url = NGA_URL.format(area="4")
    payload = json.loads(web.pages[url])
    row = payload["broadcast-warn"][0]
    assert "28-38.38N" in row["text"]
    row["text"] = row["text"].replace("28-38.38N", "98-38.38N")
    web.pages[url] = json.dumps(payload).encode()
    _keeps_source(confirmed, "nga:4", "NGA_ROW")


@pytest.mark.parametrize("description", ("invalid_coordinate", "unreadable"))
def test_unreadable_nonempty_uscg_description_cannot_confirm_a_source(confirmed, description):
    web, _, _ = confirmed
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    row = next(
        feature["properties"] for feature in payload["features"]
        if feature["properties"]["MSI_UID"] == 58217
    )
    assert "32.08333333N" in row["DESCRIPTION"]
    row["DESCRIPTION"] = (
        row["DESCRIPTION"].replace("32.08333333N", "132.08333333N")
        if description == "invalid_coordinate" else description
    )
    web.pages[url] = json.dumps(payload).encode()
    _keeps_source(confirmed, "uscg", "USCG_ROW")


def test_readable_relevant_sources_can_confirm_again(confirmed):
    web, cache, before = confirmed
    after = refresh_sources(cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None)
    assert all(entry["error"] is None for entry in after.values())
    for source in ("faa", "uscg", "nga:4"):
        assert after[source]["notices"] == before[source]["notices"]
        assert after[source]["checked_at"] == "2026-11-14T00:11:00Z"


def test_explicit_uscg_zero_part_index_confirms_a_real_empty_answer(confirmed):
    web, cache, _ = confirmed
    web.pages[USCG_INDEX_URL] = b'{"spaceOpsPoly_":{"counter":0}}'
    web.asked.clear()
    after = refresh_sources(cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None)
    assert after["uscg"]["error"] is None and after["uscg"]["notices"] == []
    assert after["uscg"]["checked_at"] == "2026-11-14T00:11:00Z"
    assert USCG_INDEX_URL in web.asked
    assert not any(url.startswith(USCG_FILE_URL.split("{part}")[0]) for url in web.asked)
