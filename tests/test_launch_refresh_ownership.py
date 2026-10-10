"""Real CRS-35 lease renewals cannot overwrite a competing catalog owner."""

import copy
import fcntl
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from generator.launch_catalog import build_launch_catalog
from generator.launch_evidence import build_launch_artifact, canonical_bytes, utc
from generator.launch_publish import publish_launch_artifact, publish_launch_catalog
from generator.orbit import TLE
from scripts import launch_refresh

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 10, 8, tzinfo=UTC)
RENEWAL = NOW + timedelta(minutes=10)
RIVAL_TIME = RENEWAL + timedelta(seconds=1)


class LaunchHarness:
    def __init__(self, root):
        self.cache = root / "cache"
        self.output = root / "publication"
        self.cache.mkdir()
        self.payload = json.loads((FIXTURES / "ll2-crs35-2026-10-10.json").read_text())
        tle_text = (FIXTURES / "iss-2026-10-09.tle").read_text()
        self.tle = TLE.from_text(tle_text)
        self.remote = {}
        self.calls = []
        (self.cache / "iss.tle").write_text(tle_text)
        self.write_cache(NOW)
        old = build_launch_artifact(
            self.payload, None, NOW - timedelta(days=2), fetched_at=NOW - timedelta(days=2),
        )
        self.seed_pointer = publish_launch_artifact(old, self.output, upload=self.upload)
        self.calls.clear()

    def write_cache(self, at):
        raw = canonical_bytes(self.payload)
        (self.cache / "launches.json").write_bytes(raw)
        (self.cache / "launches.json.receipt.json").write_bytes(canonical_bytes({
            "sha256": hashlib.sha256(raw).hexdigest(), "fetched_at": utc(at),
        }))

    def upload(self, path, key, immutable):
        self.calls.append(key)
        self.remote[key] = path.read_bytes()

    def read_remote(self):
        return json.loads(self.remote["launch/latest.json"])

    def read_catalog(self):
        raw = self.remote.get("launch/catalog/latest.json")
        return json.loads(raw) if raw is not None else None

    def run(self, at, read_remote=None, **kwargs):
        return launch_refresh.refresh_cached(
            self.cache, self.output, at, remote="test:bucket", upload=self.upload,
            read_remote=read_remote or self.read_remote, **kwargs,
        )

    def catalog(self):
        return json.loads(self.remote[self.read_catalog()["path"]])

    def competitor(self, publish_v2=True, readback=True):
        payload = copy.deepcopy(self.payload)
        payload["results"][0]["status"] = {"abbrev": "TBC"}
        artifact = build_launch_artifact(payload, self.tle, RIVAL_TIME, fetched_at=RIVAL_TIME)
        catalog = build_launch_catalog(payload, self.tle, RIVAL_TIME, fetched_at=RIVAL_TIME)

        def publish():
            if publish_v2:
                publish_launch_artifact(
                    artifact, self.output, upload=self.upload,
                    read_remote=self.read_remote if readback else None,
                )
            publish_launch_catalog(catalog, self.output, upload=self.upload)
            assert self.catalog()["items"][0]["tier"] == "watch"
            return self.remote["launch/latest.json"], self.remote["launch/catalog/latest.json"]

        return publish


@pytest.fixture
def harness(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("source fetch or network forbidden")

    monkeypatch.setattr("requests.get", forbidden)
    monkeypatch.setattr("socket.create_connection", forbidden)
    result = LaunchHarness(tmp_path)
    assert result.run(NOW)["reason"] == "PUBLISHED"
    assert result.catalog()["items"][0]["tier"] == "likely"
    return result


def test_crs35_normal_renewal_leases_through_0825(harness):
    first = harness.catalog()
    original_v2 = harness.remote["launch/latest.json"]
    state = (harness.output / ".refresh-state.json").read_bytes()
    receipt = (harness.cache / "launches.json.receipt.json").read_bytes()
    sent = len(harness.calls)

    result = harness.run(RENEWAL)

    catalog = harness.catalog()
    assert result["reason"] == "UNCHANGED_INPUT"
    assert not result["published"] and not result["notified"]
    assert "catalog_skipped" not in result
    assert catalog["generated_at"] == "2026-10-10T08:10:00Z"
    assert catalog["geometry_valid_until"] == "2026-10-10T08:25:00Z"
    assert catalog["items"][0]["schedule"]["status"] == "Go"
    assert catalog["items"][0]["tier"] == "likely"
    assert catalog["coverage"]["schedule_fetched_at"] == utc(NOW)
    assert catalog["tle"] == first["tle"]
    assert harness.remote["launch/latest.json"] == original_v2
    assert (harness.output / ".refresh-state.json").read_bytes() == state
    assert (harness.cache / "launches.json.receipt.json").read_bytes() == receipt
    assert len(harness.calls[sent:]) == 2
    assert all(key.startswith("launch/catalog/") for key in harness.calls[sent:])


@pytest.mark.parametrize("publish_v2", [True, False], ids=["new-v2-owner", "catalog-only"])
def test_renewal_rejects_competitor_after_ownership_readback(harness, publish_v2):
    publish_competitor = harness.competitor(publish_v2)
    catalog_state = (harness.output / ".refresh-catalog-state.json").read_bytes()
    interleaved = []

    def read_then_publish():
        observed = harness.read_remote()
        if not interleaved:
            rival_v2, rival_catalog = publish_competitor()
            interleaved.append((rival_v2, rival_catalog, len(harness.calls)))
        return observed

    result = harness.run(RENEWAL, read_remote=read_then_publish)

    rival_v2, rival_catalog, sent = interleaved[0]
    catalog = harness.catalog()
    assert catalog["items"][0]["schedule"]["status"] == "TBC"
    assert catalog["items"][0]["tier"] == "watch"
    assert catalog["generated_at"] == "2026-10-10T08:10:01Z"
    assert harness.remote["launch/latest.json"] == rival_v2
    assert harness.remote["launch/catalog/latest.json"] == rival_catalog
    assert (harness.output / "launch/catalog/latest.json").read_bytes() == rival_catalog
    assert (harness.output / ".refresh-catalog-state.json").read_bytes() == catalog_state
    assert harness.calls[sent:] == []
    assert result["reason"] == "UNCHANGED_INPUT"
    assert "CONFLICT" in result["catalog_skipped"] or "OBSOLETE" in result["catalog_skipped"]


def test_published_path_rejects_competitor_before_catalog_commit(harness, monkeypatch):
    publish_competitor = harness.competitor()
    catalog_state = (harness.output / ".refresh-catalog-state.json").read_bytes()
    publish = launch_refresh.publish_launch_artifact
    interleaved = []
    harness.write_cache(RENEWAL)

    def publish_then_compete(*args, **kwargs):
        pointer = publish(*args, **kwargs)
        rival_v2, rival_catalog = publish_competitor()
        interleaved.append((rival_v2, rival_catalog, len(harness.calls)))
        return pointer

    monkeypatch.setattr(launch_refresh, "publish_launch_artifact", publish_then_compete)
    result = harness.run(RENEWAL)

    rival_v2, rival_catalog, sent = interleaved[0]
    assert harness.catalog()["items"][0]["schedule"]["status"] == "TBC"
    assert harness.catalog()["items"][0]["tier"] == "watch"
    assert harness.catalog()["generated_at"] == "2026-10-10T08:10:01Z"
    assert harness.remote["launch/latest.json"] == rival_v2
    assert harness.remote["launch/catalog/latest.json"] == rival_catalog
    assert (harness.output / "launch/catalog/latest.json").read_bytes() == rival_catalog
    assert (harness.output / ".refresh-catalog-state.json").read_bytes() == catalog_state
    assert harness.calls[sent:] == []
    assert result["reason"] == "PUBLISHED"
    assert "CONFLICT" in result["catalog_skipped"] or "OBSOLETE" in result["catalog_skipped"]


def test_renewal_rejects_remote_catalog_missing_from_local_mirror(harness):
    state_path = harness.output / ".refresh-catalog-state.json"
    catalog_state = state_path.read_bytes()
    local_pointer = (harness.output / "launch/catalog/latest.json").read_bytes()
    original_v2 = harness.remote["launch/latest.json"]
    payload = copy.deepcopy(harness.payload)
    payload["results"][0]["status"] = {"abbrev": "TBC"}
    catalog = build_launch_catalog(payload, harness.tle, RIVAL_TIME, fetched_at=RIVAL_TIME)
    with launch_refresh._publisher_guard(harness.output):
        publish_launch_catalog(
            catalog, harness.output.parent / "other-publication", upload=harness.upload,
        )
    remote_pointer = harness.remote["launch/catalog/latest.json"]
    sent = len(harness.calls)

    result = harness.run(RENEWAL, read_catalog=harness.read_catalog)

    assert harness.catalog()["items"][0]["schedule"]["status"] == "TBC"
    assert harness.catalog()["items"][0]["tier"] == "watch"
    assert harness.remote["launch/catalog/latest.json"] == remote_pointer
    assert harness.remote["launch/latest.json"] == original_v2
    assert (harness.output / "launch/catalog/latest.json").read_bytes() == local_pointer
    assert state_path.read_bytes() == catalog_state
    assert harness.calls[sent:] == []
    assert "CONFLICT" in result["catalog_skipped"] or "OBSOLETE" in result["catalog_skipped"]


def test_catalog_upload_and_state_commit_hold_publisher_lock(harness, monkeypatch):
    upload = harness.upload
    atomic_json = launch_refresh._atomic_json
    checked = []

    def assert_locked(stage):
        with (harness.output / ".launch-publisher.lock").open("a") as lock:
            with pytest.raises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        checked.append(stage)

    def checked_upload(path, key, immutable):
        assert_locked(key)
        upload(path, key, immutable)

    def checked_state(path, value):
        if path.name == ".refresh-catalog-state.json":
            assert_locked(path.name)
        atomic_json(path, value)

    monkeypatch.setattr(harness, "upload", checked_upload)
    monkeypatch.setattr(launch_refresh, "_atomic_json", checked_state)

    result = harness.run(RENEWAL, read_catalog=harness.read_catalog)

    assert "catalog_skipped" not in result
    assert len(checked) == 3
    assert checked[-2:] == ["launch/catalog/latest.json", ".refresh-catalog-state.json"]


@pytest.mark.parametrize(
    ("seconds", "reason"),
    [(-1, "OBSOLETE_LAUNCH_CATALOG"), (0, "CONFLICTING_LAUNCH_CATALOG_REVISION")],
)
def test_catalog_publisher_rejects_stale_or_conflicting_generation_without_writes(
    harness, seconds, reason,
):
    at = NOW + timedelta(seconds=seconds)
    payload = copy.deepcopy(harness.payload)
    payload["results"][0]["status"] = {"abbrev": "TBC"}
    catalog = build_launch_catalog(payload, harness.tle, at, fetched_at=at)
    before = {path.relative_to(harness.output): path.read_bytes()
              for path in harness.output.rglob("*") if path.is_file()}
    remote = dict(harness.remote)
    sent = len(harness.calls)

    with pytest.raises(ValueError, match=reason):
        publish_launch_catalog(catalog, harness.output, upload=harness.upload)

    assert {path.relative_to(harness.output): path.read_bytes()
            for path in harness.output.rglob("*") if path.is_file()} == before
    assert harness.remote == remote
    assert harness.calls[sent:] == []


@pytest.mark.parametrize("minutes", [1, 10], ids=["live-lease", "renewal"])
def test_successful_refresh_adopts_lagging_local_v2_under_publisher_lock(
    harness, monkeypatch, minutes,
):
    pointer_path = harness.output / "launch/latest.json"
    pointer_path.write_bytes(canonical_bytes(harness.seed_pointer))
    atomic_json = launch_refresh._atomic_json
    checked = []

    def checked_state(path, value):
        if path == pointer_path:
            with (harness.output / ".launch-publisher.lock").open("a") as lock:
                with pytest.raises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            checked.append(path)
        atomic_json(path, value)

    monkeypatch.setattr(launch_refresh, "_atomic_json", checked_state)
    result = harness.run(NOW + timedelta(minutes=minutes))

    assert result["reason"] == "UNCHANGED_INPUT"
    assert "catalog_skipped" not in result
    assert pointer_path.read_bytes() == harness.remote["launch/latest.json"]
    assert checked == [pointer_path]


def test_renewal_conflict_does_not_adopt_readback_over_newer_local_v2(harness):
    pointer_path = harness.output / "launch/latest.json"
    pointer_path.write_bytes(canonical_bytes(harness.seed_pointer))
    publish_competitor = harness.competitor(readback=False)
    state_path = harness.output / ".refresh-catalog-state.json"
    state = state_path.read_bytes()
    interleaved = []

    def read_then_publish():
        observed = harness.read_remote()
        if not interleaved:
            rival_v2, rival_catalog = publish_competitor()
            interleaved.append((rival_v2, rival_catalog, len(harness.calls)))
        return observed

    result = harness.run(RENEWAL, read_remote=read_then_publish)

    rival_v2, rival_catalog, sent = interleaved[0]
    assert pointer_path.read_bytes() == harness.remote["launch/latest.json"] == rival_v2
    assert harness.remote["launch/catalog/latest.json"] == rival_catalog
    assert harness.catalog()["items"][0]["tier"] == "watch"
    assert state_path.read_bytes() == state
    assert harness.calls[sent:] == []
    assert "CONFLICT" in result["catalog_skipped"]
