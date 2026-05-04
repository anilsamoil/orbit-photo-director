"""Runtime configuration for the generator. All times UTC."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_TICK_MINUTES = 60  # 1h — geostationary IR refreshes every 10-15 min upstream
DEFAULT_PASS_WINDOW_HOURS = 24  # 1 full day so the Upcoming view can plan tonight + tomorrow
DEFAULT_TLE_CACHE_TTL_HOURS = 1
DEFAULT_CLOUD_CACHE_TTL_MINUTES = 55
DEFAULT_TOP_QUEUE = 5
DEFAULT_TOP_MAP = 25
DEFAULT_TOP_UPCOMING = 10
# Passes within this horizon use observed cloud sources (MODIS / GOES-IR /
# Himawari). Beyond it, observation is irrelevant — the GFS forecast governs.
OBSERVED_CLOUD_HORIZON_MINUTES = 90

# Pass detection
PASS_SAMPLE_STEP_SECONDS = 30
PASS_MAX_DISTANCE_KM = 800.0
NADIR_HORIZON_KM = 500.0  # camera-friendly horizon at ISS altitude

# TLE freshness
TLE_WARN_AGE_HOURS = 24.0
TLE_FLOOR_FRESHNESS = 0.5

# Sun-glint
SUN_GLINT_THRESHOLD_DEG = 25.0


@dataclass(frozen=True)
class Settings:
    repo_root: Path
    out_dir: Path
    cache_dir: Path
    log_dir: Path
    targets_file: Path
    tle_url: str
    satcorps_creds_file: Path
    rclone_remote: str
    tick_minutes: int = DEFAULT_TICK_MINUTES
    pass_window_hours: int = DEFAULT_PASS_WINDOW_HOURS

    @classmethod
    def from_env(cls, repo_root: Path | None = None) -> Settings:
        root = repo_root or Path(os.environ.get("OPD_ROOT", Path.cwd())).resolve()
        return cls(
            repo_root=root,
            out_dir=root / "out",
            cache_dir=Path(os.environ.get("OPD_CACHE", root / "data" / "cache")),
            log_dir=Path(os.environ.get("OPD_LOG", root / "data" / "logs")),
            targets_file=root / "targets.json",
            tle_url=os.environ.get(
                "OPD_TLE_URL",
                "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE",
            ),
            satcorps_creds_file=Path(
                os.environ.get(
                    "OPD_CREDS",
                    Path.home() / ".config" / "orbit-photo-director" / "credentials.json",
                )
            ),
            rclone_remote=os.environ.get("OPD_RCLONE_REMOTE", "r2:map-astroanil-dev"),
            tick_minutes=int(os.environ.get("OPD_TICK_MINUTES", DEFAULT_TICK_MINUTES)),
            pass_window_hours=int(
                os.environ.get("OPD_PASS_WINDOW_HOURS", DEFAULT_PASS_WINDOW_HOURS)
            ),
        )

    def ensure_dirs(self) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)


def load_targets(targets_file: Path) -> list[dict]:
    """Load and validate targets.json. Raises ValueError on schema violation.

    Targets with `"_placeholder": true` are skipped (they're stub entries
    waiting for the user to fill in real lat/lon — typically hometown / family
    cities). Skipped placeholders do NOT contribute passes to the queue.
    """
    if not targets_file.exists():
        raise FileNotFoundError(f"targets file not found: {targets_file}")
    raw = json.loads(targets_file.read_text())
    if not isinstance(raw, list):
        raise ValueError("targets.json must be a list")
    valid: list[dict] = []
    seen_ids: set[str] = set()
    for i, t in enumerate(raw):
        _validate_target(t, i)
        if t["id"] in seen_ids:
            raise ValueError(f"duplicate target id: {t['id']}")
        seen_ids.add(t["id"])
        if t.get("_placeholder") is True:
            continue
        valid.append(t)
    return valid


def _validate_target(t: dict, i: int) -> None:
    required = {"id", "name", "geom", "priority", "regime"}
    missing = required - set(t.keys())
    if missing:
        raise ValueError(f"target #{i}: missing keys {missing}")
    geom = t["geom"]
    if geom.get("type") != "point":
        raise ValueError(f"target {t['id']}: only 'point' geom is supported in V1")
    lat, lon = geom.get("lat"), geom.get("lon")
    if not (-90 <= lat <= 90):
        raise ValueError(f"target {t['id']}: lat {lat} out of range")
    if not (-180 <= lon <= 180):
        raise ValueError(f"target {t['id']}: lon {lon} out of range")
    if t["priority"] not in (1, 2, 3, 4, 5):
        raise ValueError(f"target {t['id']}: priority must be 1-5")
    if t["regime"] not in ("day", "night", "terminator", "any"):
        raise ValueError(f"target {t['id']}: regime must be day/night/terminator/any")
