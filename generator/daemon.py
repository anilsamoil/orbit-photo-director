"""Generator daemon: runs main.run_tick on an interval with a stall watchdog.

Inherits the OpenClaw subprocess-stall-watchdog pattern: any single tick that runs longer
than HARD_TIMEOUT_SECONDS gets aborted via a watchdog thread that raises in the main thread.
On repeated failures, exponential backoff up to MAX_BACKOFF_SECONDS.
"""

from __future__ import annotations

import logging
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import Settings
from .main import run_tick

log = logging.getLogger(__name__)

# 30 min cap. Was 600s; bumped 2026-05-27 during a NASA GIBS outage when
# multiplex(3 profiles) + slow-cloud-sampling ticks were exceeding 10 min.
# Still bounded — KeepAlive still catches genuine deadlocks.
HARD_TIMEOUT_SECONDS = 1800
DEPLOY_TIMEOUT_SECONDS = 300  # 5 min
INITIAL_BACKOFF_SECONDS = 30
MAX_BACKOFF_SECONDS = 3600  # 1h
# Default to the rclone-based deploy. Override with OPD_DEPLOY_SCRIPT if needed
# (e.g., to use scripts/deploy_wrangler.sh when R2 keys aren't available).
DEPLOY_SCRIPT_DEFAULT = Path("scripts") / "deploy.sh"

# Snapshot of the max mtime across generator/*.py files at process
# start. supervisor_loop polls this between ticks to detect when code
# on disk has changed (e.g., git pull, editor save), then exits non-
# zero so launchd's KeepAlive=Crashed/SuccessfulExit=false restarts
# the daemon with fresh modules.
#
# Why this exists: Python imports modules ONCE on process startup.
# The OS daemon ran for 13 days (2026-05-04 → 2026-05-17) with stale
# pre-V3.0 code while frontend redeploys happened constantly via R2
# upload. WatchPaths in the launchd plist registers FSEvents but does
# NOT restart a running job (it only STARTS on-demand jobs).
# Polling mtimes in the loop is the only mechanism that actually
# applies to a long-running daemon. P1 fix from TODOS.md, 2026-05-17.
_GENERATOR_DIR = Path(__file__).parent
def _max_generator_mtime() -> float:
    try:
        return max(p.stat().st_mtime for p in _GENERATOR_DIR.glob("*.py"))
    except (OSError, ValueError):
        return 0.0
_GENERATOR_MTIME_AT_START = _max_generator_mtime()


def _generator_code_changed() -> bool:
    """Return True if any generator/*.py file has been modified since
    the process started. Best-effort: stat failures (transient disk
    issues, missing file briefly during git swap) return False so
    we don't false-positive an exit on noise."""
    return _max_generator_mtime() > _GENERATOR_MTIME_AT_START


class StallWatchdog:
    """Best-effort watchdog: after `seconds`, raise SIGINT in this process to break the tick.

    Used in the main process for tests; in production daemon the supervisor below also
    spawns ticks as subprocesses with subprocess.Popen + timeout for harder isolation.
    """

    def __init__(self, seconds: float):
        self._seconds = seconds
        self._timer: threading.Timer | None = None
        self._fired = False

    def __enter__(self) -> StallWatchdog:
        self._timer = threading.Timer(self._seconds, self._fire)
        self._timer.daemon = True
        self._timer.start()
        return self

    def __exit__(self, *exc: object) -> None:
        if self._timer:
            self._timer.cancel()

    def _fire(self) -> None:
        self._fired = True
        log.error("stall watchdog fired after %.0fs", self._seconds)
        signal.raise_signal(signal.SIGINT)

    @property
    def fired(self) -> bool:
        return self._fired


def run_tick_with_watchdog(settings: Settings, now: datetime | None = None) -> bool:
    """Run a tick under a stall watchdog. Returns True on success."""
    try:
        with StallWatchdog(HARD_TIMEOUT_SECONDS):
            run_tick(settings, now=now)
        return True
    except KeyboardInterrupt:
        log.error("tick aborted by stall watchdog")
        return False
    except Exception:
        log.exception("tick failed")
        return False


def deploy_to_r2(
    settings: Settings,
    *,
    timeout_seconds: int = DEPLOY_TIMEOUT_SECONDS,
) -> bool:
    """Run scripts/deploy.sh to publish out/ to Cloudflare R2.

    Returns True on success. Failures are logged and surfaced as False so the
    supervisor can apply backoff. Skipped (returning True) when rclone is missing
    OR when OPD_SKIP_DEPLOY is set, so dev runs don't fail without rclone configured.
    """
    import os
    if os.environ.get("OPD_SKIP_DEPLOY") == "1":
        log.info("OPD_SKIP_DEPLOY=1 set; skipping deploy step")
        return True
    script_rel = Path(os.environ.get("OPD_DEPLOY_SCRIPT", str(DEPLOY_SCRIPT_DEFAULT)))
    script = settings.repo_root / script_rel
    if not script.exists():
        log.error("deploy script missing at %s; cannot publish", script)
        return False
    # The rclone-based deploy.sh is the default; only require rclone if THAT script
    # is selected. The wrangler fallback (deploy_wrangler.sh) doesn't need rclone.
    if "deploy.sh" in script.name and "wrangler" not in script.name:
        if shutil.which("rclone") is None:
            log.warning(
                "rclone not on PATH; skipping deploy "
                "(configure rclone or set OPD_DEPLOY_SCRIPT)"
            )
            return True

    # subprocess: deploy script path is built from settings.repo_root (trusted) +
    # a constant relative path. No user-supplied input enters the argv.
    #
    # Why Popen + thread-drain instead of subprocess.run(timeout=...):
    # subprocess.run's cleanup can hang past the timeout if the child has
    # stuck pipe writers (the OpenClaw daemon hit this exact pattern — wedge
    # for hours). We explicitly kill the process group on timeout and drain
    # output through threads so neither side can block forever.
    argv = ["bash", str(script)]  # noqa: S607
    return _run_subprocess_with_kill_on_timeout(
        argv, cwd=settings.repo_root, timeout=timeout_seconds, label="deploy"
    )


def _run_subprocess_with_kill_on_timeout(
    argv: list[str], *, cwd: Path, timeout: int, label: str
) -> bool:
    """Run argv, kill its process group on timeout, drain output via threads.

    Returns True on rc=0, False on any failure (timeout, non-zero rc, exception).
    """
    import os
    proc: subprocess.Popen[str] | None = None
    out_lines: list[str] = []
    err_lines: list[str] = []

    def _drain(stream: Any, sink: list[str]) -> None:
        try:
            for line in iter(stream.readline, ""):
                sink.append(line)
                if len(sink) > 500:  # cap memory; keep last 500 lines
                    del sink[: len(sink) - 500]
        except Exception:  # noqa: BLE001, S110
            pass

    try:
        proc = subprocess.Popen(  # noqa: S603
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,  # own process group → killpg works
        )
        out_thread = threading.Thread(target=_drain, args=(proc.stdout, out_lines), daemon=True)
        err_thread = threading.Thread(target=_drain, args=(proc.stderr, err_lines), daemon=True)
        out_thread.start()
        err_thread.start()
        try:
            rc = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            log.error("%s timed out after %ds; killing process group", label, timeout)
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                # Brief grace period before SIGKILL
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)
            except (ProcessLookupError, PermissionError) as kill_exc:
                log.warning("%s killpg failed: %s", label, kill_exc)
            return False
        finally:
            # Give drainers a moment to flush; they're daemon threads so they
            # die with the process if they don't finish.
            out_thread.join(timeout=2)
            err_thread.join(timeout=2)
        if rc != 0:
            log.error(
                "%s failed (rc=%d); stdout=%s stderr=%s",
                label, rc, "".join(out_lines)[-500:], "".join(err_lines)[-500:],
            )
            return False
        log.info("%s ok", label)
        return True
    except Exception:  # noqa: BLE001
        log.exception("%s raised unexpectedly", label)
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        return False


def supervisor_loop(settings: Settings, *, max_iterations: int | None = None) -> None:
    """Run ticks every settings.tick_minutes. Exponential backoff on consecutive failures."""
    backoff = INITIAL_BACKOFF_SECONDS
    consecutive_fail = 0
    iteration = 0

    while True:
        if max_iterations is not None and iteration >= max_iterations:
            return
        iteration += 1

        tick_ok = run_tick_with_watchdog(settings)
        deploy_ok = deploy_to_r2(settings) if tick_ok else False
        ok = tick_ok and deploy_ok
        if ok:
            consecutive_fail = 0
            backoff = INITIAL_BACKOFF_SECONDS
            sleep_s = settings.tick_minutes * 60
        else:
            consecutive_fail += 1
            sleep_s = min(backoff, MAX_BACKOFF_SECONDS)
            backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
            failed_step = "tick" if not tick_ok else "deploy"
            log.warning(
                "%s failed (consecutive=%d); sleeping %ds before retry",
                failed_step, consecutive_fail, sleep_s,
            )

        if max_iterations is not None and iteration >= max_iterations:
            return

        # Self-restart hook: if generator/*.py was modified since this
        # process started, exit non-zero so launchd respawns with the
        # new code on disk. Check AFTER the tick (so the current tick
        # completes with whatever module state was in memory) and
        # BEFORE the long sleep (so we don't wait an hour to restart).
        # SuccessfulExit=false in the launchd plist makes the non-zero
        # exit trigger a restart.
        if _generator_code_changed():
            log.warning(
                "generator code changed on disk (max mtime > %.0f); "
                "exiting non-zero so launchd restarts with fresh modules",
                _GENERATOR_MTIME_AT_START,
            )
            sys.exit(1)

        try:
            time.sleep(sleep_s)
        except KeyboardInterrupt:
            # The stall watchdog ALSO raises SIGINT to break a stuck tick. If
            # we swallow that and return cleanly, launchd's KeepAlive (which
            # restarts on Crashed=true / SuccessfulExit=false) won't bring the
            # daemon back. Re-raise so main() exits non-zero and launchd
            # treats it as a crash.
            log.info("supervisor interrupted; exiting non-zero so launchd restarts")
            raise


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = Settings.from_env()
    try:
        supervisor_loop(settings)
    except KeyboardInterrupt:
        return 130  # standard SIGINT exit code; non-zero so launchd restarts
    except Exception:
        log.exception("supervisor crashed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
