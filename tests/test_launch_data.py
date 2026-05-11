"""Tests for generator.launch_data — LL2 fetcher + parser + schema hash.

Covers the contract /plan-eng-review locked: parse the pinned fixture,
ETag-style cache reuse, cache fallback on network AND parse errors,
status/NET filters, schema-hash stability + drift detection.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest
import requests

from generator.launch_data import (
    NET_WINDOW_MAX_SECONDS,
    compute_schema_hash,
    fetch_upcoming_launches,
    filter_launches,
    parse_response,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "ll2-response-2026-05.json"


@pytest.fixture
def fixture_payload() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


@pytest.fixture
def fixture_text() -> str:
    return FIXTURE_PATH.read_text()


@pytest.fixture
def cache_path(tmp_path: Path) -> Path:
    return tmp_path / "launches.json"


# -------- parse_response: shape correctness ---------------------------------


def test_parse_response_extracts_all_four_results(fixture_payload: dict) -> None:
    launches = parse_response(fixture_payload, now=datetime(2025, 1, 1, tzinfo=UTC))
    assert len(launches) == 4
    assert {la.id for la in launches} == {
        "f9-starlink-2026-05-test-1",
        "soyuz-progress-baikonur-2026-05-test-2",
        "vulcan-tbd-2026-test-3",
        "f9-cap-vandy-2026-test-4",
    }


def test_parse_response_falcon9_fields(fixture_payload: dict) -> None:
    launches = parse_response(fixture_payload, now=datetime(2025, 1, 1, tzinfo=UTC))
    falcon = next(la for la in launches if la.id == "f9-starlink-2026-05-test-1")
    assert falcon.name == "Falcon 9 Block 5 | Starlink Group 6-99"
    assert falcon.t0 == datetime(2026, 5, 12, 3, 42, 0, tzinfo=UTC)
    assert falcon.net_window_seconds == 0  # window_start == window_end
    assert falcon.site_lat == pytest.approx(28.6082)
    assert falcon.site_lon == pytest.approx(-80.6041)
    assert falcon.site_name == "Kennedy Space Center, FL, USA"
    assert falcon.rocket_type == "Falcon 9 Block 5"
    assert falcon.status_abbrev == "Go"


def test_parse_response_wide_window_computes_half_width(fixture_payload: dict) -> None:
    launches = parse_response(fixture_payload, now=datetime(2025, 1, 1, tzinfo=UTC))
    wide = next(la for la in launches if la.id == "f9-cap-vandy-2026-test-4")
    # window_start=21:00, window_end=23:00 → 2h total → ±1h half = 3600s
    assert wide.net_window_seconds == 3600


def test_parse_response_skips_malformed_row_silently() -> None:
    payload = {
        "results": [
            {"id": "missing-everything"},  # malformed
            {  # well-formed
                "id": "ok-1",
                "name": "OK",
                "net": "2026-05-12T03:42:00Z",
                "window_start": "2026-05-12T03:42:00Z",
                "window_end": "2026-05-12T03:42:00Z",
                "status": {"abbrev": "Go"},
                "rocket": {"configuration": {"name": "Foo", "full_name": "Foo Heavy"}},
                "pad": {"latitude": "28.6", "longitude": "-80.6", "location": {"name": "Test"}},
            },
        ]
    }
    launches = parse_response(payload)
    assert len(launches) == 1
    assert launches[0].id == "ok-1"


def test_parse_response_empty_results() -> None:
    assert parse_response({"results": []}) == []
    assert parse_response({}) == []


def test_parse_response_results_not_list_returns_empty() -> None:
    # LL2 schema drift / proxy failure could put a string here.
    assert parse_response({"results": "oops"}) == []


# -------- filter_launches: status + NET window ------------------------------


def test_filter_drops_tbd_status(fixture_payload: dict) -> None:
    launches = parse_response(fixture_payload, now=datetime(2025, 1, 1, tzinfo=UTC))
    filtered = filter_launches(launches)
    ids = {la.id for la in filtered}
    assert "vulcan-tbd-2026-test-3" not in ids  # TBD status
    # Soyuz with status "Success" also dropped — only Go/Confirmed pass
    assert "soyuz-progress-baikonur-2026-05-test-2" not in ids


def test_filter_drops_wide_net_window(fixture_payload: dict) -> None:
    launches = parse_response(fixture_payload, now=datetime(2025, 1, 1, tzinfo=UTC))
    filtered = filter_launches(launches)
    ids = {la.id for la in filtered}
    # Vandy fixture has a 1-hour half-window = 3600s > NET_WINDOW_MAX_SECONDS
    assert "f9-cap-vandy-2026-test-4" not in ids
    # Threshold tightened 2026-05-10 (review): NET cap must align with the
    # find_passes window so a NET-uncertain launch can't fall outside it.
    assert NET_WINDOW_MAX_SECONDS == 300


def test_filter_keeps_clean_falcon9(fixture_payload: dict) -> None:
    launches = parse_response(fixture_payload, now=datetime(2025, 1, 1, tzinfo=UTC))
    filtered = filter_launches(launches)
    assert len(filtered) == 1
    assert filtered[0].id == "f9-starlink-2026-05-test-1"


# -------- compute_schema_hash: stability + drift ----------------------------


def test_schema_hash_stable_across_identical_responses(fixture_payload: dict) -> None:
    h1 = compute_schema_hash(fixture_payload)
    h2 = compute_schema_hash(json.loads(json.dumps(fixture_payload)))
    assert h1 == h2
    assert len(h1) == 16  # 16-hex-char prefix of sha256


def test_schema_hash_changes_when_top_level_key_added(fixture_payload: dict) -> None:
    base = compute_schema_hash(fixture_payload)
    drifted = dict(fixture_payload)
    drifted["new_top_level_field"] = "added"
    assert compute_schema_hash(drifted) != base


def test_schema_hash_changes_when_result_field_added(fixture_payload: dict) -> None:
    base = compute_schema_hash(fixture_payload)
    drifted = json.loads(json.dumps(fixture_payload))  # deep copy
    drifted["results"][0]["new_field_on_each_result"] = True
    assert compute_schema_hash(drifted) != base


def test_schema_hash_unchanged_when_only_values_change(fixture_payload: dict) -> None:
    base = compute_schema_hash(fixture_payload)
    drifted = json.loads(json.dumps(fixture_payload))
    drifted["count"] = 999
    drifted["results"][0]["name"] = "different launch name"
    assert compute_schema_hash(drifted) == base


def test_schema_hash_changes_when_nested_status_key_added(fixture_payload: dict) -> None:
    base = compute_schema_hash(fixture_payload)
    drifted = json.loads(json.dumps(fixture_payload))
    drifted["results"][0]["status"]["new_nested_key"] = 1
    assert compute_schema_hash(drifted) != base


def test_schema_hash_handles_empty_results() -> None:
    # Defensive: schema_hash on a response with no results should still
    # produce a stable hash (used during LL2-down fallback).
    h = compute_schema_hash({"count": 0, "results": []})
    assert isinstance(h, str)
    assert len(h) == 16


# -------- fetch_upcoming_launches: cache + network paths --------------------


def test_fetch_uses_fresh_cache_without_network(
    cache_path: Path, fixture_text: str
) -> None:
    cache_path.write_text(fixture_text)
    n = datetime.now(tz=UTC)

    with patch("generator.launch_data.requests.get") as mock_get:
        result = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    assert mock_get.call_count == 0  # never hit the network
    assert len(result.launches) == 4
    assert result.schema_hash is not None
    assert result.last_successful_fetch is not None  # mtime of cache


def test_fetch_hits_network_when_cache_stale(
    cache_path: Path, fixture_text: str
) -> None:
    # Pre-write cache with an old mtime so the TTL gate fails.
    cache_path.write_text(fixture_text)
    import os
    old = (datetime.now(tz=UTC) - timedelta(hours=2)).timestamp()
    os.utime(cache_path, (old, old))

    n = datetime.now(tz=UTC)

    class FakeResp:
        text = fixture_text
        def raise_for_status(self) -> None: ...

    with patch("generator.launch_data.requests.get", return_value=FakeResp()) as mock_get:
        result = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    assert mock_get.call_count == 1
    assert len(result.launches) == 4
    assert result.last_successful_fetch == n  # fresh fetch timestamp


def test_fetch_falls_back_to_cache_on_network_error(
    cache_path: Path, fixture_text: str
) -> None:
    cache_path.write_text(fixture_text)
    import os
    old = (datetime.now(tz=UTC) - timedelta(hours=2)).timestamp()
    os.utime(cache_path, (old, old))
    n = datetime.now(tz=UTC)

    with patch(
        "generator.launch_data.requests.get",
        side_effect=requests.ConnectionError("net down"),
    ):
        result = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    assert len(result.launches) == 4  # served from cache
    # last_successful_fetch reflects cache mtime (old), not now
    assert result.last_successful_fetch is not None
    assert result.last_successful_fetch < n


def test_fetch_falls_back_to_cache_on_parse_error(
    cache_path: Path, fixture_text: str
) -> None:
    cache_path.write_text(fixture_text)
    import os
    old = (datetime.now(tz=UTC) - timedelta(hours=2)).timestamp()
    os.utime(cache_path, (old, old))
    n = datetime.now(tz=UTC)

    class HtmlErrorResp:
        text = "<html><body>503 Bad Gateway</body></html>"
        def raise_for_status(self) -> None: ...

    with patch("generator.launch_data.requests.get", return_value=HtmlErrorResp()):
        result = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    # Cache survived (no overwrite with garbage). Result reflects cached parse.
    assert len(result.launches) == 4
    cached_after = cache_path.read_text()
    assert cached_after == fixture_text


def test_fetch_returns_empty_when_no_cache_and_network_fails(
    cache_path: Path,
) -> None:
    n = datetime.now(tz=UTC)
    with patch(
        "generator.launch_data.requests.get",
        side_effect=requests.ConnectionError("net down"),
    ):
        result = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    assert result.launches == []
    assert result.last_successful_fetch is None
    assert result.schema_hash is None
    assert result.count_upcoming_unfiltered == 0


def test_fetch_writes_cache_on_successful_network(
    cache_path: Path, fixture_text: str
) -> None:
    n = datetime.now(tz=UTC)
    assert not cache_path.exists()

    class FakeResp:
        text = fixture_text
        def raise_for_status(self) -> None: ...

    with patch("generator.launch_data.requests.get", return_value=FakeResp()):
        result = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    assert cache_path.exists()
    assert cache_path.read_text() == fixture_text
    assert result.last_successful_fetch == n


def test_fetch_does_not_overwrite_cache_with_html_error(
    cache_path: Path, fixture_text: str
) -> None:
    """Iron rule from fetch_tle pattern: never replace a known-good cache
    with a parse-failing response. If LL2 returns a 200 OK with HTML body
    (CDN error captured as 200), the prior cache must survive."""
    cache_path.write_text(fixture_text)
    import os
    old = (datetime.now(tz=UTC) - timedelta(hours=2)).timestamp()
    os.utime(cache_path, (old, old))
    n = datetime.now(tz=UTC)

    class HtmlErrorResp:
        text = "<html><body>cdn outage</body></html>"
        def raise_for_status(self) -> None: ...

    with patch("generator.launch_data.requests.get", return_value=HtmlErrorResp()):
        fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    # Cache still has the original good fixture.
    assert cache_path.read_text() == fixture_text


def test_fetch_result_carries_schema_hash_for_status_json(
    cache_path: Path, fixture_text: str
) -> None:
    """Per ARCH-1 (eng review 2026-05-05), main.py threads schema_hash into
    status.json. Confirm fetch returns it."""
    cache_path.write_text(fixture_text)
    n = datetime.now(tz=UTC)

    result = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    assert result.schema_hash is not None
    # Same shape → same hash across calls.
    result2 = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    assert result2.schema_hash == result.schema_hash


# -------- Sanity rejections (review 2026-05-10) -----------------------------


def test_parse_response_rejects_nan_pad_coords() -> None:
    """float('NaN') parses cleanly but breaks json.dumps + great-circle math.
    Must skip the row + log a warning, not surface a broken Launch."""
    payload = {
        "results": [{
            "id": "nan-coords",
            "name": "Bad",
            "net": "2099-01-01T00:00:00Z",  # far future so past-filter doesn't fire
            "window_start": "2099-01-01T00:00:00Z",
            "window_end": "2099-01-01T00:00:00Z",
            "status": {"abbrev": "Go"},
            "rocket": {"configuration": {"name": "X", "full_name": "X"}},
            "pad": {"latitude": "NaN", "longitude": "0", "location": {"name": "Test"}},
        }]
    }
    assert parse_response(payload) == []


def test_parse_response_rejects_infinity_pad_coords() -> None:
    payload = {
        "results": [{
            "id": "inf-coords",
            "name": "Bad",
            "net": "2099-01-01T00:00:00Z",
            "window_start": "2099-01-01T00:00:00Z",
            "window_end": "2099-01-01T00:00:00Z",
            "status": {"abbrev": "Go"},
            "rocket": {"configuration": {"name": "X", "full_name": "X"}},
            "pad": {"latitude": "Infinity", "longitude": "-Infinity", "location": {"name": "Test"}},
        }]
    }
    assert parse_response(payload) == []


def test_parse_response_rejects_out_of_range_coords() -> None:
    """abs(lat) > 90 or abs(lon) > 180 is geographically invalid."""
    payload = {
        "results": [{
            "id": "ooor",
            "name": "Bad",
            "net": "2099-01-01T00:00:00Z",
            "window_start": "2099-01-01T00:00:00Z",
            "window_end": "2099-01-01T00:00:00Z",
            "status": {"abbrev": "Go"},
            "rocket": {"configuration": {"name": "X", "full_name": "X"}},
            "pad": {"latitude": "100", "longitude": "0", "location": {"name": "Test"}},
        }]
    }
    assert parse_response(payload) == []


def test_parse_response_rejects_t0_in_past() -> None:
    """LL2 occasionally returns completed launches in the upcoming feed.
    Cache-fallback after weeks of LL2 downtime would otherwise re-publish
    them as upcoming. parse_response with now=N filters past-t0 rows."""
    n = datetime(2026, 5, 12, 12, 0, 0, tzinfo=UTC)
    payload = {
        "results": [{
            "id": "past-launch",
            "name": "Yesterday",
            "net": "2026-05-11T03:42:00Z",  # 1 day before now
            "window_start": "2026-05-11T03:42:00Z",
            "window_end": "2026-05-11T03:42:00Z",
            "status": {"abbrev": "Go"},
            "rocket": {"configuration": {"name": "X", "full_name": "X"}},
            "pad": {"latitude": "28.6", "longitude": "-80.6", "location": {"name": "Test"}},
        }]
    }
    assert parse_response(payload, now=n) == []


def test_parse_response_keeps_t0_in_future(fixture_payload: dict) -> None:
    """Sanity check: future-t0 launches still parse when now is in the past."""
    n = datetime(2025, 1, 1, tzinfo=UTC)  # well before fixture's 2026 launches
    launches = parse_response(fixture_payload, now=n)
    assert len(launches) == 4


def test_fetch_from_stale_cache_drops_completed_launches(
    cache_path: Path, fixture_text: str
) -> None:
    """Cache-fallback after LL2 has been down for weeks: re-filter against
    the current wall clock so completed launches don't surface as upcoming."""
    cache_path.write_text(fixture_text)
    # Pre-set old mtime so TTL is stale
    import os
    old = (datetime.now(tz=UTC) - timedelta(hours=2)).timestamp()
    os.utime(cache_path, (old, old))
    # "now" is in 2030 — well past all fixture launches (2026).
    n = datetime(2030, 1, 1, tzinfo=UTC)
    with patch(
        "generator.launch_data.requests.get",
        side_effect=requests.ConnectionError("net down"),
    ):
        result = fetch_upcoming_launches(cache_path, ttl_hours=1.0, now=n)
    # All 4 fixture launches are pre-2030 → past → filtered out
    assert result.launches == []


def test_net_window_max_aligns_with_pass_window() -> None:
    """The NET-window cap must NEVER exceed PASS_WINDOW_SECONDS — if NET
    uncertainty is wider than the find_passes window, the searched window
    can miss the real T-0 entirely. Locked by adversarial review 2026-05-10."""
    from generator.launch_data import NET_WINDOW_MAX_SECONDS, PASS_WINDOW_SECONDS
    assert NET_WINDOW_MAX_SECONDS <= PASS_WINDOW_SECONDS
