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
            nga.pages[NGA_URL.format(area="4")] = (fx.NOTICES / fx.NGA_2023).read_bytes()
            confirmed = refresh_sources(tmp_path / "other-cache", NOW, fetch=nga, pause=lambda _: None)
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
