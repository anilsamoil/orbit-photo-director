"""LL2 cooldown/ownership survives retries, concurrent readers and process loss."""

import fcntl
import hashlib
import importlib
import json
import os
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from pathlib import Path
from unittest.mock import patch

import pytest
import requests

from generator import launch_data

NOW = datetime(2026, 5, 11, tzinfo=UTC)
FIXTURE = Path(__file__).parent / "fixtures/ll2-response-2026-05.json"


@pytest.fixture
def cache(tmp_path):
    path = tmp_path / "launches.json"
    path.write_bytes(FIXTURE.read_bytes())
    old = (NOW - timedelta(hours=2)).timestamp()
    os.utime(path, (old, old))
    receipt = path.with_suffix(".json.receipt.json")
    receipt.write_text('{"existing": "must not change on failure"}')
    return path


def response(status=200, headers=None, body=None):
    result = requests.Response()
    result.status_code = status
    result.headers.update(headers or {})
    result._content = (body or FIXTURE.read_text()).encode()
    return result


def state(path):
    return json.loads(path.with_suffix(".json.request.json").read_text())


def fetch(path, when=NOW):
    with patch("generator.launch_data._utc_now", return_value=when, create=True):
        return launch_data.fetch_upcoming_launches(path, now=when)


def test_retry_after_survives_restart_without_renewing_good_cache(cache):
    raw = cache.read_bytes()
    mtime = cache.stat().st_mtime_ns
    receipt = cache.with_suffix(".json.receipt.json").read_bytes()
    with patch("requests.get", return_value=response(429, {"Retry-After": "7200"})) as get:
        result = fetch(cache)
        importlib.reload(launch_data)
        fetch(cache, NOW + timedelta(hours=1))
    assert get.call_count == 1
    assert state(cache)["status"] == 429
    assert state(cache)["next_attempt_at"] == (NOW + timedelta(hours=2)).isoformat()
    assert result.last_successful_fetch < NOW
    assert (cache.read_bytes(), cache.stat().st_mtime_ns) == (raw, mtime)
    assert cache.with_suffix(".json.receipt.json").read_bytes() == receipt


@pytest.mark.parametrize("header,delay", [
    ("7200", 7200),
    (format_datetime(NOW + timedelta(hours=3), usegmt=True), 10800),
    ("0", 900),
    ("-1", 900),
    ("NaN", 900),
    ("1.5", 900),
    ("garbage", 900),
    ("9" * 500, 900),
    (format_datetime(NOW - timedelta(hours=1), usegmt=True), 900),
    (None, 900),
])
def test_retry_after_parsing_and_minimum_budget(cache, header, delay):
    headers = {"Retry-After": header} if header is not None else {}
    with patch("requests.get", return_value=response(429, headers)):
        fetch(cache)
    assert state(cache)["next_attempt_at"] == (NOW + timedelta(seconds=delay)).isoformat()


def test_fallback_backoff_is_capped_and_recovers(cache):
    when = NOW
    with patch("requests.get", return_value=response(429)) as get:
        for delay in [900, 1800, 3600, 7200, 7200]:
            fetch(cache, when)
            next_at = datetime.fromisoformat(state(cache)["next_attempt_at"])
            assert next_at == when + timedelta(seconds=delay)
            fetch(cache, next_at - timedelta(seconds=1))
            when = next_at
        assert get.call_count == 5
    with patch("requests.get", return_value=response()) as get:
        result = fetch(cache, when)
    assert get.call_count == 1
    assert state(cache)["consecutive_failures"] == 0
    assert state(cache)["outcome"] == "ok"
    assert result.last_successful_fetch == when
    assert json.loads(cache.with_suffix(".json.receipt.json").read_text())["fetched_at"] == when.isoformat()


def test_large_valid_server_delay_is_not_shortened_to_backoff_cap(cache):
    with patch("requests.get", return_value=response(503, {"Retry-After": "172800"})):
        fetch(cache)
    assert state(cache)["next_attempt_at"] == (NOW + timedelta(days=2)).isoformat()


def test_lock_contention_serves_cache_without_request(cache):
    with cache.with_suffix(".json.fetch.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with patch("requests.get") as get:
            result = fetch(cache)
    get.assert_not_called()
    assert len(result.launches) == 4


def test_overlapping_consumer_cannot_start_second_request(cache):
    def during_get(*args, **kwargs):
        assert len(fetch(cache).launches) == 4
        return response()

    with patch("requests.get", side_effect=during_get) as get:
        fetch(cache)
    assert get.call_count == 1


def test_crash_after_reserving_attempt_retains_cooldown(cache):
    with patch("requests.get", side_effect=SystemExit("crash")):
        with pytest.raises(SystemExit):
            fetch(cache)
    assert state(cache)["outcome"] == "in_flight"
    with patch("requests.get") as get:
        fetch(cache, NOW + timedelta(minutes=5))
    get.assert_not_called()


@pytest.mark.parametrize("failure", ["network", "invalid_json", "invalid_schema"])
def test_failure_preserves_cache_and_persists_bounded_backoff(cache, failure):
    raw = cache.read_bytes()
    receipt = cache.with_suffix(".json.receipt.json").read_bytes()
    kwargs = {"side_effect": requests.Timeout("do-not-store-this-secret")}
    if failure != "network":
        kwargs = {"return_value": response(body="<html>bad</html>" if failure == "invalid_json" else "{}")}
    with patch("requests.get", **kwargs) as get:
        fetch(cache)
        fetch(cache, NOW + timedelta(minutes=1))
    assert get.call_count == 1
    assert cache.read_bytes() == raw
    assert cache.with_suffix(".json.receipt.json").read_bytes() == receipt
    assert state(cache)["outcome"] != "ok"
    assert "do-not-store-this-secret" not in json.dumps(state(cache))


@pytest.mark.parametrize("bad", ["bad json", "{}", "[]", '{"schema_version":99}', "x" * 65537])
def test_corrupt_attempt_ledger_quarantines_and_defers_recovery(cache, bad):
    ledger = cache.with_suffix(".json.request.json")
    ledger.write_text(bad)
    with patch("requests.get") as get:
        result = fetch(cache)
    get.assert_not_called()
    assert len(result.launches) == 4
    assert ledger.with_suffix(".invalid.json").read_text() == bad
    assert state(cache)["outcome"] == "control_recovered"
    with patch("requests.get", return_value=response()) as get:
        fetch(cache, NOW + timedelta(minutes=119))
        get.assert_not_called()
        fetch(cache, NOW + timedelta(hours=2))
        assert get.call_count == 1


def test_attempt_reservation_must_be_durable_before_network(cache):
    with patch("generator.launch_data._atomic_write", side_effect=OSError("disk full"), create=True):
        with patch("requests.get") as get:
            fetch(cache)
    get.assert_not_called()


def test_only_safe_header_metadata_is_recorded(cache):
    headers = {"Retry-After": "3600", "CF-Cache-Status": "HIT", "Age": "60",
               "Set-Cookie": "secret", "X-Internal-IP": "private", "Server": "private"}
    with patch("requests.get", return_value=response(429, headers)):
        fetch(cache)
    text = json.dumps(state(cache))
    assert "HIT" in text
    assert "private" not in text and "secret" not in text


def test_missing_cache_during_cooldown_still_does_not_fetch(cache):
    with patch("requests.get", return_value=response(429, {"Retry-After": "7200"})):
        fetch(cache)
    cache.unlink()
    with patch("requests.get") as get:
        result = fetch(cache, NOW + timedelta(hours=1))
    get.assert_not_called()
    assert result.last_successful_fetch is None and result.launches == []


def test_bounded_history_retains_throttle_after_recovery(cache):
    when = NOW
    with patch("requests.get", return_value=response(429)):
        for _ in range(27):
            fetch(cache, when)
            when = datetime.fromisoformat(state(cache)["next_attempt_at"])
    with patch("requests.get", return_value=response()):
        fetch(cache, when)
    saved = state(cache)
    assert saved["status"] == 200 and saved["outcome"] == "ok"
    assert len(saved["recent_attempts"]) == 24
    assert all(old["status"] == 429 for old in saved["recent_attempts"])
    assert all("recent_attempts" not in old for old in saved["recent_attempts"])


def test_redirect_is_not_followed_or_cached(cache):
    original = cache.read_bytes()
    with patch("requests.get", return_value=response(302, {"Location": "https://example.invalid"})) as get:
        fetch(cache)
    assert get.call_args.kwargs["allow_redirects"] is False
    assert state(cache)["status"] == 302
    assert state(cache)["outcome"] == "request_failed"
    assert cache.read_bytes() == original


def test_cooldown_uses_wall_clock_not_old_tick_start(cache):
    clock = NOW + timedelta(minutes=10)
    with patch("generator.launch_data._utc_now", return_value=clock):
        with patch("requests.get", return_value=response(429, {"Retry-After": "7200"})):
            launch_data.fetch_upcoming_launches(cache, now=NOW)
    assert state(cache)["attempted_at"] == clock.isoformat()
    assert state(cache)["next_attempt_at"] == (clock + timedelta(hours=2)).isoformat()


def test_implausible_retry_after_does_not_disable_feed_for_centuries(cache):
    with patch("requests.get", return_value=response(429, {"Retry-After": "9999999999"})):
        fetch(cache)
    assert state(cache)["retry_after_rejected"] is True
    assert state(cache)["next_attempt_at"] == (NOW + timedelta(hours=2)).isoformat()


def test_retry_after_on_invalid_success_body_is_not_a_provider_cooldown(cache):
    with patch("requests.get", return_value=response(200, {"Retry-After": "172800"}, "{}")):
        fetch(cache)
    assert state(cache)["retry_after_seconds"] is None
    assert state(cache)["next_attempt_at"] == (NOW + timedelta(minutes=15)).isoformat()


def test_success_and_ttl_use_wall_clock_not_old_tick_start(cache):
    clock = NOW + timedelta(minutes=10)
    old = (clock - timedelta(minutes=65)).timestamp()
    os.utime(cache, (old, old))
    with patch("generator.launch_data._utc_now", return_value=clock):
        with patch("requests.get", return_value=response()) as get:
            result = launch_data.fetch_upcoming_launches(cache, now=NOW)
    assert get.call_count == 1
    assert result.last_successful_fetch == clock
    receipt = json.loads(cache.with_suffix(".json.receipt.json").read_text())
    assert receipt["fetched_at"] == clock.isoformat()


def test_ten_minute_consumer_ticks_do_not_raise_successful_fetch_cadence(cache):
    with patch("requests.get", return_value=response()) as get:
        fetch(cache)
        # Model filesystem mtime using the same simulated wall clock.
        os.utime(cache, (NOW.timestamp(), NOW.timestamp()))
        for minute in range(10, 60, 10):
            fetch(cache, NOW + timedelta(minutes=minute))
        assert get.call_count == 1
        fetch(cache, NOW + timedelta(hours=1))
        assert get.call_count == 2


@pytest.mark.parametrize("failed_file", ["launches.json.receipt.pending.json", "launches.json"])
def test_cache_write_failure_leaves_last_good_pair_intact(cache, failed_file):
    before = (cache.read_bytes(), cache.stat().st_mtime_ns,
              cache.with_suffix(".json.receipt.json").read_bytes())
    original = launch_data._atomic_write

    def fail_one(path, text):
        if path.name == failed_file:
            raise OSError("disk full")
        original(path, text)

    with patch("generator.launch_data._atomic_write", side_effect=fail_one):
        with patch("requests.get", return_value=response(body='{"results": [], "count": 0}')):
            fetch(cache)
    assert (cache.read_bytes(), cache.stat().st_mtime_ns,
            cache.with_suffix(".json.receipt.json").read_bytes()) == before


def test_interrupted_receipt_promotion_repairs_before_ttl_without_refetch(cache):
    original = os.replace

    def fail_receipt(source, target):
        if Path(target).name == "launches.json.receipt.json":
            raise OSError("interrupted receipt promotion")
        return original(source, target)

    with patch("generator.launch_data.os.replace", side_effect=fail_receipt):
        with patch("requests.get", return_value=response(body='{"results": [], "count": 0}')):
            fetch(cache)
    assert cache.with_suffix(".json.receipt.pending.json").exists()
    with patch("requests.get") as get:
        fetch(cache, NOW + timedelta(minutes=1))
    get.assert_not_called()
    receipt = json.loads(cache.with_suffix(".json.receipt.json").read_text())
    assert receipt["sha256"] == hashlib.sha256(cache.read_bytes()).hexdigest()
    assert receipt["fetched_at"] == NOW.isoformat()
    assert not cache.with_suffix(".json.receipt.pending.json").exists()
