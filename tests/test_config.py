"""Tests for generator.config validation + Settings.from_env."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from generator.config import Settings, load_targets

# --------------------------------------------------------------------------
# Settings.from_env — env var driven configuration
# --------------------------------------------------------------------------


def test_from_env_uses_cwd_when_no_root(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No OPD_ROOT and no explicit root → resolve from Path.cwd()."""
    monkeypatch.delenv("OPD_ROOT", raising=False)
    monkeypatch.chdir(tmp_path)
    s = Settings.from_env()
    assert s.repo_root == tmp_path.resolve()
    assert s.out_dir == tmp_path.resolve() / "out"


def test_from_env_honors_environment_variables(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("OPD_ROOT", str(tmp_path))
    monkeypatch.setenv("OPD_CACHE", str(tmp_path / "custom-cache"))
    monkeypatch.setenv("OPD_LOG", str(tmp_path / "custom-logs"))
    monkeypatch.setenv("OPD_TLE_URL", "https://example.test/tle")
    monkeypatch.setenv("OPD_RCLONE_REMOTE", "r2:custom-bucket")
    monkeypatch.setenv("OPD_TICK_MINUTES", "15")
    monkeypatch.setenv("OPD_PASS_WINDOW_HOURS", "12")
    s = Settings.from_env()
    assert s.cache_dir == tmp_path / "custom-cache"
    assert s.log_dir == tmp_path / "custom-logs"
    assert s.tle_url == "https://example.test/tle"
    assert s.rclone_remote == "r2:custom-bucket"
    assert s.tick_minutes == 15
    assert s.pass_window_hours == 12


# --------------------------------------------------------------------------
# load_targets — validation paths
# --------------------------------------------------------------------------


def _write_targets(tmp_path: Path, payload: object) -> Path:
    p = tmp_path / "targets.json"
    p.write_text(json.dumps(payload))
    return p


def test_load_targets_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_targets(tmp_path / "does-not-exist.json")


def test_load_targets_rejects_non_list(tmp_path: Path) -> None:
    p = _write_targets(tmp_path, {"not": "a list"})
    with pytest.raises(ValueError, match="must be a list"):
        load_targets(p)


def test_load_targets_rejects_missing_required_keys(tmp_path: Path) -> None:
    p = _write_targets(tmp_path, [{"id": "x", "name": "X"}])  # missing geom/priority/regime
    with pytest.raises(ValueError, match="missing keys"):
        load_targets(p)


def test_load_targets_rejects_non_point_geom(tmp_path: Path) -> None:
    p = _write_targets(tmp_path, [{
        "id": "x", "name": "X",
        "geom": {"type": "polygon", "coords": []},
        "priority": 3, "regime": "any",
    }])
    with pytest.raises(ValueError, match="only 'point' geom"):
        load_targets(p)


def test_load_targets_rejects_lat_out_of_range(tmp_path: Path) -> None:
    p = _write_targets(tmp_path, [{
        "id": "x", "name": "X",
        "geom": {"type": "point", "lat": 95.0, "lon": 0.0},
        "priority": 3, "regime": "any",
    }])
    with pytest.raises(ValueError, match="lat .* out of range"):
        load_targets(p)


def test_load_targets_rejects_lon_out_of_range(tmp_path: Path) -> None:
    p = _write_targets(tmp_path, [{
        "id": "x", "name": "X",
        "geom": {"type": "point", "lat": 0.0, "lon": 200.0},
        "priority": 3, "regime": "any",
    }])
    with pytest.raises(ValueError, match="lon .* out of range"):
        load_targets(p)


def test_load_targets_rejects_invalid_priority(tmp_path: Path) -> None:
    p = _write_targets(tmp_path, [{
        "id": "x", "name": "X",
        "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
        "priority": 9, "regime": "any",
    }])
    with pytest.raises(ValueError, match="priority must be"):
        load_targets(p)


def test_load_targets_rejects_invalid_regime(tmp_path: Path) -> None:
    p = _write_targets(tmp_path, [{
        "id": "x", "name": "X",
        "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
        "priority": 3, "regime": "twilight",
    }])
    with pytest.raises(ValueError, match="regime must be"):
        load_targets(p)


def test_load_targets_rejects_duplicate_ids(tmp_path: Path) -> None:
    p = _write_targets(tmp_path, [
        {
            "id": "dupe", "name": "A",
            "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
            "priority": 3, "regime": "any",
        },
        {
            "id": "dupe", "name": "B",
            "geom": {"type": "point", "lat": 1.0, "lon": 1.0},
            "priority": 3, "regime": "any",
        },
    ])
    with pytest.raises(ValueError, match="duplicate target id"):
        load_targets(p)


def test_load_targets_skips_placeholder_entries(tmp_path: Path) -> None:
    """_placeholder=true entries are ignored (no passes scored), not errors."""
    p = _write_targets(tmp_path, [
        {
            "id": "real", "name": "Real",
            "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
            "priority": 3, "regime": "any",
        },
        {
            "id": "stub", "name": "Stub",
            "geom": {"type": "point", "lat": 0.0, "lon": 0.0},
            "priority": 3, "regime": "any",
            "_placeholder": True,
        },
    ])
    targets = load_targets(p)
    assert len(targets) == 1
    assert targets[0]["id"] == "real"
