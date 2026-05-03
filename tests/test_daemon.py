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



# --------------------------------------------------------------------------
# deploy_to_r2 — subprocess shell-out paths matter for 8-month unattended ops
# --------------------------------------------------------------------------

import os
import subprocess
from unittest.mock import MagicMock

from generator.daemon import deploy_to_r2


def test_deploy_skipped_when_env_var_set(settings_in_tmp: Settings) -> None:
    with patch.dict(os.environ, {"OPD_SKIP_DEPLOY": "1"}):
        assert deploy_to_r2(settings_in_tmp) is True


def test_deploy_returns_false_when_script_missing(settings_in_tmp: Settings) -> None:
    """Deploy script absent → log error and return False (not raise)."""
    with patch.dict(os.environ, {"OPD_DEPLOY_SCRIPT": "scripts/does_not_exist.sh"}, clear=False):
        os.environ.pop("OPD_SKIP_DEPLOY", None)
        assert deploy_to_r2(settings_in_tmp) is False


def test_deploy_skips_silently_when_rclone_missing(
    settings_in_tmp: Settings, tmp_path: Path
) -> None:
    """rclone-based deploy.sh requires rclone; if absent, return True (skip dev)."""
    script = settings_in_tmp.repo_root / "scripts"
    script.mkdir(parents=True, exist_ok=True)
    (script / "deploy.sh").write_text("#!/bin/bash\nexit 0\n")
    os.environ.pop("OPD_SKIP_DEPLOY", None)
    os.environ.pop("OPD_DEPLOY_SCRIPT", None)
    with patch("generator.daemon.shutil.which", return_value=None):
        assert deploy_to_r2(settings_in_tmp) is True


def test_deploy_returns_false_on_nonzero_exit(settings_in_tmp: Settings) -> None:
    """Deploy script exits non-zero → returns False, logs stderr tail."""
    script = settings_in_tmp.repo_root / "scripts"
    script.mkdir(parents=True, exist_ok=True)
    (script / "deploy.sh").write_text("#!/bin/bash\nexit 1\n")
    os.environ.pop("OPD_SKIP_DEPLOY", None)
    os.environ.pop("OPD_DEPLOY_SCRIPT", None)
    with patch("generator.daemon.shutil.which", return_value="/usr/bin/rclone"):
        fake_proc = MagicMock(returncode=1, stdout="", stderr="boom")
        with patch("generator.daemon.subprocess.run", return_value=fake_proc):
            assert deploy_to_r2(settings_in_tmp) is False


def test_deploy_returns_false_on_timeout(settings_in_tmp: Settings) -> None:
    """Subprocess timeout → return False, log error (no exception escapes)."""
    script = settings_in_tmp.repo_root / "scripts"
    script.mkdir(parents=True, exist_ok=True)
    (script / "deploy.sh").write_text("#!/bin/bash\nsleep 999\n")
    os.environ.pop("OPD_SKIP_DEPLOY", None)
    os.environ.pop("OPD_DEPLOY_SCRIPT", None)
    with patch("generator.daemon.shutil.which", return_value="/usr/bin/rclone"):
        with patch(
            "generator.daemon.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="bash", timeout=1),
        ):
            assert deploy_to_r2(settings_in_tmp) is False


def test_deploy_succeeds_on_zero_exit(settings_in_tmp: Settings) -> None:
    """Happy path: deploy script returns 0 → True."""
    script = settings_in_tmp.repo_root / "scripts"
    script.mkdir(parents=True, exist_ok=True)
    (script / "deploy.sh").write_text("#!/bin/bash\nexit 0\n")
    os.environ.pop("OPD_SKIP_DEPLOY", None)
    os.environ.pop("OPD_DEPLOY_SCRIPT", None)
    with patch("generator.daemon.shutil.which", return_value="/usr/bin/rclone"):
        fake_proc = MagicMock(returncode=0, stdout="ok", stderr="")
        with patch("generator.daemon.subprocess.run", return_value=fake_proc):
            assert deploy_to_r2(settings_in_tmp) is True


def test_deploy_wrangler_script_does_not_require_rclone(
    settings_in_tmp: Settings,
) -> None:
    """When OPD_DEPLOY_SCRIPT points to deploy_wrangler.sh, rclone is not required."""
    script = settings_in_tmp.repo_root / "scripts"
    script.mkdir(parents=True, exist_ok=True)
    (script / "deploy_wrangler.sh").write_text("#!/bin/bash\nexit 0\n")
    with patch.dict(os.environ, {"OPD_DEPLOY_SCRIPT": "scripts/deploy_wrangler.sh"}, clear=False):
        os.environ.pop("OPD_SKIP_DEPLOY", None)
        with patch("generator.daemon.shutil.which", return_value=None):
            fake_proc = MagicMock(returncode=0, stdout="ok", stderr="")
            with patch("generator.daemon.subprocess.run", return_value=fake_proc):
                assert deploy_to_r2(settings_in_tmp) is True

