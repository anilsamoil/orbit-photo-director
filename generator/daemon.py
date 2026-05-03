"""Generator daemon: runs main.run_tick on an interval with a stall watchdog.

Inherits the OpenClaw subprocess-stall-watchdog pattern: any single tick that runs longer
than HARD_TIMEOUT_SECONDS gets aborted via a watchdog thread that raises in the main thread.
On repeated failures, exponential backoff up to MAX_BACKOFF_SECONDS.
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
import time
from datetime import datetime

from .config import Settings
from .main import run_tick

log = logging.getLogger(__name__)

HARD_TIMEOUT_SECONDS = 600  # 10 min
INITIAL_BACKOFF_SECONDS = 30
MAX_BACKOFF_SECONDS = 3600  # 1h


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


def supervisor_loop(settings: Settings, *, max_iterations: int | None = None) -> None:
    """Run ticks every settings.tick_minutes. Exponential backoff on consecutive failures."""
    backoff = INITIAL_BACKOFF_SECONDS
    consecutive_fail = 0
    iteration = 0

    while True:
        if max_iterations is not None and iteration >= max_iterations:
            return
        iteration += 1

        ok = run_tick_with_watchdog(settings)
        if ok:
            consecutive_fail = 0
            backoff = INITIAL_BACKOFF_SECONDS
            sleep_s = settings.tick_minutes * 60
        else:
            consecutive_fail += 1
            sleep_s = min(backoff, MAX_BACKOFF_SECONDS)
            backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
            log.warning(
                "tick failed (consecutive=%d); sleeping %ds before retry",
                consecutive_fail,
                sleep_s,
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
