from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import requests

from generator.hazard_match import build_bundle
from generator.hazard_sources import (
    FAA_DETAIL_URL,
    FAA_LIST_URL,
    NGA_URL,
    STATE_NAME,
    USCG_FILE_URL,
    USCG_INDEX_URL,
    refresh_sources,
    sightings_from_state,
)
from scripts import hazard_refresh
from scripts.hazard_refresh import (
    ARTIFACT,
    PUBLICATION_RECEIPT,
    RUN_LOG,
    PublicationTarget,
    refresh_hazards,
)
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web, _output


@pytest.mark.parametrize("source", ("faa", "uscg", "nga:4", "nga:12", "nga:A", "nga:P"))
def test_unreadable_relevant_row_keeps_confirmed_hazards_and_publication(
    tmp_path: Path, source: str,
):
    web = Web(complete=True)
    if source.startswith("nga:"):
        area = source.split(":")[1]
        _, issued, text = fx.broadcast_blocks("navarea-iv-1078-26.txt")[0]
        web.pages[NGA_URL.format(area=area)] = json.dumps({
            "broadcast-warn": [{
                "navArea": area, "msgNumber": 1078, "msgYear": 2026,
                "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(), "text": text,
            }],
        }).encode()
    output = _output(tmp_path)
    cache = tmp_path / "cache"
    uploads: list[bytes] = []
    publication = PublicationTarget(
        "r2:test", lambda path, *_: uploads.append(path.read_bytes()),
    )
    first = refresh_hazards(
        cache, output, NOW, fetch=web, pause=lambda _: None, publication=publication,
    )
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    before = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    bundle = json.loads(artifact)
    assert first["ok"] and first["published"] and len(uploads) == 1
    assert len(bundle["launches"]) == 2
    assert len(fx.launch(bundle, fx.USSF_317)["geojson"]["features"]) == 3
    vulcan = fx.launch(bundle, fx.VULCAN)["geojson"]["features"]
    if source.startswith("nga:"):
        assert any("1078/26" in feature["properties"]["notice_id"] for feature in vulcan)
    else:
        assert len(vulcan) == 2

    if source == "uscg":
        url = USCG_FILE_URL.format(part=1)
        payload = json.loads(web.pages[url])
        row = next(
            feature["properties"] for feature in payload["features"]
            if feature["properties"]["MSI_UID"] == 58217
        )
        assert (row["STATUS"], row["MSI_GROUP"]) == ("Approved", "Space Operations")
        row["DESCRIPTION"] = None
    elif source == "faa":
        url = FAA_LIST_URL
        payload = json.loads(web.pages[url])
        row = next(row for row in payload if row["notam_id"] == "6/7111")
        assert row["type"] == "SPACE OPERATIONS"
        row["notam_id"] = None
    else:
        url = NGA_URL.format(area=source.split(":")[1])
        payload = json.loads(web.pages[url])
        payload["broadcast-warn"][0]["text"] = None
    web.pages[url] = json.dumps(payload).encode()

    report = refresh_hazards(
        cache, output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
        publication=publication,
    )
    after = json.loads((cache / STATE_NAME).read_bytes())["sources"][source]
    assert after["error"] == f"{source.split(':')[0].upper()}_ROW"
    assert after["notices"] == before["notices"]
    assert after["checked_at"] == before["checked_at"] == "2026-11-13T23:40:00Z"
    assert after["attempted_at"] == "2026-11-14T00:11:00Z"
    assert (report["ok"], report["degraded"], report["reason"]) == (
        False, True, "SOURCE_REFRESH_DEGRADED",
    )
    assert (report["written"], report["published"]) == (False, False)
    assert report["revision"] == bundle["revision"] and report["launches"] == 2
    run = json.loads((output / RUN_LOG).read_bytes())
    assert run["revision"] == bundle["revision"]
    assert run["candidate_revision"] != bundle["revision"]
    assert (output / ARTIFACT).read_bytes() == artifact
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert uploads == [artifact]


def test_unreadable_required_faa_detail_field_keeps_last_good_notice(tmp_path: Path):
    web = Web(complete=True)
    cache = tmp_path / "cache"
    before = refresh_sources(cache, NOW, fetch=web, pause=lambda _: None)["faa"]
    url = FAA_DETAIL_URL.format(year="6", sequence="7111")
    assert web.pages[url].count(b"<codeType>91.143</codeType>") == 1
    web.pages[url] = web.pages[url].replace(
        b"<codeType>91.143</codeType>", b"<codeType />",
    )

    after = refresh_sources(
        cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
    )["faa"]

    assert after["error"] == "FAA_ROW"
    assert after["notices"] == before["notices"]
    assert after["checked_at"] == before["checked_at"] == "2026-11-13T23:40:00Z"
    retained = next(row for row in after["notices"] if row["notice_id"] == "TFR 6/7111")
    assert retained["kind"] == "launch" and len(retained["areas"]) == 1
    assert len(retained["areas"][0]["ring"]) > 3


def test_unreadable_row_exits_two_through_the_actual_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
):
    web = Web(complete=True)
    output = _output(tmp_path)
    cache = tmp_path / "cache"
    refresh_hazards(cache, output, NOW, fetch=web, pause=lambda _: None)
    artifact = (output / ARTIFACT).read_bytes()
    listing = json.loads(web.pages[FAA_LIST_URL])
    next(row for row in listing if row["notam_id"] == "6/7111")["notam_id"] = None
    web.pages[FAA_LIST_URL] = json.dumps(listing).encode()
    uploads: list[object] = []

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW + timedelta(minutes=31)

    class Answer:
        status_code = 200

        def __init__(self, url: str):
            self.content = web(url)

    monkeypatch.setattr(hazard_refresh, "datetime", FrozenDateTime)
    monkeypatch.setattr(requests, "get", lambda url, **_: Answer(url))
    monkeypatch.setattr(
        hazard_refresh, "rclone_uploader", lambda _: lambda *args: uploads.append(args),
    )
    result = hazard_refresh.main([
        "--cache-dir", str(cache), "--output", str(output), "--publish", "--remote", "r2:test",
    ])
    report = json.loads(capsys.readouterr().out)
    assert result == 2
    assert (report["ok"], report["degraded"], report["reason"]) == (
        False, True, "SOURCE_REFRESH_DEGRADED",
    )
    assert report["sources"]["faa"] == {
        "checked_at": "2026-11-13T23:40:00Z", "error": "FAA_ROW",
    }
    assert (output / ARTIFACT).read_bytes() == artifact
    assert uploads == [] and not (output / PUBLICATION_RECEIPT).exists()


@pytest.mark.parametrize(
    ("area", "notice_id"),
    (
        ("4", "NAVAREA IV 1231/23"),
        ("12", "NAVAREA XII 1231/23"),
        ("A", "HYDROLANT 1231/23"),
        ("P", "HYDROPAC 1231/23"),
    ),
)
def test_unreadable_nga_launch_row_retains_each_required_source_snapshot(
    tmp_path: Path, area: str, notice_id: str,
):
    payload = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())
    row = next(row for row in payload["broadcast-warn"] if row["msgNumber"] == 1231)
    row.update(navArea=area, area=area)
    payload["broadcast-warn"] = [row]
    web = Web(complete=True)
    url = NGA_URL.format(area=area)
    web.pages[url] = json.dumps(payload).encode()
    checked = datetime(2023, 10, 30, 21, tzinfo=UTC)
    cache = tmp_path / "cache"
    key = f"nga:{area}"
    before = refresh_sources(cache, checked, fetch=web, pause=lambda _: None)[key]
    assert before["error"] is None
    assert [notice["notice_id"] for notice in before["notices"]] == [notice_id]
    assert len(before["notices"][0]["areas"]) == 2
    row["text"] = None
    web.pages[url] = json.dumps(payload).encode()

    after = refresh_sources(
        cache, checked + timedelta(hours=1), fetch=web, pause=lambda _: None,
    )[key]

    assert after["error"] == "NGA_ROW"
    assert after["notices"] == before["notices"]
    assert after["checked_at"] == before["checked_at"] == "2023-10-30T21:00:00Z"
    assert after["attempted_at"] == "2023-10-30T22:00:00Z"


def test_readable_security_classification_excludes_an_unreadable_faa_identifier(tmp_path: Path):
    web = Web(complete=True)
    cache = tmp_path / "cache"
    before = refresh_sources(cache, NOW, fetch=web, pause=lambda _: None)["faa"]
    listing = json.loads(web.pages[FAA_LIST_URL])
    listing.append({"type": "SECURITY", "notam_id": None})
    web.pages[FAA_LIST_URL] = json.dumps(listing).encode()

    after = refresh_sources(
        cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
    )["faa"]

    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert after["notices"] == before["notices"]


@pytest.mark.parametrize(
    ("group", "status"),
    (("Navigation", "Approved"), ("Space Operations", "Pending")),
)
def test_explicitly_excluded_uscg_rows_need_no_notice_identity_or_description(
    tmp_path: Path, group: str, status: str,
):
    web = Web(complete=True)
    cache = tmp_path / "cache"
    before = refresh_sources(cache, NOW, fetch=web, pause=lambda _: None)["uscg"]
    url = USCG_FILE_URL.format(part=1)
    payload = json.loads(web.pages[url])
    payload["features"].append({
        "type": "Feature",
        "properties": {
            "MSI_GROUP": group, "STATUS": status, "MSI_UID": None, "DESCRIPTION": None,
        },
        "geometry": None,
    })
    web.pages[url] = json.dumps(payload).encode()

    after = refresh_sources(
        cache, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None,
    )["uscg"]

    assert after["error"] is None and after["checked_at"] == "2026-11-14T00:11:00Z"
    assert [notice["notice_id"] for notice in after["notices"]] == [
        notice["notice_id"] for notice in before["notices"]
    ]
    assert [notice["areas"] for notice in after["notices"]] == [
        notice["areas"] for notice in before["notices"]
    ]


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
def test_readable_non_space_nga_warning_is_a_successful_empty_source(
    tmp_path: Path, area: str,
):
    payload = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())
    row = next(row for row in payload["broadcast-warn"] if row["msgNumber"] == 1231)
    row.update(
        navArea=area, area=area,
        text="WESTERN NORTH ATLANTIC.\n1. CABLE LAYING OPERATIONS IN PROGRESS.\n",
    )
    payload["broadcast-warn"] = [row]
    web = Web(complete=True)
    web.pages[NGA_URL.format(area=area)] = json.dumps(payload).encode()
    sources = refresh_sources(
        tmp_path / "cache", NOW, fetch=web, pause=lambda _: None,
    )

    assert sources[f"nga:{area}"]["error"] is None
    assert sources[f"nga:{area}"]["notices"] == []
    assert sources[f"nga:{area}"]["checked_at"] == "2026-11-13T23:40:00Z"


def test_malformed_nga_launch_row_retains_last_good_geometry_and_confirmation(tmp_path: Path):
    raw = (fx.NOTICES / fx.NGA_2023).read_bytes()
    payload = json.loads(raw)
    assert len(payload["broadcast-warn"]) == 85
    payload["broadcast-warn"] = [
        row for row in payload["broadcast-warn"] if (row["msgNumber"], row["msgYear"])
        not in {(1100, 2023), (329, 2023), (222, 2023)}
    ]
    assert len(payload["broadcast-warn"]) == 82
    raw = json.dumps(payload).encode()
    launch = next(row for row in payload["broadcast-warn"] if row["msgNumber"] == 1231)
    launch["issueDate"] = "yesterday"
    answers = [raw, json.dumps(payload).encode()]

    def fetch(url: str) -> bytes:
        if url == NGA_URL.format(area="4"):
            return answers.pop(0)
        if url == FAA_LIST_URL:
            return b"[]"
        if url == USCG_INDEX_URL:
            return b'{"spaceOpsPoly_": {"counter": 0}}'
        assert url in {NGA_URL.format(area=area) for area in ("12", "A", "P")}
        return b'{"broadcast-warn": []}'

    checked = datetime(2023, 10, 30, 21, tzinfo=UTC)
    now = checked + timedelta(hours=1)
    cache = tmp_path / "cache"
    before_sources = refresh_sources(cache, checked, fetch=fetch, pause=lambda _: None)
    after_sources = refresh_sources(cache, now, fetch=fetch, pause=lambda _: None)
    before, after = before_sources["nga:4"], after_sources["nga:4"]
    item = json.loads((fx.FIXTURES / "launch-starlink-6-25-2023.json").read_bytes())["item"]

    def bundle(sources: dict) -> dict:
        return build_bundle([item], sightings_from_state(sources, now), now)[0]

    before_launch = fx.launch(bundle(before_sources), fx.STARLINK_6_25)
    assert len(before_launch["geojson"]["features"]) == 2
    assert bundle(after_sources)["launches"] == [before_launch]
    assert after["error"] == "NGA_ROW"
    assert after["checked_at"] == before["checked_at"] == "2023-10-30T21:00:00Z"
