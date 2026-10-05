from __future__ import annotations

import fcntl
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import urlparse

import pytest
import urllib3

from generator.tle_sources import (
    Answered,
    BackedOff,
    Failed,
    Throttled,
    TleSources,
    open_http,
)
from tests.tle_fakes import FakeClock, TextStream, TrickleStream

T0 = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE"


def _echo(status: int, text: str) -> str:
    del status
    return text


def _sources(
    cache_dir: Path,
    clock: FakeClock,
    transport,
) -> TleSources:
    return TleSources(cache_dir, clock=clock, transport=transport)


def test_fresh_answer_is_not_fetched_again_within_two_hours(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    calls: list[float] = []

    def transport(url: str, budget_s: float) -> TextStream:
        del url
        calls.append(budget_s)
        return TextStream("tle-body")

    sources = _sources(tmp_path, clock, transport)
    assert sources.ask(URL, _echo, budget_s=5) == Answered("tle-body")
    clock.advance(2 * 3600 - 1)
    resting = sources.ask(URL, _echo, budget_s=5)
    assert isinstance(resting, Throttled)
    assert resting.until == T0 + timedelta(hours=2)
    assert calls == [5]
    saved = json.loads((tmp_path / "tle-sources.json").read_text())
    assert saved["version"] == 1
    assert set(saved["sources"][URL]) == {"attempted_at", "failures"}
    assert saved["sources"][URL]["failures"] == 0
    clock.advance(1)
    assert sources.ask(URL, _echo, budget_s=5) == Answered("tle-body")
    assert calls == [5, 5]


def test_consecutive_failures_double_then_a_success_resets(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    calls = {"n": 0}
    fail = {"on": True}

    def transport(url: str, budget_s: float) -> TextStream:
        del url, budget_s
        calls["n"] += 1
        if fail["on"]:
            raise ConnectionError("refused")
        return TextStream("ok")

    sources = _sources(tmp_path, clock, transport)

    assert isinstance(sources.ask(URL, _echo, budget_s=5), Failed)
    clock.advance(2 * 3600 - 1)
    backed = sources.ask(URL, _echo, budget_s=5)
    assert isinstance(backed, BackedOff)
    assert backed.failures == 1
    assert backed.until == T0 + timedelta(hours=2)
    assert calls["n"] == 1

    clock.advance(1)
    assert isinstance(sources.ask(URL, _echo, budget_s=5), Failed)
    clock.advance(4 * 3600 - 1)
    backed = sources.ask(URL, _echo, budget_s=5)
    assert isinstance(backed, BackedOff)
    assert backed.failures == 2
    assert backed.until == T0 + timedelta(hours=6)

    clock.advance(1)
    assert isinstance(sources.ask(URL, _echo, budget_s=5), Failed)
    clock.advance(8 * 3600 - 1)
    backed = sources.ask(URL, _echo, budget_s=5)
    assert isinstance(backed, BackedOff)
    assert backed.failures == 3
    assert backed.until == T0 + timedelta(hours=14)

    clock.advance(1)
    fail["on"] = False
    assert isinstance(sources.ask(URL, _echo, budget_s=5), Answered)
    clock.advance(2 * 3600 - 1)
    assert isinstance(sources.ask(URL, _echo, budget_s=5), Throttled)
    assert calls["n"] == 4

    clock.advance(1)
    fail["on"] = True
    assert isinstance(sources.ask(URL, _echo, budget_s=5), Failed)
    failed_at = clock.now()
    clock.advance(2 * 3600 - 1)
    backed = sources.ask(URL, _echo, budget_s=5)
    assert isinstance(backed, BackedOff)
    assert backed.failures == 1
    assert backed.until == failed_at + timedelta(hours=2)
    clock.advance(1)
    assert isinstance(sources.ask(URL, _echo, budget_s=5), Failed)
    assert calls["n"] == 6


def test_backoff_survives_a_new_client(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    calls: list[str] = []

    def transport(url: str, budget_s: float) -> TextStream:
        del budget_s
        calls.append(url)
        raise ConnectionError("refused")

    first = _sources(tmp_path, clock, transport)
    assert isinstance(first.ask(URL, _echo, budget_s=5), Failed)
    clock.advance(3600)
    second = TleSources(tmp_path, clock=clock, transport=transport)
    reply = second.ask(URL, _echo, budget_s=5)
    assert isinstance(reply, BackedOff)
    assert reply.failures == 1
    assert reply.until == T0 + timedelta(hours=2)
    assert calls == [URL]


def test_trickle_aborts_at_the_budget_with_bytes_unread(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    body = b"x" * 100
    streams: list[TrickleStream] = []

    def transport(url: str, budget_s: float) -> TrickleStream:
        del url
        assert budget_s == 5.0
        stream = TrickleStream(body, clock, chunk=8, gap_s=1.0)
        streams.append(stream)
        return stream

    sources = _sources(tmp_path, clock, transport)
    reply = sources.ask(URL, _echo, budget_s=5.0)
    assert isinstance(reply, Failed)
    assert "40" in reply.reason
    assert streams[0].unread == 60
    assert clock.monotonic() == 5.0
    again = sources.ask(URL, _echo, budget_s=5.0)
    assert isinstance(again, BackedOff)
    assert again.failures == 1
    assert again.until == T0 + timedelta(hours=2)
    assert len(streams) == 1


def test_stalled_read_aborts_with_the_body_unread(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    body = b"x" * 20
    stream = TrickleStream(body, clock, chunk=1, gap_s=30.0)

    def transport(url: str, budget_s: float) -> TrickleStream:
        del url, budget_s
        return stream

    sources = _sources(tmp_path, clock, transport)
    reply = sources.ask(URL, _echo, budget_s=5.0)
    assert isinstance(reply, Failed)
    assert "0" in reply.reason
    assert stream.unread == len(body)
    assert clock.monotonic() == 5.0
    assert isinstance(sources.ask(URL, _echo, budget_s=5.0), BackedOff)


def test_status_other_than_200_or_404_skips_the_judge(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    seen: list[int] = []

    def judge(status: int, text: str) -> str:
        del text
        seen.append(status)
        return "nope"

    def transport(url: str, budget_s: float) -> TextStream:
        del url, budget_s
        return TextStream("denied", status=403)

    sources = _sources(tmp_path, clock, transport)
    assert sources.ask(URL, judge, budget_s=5) == Failed("HTTP 403")
    assert seen == []
    assert isinstance(sources.ask(URL, judge, budget_s=5), BackedOff)


def test_404_reaches_the_judge(tmp_path: Path) -> None:
    clock = FakeClock(T0)

    def judge(status: int, text: str) -> list[str]:
        assert status == 404
        assert text == "missing"
        return []

    def transport(url: str, budget_s: float) -> TextStream:
        del url, budget_s
        return TextStream("missing", status=404)

    sources = _sources(tmp_path, clock, transport)
    assert sources.ask(URL, judge, budget_s=15) == Answered([])


def test_lift_answer_rest_skips_throttle_not_backoff(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    calls = {"n": 0}

    def transport(url: str, budget_s: float) -> TextStream:
        del url, budget_s
        calls["n"] += 1
        return TextStream("ok")

    sources = _sources(tmp_path, clock, transport)
    assert sources.ask(URL, _echo, budget_s=5) == Answered("ok")
    clock.advance(60)
    assert isinstance(sources.ask(URL, _echo, budget_s=5), Throttled)
    assert sources.ask(URL, _echo, budget_s=5, lift_answer_rest=True) == Answered("ok")
    assert calls["n"] == 2

    def fail(url: str, budget_s: float) -> TextStream:
        del url, budget_s
        raise ConnectionError("refused")

    failing = TleSources(tmp_path, clock=clock, transport=fail)
    clock.advance(2 * 3600)
    assert isinstance(failing.ask(URL, _echo, budget_s=5), Failed)
    clock.advance(60)
    assert isinstance(failing.ask(URL, _echo, budget_s=5, lift_answer_rest=True), BackedOff)


def test_future_stamp_waits_at_most_one_rest(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    future = T0 + timedelta(days=1)
    ledger = {
        "version": 1,
        "sources": {URL: {"attempted_at": future.isoformat(), "failures": 0}},
    }
    (tmp_path / "tle-sources.json").write_text(json.dumps(ledger))
    sources = TleSources(tmp_path, clock=clock, transport=lambda url, budget_s: TextStream("x"))
    reply = sources.ask(URL, _echo, budget_s=5)
    assert isinstance(reply, Throttled)
    assert reply.until == T0 + timedelta(hours=2)


def test_corrupt_ledger_is_treated_as_empty(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    clock = FakeClock(T0)
    (tmp_path / "tle-sources.json").write_text("{not json")
    calls: list[str] = []

    def transport(url: str, budget_s: float) -> TextStream:
        del budget_s
        calls.append(url)
        return TextStream("ok")

    sources = _sources(tmp_path, clock, transport)
    import logging

    with caplog.at_level(logging.WARNING, logger="generator.tle_sources"):
        assert sources.ask(URL, _echo, budget_s=5) == Answered("ok")
    assert calls == [URL]
    assert any("unreadable" in record.message for record in caplog.records)
    saved = json.loads((tmp_path / "tle-sources.json").read_text())
    assert saved["sources"][URL]["failures"] == 0


def test_lock_is_released_before_the_transport_runs(tmp_path: Path) -> None:
    clock = FakeClock(T0)
    lock_path = tmp_path / "tle-sources.json.lock"

    def transport(url: str, budget_s: float) -> TextStream:
        del url, budget_s
        fd = os.open(lock_path, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        return TextStream("ok")

    sources = _sources(tmp_path, clock, transport)
    assert sources.ask(URL, _echo, budget_s=5) == Answered("ok")


def test_success_leaves_a_newer_reservation_alone(tmp_path: Path) -> None:
    clock = FakeClock(T0)

    def transport(url: str, budget_s: float) -> TextStream:
        del budget_s
        newer = T0 + timedelta(seconds=10)
        payload = {
            "version": 1,
            "sources": {url: {"attempted_at": newer.isoformat(), "failures": 4}},
        }
        (tmp_path / "tle-sources.json").write_text(json.dumps(payload))
        return TextStream("ok")

    sources = _sources(tmp_path, clock, transport)
    assert isinstance(sources.ask(URL, _echo, budget_s=5), Answered)
    saved = json.loads((tmp_path / "tle-sources.json").read_text())
    assert saved["sources"][URL]["failures"] == 4


def test_failed_store_does_not_block_the_fetch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = FakeClock(T0)

    def boom(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise OSError("disk full")

    monkeypatch.setattr("generator.tle_sources.os.replace", boom)
    calls: list[str] = []

    def transport(url: str, budget_s: float) -> TextStream:
        del budget_s
        calls.append(urlparse(url).netloc)
        return TextStream("ok")

    sources = _sources(tmp_path, clock, transport)
    assert sources.ask(URL, _echo, budget_s=5) == Answered("ok")
    assert calls == ["celestrak.org"]


def test_open_http_uses_one_total_timeout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sock = Mock()
    raw = Mock()
    raw.connection = Mock(sock=sock)
    raw.read1.side_effect = [b"abc", b""]
    response = Mock(status_code=200, raw=raw)
    captured: dict[str, object] = {}

    def fake_get(url: str, **kwargs: object) -> Mock:
        captured["url"] = url
        captured["kwargs"] = kwargs
        return response

    monkeypatch.setattr("generator.tle_sources.requests.get", fake_get)
    clock = FakeClock(T0)
    sources = TleSources(tmp_path, clock=clock, transport=open_http)
    assert sources.ask("https://example.test/tle", _echo, budget_s=5) == Answered("abc")
    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs["stream"] is True
    assert kwargs["allow_redirects"] is False
    assert kwargs["headers"] == {"Accept-Encoding": "identity"}
    timeout = kwargs["timeout"]
    assert isinstance(timeout, urllib3.Timeout)
    assert timeout.total == 5
    sock.settimeout.assert_called_with(5.0)
    raw.read1.assert_any_call(8192, decode_content=True)
    response.close.assert_called_once()


def test_open_http_turns_a_read_timeout_into_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = Mock()
    raw.connection = Mock(sock=Mock())
    raw.read1.side_effect = urllib3.exceptions.ReadTimeoutError(
        None, "https://example.test/tle", "timed out"
    )
    response = Mock(status_code=200, raw=raw)
    monkeypatch.setattr("generator.tle_sources.requests.get", lambda *args, **kwargs: response)
    sources = TleSources(tmp_path, clock=FakeClock(T0), transport=open_http)
    reply = sources.ask("https://example.test/tle", _echo, budget_s=5)
    assert isinstance(reply, Failed)
    assert "timed out" in reply.reason
    response.close.assert_called_once()


def test_open_http_turns_urllib3_errors_into_connection_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = Mock()
    raw.connection = Mock(sock=None)
    raw.read1.side_effect = urllib3.exceptions.ProtocolError("reset")
    response = Mock(status_code=200, raw=raw)
    monkeypatch.setattr("generator.tle_sources.requests.get", lambda *args, **kwargs: response)
    sources = TleSources(tmp_path, clock=FakeClock(T0), transport=open_http)
    reply = sources.ask("https://example.test/other", _echo, budget_s=5)
    assert isinstance(reply, Failed)
    assert "reset" in reply.reason
