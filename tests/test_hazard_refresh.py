"""Source fetching, last-good state, and the refresh run that writes hazard schema 2."""

from __future__ import annotations

import fcntl
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import requests

from generator import hazard_sources
from generator.hazard_sources import (
    FAA_DETAIL_URL,
    FAA_LIST_URL,
    NGA_URL,
    SOURCES,
    STATE_NAME,
    USCG_FILE_URL,
    USCG_INDEX_URL,
    SourceError,
    http_fetch,
    refresh_sources,
    sightings_from_state,
)
from generator.launch_publish import publish_launch_catalog
from scripts import hazard_refresh
from scripts.hazard_refresh import ARTIFACT, RUN_LOG, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx

NOW = fx.SCENARIO_NOW
HELD = ("6/7129", "6/7130", "6/7131", "6/7111", "6/7112")


class Web:
    """The public sources, answered from the fixtures. A missing address is a 503."""

    def __init__(self, *, complete: bool = False) -> None:
        listing = json.loads((fx.NOTICES / "faa-tfr-list-2026-11-13.json").read_text())
        self.pages: dict[str, bytes] = {
            FAA_LIST_URL: json.dumps([row for row in listing if row["notam_id"] in HELD or row["type"] != "SPACE OPERATIONS"]).encode(),
            USCG_INDEX_URL: json.dumps({"spaceOpsPoly_": {"counter": 1, "timestamp": 1794518101}}).encode(),
            USCG_FILE_URL.format(part=1): (fx.NOTICES / fx.USCG).read_bytes(),
        }
        for number in HELD:
            year, sequence = number.split("/")
            self.pages[FAA_DETAIL_URL.format(year=year, sequence=sequence)] = (fx.NOTICES / f"faa-tfr-{year}-{sequence}.xml").read_bytes()
        if complete:
            for area in ("4", "12", "A", "P"):
                self.pages[NGA_URL.format(area=area)] = b'{"broadcast-warn": []}'
        self.asked: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.asked.append(url)
        if url not in self.pages:
            raise SourceError("HTTP_503")
        return self.pages[url]


def _refresh(tmp_path: Path, web: Web, now: datetime = NOW) -> dict:
    return refresh_sources(tmp_path / "cache", now, fetch=web, pause=lambda _: None)


def _ids(sources: dict, name: str) -> list[str]:
    return sorted(record["notice_id"] for record in sources[name].get("notices", []))


def test_reachable_sources_are_read_and_an_unreachable_one_invents_nothing(tmp_path: Path):
    web = Web()
    sources = _refresh(tmp_path, web)
    assert list(sources) == list(SOURCES)
    assert _ids(sources, "faa") == ["TFR 6/7111", "TFR 6/7112", "TFR 6/7129", "TFR 6/7130", "TFR 6/7131"]
    assert len(_ids(sources, "uscg")) == 23
    assert sources["faa"]["checked_at"] == sources["uscg"]["checked_at"] == "2026-11-13T23:40:00Z"
    for area in ("4", "12", "A", "P"):
        assert sources[f"nga:{area}"] == {"attempted_at": "2026-11-13T23:40:00Z", "error": "HTTP_503"}
    assert NGA_URL.format(area="12") in web.asked and len(web.asked) == 12
    with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
        sightings_from_state(sources, NOW)
    assert json.loads((tmp_path / "cache" / STATE_NAME).read_text())["sources"] == sources


def test_a_failed_source_keeps_its_last_good_notices_and_their_real_checked_time(tmp_path: Path):
    web = Web(complete=True)
    _refresh(tmp_path, web)
    later = NOW + timedelta(hours=1)
    del web.pages[FAA_LIST_URL]
    web.pages[USCG_INDEX_URL] = b"<html>MSI IS CURRENTLY UNDER MAINTENANCE</html>"
    sources = _refresh(tmp_path, web, later)
    assert sources["faa"]["error"] == "HTTP_503" and sources["uscg"]["error"] == "NOT_JSON"
    assert sources["faa"]["attempted_at"] == "2026-11-14T00:40:00Z"
    assert sources["faa"]["checked_at"] == sources["uscg"]["checked_at"] == "2026-11-13T23:40:00Z"
    assert len(_ids(sources, "faa")) == 5 and len(_ids(sources, "uscg")) == 23
    assert {sighting.checked_at for sighting in sightings_from_state(sources, later)} == {NOW}


def test_one_unreadable_detail_file_keeps_the_whole_previous_faa_answer(tmp_path: Path):
    web = Web()
    _refresh(tmp_path, web)
    web.pages[FAA_DETAIL_URL.format(year="6", sequence="7111")] = b"<XNOTAM-Update>"
    listing = [row for row in json.loads(web.pages[FAA_LIST_URL]) if row["notam_id"] != "6/7131"]
    web.pages[FAA_LIST_URL] = json.dumps(listing).encode()
    sources = _refresh(tmp_path, web, NOW + timedelta(minutes=20))
    assert sources["faa"]["error"] == "FAA_NOT_XML"
    assert "TFR 6/7131" in _ids(sources, "faa") and sources["faa"]["checked_at"] == "2026-11-13T23:40:00Z"
    web.pages[FAA_DETAIL_URL.format(year="6", sequence="7111")] = web.pages[FAA_DETAIL_URL.format(year="6", sequence="7129")]
    assert _refresh(tmp_path, web, NOW + timedelta(minutes=40))["faa"]["error"] == "FAA_DETAIL_MISMATCH"


def test_a_notice_gone_from_a_good_answer_is_withdrawn_and_an_amended_one_replaces_it(tmp_path: Path):
    web = Web()
    _refresh(tmp_path, web)
    listing = [row for row in json.loads(web.pages[FAA_LIST_URL]) if row["notam_id"] != "6/7129"]
    web.pages[FAA_LIST_URL] = json.dumps(listing).encode()
    amended = web.pages[FAA_DETAIL_URL.format(year="6", sequence="7130")].replace(
        b"26.1N", b"26.2N",
    ).replace(b"260600N0965500W", b"261200N0965500W")
    web.pages[FAA_DETAIL_URL.format(year="6", sequence="7130")] = amended
    sources = _refresh(tmp_path, web, NOW + timedelta(minutes=15))
    assert _ids(sources, "faa") == ["TFR 6/7111", "TFR 6/7112", "TFR 6/7130", "TFR 6/7131"]
    assert sources["faa"]["checked_at"] == "2026-11-13T23:55:00Z"
    record = next(r for r in sources["faa"]["notices"] if r["notice_id"] == "TFR 6/7130")
    assert [26.2 in point for point in record["areas"][0]["ring"]].count(True) == 1


def test_no_source_is_asked_again_before_its_interval(tmp_path: Path):
    web = Web()
    _refresh(tmp_path, web)
    first = len(web.asked)
    _refresh(tmp_path, web, NOW + timedelta(minutes=14))
    assert len(web.asked) == first
    _refresh(tmp_path, web, NOW + timedelta(minutes=15))
    listed = [row["notam_id"] for row in json.loads(web.pages[FAA_LIST_URL]) if row["type"] == "SPACE OPERATIONS"]
    faa = [FAA_LIST_URL, *(FAA_DETAIL_URL.format(year="6", sequence=number.split("/")[1]) for number in listed)]
    assert sorted(listed) == sorted(HELD) and web.asked[first:] == faa
    again = len(web.asked)
    _refresh(tmp_path, web, NOW + timedelta(minutes=30))
    assert web.asked[again:] == [
        *faa, USCG_INDEX_URL, USCG_FILE_URL.format(part=1), *(NGA_URL.format(area=a) for a in ("4", "12", "A", "P")),
    ]
    earlier = _refresh(tmp_path, web, NOW - timedelta(hours=1))
    assert earlier["faa"]["attempted_at"] == "2026-11-13T22:40:00Z"


def test_nga_answer_is_kept_without_the_warnings_that_are_not_space_operations(tmp_path: Path):
    web = Web()
    payload = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())
    assert len(payload["broadcast-warn"]) == 85
    web.pages[NGA_URL.format(area="4")] = json.dumps(payload).encode()
    sources = _refresh(tmp_path, web)
    assert _ids(sources, "nga:4") == [
        "NAVAREA IV 1130/23", "NAVAREA IV 1231/23", "NAVAREA IV 329/23",
    ]
    assert sources["nga:4"]["error"] is None and sources["nga:12"]["error"] == "HTTP_503"
    assert sources["nga:4"]["notices"][0]["source_url"].endswith("navArea=4&status=active&output=json")


def test_source_documents_of_the_wrong_shape_fail_that_source_only(tmp_path: Path):
    for page, body, name, code in (
        (FAA_LIST_URL, b'{"rows": []}', "faa", "FAA_LIST_SHAPE"),
        (FAA_LIST_URL, json.dumps([{"type": "SPACE OPERATIONS", "notam_id": f"6/{n:04d}"} for n in range(41)]).encode(), "faa", "FAA_LIST_TOO_LONG"),
        (USCG_INDEX_URL, b'{"spaceOpsPoly_": {"counter": 99}}', "uscg", "USCG_INDEX_SHAPE"),
        (USCG_INDEX_URL, b"[]", "uscg", "USCG_INDEX_SHAPE"),
        (USCG_FILE_URL.format(part=1), b"{}", "uscg", "USCG_SHAPE"),
    ):
        web = Web()
        web.pages[page] = body
        sources = refresh_sources(tmp_path / code / str(len(body)), NOW, fetch=web, pause=lambda _: None)
        assert sources[name]["error"] == code and "checked_at" not in sources[name]
        other = "uscg" if name == "faa" else "faa"
        assert sources[other]["error"] is None
    web = Web()
    web.pages[FAA_LIST_URL] = json.dumps([{"type": "SPACE OPERATIONS", "notam_id": "../../x"}, {"type": "SECURITY", "notam_id": "6/7507"}, 4]).encode()
    web.pages[USCG_INDEX_URL] = b'{"spaceOpsPoly_": {"counter": 0}}'
    sources = _refresh(tmp_path / "empty", web)
    assert sources["faa"]["error"] == "FAA_ROW" and "checked_at" not in sources["faa"]
    assert sources["uscg"]["notices"] == []
    assert not any(url.startswith("https://tfr.faa.gov/download/") for url in web.asked)
    for incomplete in (sources, {"faa": "broken"}):
        with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
            sightings_from_state(incomplete, NOW)


def test_a_broken_state_file_recovers_and_a_busy_lock_stops_the_run(tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / STATE_NAME).write_text("{not json")
    web = Web()
    assert _refresh(tmp_path, web)["faa"]["error"] is None
    (cache / STATE_NAME).write_text(json.dumps({"schema_version": 1, "sources": {"faa": {"attempted_at": "once"}, "uscg": 3}}))
    recovered = _refresh(tmp_path, web)
    assert recovered["faa"]["error"] is None and recovered["uscg"]["error"] is None
    with (cache / f"{STATE_NAME}.lock").open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        asked = len(web.asked)
        with pytest.raises(SourceError, match="SOURCE_CACHE_BUSY"):
            _refresh(tmp_path, web, NOW + timedelta(hours=2))
        assert len(web.asked) == asked


def test_http_fetch_refuses_redirects_errors_and_oversized_bodies(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict] = []

    class Answer:
        def __init__(self, status: int, content: bytes) -> None:
            self.status_code, self.content = status, content

    answers = [Answer(200, b"ok"), Answer(302, b""), Answer(503, b"<html>"), Answer(200, b" " * 4_000_001)]

    def get(url: str, **options):
        calls.append({"url": url, **options})
        return answers.pop(0)

    monkeypatch.setattr(requests, "get", get)
    assert http_fetch("https://tfr.faa.gov/tfrapi/exportTfrList") == b"ok"
    assert calls[0]["allow_redirects"] is False and calls[0]["timeout"] == 20
    assert calls[0]["headers"] == {"User-Agent": "launch-hazard-notices/1"}
    for code in ("HTTP_302", "HTTP_503", "TOO_LARGE"):
        with pytest.raises(SourceError, match=code):
            http_fetch("https://example.invalid/")


def test_a_network_error_is_recorded_by_its_type(tmp_path: Path):
    def offline(url: str) -> bytes:
        raise requests.ConnectionError("no route to host 10.0.0.1")

    sources = refresh_sources(tmp_path, NOW, fetch=offline, pause=lambda _: None)
    assert {entry["error"] for entry in sources.values()} == {"ConnectionError"}
    assert "10.0.0.1" not in (tmp_path / STATE_NAME).read_text()


def _output(tmp_path: Path) -> Path:
    output = tmp_path / "launch-output"
    publish_launch_catalog(json.loads((fx.FIXTURES / "launch-catalog-2026-11-13.json").read_text()), output)
    return output


def test_one_run_writes_the_file_and_the_decision_log_and_uploads_only_when_asked(tmp_path: Path):
    output = _output(tmp_path)
    uploads: list[tuple[str, str, bool]] = []
    web = Web(complete=True)
    report = refresh_hazards(
        tmp_path / "cache", output, NOW, fetch=web, pause=lambda _: None,
        publication=PublicationTarget("r2:test", lambda path, relative, immutable: uploads.append((path.read_text(), relative, immutable))),
    )
    bundle = json.loads((output / ARTIFACT).read_text())
    assert ARTIFACT == "hazards/v2/launches.json"
    assert uploads == [((output / ARTIFACT).read_text(), ARTIFACT, False)]
    assert report["ok"] and report["published"] and report["written"] and report["launches"] == 2
    assert report["revision"] == bundle["revision"] and bundle["generated_at"] == "2026-11-13T23:40:00Z"
    assert [entry["event_id"] for entry in bundle["launches"]] == [fx.USSF_317, fx.VULCAN]
    assert [(n["notice_id"], n["area_id"]) for n in fx.launch(bundle, fx.VULCAN)["notices"]] == [
        ("USCG LNM 58224", "A"), ("TFR 6/7111", "6/7111"),
    ]
    assert report["sources"]["nga:4"] == {"checked_at": "2026-11-13T23:40:00Z", "error": None}
    assert report["sources"]["faa"] == {"checked_at": "2026-11-13T23:40:00Z", "error": None}
    assert report["undrawn"] == ["TFR 6/7129", "TFR 6/7130", "USCG LNM 57935", "USCG LNM 58060", "USCG LNM 58067", "USCG LNM 58218", "USCG LNM 58219"]
    run = json.loads((output / RUN_LOG).read_text())
    assert run["revision"] == bundle["revision"] and len(run["decisions"]) == 28
    assert run["catalog_revision"] == "9762bf4f3a9ac288a94797ff"
    quiet = refresh_hazards(tmp_path / "cache", output, NOW + timedelta(minutes=5), fetch=web, pause=lambda _: None, publication=PublicationTarget("r2:test", lambda *_: uploads.append(("again", "", False))))
    assert (quiet["written"], quiet["published"], len(uploads)) == (False, False, 1)
    local = refresh_hazards(tmp_path / "cache2", output, NOW, fetch=web, pause=lambda _: None)
    assert local["written"] is False and local["published"] is False


def test_a_source_outage_between_runs_keeps_the_published_areas_and_their_checked_time(tmp_path: Path):
    output = _output(tmp_path)
    web = Web(complete=True)
    refresh_hazards(tmp_path / "cache", output, NOW, fetch=web, pause=lambda _: None)
    before = json.loads((output / ARTIFACT).read_text())
    web.pages = {}
    report = refresh_hazards(tmp_path / "cache", output, NOW + timedelta(minutes=31), fetch=web, pause=lambda _: None)
    after = json.loads((output / ARTIFACT).read_text())
    assert report["sources"]["faa"] == {"checked_at": "2026-11-13T23:40:00Z", "error": "HTTP_503"}
    assert after["launches"] == before["launches"] and report["written"] is False
    assert fx.launch(after, fx.VULCAN)["notices"][0]["checked_at"] == "2026-11-13T23:40:00Z"


def test_no_current_catalog_means_no_new_file(tmp_path: Path):
    output = tmp_path / "launch-output"
    web = Web()
    with pytest.raises(ValueError, match="CATALOG_UNAVAILABLE"):
        refresh_hazards(tmp_path / "cache", output, NOW, fetch=web, pause=lambda _: None)
    output = _output(tmp_path)
    for when in (datetime(2026, 11, 13, 23, 9, tzinfo=UTC), datetime(2026, 11, 14, 0, 25, tzinfo=UTC)):
        with pytest.raises(ValueError, match="CATALOG_EXPIRED"):
            refresh_hazards(tmp_path / "cache", output, when, fetch=web, pause=lambda _: None)
    assert web.asked == [] and not (output / ARTIFACT).exists()
    with pytest.raises(ValueError, match="separate from Earth out"):
        refresh_hazards(tmp_path / "cache", tmp_path / "out" / "launch", NOW, fetch=web, pause=lambda _: None)
    with (output / ".hazard-refresh.lock").open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(RuntimeError, match="HAZARD_REFRESH_BUSY"):
            refresh_hazards(tmp_path / "cache", output, NOW, fetch=web, pause=lambda _: None)


def test_an_operator_file_can_ban_a_notice_and_a_malformed_one_stops_the_run(tmp_path: Path):
    output = _output(tmp_path)
    web = Web(complete=True)
    rules = tmp_path / "overrides.json"
    rules.write_text(json.dumps({"schema_version": 1, "pin": {}, "ban": ["TFR 6/7111", "TFR 6/7112"]}))
    refresh_hazards(tmp_path / "cache", output, NOW, fetch=web, pause=lambda _: None, overrides=rules)
    bundle = json.loads((output / ARTIFACT).read_text())
    assert [n["notice_id"] for n in fx.launch(bundle, fx.VULCAN)["notices"]] == ["USCG LNM 58224"]
    rules.write_text(json.dumps({"schema_version": 1, "pin": {"TFR 6/7111": 7}, "ban": []}))
    with pytest.raises(ValueError, match="INVALID_OVERRIDES"):
        refresh_hazards(tmp_path / "cache", output, NOW, fetch=web, pause=lambda _: None, overrides=rules)


def test_command_line_reports_and_never_uploads_without_publish(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    seen: dict = {}

    def run(cache, output, now, *, publication, overrides):
        seen.update(cache=cache, output=output, publication=publication, overrides=overrides, now=now)
        return {"ok": True, "published": False, "written": True, "revision": "0" * 16, "launches": 0, "sources": {}, "undrawn": []}

    monkeypatch.setattr(hazard_refresh, "refresh_hazards", run)
    monkeypatch.setattr(hazard_refresh, "rclone_uploader", lambda remote: pytest.fail("uploader built without --publish"))
    assert hazard_refresh.main(["--cache-dir", str(tmp_path / "c"), "--output", str(tmp_path / "o")]) == 0
    assert seen["publication"] is None and seen["overrides"] is None and seen["now"].tzinfo is UTC
    assert json.loads(capsys.readouterr().out)["revision"] == "0" * 16
    monkeypatch.setattr(hazard_refresh, "rclone_uploader", lambda remote: ("uploader", remote))
    assert hazard_refresh.main(["--cache-dir", "c", "--output", "o", "--publish", "--remote", "r2:test", "--overrides", "rules.json"]) == 0
    assert seen["publication"] == PublicationTarget("r2:test", ("uploader", "r2:test"))
    assert seen["overrides"] == Path("rules.json")
    capsys.readouterr()

    def fail(*_args, **_kwargs):
        raise ValueError("CATALOG_EXPIRED")

    monkeypatch.setattr(hazard_refresh, "refresh_hazards", fail)
    assert hazard_refresh.main(["--cache-dir", "c", "--output", "o"]) == 2
    printed = json.loads(capsys.readouterr().out)
    assert (printed["ok"], printed["reason"]) == (False, "CATALOG_EXPIRED")
    assert hazard_sources.USER_AGENT == "launch-hazard-notices/1"
