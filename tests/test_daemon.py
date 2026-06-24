"""Tests for generator.daemon."""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest

from generator.config import Settings
from generator.daemon import (
    INITIAL_BACKOFF_SECONDS,
    StallWatchdog,
    deploy_to_r2,
    main,
    run_tick_with_watchdog,
    supervisor_loop,
)
from tests.conftest import SAMPLE_TLE_TEXT


@pytest.fixture(autouse=True)
def _skip_host_netcheck(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep daemon tests hermetic: don't shell out to netstat/sysctl for the
    host net guardrails. The guardrails themselves are unit-tested in
    test_netcheck.py; the dedicated wiring test below re-enables them."""
    monkeypatch.setenv("OPD_SKIP_NETCHECK", "1")


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


def test_supervisor_loop_calls_time_wait_monitor(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When netcheck is enabled, the loop emits the host TIME_WAIT guardrail
    once per tick (the 2026-06-24 outage early-warning)."""
    monkeypatch.delenv("OPD_SKIP_NETCHECK", raising=False)  # re-enable
    cache = settings_in_tmp.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "iss.tle").write_text(SAMPLE_TLE_TEXT)

    with (
        patch("generator.daemon.run_tick_with_watchdog", return_value=True),
        patch("time.sleep"),
        patch("generator.netcheck.warn_if_time_wait_high") as monitor,
    ):
        supervisor_loop(settings_in_tmp, max_iterations=2)
    assert monitor.call_count == 2


def test_supervisor_loop_skips_monitor_when_disabled(
    settings_in_tmp: Settings,
) -> None:
    """OPD_SKIP_NETCHECK=1 (set by the autouse fixture) suppresses the host
    guardrail — the operator off-switch / hermetic-test path."""
    cache = settings_in_tmp.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "iss.tle").write_text(SAMPLE_TLE_TEXT)

    with (
        patch("generator.daemon.run_tick_with_watchdog", return_value=True),
        patch("time.sleep"),
        patch("generator.netcheck.warn_if_time_wait_high") as monitor,
    ):
        supervisor_loop(settings_in_tmp, max_iterations=2)
    monitor.assert_not_called()


def test_main_runs_net_tuning_self_check(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """At startup main() warns if the host ephemeral-port tuning is missing."""
    monkeypatch.delenv("OPD_SKIP_NETCHECK", raising=False)  # re-enable
    monkeypatch.setattr("generator.daemon.supervisor_loop", lambda s: None)
    monkeypatch.setattr(
        "generator.daemon.Settings.from_env", classmethod(lambda cls: settings_in_tmp)
    )
    with patch("generator.netcheck.warn_if_net_tuning_missing") as check:
        assert main() == 0
    check.assert_called_once()


def test_supervisor_loop_exits_when_generator_code_changes(
    settings_in_tmp: Settings,
) -> None:
    """The mtime-check hook (added 2026-05-17 P1) should exit non-zero
    when any generator/*.py is newer than process start. This is the
    self-restart mechanism that lets launchd respawn with fresh modules
    after a git pull / editor save / code deploy."""
    cache = settings_in_tmp.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "iss.tle").write_text(SAMPLE_TLE_TEXT)

    # Patch the mtime-at-start to a low value, force _max_generator_mtime
    # to return a higher value → simulates a code change since startup.
    with (
        patch("generator.daemon._GENERATOR_MTIME_AT_START", 0.0),
        patch("generator.daemon._max_generator_mtime", return_value=999.0),
        patch("generator.daemon.run_tick_with_watchdog", return_value=True),
        patch("generator.daemon.deploy_to_r2", return_value=True),
        patch("time.sleep"),  # safety: prevent any real sleep if exit path fails
        pytest.raises(SystemExit) as exc_info,
    ):
        supervisor_loop(settings_in_tmp, max_iterations=10)

    # Non-zero exit so launchd KeepAlive.SuccessfulExit=false restarts us.
    assert exc_info.value.code == 1


def test_supervisor_loop_does_not_exit_when_code_unchanged(
    settings_in_tmp: Settings,
) -> None:
    """No mtime change → no self-restart. Regression guard: don't make
    the daemon flap on every tick."""
    cache = settings_in_tmp.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "iss.tle").write_text(SAMPLE_TLE_TEXT)

    with (
        patch("generator.daemon._GENERATOR_MTIME_AT_START", 999.0),
        patch("generator.daemon._max_generator_mtime", return_value=999.0),
        patch("generator.daemon.run_tick_with_watchdog", return_value=True),
        patch("generator.daemon.deploy_to_r2", return_value=True),
        patch("time.sleep"),
    ):
        # max_iterations=2 means loop exits normally; SystemExit would mean bug.
        supervisor_loop(settings_in_tmp, max_iterations=2)
    # No assertion needed beyond "didn't raise SystemExit".


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
    (script / "deploy.sh").write_text("#!/bin/bash\necho 'boom' >&2\nexit 1\n")
    (script / "deploy.sh").chmod(0o755)
    os.environ.pop("OPD_SKIP_DEPLOY", None)
    os.environ.pop("OPD_DEPLOY_SCRIPT", None)
    with patch("generator.daemon.shutil.which", return_value="/usr/bin/rclone"):
        # Real subprocess: bash runs the script, exits 1, deploy returns False.
        assert deploy_to_r2(settings_in_tmp, timeout_seconds=5) is False


def test_deploy_returns_false_on_timeout(settings_in_tmp: Settings) -> None:
    """Subprocess timeout → killpg the process group, return False (no hang).

    Verifies the new Popen + thread-drain + killpg path: a `sleep 30`
    child under the test's 1s timeout is SIGTERM'd within the grace period
    and the function returns False quickly. This is the behavior we lost
    with subprocess.run (its cleanup can wedge on stuck pipe writers).
    """
    script = settings_in_tmp.repo_root / "scripts"
    script.mkdir(parents=True, exist_ok=True)
    (script / "deploy.sh").write_text("#!/bin/bash\nsleep 30\n")
    (script / "deploy.sh").chmod(0o755)
    os.environ.pop("OPD_SKIP_DEPLOY", None)
    os.environ.pop("OPD_DEPLOY_SCRIPT", None)
    import time as _time
    with patch("generator.daemon.shutil.which", return_value="/usr/bin/rclone"):
        start = _time.monotonic()
        result = deploy_to_r2(settings_in_tmp, timeout_seconds=1)
        elapsed = _time.monotonic() - start
    assert result is False
    # Should kill within ~1s timeout + ~5s grace; far below the 30s sleep.
    assert elapsed < 15.0, f"deploy_to_r2 took {elapsed:.1f}s — kill path is wedged"


def test_deploy_succeeds_on_zero_exit(settings_in_tmp: Settings) -> None:
    """Happy path: deploy script returns 0 → True."""
    script = settings_in_tmp.repo_root / "scripts"
    script.mkdir(parents=True, exist_ok=True)
    (script / "deploy.sh").write_text("#!/bin/bash\necho 'ok'\nexit 0\n")
    (script / "deploy.sh").chmod(0o755)
    os.environ.pop("OPD_SKIP_DEPLOY", None)
    os.environ.pop("OPD_DEPLOY_SCRIPT", None)
    with patch("generator.daemon.shutil.which", return_value="/usr/bin/rclone"):
        assert deploy_to_r2(settings_in_tmp, timeout_seconds=5) is True


def test_deploy_wrangler_script_does_not_require_rclone(
    settings_in_tmp: Settings,
) -> None:
    """When OPD_DEPLOY_SCRIPT points to deploy_wrangler.sh, rclone is not required."""
    script = settings_in_tmp.repo_root / "scripts"
    script.mkdir(parents=True, exist_ok=True)
    (script / "deploy_wrangler.sh").write_text("#!/bin/bash\nexit 0\n")
    (script / "deploy_wrangler.sh").chmod(0o755)
    with patch.dict(os.environ, {"OPD_DEPLOY_SCRIPT": "scripts/deploy_wrangler.sh"}, clear=False):
        os.environ.pop("OPD_SKIP_DEPLOY", None)
        with patch("generator.daemon.shutil.which", return_value=None):
            assert deploy_to_r2(settings_in_tmp, timeout_seconds=5) is True


# --------------------------------------------------------------------------
# supervisor_loop — backoff + iteration cap behavior
# --------------------------------------------------------------------------


def test_supervisor_loop_resets_backoff_on_success(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful tick resets the backoff counter and sleeps tick_minutes*60."""
    sleep_durations: list[float] = []
    monkeypatch.setattr("time.sleep", lambda s: sleep_durations.append(s))
    monkeypatch.setattr("generator.daemon.run_tick_with_watchdog", lambda s: True)
    monkeypatch.setattr("generator.daemon.deploy_to_r2", lambda s: True)
    supervisor_loop(settings_in_tmp, max_iterations=2)
    # Both iterations succeeded → both sleeps are tick_minutes * 60
    assert all(d == settings_in_tmp.tick_minutes * 60 for d in sleep_durations)


def test_supervisor_loop_skips_deploy_when_tick_fails(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If run_tick fails, deploy is not attempted (avoid publishing stale out/)."""
    deploy_called = []
    monkeypatch.setattr("time.sleep", lambda s: None)
    monkeypatch.setattr("generator.daemon.run_tick_with_watchdog", lambda s: False)
    monkeypatch.setattr(
        "generator.daemon.deploy_to_r2",
        lambda s: deploy_called.append(True) or True,
    )
    supervisor_loop(settings_in_tmp, max_iterations=1)
    assert deploy_called == []


def test_supervisor_loop_reraises_keyboard_interrupt(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """KeyboardInterrupt during sleep must propagate so launchd sees a crash."""
    def kbint(_):
        raise KeyboardInterrupt
    monkeypatch.setattr("time.sleep", kbint)
    monkeypatch.setattr("generator.daemon.run_tick_with_watchdog", lambda s: True)
    monkeypatch.setattr("generator.daemon.deploy_to_r2", lambda s: True)
    with pytest.raises(KeyboardInterrupt):
        supervisor_loop(settings_in_tmp, max_iterations=5)


# --------------------------------------------------------------------------
# main() entry point — exit codes feed launchd's KeepAlive policy
# --------------------------------------------------------------------------


def test_daemon_main_returns_zero_on_clean_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    """supervisor_loop returns normally → main() returns 0."""
    monkeypatch.setattr("generator.daemon.supervisor_loop", lambda s: None)
    monkeypatch.setattr(
        "generator.daemon.Settings.from_env",
        classmethod(lambda cls: Settings(
            repo_root=Path("/tmp"),
            out_dir=Path("/tmp/out"),
            cache_dir=Path("/tmp/cache"),
            log_dir=Path("/tmp/log"),
            targets_file=Path("/tmp/targets.json"),
            tle_url="http://example.invalid",
            satcorps_creds_file=Path("/tmp/creds.json"),
            rclone_remote="r2:bucket",
            tick_minutes=30,
            pass_window_hours=6,
        )),
    )
    assert main() == 0


def test_daemon_main_returns_130_on_keyboard_interrupt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SIGINT (stall watchdog or external) → exit 130 so launchd restarts."""
    def kbint(s):
        raise KeyboardInterrupt
    monkeypatch.setattr("generator.daemon.supervisor_loop", kbint)
    monkeypatch.setattr(
        "generator.daemon.Settings.from_env",
        classmethod(lambda cls: Settings(
            repo_root=Path("/tmp"),
            out_dir=Path("/tmp/out"),
            cache_dir=Path("/tmp/cache"),
            log_dir=Path("/tmp/log"),
            targets_file=Path("/tmp/targets.json"),
            tle_url="http://example.invalid",
            satcorps_creds_file=Path("/tmp/creds.json"),
            rclone_remote="r2:bucket",
            tick_minutes=30,
            pass_window_hours=6,
        )),
    )
    assert main() == 130


def test_daemon_main_returns_one_on_unexpected_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Any other exception → exit 1 so launchd treats as crash and restarts."""
    def boom(s):
        raise RuntimeError("supervisor blew up")
    monkeypatch.setattr("generator.daemon.supervisor_loop", boom)
    monkeypatch.setattr(
        "generator.daemon.Settings.from_env",
        classmethod(lambda cls: Settings(
            repo_root=Path("/tmp"),
            out_dir=Path("/tmp/out"),
            cache_dir=Path("/tmp/cache"),
            log_dir=Path("/tmp/log"),
            targets_file=Path("/tmp/targets.json"),
            tle_url="http://example.invalid",
            satcorps_creds_file=Path("/tmp/creds.json"),
            rclone_remote="r2:bucket",
            tick_minutes=30,
            pass_window_hours=6,
        )),
    )
    assert main() == 1


# --------------------------------------------------------------------------
# run_tick_with_watchdog — failure paths
# --------------------------------------------------------------------------


def test_run_tick_with_watchdog_returns_false_on_keyboard_interrupt(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stall watchdog raises SIGINT → run_tick_with_watchdog returns False."""
    def kbint(*args, **kwargs):
        raise KeyboardInterrupt
    monkeypatch.setattr("generator.daemon.run_tick", kbint)
    assert run_tick_with_watchdog(settings_in_tmp) is False


def test_run_tick_with_watchdog_returns_false_on_other_exception(
    settings_in_tmp: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*args, **kwargs):
        raise RuntimeError("tick fell over")
    monkeypatch.setattr("generator.daemon.run_tick", boom)
    assert run_tick_with_watchdog(settings_in_tmp) is False

