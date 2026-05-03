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

from .config import Settings
from .main import run_tick

log = logging.getLogger(__name__)

HARD_TIMEOUT_SECONDS = 600  # 10 min
DEPLOY_TIMEOUT_SECONDS = 300  # 5 min
INITIAL_BACKOFF_SECONDS = 30
MAX_BACKOFF_SECONDS = 3600  # 1h
# Default to the rclone-based deploy. Override with OPD_DEPLOY_SCRIPT if needed
# (e.g., to use scripts/deploy_wrangler.sh when R2 keys aren't available).
DEPLOY_SCRIPT_DEFAULT = Path("scripts") / "deploy.sh"


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
    argv = ["bash", str(script)]  # noqa: S607
    try:
        proc = subprocess.run(  # noqa: S603
            argv,
            cwd=settings.repo_root,
            timeout=timeout_seconds,
            capture_output=True,
            text=True,
            check=False,
        )
    except subprocess.TimeoutExpired:
        log.error("deploy timed out after %ds", timeout_seconds)
        return False
    except Exception:  # noqa: BLE001
        log.exception("deploy raised unexpectedly")
        return False
    if proc.returncode != 0:
        log.error(
            "deploy failed (rc=%d); stdout=%s stderr=%s",
            proc.returncode, proc.stdout[-500:], proc.stderr[-500:],
        )
        return False
    log.info("deploy ok")
    return True


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

        try:
            time.sleep(sleep_s)
        except KeyboardInterrupt:
            log.info("supervisor interrupted; exiting")
            return


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = Settings.from_env()
    supervisor_loop(settings)
    return 0


if __name__ == "__main__":
    sys.exit(main())
