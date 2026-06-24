"""Shared pooled HTTP session for the generator's outbound fetches.

Why this exists
---------------
Every fetch site historically used a bare ``requests.get(...)``. ``requests.get``
spins up a brand-new ``Session`` internally on every call, so each request opens a
fresh TCP connection and leaves it in ``TIME_WAIT`` when it closes. The hourly tick
bursts hundreds of these — most acutely the ~360 parallel GLM granule GETs to S3,
plus the GIBS tiles and the Open-Meteo batches — so a slow tick (or one fighting a
flaky upstream) briefly piles ``TIME_WAIT`` sockets onto the host.

On 2026-06-23/24 the host wedged its own networking via macOS ephemeral-port
exhaustion (~19k stuck ``TIME_WAIT`` sockets filled the default 49152-65535 range,
after which every ``127.0.0.1`` connect failed with "Can't assign requested
address"). The generator was NOT the dominant contributor — the bulk were
localhost services (BlueBubbles relay, the gateway) which this app never touches,
and between ticks the daemon holds zero connections. But opening a fresh socket per
request when a pooled one would do is poor host citizenship, so this module makes
the generator reuse connections instead of churning them.

A single process-global ``Session`` with HTTP keep-alive reuses connections
per-host, collapsing the per-tick burst to a small bounded pool. It is safe to
share across the GLM ``ThreadPoolExecutor``: urllib3's connection pool guards
checkout/checkin, and the pool is sized above the worker count so concurrent GETs
never starve. Tests that inject their own ``fetcher`` bypass this entirely.

The real defense against port exhaustion is the host net-tuning LaunchDaemon
(``com.astroanil.net-tuning``); see :mod:`generator.netcheck` for the startup
self-check that warns if it is missing. This module just keeps the generator from
being a cause.
"""

from __future__ import annotations

import threading
from typing import Any

# Sized to the GLM granule fetch fan-out (lightning.GLM_FETCH_MAX_WORKERS = 16)
# plus headroom for the other samplers interleaving on the same host. 16 workers
# each reuse a pooled keep-alive connection to s3.amazonaws.com across their ~22
# sequential granule GETs, instead of opening a fresh socket every time.
POOL_MAXSIZE = 24

# Retry ONLY transient connection failures, and only once. We deliberately do
# NOT retry on HTTP status (status=0) or reads (read=0): the app layers already
# own that policy — forecast_clouds has explicit 429 backoff, the daemon has
# tick-level exponential backoff, and read retries risk duplicating a
# non-idempotent effect. So this is purely "the socket dropped mid-connect, try
# once more" — it does not change any app-visible retry semantics.
CONNECT_RETRIES = 1
RETRY_BACKOFF_FACTOR = 0.5

_session: Any | None = None
_lock = threading.Lock()


def _build_session() -> Any:
    import requests
    from requests.adapters import HTTPAdapter

    try:
        from urllib3.util.retry import Retry

        retries: Any = Retry(
            total=CONNECT_RETRIES,
            connect=CONNECT_RETRIES,
            read=0,
            redirect=0,
            status=0,
            backoff_factor=RETRY_BACKOFF_FACTOR,
            respect_retry_after_header=True,
        )
    except Exception:  # pragma: no cover - urllib3 always ships with requests
        retries = CONNECT_RETRIES

    adapter = HTTPAdapter(
        pool_connections=POOL_MAXSIZE,
        pool_maxsize=POOL_MAXSIZE,
        max_retries=retries,
    )
    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def get_session() -> Any:
    """Return the process-global pooled ``requests.Session`` (lazy, thread-safe).

    The first caller builds and mounts the keep-alive adapter; every subsequent
    caller — including worker threads in the GLM fetch pool — gets the same
    instance, so connections are reused instead of re-opened.
    """
    global _session
    if _session is not None:
        return _session
    with _lock:
        if _session is None:
            _session = _build_session()
    return _session


def reset_session_for_test() -> None:
    """Drop the cached session so a test can rebuild it in isolation."""
    global _session
    with _lock:
        if _session is not None:
            try:
                _session.close()
            except Exception:  # noqa: BLE001, S110 - best effort cleanup
                pass
        _session = None
