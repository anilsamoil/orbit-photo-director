from __future__ import annotations

import fcntl
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from generator.hazard_sources import (
    FAA_LIST_URL,
    NGA_URL,
    STATE_NAME,
    USCG_INDEX_URL,
    SourceError,
    refresh_sources,
)
from scripts import hazard_refresh
from scripts.hazard_refresh import ARTIFACT, PUBLICATION_RECEIPT, PublicationTarget, refresh_hazards
from tests import hazard_fixtures as fx
from tests.test_hazard_refresh import NOW, Web, _output


def complete_web() -> Web:
    return Web(complete=True)


def _run(tmp_path: Path, web: Web, *, upload=None, now=NOW, remote="r2:test", overrides=None):
    return refresh_hazards(
        tmp_path / "cache", tmp_path / "launch-output", now,
        fetch=web, pause=lambda _: None, overrides=overrides,
        publication=PublicationTarget(remote, upload) if upload else None,
    )


def _populated_output(tmp_path: Path) -> tuple[Path, bytes]:
    output = _output(tmp_path)
    target = output / ARTIFACT
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(fx.GOLDEN.read_bytes())
    return target, target.read_bytes()


@pytest.mark.parametrize("damage", ["absent", "unreadable", "missing_source", "missing_notices", "bad_record", "future_check", "bad_schema", "wrong_nga_area"])
def test_unknown_source_state_preserves_the_exact_publication(tmp_path: Path, damage: str):
    target, original = _populated_output(tmp_path)
    receipt_path = tmp_path / "launch-output" / PUBLICATION_RECEIPT
    prior_receipt = b'{"previous": "confirmation"}'
    receipt_path.write_bytes(prior_receipt)
    cache = tmp_path / "cache"
    if damage != "absent":
        refresh_sources(cache, NOW, fetch=complete_web(), pause=lambda _: None)
        state = json.loads((cache / STATE_NAME).read_text())
        if damage == "missing_source":
            del state["sources"]["nga:P"]
        elif damage == "missing_notices":
            del state["sources"]["faa"]["notices"]
        elif damage == "bad_record":
            state["sources"]["faa"]["notices"][0]["subject"] = []
        elif damage == "future_check":
            state["sources"]["faa"]["checked_at"] = "2026-11-15T00:00:00Z"
        elif damage == "bad_schema":
            state["schema_version"] = True
        elif damage == "wrong_nga_area":
            nga = complete_web()
            payload = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())
            payload["broadcast-warn"] = [row for row in payload["broadcast-warn"] if row["msgNumber"] == 1231]
            nga.pages[NGA_URL.format(area="4")] = json.dumps(payload).encode()
            confirmed = refresh_sources(tmp_path / "other-cache", NOW, fetch=nga, pause=lambda _: None)
            assert confirmed["nga:4"]["error"] is None and confirmed["nga:4"]["notices"]
            state["sources"]["nga:P"] = confirmed["nga:4"]
        (cache / STATE_NAME).write_text("{broken" if damage == "unreadable" else json.dumps(state))
    web = Web()
    web.pages = {}
    uploads = []
    with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
        _run(tmp_path, web, upload=lambda *args: uploads.append(args), now=NOW + timedelta(minutes=31))
    assert target.read_bytes() == original
    assert receipt_path.read_bytes() == prior_receipt
    assert uploads == []


def test_initial_publication_also_requires_complete_source_knowledge(tmp_path: Path):
    output = _output(tmp_path)
    uploads = []
    with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
        _run(tmp_path, Web(), upload=lambda *args: uploads.append(args))
    assert not (output / ARTIFACT).exists()
    assert uploads == []


def test_busy_source_cache_preserves_the_exact_publication(tmp_path: Path):
    target, original = _populated_output(tmp_path)
    cache = tmp_path / "cache"
    cache.mkdir()
    web = complete_web()
    uploads = []
    with (cache / f"{STATE_NAME}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with pytest.raises(SourceError, match="SOURCE_CACHE_BUSY"):
            _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    assert target.read_bytes() == original
    assert uploads == [] and web.asked == []


def test_complete_confirmed_empty_answers_can_withdraw_the_publication(tmp_path: Path):
    target, _ = _populated_output(tmp_path)
    web = complete_web()
    web.pages[FAA_LIST_URL] = b"[]"
    web.pages[USCG_INDEX_URL] = b'{"spaceOpsPoly_": {"counter": 0}}'
    uploads = []
    report = _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    assert report["ok"] is True and report["published"] is True
    assert json.loads(target.read_bytes())["launches"] == []
    assert len(uploads) == 1


def test_complete_warm_cache_keeps_original_age_and_reports_degraded_sources(tmp_path: Path):
    _output(tmp_path)
    web = complete_web()
    _run(tmp_path, web)
    target = tmp_path / "launch-output" / ARTIFACT
    original = target.read_bytes()
    web.pages = {}
    report = _run(tmp_path, web, now=NOW + timedelta(minutes=31))
    assert target.read_bytes() == original
    assert report["ok"] is False and report["degraded"] is True
    assert report["reason"] == "SOURCE_REFRESH_DEGRADED"
    assert all(entry == {"checked_at": "2026-11-13T23:40:00Z", "error": "HTTP_503"} for entry in report["sources"].values())


def test_dry_run_does_not_confirm_publication(tmp_path: Path):
    output = _output(tmp_path)
    web = complete_web()
    _run(tmp_path, web)
    assert not (output / PUBLICATION_RECEIPT).exists()
    uploads = []
    report = _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    assert len(uploads) == 1
    assert report["written"] is False and report["published"] is True


def test_failed_upload_is_retried_without_a_local_content_change(tmp_path: Path):
    _output(tmp_path)
    web = complete_web()
    uploads = []

    def upload(*args):
        uploads.append(args)
        if len(uploads) == 1:
            raise RuntimeError("UPLOAD_FAILED")

    with pytest.raises(RuntimeError, match="UPLOAD_FAILED"):
        _run(tmp_path, web, upload=upload)
    report = _run(tmp_path, web, upload=upload)
    assert len(uploads) == 2
    assert report["written"] is False and report["published"] is True


def test_crash_after_local_write_does_not_confirm_publication(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    output = _output(tmp_path)
    web = complete_web()
    uploads = []
    write = hazard_refresh._write_bytes_atomic

    def crash(path: Path, data: bytes):
        write(path, data)
        if path == output / ARTIFACT:
            raise RuntimeError("PROCESS_STOPPED")

    monkeypatch.setattr(hazard_refresh, "_write_bytes_atomic", crash)
    with pytest.raises(RuntimeError, match="PROCESS_STOPPED"):
        _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    monkeypatch.setattr(hazard_refresh, "_write_bytes_atomic", write)
    report = _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    assert len(uploads) == 1
    assert report["written"] is False and report["published"] is True


@pytest.mark.parametrize("damage", ["missing_notices", "bad_record", "future_check"])
def test_damaged_confirmed_cache_is_repaired_even_before_its_poll_interval(tmp_path: Path, damage: str):
    _output(tmp_path)
    web = complete_web()
    _run(tmp_path, web)
    path = tmp_path / "cache" / STATE_NAME
    state = json.loads(path.read_text())
    if damage == "missing_notices":
        del state["sources"]["faa"]["notices"]
    elif damage == "bad_record":
        state["sources"]["faa"]["notices"][0]["subject"] = []
    else:
        state["sources"]["faa"]["checked_at"] = "2026-11-15T00:00:00Z"
    path.write_text(json.dumps(state))
    web.asked.clear()
    report = _run(tmp_path, web, now=NOW + timedelta(minutes=1))
    assert FAA_LIST_URL in web.asked
    assert report["ok"] is True and report["launches"] == 2
    assert report["sources"]["faa"] == {"checked_at": "2026-11-13T23:41:00Z", "error": None}


def test_successful_receipt_names_only_the_effective_target_hash_and_revision(tmp_path: Path):
    output = _output(tmp_path)
    web = complete_web()
    uploads = []
    remote = "r2:test/prefix/"
    report = _run(tmp_path, web, upload=lambda *args: uploads.append(args), remote=remote)
    receipt_path = output / PUBLICATION_RECEIPT
    receipt = json.loads(receipt_path.read_text())
    assert receipt == {
        "schema_version": 1,
        "target_sha256": hashlib.sha256(b"r2:test/prefix/hazards/v2/launches.json").hexdigest(),
        "revision": report["revision"],
    }
    assert remote not in receipt_path.read_text()
    original = receipt_path.read_bytes()
    _run(tmp_path, web)
    assert receipt_path.read_bytes() == original
    quiet = _run(tmp_path, web, upload=lambda *args: uploads.append(args), remote="r2:test/prefix")
    assert len(uploads) == 1 and quiet["published"] is False


def test_changing_remote_always_requires_confirmation_for_that_remote(tmp_path: Path):
    _output(tmp_path)
    web = complete_web()
    uploads = []
    for remote in ("r2:first", "r2:second", "r2:first"):
        report = _run(tmp_path, web, upload=lambda *args: uploads.append(args), remote=remote)
        assert report["published"] is True
    assert len(uploads) == 3


@pytest.mark.parametrize("damage", ["not_json", "missing_revision", "invalid_hash", "wrong_schema", "extra_fields"])
def test_invalid_receipt_never_suppresses_an_upload(tmp_path: Path, damage: str):
    output = _output(tmp_path)
    web = complete_web()
    uploads = []
    _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    path = output / PUBLICATION_RECEIPT
    receipt = json.loads(path.read_text())
    if damage == "missing_revision":
        del receipt["revision"]
    elif damage == "invalid_hash":
        receipt["target_sha256"] = "invalid"
    elif damage == "wrong_schema":
        receipt["schema_version"] = True
    elif damage == "extra_fields":
        receipt["unexpected"] = "value"
    path.write_text("{broken" if damage == "not_json" else json.dumps(receipt))
    report = _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    assert len(uploads) == 2 and report["published"] is True


def test_crash_after_upload_and_before_receipt_retries_the_same_revision(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    output = _output(tmp_path)
    web = complete_web()
    revisions = []
    write = hazard_refresh._write_bytes_atomic

    def upload(path: Path, _relative: str, _immutable: bool):
        revisions.append(json.loads(path.read_bytes())["revision"])

    def crash(path: Path, data: bytes):
        if path == output / PUBLICATION_RECEIPT:
            raise RuntimeError("PROCESS_STOPPED")
        write(path, data)

    monkeypatch.setattr(hazard_refresh, "_write_bytes_atomic", crash)
    with pytest.raises(RuntimeError, match="PROCESS_STOPPED"):
        _run(tmp_path, web, upload=upload)
    assert not (output / PUBLICATION_RECEIPT).exists()
    monkeypatch.setattr(hazard_refresh, "_write_bytes_atomic", write)
    report = _run(tmp_path, web, upload=upload)
    assert revisions == [report["revision"], report["revision"]]
    assert report["published"] is True and report["written"] is False


def test_ambiguous_new_revision_cannot_leave_an_old_confirmation_to_skip_restoration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    output = _output(tmp_path)
    web = complete_web()
    revisions = []

    def upload(path: Path, _relative: str, _immutable: bool):
        revisions.append(json.loads(path.read_bytes())["revision"])

    original = _run(tmp_path, web, upload=upload)["revision"]
    rules = tmp_path / "overrides.json"
    rules.write_text(json.dumps({"schema_version": 1, "pin": {}, "ban": ["TFR 6/7111", "TFR 6/7112"]}))
    write = hazard_refresh._write_bytes_atomic

    def crash(path: Path, data: bytes):
        if path == output / PUBLICATION_RECEIPT:
            raise RuntimeError("PROCESS_STOPPED")
        write(path, data)

    monkeypatch.setattr(hazard_refresh, "_write_bytes_atomic", crash)
    with pytest.raises(RuntimeError, match="PROCESS_STOPPED"):
        _run(tmp_path, web, upload=upload, overrides=rules)
    assert len(revisions) == 2 and revisions[1] != original
    assert not (output / PUBLICATION_RECEIPT).exists()
    monkeypatch.setattr(hazard_refresh, "_write_bytes_atomic", write)
    restored = _run(tmp_path, web, upload=upload)
    assert revisions == [original, revisions[1], original]
    assert restored["published"] is True


def test_receipt_invalidation_failure_stops_before_any_remote_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    output = _output(tmp_path)
    web = complete_web()
    uploads = []
    _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    unlink = Path.unlink

    def refuse(path: Path, *args, **kwargs):
        if path == output / PUBLICATION_RECEIPT:
            raise PermissionError("RECEIPT_LOCKED")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", refuse)
    with pytest.raises(PermissionError, match="RECEIPT_LOCKED"):
        _run(tmp_path, web, upload=lambda *args: uploads.append(args), remote="r2:second")
    assert len(uploads) == 1
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt


@pytest.mark.parametrize("damage", ["missing_fields", "modified_content", "invalid_timestamp"])
def test_corrupt_local_bytes_cannot_be_uploaded_under_a_matching_revision(tmp_path: Path, damage: str):
    output = _output(tmp_path)
    web = complete_web()
    original = _run(tmp_path, web)
    path = output / ARTIFACT
    bundle = json.loads(path.read_text())
    if damage == "missing_fields":
        del bundle["launches"]
    elif damage == "modified_content":
        bundle["launches"] = []
    else:
        bundle["generated_at"] = "broken"
    path.write_text(json.dumps(bundle))
    uploaded = []
    report = _run(tmp_path, web, upload=lambda path, *_: uploaded.append(json.loads(path.read_bytes())))
    assert report["written"] is True and report["published"] is True
    assert uploaded[0]["revision"] == original["revision"]
    assert len(uploaded[0]["launches"]) == 2
    assert uploaded[0]["generated_at"] == "2026-11-13T23:40:00Z"


@pytest.mark.parametrize("damage", ["bool_coordinate", "string_coordinate", "invalid_ring", "invalid_window", "wrong_authority", "missing_record_field"])
def test_unusable_notice_records_never_count_as_source_confirmation(tmp_path: Path, damage: str):
    target, original = _populated_output(tmp_path)
    cache = tmp_path / "cache"
    refresh_sources(cache, NOW, fetch=complete_web(), pause=lambda _: None)
    state = json.loads((cache / STATE_NAME).read_text())
    record = state["sources"]["faa"]["notices"][0]
    if damage == "bool_coordinate":
        record["areas"][0]["ring"][0][0] = True
    elif damage == "string_coordinate":
        record["areas"][0]["ring"][0][0] = "1"
    elif damage == "invalid_ring":
        record["areas"][0]["ring"] = [[-81, 26], [-81, 27]]
    elif damage == "invalid_window":
        record["areas"][0]["windows"][0][1] = record["areas"][0]["windows"][0][0]
    elif damage == "wrong_authority":
        record["authority"] = "USCG"
    else:
        del record["source_url"]
    (cache / STATE_NAME).write_text(json.dumps(state))
    web = complete_web()
    del web.pages[FAA_LIST_URL]
    uploads = []
    with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
        _run(tmp_path, web, upload=lambda *args: uploads.append(args))
    assert target.read_bytes() == original and uploads == []


def test_degraded_refresh_is_a_nonzero_cli_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    _output(tmp_path)
    web = complete_web()
    _run(tmp_path, web)
    web.pages = {}

    def degraded(*_args, **_kwargs):
        return _run(tmp_path, web, now=NOW + timedelta(minutes=31))

    monkeypatch.setattr(hazard_refresh, "refresh_hazards", degraded)
    assert hazard_refresh.main(["--cache-dir", str(tmp_path / "cache"), "--output", str(tmp_path / "launch-output")]) == 2
    report = json.loads(capsys.readouterr().out)
    assert report["ok"] is False and report["degraded"] is True
    assert report["reason"] == "SOURCE_REFRESH_DEGRADED"


@pytest.mark.parametrize("state", ["cold", "damaged", "busy"])
def test_cli_refuses_to_replace_populated_hazards_without_source_confirmation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], state: str):
    target, original = _populated_output(tmp_path)
    assert len(json.loads(original)["launches"]) == 3
    cache = tmp_path / "cache"
    cache.mkdir()
    if state == "damaged":
        (cache / STATE_NAME).write_text("{broken")
    web = Web()
    web.pages = {}
    uploads = []

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

    def refresh(cache, output, now, **options):
        return refresh_hazards(cache, output, now, fetch=web, pause=lambda _: None, **options)

    monkeypatch.setattr(hazard_refresh, "datetime", FrozenDateTime)
    monkeypatch.setattr(hazard_refresh, "refresh_hazards", refresh)
    monkeypatch.setattr(hazard_refresh, "rclone_uploader", lambda _remote: lambda *args: uploads.append(args))
    with (cache / f"{STATE_NAME}.lock").open("a") as lock:
        if state == "busy":
            fcntl.flock(lock, fcntl.LOCK_EX)
        assert hazard_refresh.main(["--cache-dir", str(cache), "--output", str(tmp_path / "launch-output"), "--publish"]) == 2
    report = json.loads(capsys.readouterr().out)
    assert report["ok"] is False
    assert report["reason"] == ("SOURCE_CACHE_BUSY" if state == "busy" else "SOURCE_STATE_INCOMPLETE")
    assert target.read_bytes() == original and uploads == []


@pytest.mark.parametrize(("source", "notice_id", "problem"), (
    ("uscg", "USCG LNM 58217", "GEOMETRY_UNPARSED:C"),
    ("faa", "TFR 6/7111", "NUMBER_CONFLICT"),
    ("faa", "TFR 6/7111", "WINDOW_CONFLICT"),
    ("faa", "TFR 6/7111", "NARRATIVE_UNPARSED"),
    ("nga:4", "NAVAREA IV 1231/23", "GEOMETRY_UNPARSED:A"),
))
@pytest.mark.parametrize("available", (False, True))
def test_cached_fatal_diagnostic_requires_refetch_before_the_poll_interval(
    tmp_path: Path, source: str, notice_id: str, problem: str, available: bool,
):
    output = _output(tmp_path)
    web = complete_web()
    if source == "nga:4":
        payload = json.loads((fx.NOTICES / fx.NGA_2023).read_bytes())
        payload["broadcast-warn"] = [row for row in payload["broadcast-warn"] if row["msgNumber"] == 1231]
        web.pages[NGA_URL.format(area="4")] = json.dumps(payload).encode()
    uploads = []
    seeded = _run(tmp_path, web, upload=lambda path, *_: uploads.append(path.read_bytes()))
    assert seeded["ok"] is True and seeded["launches"] == 2 and len(uploads) == 1
    target = output / ARTIFACT
    receipt_path = output / PUBLICATION_RECEIPT
    original, receipt = target.read_bytes(), receipt_path.read_bytes()
    state_path = tmp_path / "cache" / STATE_NAME
    state = json.loads(state_path.read_bytes())
    confirmed = json.loads(state_path.read_bytes())["sources"][source]
    record = next(row for row in state["sources"][source]["notices"] if row["notice_id"] == notice_id)
    record["problems"].append(problem)
    if problem.startswith("GEOMETRY_UNPARSED:"):
        record["areas"] = []
    elif problem == "WINDOW_CONFLICT":
        for area in record["areas"]:
            area["windows"] = []
    state_path.write_text(json.dumps(state))
    web.asked.clear()
    if not available:
        web.pages = {}
        with pytest.raises(SourceError, match="SOURCE_STATE_INCOMPLETE"):
            _run(tmp_path, web, upload=lambda path, *_: uploads.append(path.read_bytes()), now=NOW + timedelta(minutes=1))
        assert target.read_bytes() == original
        assert receipt_path.read_bytes() == receipt
        assert len(uploads) == 1
    else:
        report = _run(tmp_path, web, upload=lambda path, *_: uploads.append(path.read_bytes()), now=NOW + timedelta(minutes=1))
        assert report["ok"] is True and report["degraded"] is False
        assert report["sources"][source] == {"checked_at": "2026-11-13T23:41:00Z", "error": None}
        restored = json.loads(target.read_bytes())
        assert {launch["event_id"] for launch in restored["launches"]} == {fx.USSF_317, fx.VULCAN}
        assert [(row["notice_id"], row["area_id"]) for row in fx.launch(restored, fx.VULCAN)["notices"]] == [
            ("USCG LNM 58224", "A"), ("TFR 6/7111", "6/7111"),
        ]
    expected_url = {"faa": FAA_LIST_URL, "uscg": USCG_INDEX_URL, "nga:4": NGA_URL.format(area="4")}[source]
    assert web.asked and web.asked[0] == expected_url
    refreshed = json.loads(state_path.read_bytes())["sources"]
    if available:
        assert refreshed[source]["notices"] == confirmed["notices"]
        assert refreshed[source]["checked_at"] == "2026-11-13T23:41:00Z"
    else:
        assert web.asked == [expected_url]
        assert refreshed[source] == {"attempted_at": "2026-11-13T23:41:00Z", "error": "HTTP_503"}
    assert all(entry == state["sources"][name] for name, entry in refreshed.items() if name != source)


def test_cached_valid_long_window_diagnostic_is_reused_without_http_or_another_upload(tmp_path: Path):
    output = _output(tmp_path)
    web = complete_web()
    uploads = []
    _run(tmp_path, web, upload=lambda path, *_: uploads.append(path.read_bytes()))
    state_path = tmp_path / "cache" / STATE_NAME
    original_state = state_path.read_bytes()
    notices = json.loads(original_state)["sources"]["uscg"]["notices"]
    long_window = next(record for record in notices if record["notice_id"] == "USCG LNM 58219")
    assert long_window["areas"] and long_window["problems"]
    assert all(problem.startswith("WINDOW_UNPARSED:") for problem in long_window["problems"])
    original = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    web.asked.clear()
    web.pages = {}
    report = _run(tmp_path, web, upload=lambda path, *_: uploads.append(path.read_bytes()), now=NOW + timedelta(minutes=1))
    assert report["ok"] is True and report["launches"] == 2
    assert report["written"] is False and report["published"] is False
    assert web.asked == [] and len(uploads) == 1
    assert (output / ARTIFACT).read_bytes() == original
    assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
    assert state_path.read_bytes() == original_state


@pytest.mark.parametrize("unavailable", (None, "faa", "uscg", "nga:4", "nga:12", "nga:A", "nga:P"))
@pytest.mark.parametrize("legacy_shape", ("complete", "missing_area", "unreadable_window"))
@pytest.mark.parametrize("legacy_version", (1, 2, 3))
def test_legacy_cache_requires_every_source_to_confirm_with_the_current_parser(
    tmp_path: Path, unavailable: str | None, legacy_shape: str, legacy_version: int,
):
    output = _output(tmp_path)
    web = complete_web()
    _, issued, body = fx.broadcast_blocks("navarea-xii-785-26.txt")[0]
    row = {
        "navArea": "12", "msgNumber": 785, "msgYear": 2026,
        "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(), "text": body,
    }
    web.pages[NGA_URL.format(area="12")] = json.dumps({"broadcast-warn": [row]}).encode()
    uploads = []

    def upload(path, *_):
        uploads.append(path.read_bytes())

    assert _run(tmp_path, web, upload=upload)["published"]
    artifact = (output / ARTIFACT).read_bytes()
    receipt = (output / PUBLICATION_RECEIPT).read_bytes()
    state_path = tmp_path / "cache" / STATE_NAME
    state = json.loads(state_path.read_bytes())
    state["schema_version"] = legacy_version
    notice = state["sources"]["nga:12"]["notices"][0]
    assert len(notice["areas"]) == 3
    if legacy_shape == "missing_area":
        notice["areas"].pop()
        assert notice["problems"] == []
    elif legacy_shape == "unreadable_window":
        notice["areas"][0]["windows"] = []
        notice["problems"] = ["WINDOW_UNPARSED:130423X TO 130846X NOV"]
    state_path.write_text(json.dumps(state))
    urls = {"faa": FAA_LIST_URL, "uscg": USCG_INDEX_URL}
    urls.update({f"nga:{area}": NGA_URL.format(area=area) for area in ("4", "12", "A", "P")})
    if unavailable:
        del web.pages[urls[unavailable]]
    web.asked.clear()
    now = NOW + timedelta(minutes=1)
    if unavailable:
        with pytest.raises(SourceError, match="^SOURCE_STATE_INCOMPLETE$"):
            _run(tmp_path, web, upload=upload, now=now)
        assert (output / ARTIFACT).read_bytes() == artifact
        assert (output / PUBLICATION_RECEIPT).read_bytes() == receipt
        assert uploads == [artifact]
    else:
        report = _run(tmp_path, web, upload=upload, now=now)
        assert report["ok"] and report["published"] and len(uploads) == 2
    assert set(urls.values()) <= set(web.asked)
    restored = json.loads(state_path.read_bytes())
    assert restored["schema_version"] == 4
    for key, entry in restored["sources"].items():
        assert entry["attempted_at"] == "2026-11-13T23:41:00Z"
        if key == unavailable:
            assert entry == {"attempted_at": "2026-11-13T23:41:00Z", "error": "HTTP_503"}
        else:
            assert entry["checked_at"] == "2026-11-13T23:41:00Z" and entry["error"] is None
    if unavailable != "nga:12":
        assert len(restored["sources"]["nga:12"]["notices"][0]["areas"]) == 3


_RESTART_SOURCE_URLS = {
    "faa": FAA_LIST_URL,
    "uscg": USCG_INDEX_URL,
    **{f"nga:{area}": NGA_URL.format(area=area) for area in ("4", "12", "A", "P")},
}


def _restart_web(source: str) -> Web:
    web = complete_web()
    if source.startswith("nga:"):
        _, issued, body = fx.broadcast_blocks("navarea-xii-785-26.txt")[0]
        row = {
            "navArea": source[4:], "msgNumber": 785, "msgYear": 2026,
            "issueDate": issued.strftime("%d%H%MZ %b %Y").upper(), "text": body,
        }
        web.pages[_RESTART_SOURCE_URLS[source]] = json.dumps({"broadcast-warn": [row]}).encode()
    return web


def _unreadable_restart_answer(web: Web, source: str) -> str:
    from generator.hazard_sources import USCG_FILE_URL

    url = _RESTART_SOURCE_URLS[source]
    if source == "faa":
        web.pages[url] = b'[{"type": null}]'
    elif source == "uscg":
        url = USCG_FILE_URL.format(part=1)
        web.pages[url] = b'{"type":"FeatureCollection","features":[null]}'
    else:
        web.pages[url] = b'{"broadcast-warn":[null]}'
    return url


def _interrupt_source_write(
    monkeypatch: pytest.MonkeyPatch, source: str, at: datetime, stage: str,
    failure: type[BaseException] = SystemExit,
) -> list[str]:
    from generator import hazard_sources

    write = hazard_sources._atomic_write
    stopped = []
    stamp = at.strftime("%Y-%m-%dT%H:%M:%SZ")
    row_error = f"{source.split(':')[0].upper()}_ROW"

    def interrupt(path: Path, data: str):
        entry = json.loads(data)["sources"].get(source, {})
        if entry.get("attempted_at") == stamp and (
            stage in {"before_attempt", "after_attempt"}
            or (stage == "after_failure" and entry.get("error") == row_error)
            or (stage == "after_success" and entry.get("checked_at") == stamp)
        ):
            if stage == "after_attempt":
                write(path, data)
            stopped.append(stage)
            raise failure("SOURCE_STATE_WRITE_INTERRUPTED")
        return write(path, data)

    monkeypatch.setattr(hazard_sources, "_atomic_write", interrupt)
    return stopped


@pytest.mark.parametrize("source", _RESTART_SOURCE_URLS)
@pytest.mark.parametrize("stage", ("after_attempt", "after_failure", "after_success"))
@pytest.mark.parametrize("recovery", ("unreadable", "unavailable", "confirmed"))
def test_interrupted_source_refresh_retries_before_its_interval_and_freezes_until_confirmed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str, stage: str, recovery: str,
):
    output = _output(tmp_path)
    web = _restart_web(source)
    valid_pages = web.pages.copy()
    uploads = []

    def upload(path, *_):
        uploads.append(path.read_bytes())

    assert _run(tmp_path, web, upload=upload)["published"]
    target, receipt_path = output / ARTIFACT, output / PUBLICATION_RECEIPT
    artifact, receipt = target.read_bytes(), receipt_path.read_bytes()
    state_path = tmp_path / "cache" / STATE_NAME
    confirmed = json.loads(state_path.read_bytes())["sources"][source]
    assert confirmed["notices"]
    if source == "faa":
        web.pages[USCG_INDEX_URL] = b'{"spaceOpsPoly_":{"counter":0}}'
    else:
        web.pages[FAA_LIST_URL] = b"[]"
    bad_url = _unreadable_restart_answer(web, source)
    if stage == "after_success":
        web.pages[bad_url] = valid_pages[bad_url]
    with monkeypatch.context() as cut:
        stopped = _interrupt_source_write(cut, source, NOW + timedelta(minutes=31), stage)
        with pytest.raises(SystemExit, match="SOURCE_STATE_WRITE_INTERRUPTED"):
            _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=31))
    assert stopped == [stage]
    interrupted = json.loads(state_path.read_bytes())["sources"][source]
    assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
    assert uploads == [artifact]
    if recovery == "confirmed":
        web.pages[bad_url] = valid_pages[bad_url]
    elif recovery == "unavailable":
        del web.pages[_RESTART_SOURCE_URLS[source]]
    else:
        _unreadable_restart_answer(web, source)
    web.asked.clear()
    report = _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=32))
    assert _RESTART_SOURCE_URLS[source] in web.asked
    restored = json.loads(state_path.read_bytes())
    assert restored["schema_version"] == 4
    entry = restored["sources"][source]
    assert entry["attempted_at"] == "2026-11-14T00:12:00Z"
    assert entry["notices"] == confirmed["notices"]
    if recovery == "confirmed":
        assert report["ok"] and not report["degraded"] and report["published"]
        assert entry["error"] is None and entry["checked_at"] == entry["attempted_at"]
        assert len(uploads) == 2
    else:
        assert not report["ok"] and report["degraded"]
        assert report["reason"] == "SOURCE_REFRESH_DEGRADED"
        assert not report["written"] and not report["published"]
        expected_error = "HTTP_503" if recovery == "unavailable" else f"{source.split(':')[0].upper()}_ROW"
        assert entry["error"] == expected_error
        assert entry["checked_at"] == confirmed["checked_at"]
        assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
        assert uploads == [artifact]
    assert interrupted["error"] == "SOURCE_REFRESH_PENDING"
    assert interrupted["checked_at"] == confirmed["checked_at"]
    assert interrupted["notices"] == confirmed["notices"]
    stable_state, stable_artifact, stable_receipt = state_path.read_bytes(), target.read_bytes(), receipt_path.read_bytes()
    upload_count = len(uploads)
    web.asked.clear()
    repeated = _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=33))
    assert repeated["ok"] == report["ok"] and not repeated["published"]
    assert web.asked == [] and len(uploads) == upload_count
    assert state_path.read_bytes() == stable_state
    assert target.read_bytes() == stable_artifact and receipt_path.read_bytes() == stable_receipt


@pytest.mark.parametrize("source", _RESTART_SOURCE_URLS)
@pytest.mark.parametrize("recovery", ("unreadable", "unavailable", "confirmed"))
def test_unfinished_current_version_attempt_requires_fresh_confirmation(
    tmp_path: Path, source: str, recovery: str,
):
    output = _output(tmp_path)
    web = _restart_web(source)
    uploads = []

    def upload(path, *_):
        uploads.append(path.read_bytes())

    assert _run(tmp_path, web, upload=upload)["published"]
    target, receipt_path = output / ARTIFACT, output / PUBLICATION_RECEIPT
    artifact, receipt = target.read_bytes(), receipt_path.read_bytes()
    state_path = tmp_path / "cache" / STATE_NAME
    state = json.loads(state_path.read_bytes())
    confirmed = json.loads(state_path.read_bytes())["sources"][source]
    state["sources"][source]["attempted_at"] = "2026-11-13T23:41:00Z"
    assert state["sources"][source]["error"] is None
    state_path.write_text(json.dumps(state))
    if recovery == "unreadable":
        _unreadable_restart_answer(web, source)
    elif recovery == "unavailable":
        del web.pages[_RESTART_SOURCE_URLS[source]]
    web.asked.clear()
    report = _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=2))
    assert _RESTART_SOURCE_URLS[source] in web.asked
    restored = json.loads(state_path.read_bytes())
    assert restored["schema_version"] == 4
    entry = restored["sources"][source]
    assert entry["attempted_at"] == "2026-11-13T23:42:00Z"
    assert entry["notices"] == confirmed["notices"]
    if recovery == "confirmed":
        assert report["ok"] and report["published"] and len(uploads) == 2
        assert entry["error"] is None and entry["checked_at"] == entry["attempted_at"]
    else:
        assert not report["ok"] and report["degraded"]
        assert not report["written"] and not report["published"]
        assert entry["error"] == ("HTTP_503" if recovery == "unavailable" else f"{source.split(':')[0].upper()}_ROW")
        assert entry["checked_at"] == confirmed["checked_at"]
        assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
        assert uploads == [artifact]


@pytest.mark.parametrize("source", _RESTART_SOURCE_URLS)
@pytest.mark.parametrize("recovery", ("unreadable", "unavailable", "confirmed"))
def test_interrupted_initial_source_attempt_still_requires_a_validated_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str, recovery: str,
):
    target, artifact = _populated_output(tmp_path)
    receipt_path = tmp_path / "launch-output" / PUBLICATION_RECEIPT
    receipt = b'{"previous":"confirmation"}'
    receipt_path.write_bytes(receipt)
    web = _restart_web(source)
    uploads = []

    def upload(path, *_):
        uploads.append(path.read_bytes())

    with monkeypatch.context() as cut:
        stopped = _interrupt_source_write(cut, source, NOW, "after_attempt")
        with pytest.raises(SystemExit, match="SOURCE_STATE_WRITE_INTERRUPTED"):
            _run(tmp_path, web, upload=upload)
    assert stopped == ["after_attempt"]
    state_path = tmp_path / "cache" / STATE_NAME
    interrupted = json.loads(state_path.read_bytes())["sources"][source]
    if recovery == "unreadable":
        _unreadable_restart_answer(web, source)
    elif recovery == "unavailable":
        del web.pages[_RESTART_SOURCE_URLS[source]]
    web.asked.clear()
    if recovery == "confirmed":
        report = _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=1))
        assert report["ok"] and report["published"] and len(uploads) == 1
    else:
        with pytest.raises(SourceError, match="^SOURCE_STATE_INCOMPLETE$"):
            _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=1))
        assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
        assert uploads == []
    assert _RESTART_SOURCE_URLS[source] in web.asked
    assert interrupted == {"attempted_at": "2026-11-13T23:40:00Z", "error": "SOURCE_REFRESH_PENDING"}
    entry = json.loads(state_path.read_bytes())["sources"][source]
    assert entry["attempted_at"] == "2026-11-13T23:41:00Z"
    if recovery == "confirmed":
        assert entry["error"] is None and entry["notices"]
    else:
        assert "checked_at" not in entry and "notices" not in entry
        assert entry["error"] == ("HTTP_503" if recovery == "unavailable" else f"{source.split(':')[0].upper()}_ROW")


@pytest.mark.parametrize("source", _RESTART_SOURCE_URLS)
def test_failed_attempt_persistence_aborts_before_fetch_and_remains_due(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str,
):
    output = _output(tmp_path)
    web = _restart_web(source)
    uploads = []

    def upload(path, *_):
        uploads.append(path.read_bytes())

    assert _run(tmp_path, web, upload=upload)["published"]
    target, receipt_path = output / ARTIFACT, output / PUBLICATION_RECEIPT
    artifact, receipt = target.read_bytes(), receipt_path.read_bytes()
    state_path = tmp_path / "cache" / STATE_NAME
    confirmed = json.loads(state_path.read_bytes())["sources"][source]
    _unreadable_restart_answer(web, source)
    web.asked.clear()
    with monkeypatch.context() as cut:
        stopped = _interrupt_source_write(cut, source, NOW + timedelta(minutes=31), "before_attempt", OSError)
        with pytest.raises(OSError, match="SOURCE_STATE_WRITE_INTERRUPTED"):
            _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=31))
    assert stopped == ["before_attempt"] and _RESTART_SOURCE_URLS[source] not in web.asked
    assert json.loads(state_path.read_bytes())["sources"][source] == confirmed
    assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
    assert uploads == [artifact]
    web.asked.clear()
    report = _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=32))
    assert _RESTART_SOURCE_URLS[source] in web.asked
    assert not report["ok"] and report["degraded"]
    assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
    assert uploads == [artifact]


@pytest.mark.parametrize("source", _RESTART_SOURCE_URLS)
def test_repeated_failed_result_persistence_keeps_restart_degraded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str,
):
    output = _output(tmp_path)
    web = _restart_web(source)
    uploads = []

    def upload(path, *_):
        uploads.append(path.read_bytes())

    assert _run(tmp_path, web, upload=upload)["published"]
    target, receipt_path = output / ARTIFACT, output / PUBLICATION_RECEIPT
    artifact, receipt = target.read_bytes(), receipt_path.read_bytes()
    state_path = tmp_path / "cache" / STATE_NAME
    confirmed = json.loads(state_path.read_bytes())["sources"][source]
    _unreadable_restart_answer(web, source)
    for minute in (31, 32):
        web.asked.clear()
        with monkeypatch.context() as cut:
            stopped = _interrupt_source_write(cut, source, NOW + timedelta(minutes=minute), "after_failure", OSError)
            with pytest.raises(OSError, match="SOURCE_STATE_WRITE_INTERRUPTED"):
                _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=minute))
        assert stopped == ["after_failure"] and _RESTART_SOURCE_URLS[source] in web.asked
        entry = json.loads(state_path.read_bytes())["sources"][source]
        assert entry["error"] == "SOURCE_REFRESH_PENDING"
        assert entry["checked_at"] == confirmed["checked_at"] and entry["notices"] == confirmed["notices"]
        assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
        assert uploads == [artifact]
    del web.pages[_RESTART_SOURCE_URLS[source]]
    report = _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=33))
    assert not report["ok"] and report["degraded"] and not report["written"] and not report["published"]
    assert report["sources"][source] == {"checked_at": confirmed["checked_at"], "error": "HTTP_503"}
    assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
    assert uploads == [artifact]


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
def test_version_two_gap_snapshot_cannot_publish_a_cached_withdrawal(tmp_path: Path, area: str):
    output = _output(tmp_path)
    source = f"nga:{area}"
    web = _restart_web(source)
    uploads = []

    def upload(path, *_):
        uploads.append(path.read_bytes())

    assert _run(tmp_path, web, upload=upload)["published"]
    target, receipt_path = output / ARTIFACT, output / PUBLICATION_RECEIPT
    artifact, receipt = target.read_bytes(), receipt_path.read_bytes()
    state_path = tmp_path / "cache" / STATE_NAME
    state = json.loads(state_path.read_bytes())
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    row = payload["broadcast-warn"][0]
    assert "\n2. CANCEL THIS MSG" in row["text"]
    row["text"] = row["text"].replace("\n2. CANCEL THIS MSG", "\n3. CANCEL THIS MSG", 1)
    web.pages[url] = json.dumps(payload).encode()
    state["schema_version"] = 2
    for entry in state["sources"].values():
        entry.update(checked_at="2026-11-14T00:11:00Z", attempted_at="2026-11-14T00:11:00Z")
        assert entry["error"] is None
    notice = state["sources"][source]["notices"][0]
    assert notice["problems"] == [] and len(notice["areas"]) == 3
    notice["source_sha256"] = hashlib.sha256(web.pages[url]).hexdigest()
    state["sources"]["faa"]["notices"] = []
    state_path.write_text(json.dumps(state))
    web.pages[FAA_LIST_URL] = b"[]"
    web.asked.clear()
    with pytest.raises(SourceError, match="^SOURCE_STATE_INCOMPLETE$"):
        _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=32))
    assert set(_RESTART_SOURCE_URLS.values()) <= set(web.asked)
    restored = json.loads(state_path.read_bytes())
    assert restored["schema_version"] == 4
    assert restored["sources"][source] == {
        "attempted_at": "2026-11-14T00:12:00Z", "error": "NGA_ROW",
    }
    for key, entry in restored["sources"].items():
        if key != source:
            assert entry["error"] is None and entry["checked_at"] == "2026-11-14T00:12:00Z"
    assert restored["sources"]["faa"]["notices"] == []
    assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
    assert uploads == [artifact] and json.loads(artifact)["schema_version"] == 2
    assert sum(len(launch["geojson"]["features"]) for launch in json.loads(artifact)["launches"]) == 5


@pytest.mark.parametrize("area", ("4", "12", "A", "P"))
@pytest.mark.parametrize("legacy_version", (1, 2, 3))
@pytest.mark.parametrize("recovery", ("unreadable", "known_withdrawal", "restored"))
def test_prior_inline_ordinal_cache_requires_every_source_to_reconfirm(
    tmp_path: Path, area: str, legacy_version: int, recovery: str,
):
    output = _output(tmp_path)
    source = f"nga:{area}"
    web = _restart_web(source)
    uploads = []

    def upload(path, *_):
        uploads.append(path.read_bytes())

    assert _run(tmp_path, web, upload=upload)["published"]
    target, receipt_path = output / ARTIFACT, output / PUBLICATION_RECEIPT
    artifact, receipt = target.read_bytes(), receipt_path.read_bytes()
    state_path = tmp_path / "cache" / STATE_NAME
    state = json.loads(state_path.read_bytes())
    url = NGA_URL.format(area=area)
    payload = json.loads(web.pages[url])
    if recovery != "restored":
        number = 3 if recovery == "unreadable" else 2
        payload["broadcast-warn"][0]["text"] = (
            f"1. CABLE LAYING OPERATIONS IN PROGRESS. {number}. CANCEL NAVAREA XII 784/26."
        )
        web.pages[url] = json.dumps(payload).encode()
    state["schema_version"] = legacy_version
    for entry in state["sources"].values():
        entry.update(checked_at="2026-11-14T00:11:00Z", attempted_at="2026-11-14T00:11:00Z")
        assert entry["error"] is None
    state["sources"][source]["notices"] = []
    state["sources"]["faa"]["notices"] = []
    state_path.write_text(json.dumps(state))
    web.pages[FAA_LIST_URL] = b"[]"
    web.asked.clear()
    if recovery == "unreadable":
        with pytest.raises(SourceError, match="^SOURCE_STATE_INCOMPLETE$"):
            _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=32))
        assert target.read_bytes() == artifact and receipt_path.read_bytes() == receipt
        assert uploads == [artifact]
    else:
        report = _run(tmp_path, web, upload=upload, now=NOW + timedelta(minutes=32))
        assert report["ok"] and report["published"] and not report["degraded"]
        assert len(uploads) == 2 and uploads[-1] == target.read_bytes()
    assert set(_RESTART_SOURCE_URLS.values()) <= set(web.asked)
    restored = json.loads(state_path.read_bytes())
    assert restored["schema_version"] == 4
    entry = restored["sources"][source]
    if recovery == "unreadable":
        assert entry == {"attempted_at": "2026-11-14T00:12:00Z", "error": "NGA_ROW"}
    else:
        assert entry["error"] is None and entry["checked_at"] == "2026-11-14T00:12:00Z"
        assert len(entry["notices"]) == (1 if recovery == "restored" else 0)
    for key, entry in restored["sources"].items():
        if key != source:
            assert entry["error"] is None and entry["checked_at"] == "2026-11-14T00:12:00Z"
    assert json.loads(artifact)["schema_version"] == 2
