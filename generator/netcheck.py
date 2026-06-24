"""Host network self-checks: a guardrail against silent port exhaustion.

Context
-------
On 2026-06-23/24 the host (macOS Mac mini) wedged its own networking through
ephemeral-port exhaustion: ~19k stuck ``TIME_WAIT`` sockets filled the default
49152-65535 range, after which every ``127.0.0.1`` connect failed with "Can't
assign requested address" and the whole box went dark for hours. The fix was a
LaunchDaemon (``com.astroanil.net-tuning``) that widens the ephemeral range to
32768 and shortens ``TIME_WAIT`` linger (``net.inet.tcp.msl`` 15000 -> 750 ms).

This module gives the generator two cheap, best-effort guardrails so the same
condition is caught EARLY next time rather than discovered as a multi-hour outage:

1. :func:`warn_if_net_tuning_missing` — run once at daemon startup. Warns if the
   ephemeral-port floor is back at (or near) the 49152 default, i.e. the host
   net-tuning daemon did not load. This app depends on that daemon being active.

2. :func:`warn_if_time_wait_high` — run once per tick. Logs the host ``TIME_WAIT``
   count as a metric and warns if it crosses a threshold, so a climbing socket
   pile is visible in the generator log long before it exhausts the port range.

Both functions are macOS-only, run external tools with a short timeout, and NEVER
raise — they execute inside the mission-critical tick loop and must not be able to
break it. On any other platform, or any failure, they no-op (returning ``None``).
"""

from __future__ import annotations

import logging
import subprocess
import sys

# macOS default ephemeral floor is 49152 (~16k ports). The net-tuning daemon
# lowers it to 32768 (~33k ports). Anything at/above this means the tuning is
# NOT applied — treat as the danger state. Picked above 32768 and below 49152.
EPHEMERAL_FLOOR_DANGER_AT = 40000
NET_TUNING_DAEMON = "com.astroanil.net-tuning"

# Warn when host TIME_WAIT climbs past this. The outage peaked ~19k; 8000 is a
# loud-but-not-yet-fatal early-warning line (≈ half the old 16k range).
TIME_WAIT_WARN_THRESHOLD = 8000

_SUBPROCESS_TIMEOUT_S = 5


def _is_macos() -> bool:
    return sys.platform == "darwin"


def ephemeral_port_floor() -> int | None:
    """Return ``net.inet.ip.portrange.first`` (macOS), or ``None`` on failure."""
    if not _is_macos():
        return None
    try:
        out = subprocess.run(  # noqa: S603
            ["sysctl", "-n", "net.inet.ip.portrange.first"],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT_S,
            check=False,
        )
        if out.returncode != 0:
            return None
        return int(out.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def count_time_wait() -> int | None:
    """Return the host's total ``TIME_WAIT`` socket count, or ``None`` on failure.

    Uses ``netstat -an`` (universally present on macOS; no ``ss``). The output is
    a few thousand lines at worst and this runs once per hour, so the cost is
    negligible.
    """
    if not _is_macos():
        return None
    try:
        out = subprocess.run(  # noqa: S603
            ["netstat", "-an"],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT_S,
            check=False,
        )
        if out.returncode != 0:
            return None
        return out.stdout.count("TIME_WAIT")
    except (OSError, subprocess.SubprocessError):
        return None


def warn_if_net_tuning_missing(log: logging.Logger) -> int | None:
    """Once at startup: warn if the host ephemeral-port tuning is not applied.

    Returns the observed floor (for tests/visibility), or ``None`` if it could
    not be read. Never raises.
    """
    floor = ephemeral_port_floor()
    if floor is None:
        return None
    if floor >= EPHEMERAL_FLOOR_DANGER_AT:
        log.warning(
            "host ephemeral-port floor is %d (>= %d) — the net-tuning daemon "
            "'%s' appears NOT to be loaded. The host has only ~%d ephemeral "
            "ports and is vulnerable to TIME_WAIT exhaustion (the 2026-06-24 "
            "outage). Load it: sudo launchctl load -w "
            "/Library/LaunchDaemons/%s.plist",
            floor,
            EPHEMERAL_FLOOR_DANGER_AT,
            NET_TUNING_DAEMON,
            65535 - floor,
            NET_TUNING_DAEMON,
        )
    else:
        log.info(
            "host ephemeral-port floor=%d (net-tuning active; ~%d ports)",
            floor,
            65535 - floor,
        )
    return floor


def warn_if_time_wait_high(
    log: logging.Logger, threshold: int = TIME_WAIT_WARN_THRESHOLD
) -> int | None:
    """Once per tick: log the host TIME_WAIT count; warn if it crosses threshold.

    Returns the observed count (for tests/visibility), or ``None`` if it could
    not be read. Never raises.
    """
    count = count_time_wait()
    if count is None:
        return None
    if count >= threshold:
        log.warning(
            "host TIME_WAIT sockets = %d (>= %d threshold) — approaching "
            "ephemeral-port exhaustion. If this keeps climbing, localhost "
            "connects will start failing with 'Can't assign requested "
            "address'. Check what is churning connections "
            "(netstat -an | grep TIME_WAIT | awk '{print $5}' | sort | uniq -c).",
            count,
            threshold,
        )
    else:
        log.info("host TIME_WAIT sockets = %d (healthy, < %d)", count, threshold)
    return count
