"""Tests for generator.netpool — the shared pooled HTTP session."""

from __future__ import annotations

import threading

import pytest

from generator import netpool


@pytest.fixture(autouse=True)
def _reset() -> None:
    netpool.reset_session_for_test()
    yield
    netpool.reset_session_for_test()


def test_get_session_is_singleton() -> None:
    """Every caller gets the SAME session, so connections are reused — this is
    the whole point (no fresh socket per request)."""
    s1 = netpool.get_session()
    s2 = netpool.get_session()
    assert s1 is s2


def test_session_mounts_pooled_keepalive_adapter() -> None:
    """https:// and http:// are served by an adapter whose pool is sized for the
    GLM worker fan-out, so concurrent GETs reuse keep-alive connections."""
    s = netpool.get_session()
    for scheme in ("https://", "http://"):
        adapter = s.get_adapter(scheme)
        # urllib3 PoolManager carries the max pool size we configured.
        assert adapter._pool_maxsize == netpool.POOL_MAXSIZE
        assert adapter._pool_maxsize >= 16  # ≥ GLM_FETCH_MAX_WORKERS


def test_retry_is_connect_only_not_status() -> None:
    """The pooled session must NOT add HTTP-status retries — forecast_clouds and
    the daemon already own 429/backoff. Only a dropped connect is retried."""
    s = netpool.get_session()
    retries = s.get_adapter("https://").max_retries
    # Retry object (not a bare int) with status/read disabled.
    assert retries.total == netpool.CONNECT_RETRIES
    assert retries.status == 0
    assert retries.read == 0
    assert retries.connect == netpool.CONNECT_RETRIES


def test_reset_drops_session() -> None:
    s1 = netpool.get_session()
    netpool.reset_session_for_test()
    s2 = netpool.get_session()
    assert s1 is not s2


def test_concurrent_callers_share_one_session() -> None:
    """Worker threads (e.g. the GLM pool) must all see one session instance."""
    netpool.reset_session_for_test()
    seen: list[object] = []
    barrier = threading.Barrier(8)

    def grab() -> None:
        barrier.wait()
        seen.append(netpool.get_session())

    threads = [threading.Thread(target=grab) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(seen) == 8
    assert all(s is seen[0] for s in seen)
