"""Tests for generator.daemon."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest

from generator.config import Settings
from generator.daemon import (
    INITIAL_BACKOFF_SECONDS,
    StallWatchdog,
    run_tick_with_watchdog,
    supervisor_loop,
)
from tests.conftest import SAMPLE_TLE_TEXT


def test_stall_watchdog_does_not_fire_when_work_finishes_quickly() -> None:
    with StallWatchdog(seconds=2.0) as wd:
        time.sleep(0.1)
    assert wd.fired is False


def test_stall_watchdog_fires_on_long_work() -> None:
    """Watchdog raises SIGINT after the deadline; we should observe KeyboardInterrupt."""
    with pytest.raises(KeyboardInterrupt):
        with StallWatchdog(seconds=0.5) as wd:
            time.sleep(2.0)
    assert wd.fired is True


def test_run_tick_with_watchdog_succeeds(
    settings_in_tmp: Settings, tmp_path: Path
) -> None:
    cache = settings_in_tmp.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "iss.tle").write_text(SAMPLE_TLE_TEXT)
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    assert run_tick_with_watchdog(settings_in_tmp, now=now) is True


def test_run_tick_with_watchdog_returns_false_on_failure(settings_in_tmp: Settings) -> None:
    """No TLE cache + unreachable URL → run_tick raises → watchdog wrapper returns False."""
    # No cache seeded, URL is example.invalid
    assert run_tick_with_watchdog(settings_in_tmp) is False


def test_supervisor_loop_runs_max_iterations(settings_in_tmp: Settings) -> None:
    """With max_iterations=2, the loop runs twice and exits without sleeping."""
    cache = settings_in_tmp.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "iss.tle").write_text(SAMPLE_TLE_TEXT)

    call_count = {"n": 0}

    def fake_run_tick_with_watchdog(settings, now=None):
        call_count["n"] += 1
        return True

    with patch("generator.daemon.run_tick_with_watchdog", side_effect=fake_run_tick_with_watchdog):
        # Patch sleep so loop exits fast even on the trailing sleep
        with patch("time.sleep"):
            supervisor_loop(settings_in_tmp, max_iterations=2)

    assert call_count["n"] == 2


def test_supervisor_loop_backs_off_on_failure(settings_in_tmp: Settings) -> None:
    """Consecutive failures should trigger exponential backoff."""
    sleep_durations: list[float] = []

    def record_sleep(s: float) -> None:
        sleep_durations.append(s)

    with patch("generator.daemon.run_tick_with_watchdog", return_value=False):
        with patch("time.sleep", side_effect=record_sleep):
            supervisor_loop(settings_in_tmp, max_iterations=3)

    # First failure sleeps INITIAL_BACKOFF, then doubles
    assert len(sleep_durations) >= 2
    assert sleep_durations[0] == INITIAL_BACKOFF_SECONDS
    assert sleep_durations[1] >= INITIAL_BACKOFF_SECONDS * 2 - 1
