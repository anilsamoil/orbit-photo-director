"""Tests for the per-astronaut profile multiplexer (Slot 4, design rev 2).

Coverage:
  - Multiplexer with 0 profiles → no per-profile artifacts, canonical
    pipeline unchanged.
  - 1 profile with 0 personal targets → passes_<name>.json matches the
    canonical passes.json content (same targets in, same targets out).
  - 2 profiles with different personal targets → 2 distinct per-profile
    pass sets; manifest declares both.
  - Worker API unreachable → curated-only per profile, no exception.
  - Worker returns a malformed target → that target dropped, rest succeed.
  - Score parity: a target that exists in both curated and a profile's
    personal list scores identically in the per-profile artifact and the
    canonical artifact (defensive regression — scoring math is identical).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import requests

from generator.config import Settings
from generator.main import run_tick
from generator.multiplex import (
    build_profile_target_list,
    fetch_profile_targets,
    multiplex_enabled,
    validate_personal_target,
)
from tests.conftest import SAMPLE_TLE_TEXT


@pytest.fixture
def cached_tle(settings_in_tmp: Settings) -> Path:
    """Pre-seed the TLE cache so run_tick doesn't need network."""
    settings_in_tmp.cache_dir.mkdir(parents=True, exist_ok=True)
    cache = settings_in_tmp.cache_dir / "iss.tle"
    cache.write_text(SAMPLE_TLE_TEXT)
    return cache


def _personal_target(profile: str, token: str, name: str, lat: float, lon: float,
                     priority: int = 5) -> dict[str, Any]:
    """Build a PersonalTarget dict in the Worker's wire format."""
    return {
        "id": f"personal:{profile}:{token}",
        "name": name,
        "lat": lat,
        "lon": lon,
        "priority": priority,
        "createdAt": "2026-05-26T15:00:00Z",
    }


class _MockResponse:
    """Minimal stand-in for requests.Response used by fetch_profile_targets."""

    def __init__(self, body: Any, status: int = 200):
        self._body = body
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"status {self.status_code}")

    def json(self) -> Any:
        return self._body


# ----------------------------------------------------------------------
# validate_personal_target — unit (no network, no fixtures)
# ----------------------------------------------------------------------

def test_validate_personal_target_accepts_well_formed() -> None:
    t = _personal_target("jack", "abc123", "Boston, MA", 42.36, -71.06, priority=5)
    out = validate_personal_target(t, "jack")
    assert out is not None
    assert out["id"] == "personal:jack:abc123"
    assert out["geom"] == {"type": "point", "lat": 42.36, "lon": -71.06}
    assert out["regime"] == "any"
    assert out["priority"] == 5


def test_validate_personal_target_clamps_priority_above_five() -> None:
    """Worker accepts priority 1-10, but scoring caps at 5. Confirm clamp."""
    t = _personal_target("jack", "abc123", "Boston", 42.0, -71.0, priority=9)
    out = validate_personal_target(t, "jack")
    assert out is not None
    assert out["priority"] == 5


@pytest.mark.parametrize(
    "mutate,expected_skip",
    [
        ({"id": "not-a-personal-id"}, True),
        ({"id": "personal:chris:xyz"}, True),  # wrong profile in id
        ({"name": ""}, True),
        ({"name": "x" * 201}, True),
        ({"lat": 91.0}, True),
        ({"lat": -91.0}, True),
        ({"lon": 181.0}, True),
        ({"lon": -181.0}, True),
        ({"priority": 0}, True),
        ({"priority": 11}, True),
        ({"priority": "5"}, True),  # not an int
    ],
)
def test_validate_personal_target_skips_malformed(
    mutate: dict[str, Any], expected_skip: bool,
) -> None:
    t = _personal_target("jack", "abc123", "Boston", 42.0, -71.0)
    t.update(mutate)
    out = validate_personal_target(t, "jack")
    if expected_skip:
        assert out is None


def test_validate_personal_target_rejects_non_dict() -> None:
    assert validate_personal_target("not a dict", "jack") is None
    assert validate_personal_target(None, "jack") is None
    assert validate_personal_target([1, 2, 3], "jack") is None


# ----------------------------------------------------------------------
# build_profile_target_list — pure-function unit
# ----------------------------------------------------------------------

def test_build_profile_target_list_unions_curated_and_personal() -> None:
    curated = [
        {"id": "tokyo-night", "name": "Tokyo", "geom": {"type": "point", "lat": 35.7, "lon": 139.7}, "priority": 5, "regime": "night"},
    ]
    personal = [
        {"id": "personal:jack:1", "name": "Boston", "geom": {"type": "point", "lat": 42.4, "lon": -71.1}, "priority": 5, "regime": "any"},
    ]
    result = build_profile_target_list(curated, personal, removed_curated_ids=[])
    assert len(result) == 2
    assert result[0]["id"] == "tokyo-night"
    assert result[1]["id"] == "personal:jack:1"


def test_build_profile_target_list_excludes_removed_curated() -> None:
    curated = [
        {"id": "tokyo-night", "name": "Tokyo", "geom": {"type": "point", "lat": 35.7, "lon": 139.7}, "priority": 5, "regime": "night"},
        {"id": "lake-baikal", "name": "Baikal", "geom": {"type": "point", "lat": 53.5, "lon": 108.0}, "priority": 3, "regime": "day"},
    ]
    result = build_profile_target_list(curated, personal=[], removed_curated_ids=["lake-baikal"])
    assert len(result) == 1
    assert result[0]["id"] == "tokyo-night"


def test_build_profile_target_list_personal_wins_on_id_collision() -> None:
    """If somehow a personal target has the same id as a curated one,
    the personal entry replaces it (operator's explicit choice)."""
    curated = [
        {"id": "shared-id", "name": "Curated", "geom": {"type": "point", "lat": 0, "lon": 0}, "priority": 5, "regime": "any"},
    ]
    personal = [
        {"id": "shared-id", "name": "Personal", "geom": {"type": "point", "lat": 1, "lon": 1}, "priority": 5, "regime": "any"},
    ]
    result = build_profile_target_list(curated, personal, removed_curated_ids=[])
    assert len(result) == 1
    assert result[0]["name"] == "Personal"


# ----------------------------------------------------------------------
# fetch_profile_targets — network mocking via unittest.mock
# ----------------------------------------------------------------------

def test_fetch_profile_targets_no_token_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPD_CALIB_TOKEN", raising=False)
    out = fetch_profile_targets("jack")
    assert out["targets"] == []
    assert out["source"] == "curated-only"


def test_fetch_profile_targets_network_failure_returns_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    with patch("generator.multiplex.requests.get", side_effect=requests.ConnectionError("boom")):
        out = fetch_profile_targets("jack")
    assert out["targets"] == []
    assert out["source"] == "curated-only"


def test_fetch_profile_targets_http_error_returns_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    with patch("generator.multiplex.requests.get", return_value=_MockResponse({}, status=500)):
        out = fetch_profile_targets("jack")
    assert out["targets"] == []
    assert out["source"] == "curated-only"


def test_fetch_profile_targets_drops_malformed_keeps_good(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    body = {
        "targets": [
            _personal_target("jack", "good1", "Boston", 42.0, -71.0),
            # Malformed: lat out of range — gets skipped
            _personal_target("jack", "bad1", "Bad", 91.0, -71.0),
            _personal_target("jack", "good2", "Houston", 29.8, -95.4),
        ],
    }
    with patch("generator.multiplex.requests.get", return_value=_MockResponse(body)):
        out = fetch_profile_targets("jack")
    assert out["source"] == "api"
    ids = [t["id"] for t in out["targets"]]
    assert "personal:jack:good1" in ids
    assert "personal:jack:good2" in ids
    assert "personal:jack:bad1" not in ids
    assert len(out["targets"]) == 2


def test_fetch_profile_targets_reads_removed_curated_ids_when_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Slot 6 will start POSTing removedCuratedIds; daemon's read path
    should already handle it (defensive default [] when absent)."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    body = {
        "targets": [],
        "removedCuratedIds": ["tokyo-night", "lake-baikal"],
    }
    with patch("generator.multiplex.requests.get", return_value=_MockResponse(body)):
        out = fetch_profile_targets("jack")
    assert out["removed_curated_ids"] == ["tokyo-night", "lake-baikal"]


def test_fetch_profile_targets_handles_non_object_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    with patch("generator.multiplex.requests.get", return_value=_MockResponse([1, 2, 3])):
        out = fetch_profile_targets("jack")
    assert out["source"] == "curated-only"


def test_fetch_profile_targets_handles_missing_targets_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    with patch("generator.multiplex.requests.get", return_value=_MockResponse({"foo": "bar"})):
        out = fetch_profile_targets("jack")
    assert out["source"] == "curated-only"


# ----------------------------------------------------------------------
# multiplex_enabled — env gate
# ----------------------------------------------------------------------

def test_multiplex_enabled_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPD_CALIB_TOKEN", raising=False)
    assert multiplex_enabled() is False


def test_multiplex_enabled_requires_profile_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    with patch("generator.multiplex.profile_names", return_value=()):
        assert multiplex_enabled() is False


def test_multiplex_enabled_token_and_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    with patch("generator.multiplex.profile_names", return_value=("anil",)):
        assert multiplex_enabled() is True


# ----------------------------------------------------------------------
# Integration — run_tick with multiplex
# ----------------------------------------------------------------------

def test_run_tick_no_profiles_writes_only_canonical(
    settings_in_tmp: Settings, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Empty PROFILE_NAMES → no per-profile artifacts, canonical pipeline
    unchanged (back-compat guarantee for the rollback path)."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)
    with patch("generator.main.profile_names", return_value=()):
        manifest = run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    # Canonical artifacts present
    assert (v_dir / "passes.json").exists()
    assert (v_dir / "status.json").exists()
    # No per-profile artifacts
    assert not (v_dir / "passes_anil.json").exists()
    assert not (v_dir / "passes_jack.json").exists()
    # Manifest has no profiles block
    assert "profiles" not in manifest["artifacts"]


def test_run_tick_one_profile_no_personal_matches_canonical(
    settings_in_tmp: Settings, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Profile with 0 personal targets → passes_<name>.json has same
    content as canonical passes.json (just renamed)."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)

    # Worker returns empty target list for jack
    with (
        patch("generator.main.profile_names", return_value=("jack",)),
        patch(
            "generator.main.fetch_profile_targets",
            return_value={"targets": [], "removed_curated_ids": [], "source": "api"},
        ),
    ):
        manifest = run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    canonical = json.loads((v_dir / "passes.json").read_text())
    profile = json.loads((v_dir / "passes_jack.json").read_text())
    assert canonical == profile

    # GSHHG water gate (regression guard, Codex 2026-06-14): the profile
    # multiplex must actually RECEIVE the water mask — an early version
    # referenced water_mask_obj outside its scope, NameError'd inside
    # _run_profile_multiplex, and the caller silently dropped every profile's
    # passes. With the committed mask present (the normal case) each profile
    # pass must carry a `water` boolean; absence here means the mask never
    # reached the profile scorer.
    from generator.water_mask import load_water_mask

    if load_water_mask() is not None and profile:
        assert all("water" in p for p in profile), (
            "profile passes must carry the water flag when the mask is loaded"
        )

    # Manifest declares the profile artifacts under artifacts.profiles
    assert "profiles" in manifest["artifacts"]
    assert "jack" in manifest["artifacts"]["profiles"]
    jack_artifacts = manifest["artifacts"]["profiles"]["jack"]
    assert jack_artifacts["passes"]["path"].endswith("passes_jack.json")
    assert jack_artifacts["status"]["path"].endswith("status_jack.json")
    assert jack_artifacts["top5"]["path"].endswith("top5_jack.json")
    assert jack_artifacts["top_24h"]["path"].endswith("top_24h_jack.json")


def test_run_tick_two_profiles_distinct_personal_targets(
    settings_in_tmp: Settings, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two profiles with different personal targets → two distinct
    per-profile pass sets, both declared in the manifest."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)

    # Use the equator (0,0) — the curated fixture already has that
    # target, so we know it'll have passes within the test window.
    # Personal targets at distant latitudes so we don't accidentally
    # collide with curated ones.
    jack_personal = validate_personal_target(
        _personal_target("jack", "boston", "Boston, MA", 42.36, -71.06), "jack",
    )
    chris_personal = validate_personal_target(
        _personal_target("chris", "santiago", "Santiago, CL", -33.45, -70.66), "chris",
    )
    assert jack_personal is not None and chris_personal is not None

    def fake_fetch(name: str) -> dict[str, Any]:
        if name == "jack":
            return {"targets": [jack_personal], "removed_curated_ids": [], "source": "api"}
        if name == "chris":
            return {"targets": [chris_personal], "removed_curated_ids": [], "source": "api"}
        return {"targets": [], "removed_curated_ids": [], "source": "api"}

    with (
        patch("generator.main.profile_names", return_value=("jack", "chris")),
        patch("generator.main.fetch_profile_targets", side_effect=fake_fetch),
    ):
        manifest = run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    assert (v_dir / "passes_jack.json").exists()
    assert (v_dir / "passes_chris.json").exists()

    # Both profiles in manifest
    assert set(manifest["artifacts"]["profiles"].keys()) == {"jack", "chris"}

    # The per-profile status.json declares the profile name
    jack_status = json.loads((v_dir / "status_jack.json").read_text())
    chris_status = json.loads((v_dir / "status_chris.json").read_text())
    assert jack_status["profile"] == "jack"
    assert chris_status["profile"] == "chris"

    # Per-profile target_count reflects the union (3 curated + 1 personal each)
    assert jack_status["target_count"] == 4
    assert chris_status["target_count"] == 4


def test_run_tick_worker_unreachable_falls_through_to_curated(
    settings_in_tmp: Settings, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Worker API down → falls through to curated-only per profile, no
    exception escapes, per-profile artifacts still get written."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)

    # Simulate the Worker being down by having fetch_profile_targets
    # return its degraded ("curated-only") sentinel — that's the contract
    # the multiplexer's caller relies on (fetch never raises).
    with (
        patch("generator.main.profile_names", return_value=("jack",)),
        patch(
            "generator.main.fetch_profile_targets",
            return_value={"targets": [], "removed_curated_ids": [], "source": "curated-only"},
        ),
    ):
        manifest = run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    # passes_jack.json still gets written — just curated-only (no Boston)
    assert (v_dir / "passes_jack.json").exists()
    jack = json.loads((v_dir / "passes_jack.json").read_text())
    canonical = json.loads((v_dir / "passes.json").read_text())
    # With no personal targets added, the two should be identical
    assert jack == canonical
    # Manifest still declares the profile (degraded mode is still
    # operationally visible to the frontend)
    assert "jack" in manifest["artifacts"]["profiles"]


def test_forecast_sampler_default_path_is_offline_in_tests() -> None:
    """Regression: the autouse conftest fixture must neuter the GFS forecast
    sampler's live-network default.

    Before the fix, `GFSForecastSampler(coords)` with no injected fetcher did a
    live requests.get to api.open-meteo.com. A transient timeout made run_tick
    non-deterministic — the canonical pass-set got a "gfs-forecast-no-data"
    cloud attribution while the per-profile pass-set re-fetched the same coords,
    succeeded, and got "gfs-forecast-out-of-horizon", breaking the
    `jack == canonical` byte-equality assertion above. This pins the invariant
    that the default (no-fetcher) path never reaches the network in tests, so
    every sample is the deterministic no-data placeholder.
    """
    from generator.cloud import GFSForecastSampler

    sampler = GFSForecastSampler([(35.68, 139.69)])  # no fetcher → offline stub
    sample = sampler.sample(
        35.68, 139.69, datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC),
    )
    # A live fetch would have yielded "gfs-forecast" or "...out-of-horizon";
    # offline it is deterministically the no-data placeholder.
    assert sample.source == "gfs-forecast-no-data"


def test_run_tick_worker_returns_malformed_target_skips_only_that_one(
    settings_in_tmp: Settings, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One bad row → skipped with a log warning; the rest of the
    profile's targets still get scored and shipped."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)

    # Validator drops `bad1`; the multiplexer only sees the two good
    # entries. Simulate by passing validated targets directly.
    good1 = validate_personal_target(
        _personal_target("jack", "good1", "Boston", 42.36, -71.06), "jack",
    )
    good2 = validate_personal_target(
        _personal_target("jack", "good2", "Houston", 29.76, -95.37), "jack",
    )
    assert good1 is not None and good2 is not None
    # Confirm the bad entry would have been dropped:
    bad = validate_personal_target(
        _personal_target("jack", "bad1", "Bad", 999.0, -71.0), "jack",
    )
    assert bad is None

    with (
        patch("generator.main.profile_names", return_value=("jack",)),
        patch(
            "generator.main.fetch_profile_targets",
            return_value={"targets": [good1, good2], "removed_curated_ids": [], "source": "api"},
        ),
    ):
        manifest = run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    jack_status = json.loads((v_dir / "status_jack.json").read_text())
    # 3 curated + 2 valid personal = 5 (bad1 dropped before scoring)
    assert jack_status["target_count"] == 5
    assert "jack" in manifest["artifacts"]["profiles"]


def test_run_tick_score_parity_for_curated_target(
    settings_in_tmp: Settings, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Score parity sanity: a curated target's pass should score
    identically in canonical passes.json and in passes_<name>.json.
    Per-profile scoring runs the same math against the same inputs;
    this regression test catches anything that breaks that invariant."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)

    # Jack has no personal targets — so passes_jack.json should only
    # contain curated-target passes, and each curated pass's score
    # should equal its score in passes.json.
    with (
        patch("generator.main.profile_names", return_value=("jack",)),
        patch(
            "generator.main.fetch_profile_targets",
            return_value={"targets": [], "removed_curated_ids": [], "source": "api"},
        ),
    ):
        run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    canonical = json.loads((v_dir / "passes.json").read_text())
    jack = json.loads((v_dir / "passes_jack.json").read_text())
    canonical_by_key = {
        (p["target_id"], p["closest_approach"]): p["score"] for p in canonical
    }
    for p in jack:
        key = (p["target_id"], p["closest_approach"])
        if key in canonical_by_key:
            # Allow zero diff — same inputs, same scoring math
            assert p["score"] == canonical_by_key[key], (
                f"score drift for {key}: canonical={canonical_by_key[key]} "
                f"profile={p['score']}"
            )


def test_run_tick_profile_removed_curated_ids_excluded(
    settings_in_tmp: Settings, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per design doc: `removedCuratedIds` correctly excluded. Frontend
    doesn't POST this yet (slot 6's job) but the daemon read path is
    wired so it works when slot 6 ships. Defensive test."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)

    # Hide "tokyo-night" from the curated fixture for jack's view.
    with (
        patch("generator.main.profile_names", return_value=("jack",)),
        patch(
            "generator.main.fetch_profile_targets",
            return_value={
                "targets": [],
                "removed_curated_ids": ["tokyo-night"],
                "source": "api",
            },
        ),
    ):
        run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    jack_status = json.loads((v_dir / "status_jack.json").read_text())
    # 3 curated − 1 removed = 2 targets
    assert jack_status["target_count"] == 2

    # No tokyo-night passes appear in jack's passes file
    jack_passes = json.loads((v_dir / "passes_jack.json").read_text())
    assert all(p["target_id"] != "tokyo-night" for p in jack_passes)


def test_run_tick_profile_with_personal_target_includes_it_in_passes(
    settings_in_tmp: Settings, cached_tle: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: a profile with a personal target should see that
    target's id appear in their per-profile passes (when the target
    happens to have a pass in the test window). At minimum, the target
    must be in the profile's status.target_count."""
    monkeypatch.setenv("OPD_CALIB_TOKEN", "test-token")
    now = datetime(2024, 10, 17, 12, 0, 0, tzinfo=UTC)

    # Add a target right at the equator + 0 longitude (matches the
    # versatile fixture target's pattern — ISS crosses this line every
    # orbit so there should be at least one pass).
    equator = validate_personal_target(
        _personal_target("jack", "equator1", "Equator Point", 0.5, 0.5), "jack",
    )
    assert equator is not None

    with (
        patch("generator.main.profile_names", return_value=("jack",)),
        patch(
            "generator.main.fetch_profile_targets",
            return_value={"targets": [equator], "removed_curated_ids": [], "source": "api"},
        ),
    ):
        run_tick(settings_in_tmp, now=now)

    v_dir = settings_in_tmp.out_dir / "v" / "20241017T120000Z"
    jack_status = json.loads((v_dir / "status_jack.json").read_text())
    # 3 curated + 1 personal = 4 targets
    assert jack_status["target_count"] == 4
