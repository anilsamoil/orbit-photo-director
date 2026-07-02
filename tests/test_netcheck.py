"""Tests for generator.netcheck — host net guardrails.

All external commands are stubbed; these tests never shell out. The functions
under test are best-effort and must never raise, which several cases assert.
"""

from __future__ import annotations

import logging
import subprocess
from types import SimpleNamespace

import pytest

from generator import netcheck


def _fake_run(stdout: str = "", returncode: int = 0):
    def _run(*_args, **_kwargs):
        return SimpleNamespace(stdout=stdout, returncode=returncode)

    return _run


@pytest.fixture
def macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(netcheck.sys, "platform", "darwin")


# --- ephemeral_port_floor -------------------------------------------------


def test_floor_parses_sysctl(macos: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(netcheck.subprocess, "run", _fake_run("32768\n"))
    assert netcheck.ephemeral_port_floor() == 32768


def test_floor_none_off_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(netcheck.sys, "platform", "linux")
    assert netcheck.ephemeral_port_floor() is None


def test_floor_none_on_nonzero_rc(macos: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(netcheck.subprocess, "run", _fake_run("", returncode=1))
    assert netcheck.ephemeral_port_floor() is None


def test_floor_none_on_garbage(macos: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(netcheck.subprocess, "run", _fake_run("not-a-number"))
    assert netcheck.ephemeral_port_floor() is None


def test_floor_never_raises_on_subprocess_error(
    macos: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(*_a, **_k):
        raise subprocess.TimeoutExpired(cmd="sysctl", timeout=5)

    monkeypatch.setattr(netcheck.subprocess, "run", _boom)
    assert netcheck.ephemeral_port_floor() is None


# --- warn_if_net_tuning_missing -------------------------------------------


def test_net_tuning_warns_when_floor_at_default(
    macos: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(netcheck.subprocess, "run", _fake_run("49152\n"))
    log = logging.getLogger("t")
    with caplog.at_level(logging.WARNING):
        floor = netcheck.warn_if_net_tuning_missing(log)
    assert floor == 49152
    assert any("net-tuning" in r.message for r in caplog.records)
    assert any(r.levelno == logging.WARNING for r in caplog.records)


def test_net_tuning_quiet_when_tuned(
    macos: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(netcheck.subprocess, "run", _fake_run("32768\n"))
    log = logging.getLogger("t")
    with caplog.at_level(logging.WARNING):
        floor = netcheck.warn_if_net_tuning_missing(log)
    assert floor == 32768
    # No WARNING when the tuning is active.
    assert not any(r.levelno == logging.WARNING for r in caplog.records)


def test_net_tuning_returns_none_when_unreadable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(netcheck.sys, "platform", "linux")
    assert netcheck.warn_if_net_tuning_missing(logging.getLogger("t")) is None


# --- count_time_wait / warn_if_time_wait_high -----------------------------

_NETSTAT_SAMPLE = (
    "tcp4  0  0  127.0.0.1.1234  127.0.0.1.51000  TIME_WAIT\n"
    "tcp4  0  0  127.0.0.1.1234  127.0.0.1.51001  TIME_WAIT\n"
    "tcp4  0  0  10.0.0.2.443    10.0.0.9.51002   ESTABLISHED\n"
    "tcp4  0  0  127.0.0.1.1234  127.0.0.1.51003  TIME_WAIT\n"
)


def test_count_time_wait(macos: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(netcheck.subprocess, "run", _fake_run(_NETSTAT_SAMPLE))
    assert netcheck.count_time_wait() == 3


def test_count_time_wait_none_off_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(netcheck.sys, "platform", "win32")
    assert netcheck.count_time_wait() is None


def test_time_wait_warns_over_threshold(
    macos: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(netcheck, "count_time_wait", lambda: 9000)
    log = logging.getLogger("t")
    with caplog.at_level(logging.WARNING):
        count = netcheck.warn_if_time_wait_high(log, threshold=8000)
    assert count == 9000
    assert any(r.levelno == logging.WARNING for r in caplog.records)
    assert any("TIME_WAIT" in r.message for r in caplog.records)


def test_time_wait_quiet_under_threshold(
    macos: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(netcheck, "count_time_wait", lambda: 12)
    log = logging.getLogger("t")
    with caplog.at_level(logging.WARNING):
        count = netcheck.warn_if_time_wait_high(log, threshold=8000)
    assert count == 12
    assert not any(r.levelno == logging.WARNING for r in caplog.records)


def test_time_wait_returns_none_when_unreadable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(netcheck, "count_time_wait", lambda: None)
    assert netcheck.warn_if_time_wait_high(logging.getLogger("t")) is None


def test_time_wait_never_raises(macos: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*_a, **_k):
        raise OSError("netstat exploded")

    monkeypatch.setattr(netcheck.subprocess, "run", _boom)
    # count_time_wait swallows, warn_* returns None — no exception escapes.
    assert netcheck.warn_if_time_wait_high(logging.getLogger("t")) is None
