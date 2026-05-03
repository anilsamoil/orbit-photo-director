"""Cloud cover adapter: NOAA SatCORPS NetCDF + obstruction class derivation.

V1 source: SatCORPS hourly global composite. Mock sampler used for tests.
Three-class obstruction model: clear / cloudy / sun-glint risk.
Thin cirrus / haze / snow-IR detection deferred to V2.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger(__name__)

# Recognized cloud-fraction variable names across SatCORPS products
CLOUD_VAR_CANDIDATES = (
    "cloud_amount_high",
    "cloud_fraction",
    "cld_frac",
    "total_cloud_amount",
    "cloud_amt",
)


@dataclass(frozen=True)
class CloudSample:
    cloud_fraction: float
    sample_time: datetime
    source: str  # satcorps | goes | himawari | meteosat | mock | cached | satcorps-fallback


@dataclass(frozen=True)
class ObstructionAssessment:
    p_unobstructed: float
    obstruction_class: str  # clear | cloudy | sun-glint risk


class CloudSampler(Protocol):
    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample: ...


def assess_obstruction(
    sample: CloudSample,
    sun_glint_risk: bool,
) -> ObstructionAssessment:
    """V1 three-class model. Sun-glint trumps cloud level."""
    cf = max(0.0, min(100.0, sample.cloud_fraction))
    if sun_glint_risk:
        return ObstructionAssessment(
            p_unobstructed=max(0.0, 60.0 - cf),
            obstruction_class="sun-glint risk",
        )
    if cf > 70:
        return ObstructionAssessment(p_unobstructed=100.0 - cf, obstruction_class="cloudy")
    if cf < 20:
        return ObstructionAssessment(p_unobstructed=100.0 - cf, obstruction_class="clear")
    return ObstructionAssessment(p_unobstructed=100.0 - cf, obstruction_class="cloudy")


def sun_subpoint(when: datetime) -> tuple[float, float]:
    """Sub-solar point at UTC time. Approximate (Cooper's declination + UTC noon hour angle).
    Sufficient for sun-glint check; not for precise solar geometry."""
    if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
        raise ValueError("when must be UTC-aware")
    n = when.timetuple().tm_yday + (when.hour + when.minute / 60.0) / 24.0
    dec = 23.44 * math.sin(math.radians(360.0 * (284.0 + n) / 365.0))
    utc_h = when.hour + when.minute / 60.0 + when.second / 3600.0
    sub_lon = -15.0 * (utc_h - 12.0)
    while sub_lon > 180:
        sub_lon -= 360
    while sub_lon < -180:
        sub_lon += 360
    return (dec, sub_lon)


def lighting_regime(sun_lat: float, sun_lon: float, target_lat: float, target_lon: float) -> str:
    """Classify the pass: day / night / terminator based on solar zenith angle at target.

    Solar zenith < 70° -> day, > 100° -> night, between -> terminator.
    """
    rl_t = math.radians(target_lat)
    rl_s = math.radians(sun_lat)
    dl = math.radians(target_lon - sun_lon)
    cos_zenith = math.sin(rl_t) * math.sin(rl_s) + math.cos(rl_t) * math.cos(rl_s) * math.cos(dl)
    cos_zenith = max(-1.0, min(1.0, cos_zenith))
    zenith_deg = math.degrees(math.acos(cos_zenith))
    if zenith_deg < 70:
        return "day"
    if zenith_deg > 100:
        return "night"
    return "terminator"


def angular_separation_deg(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    """Angular separation between two surface points (deg). Same math as great-circle."""

    rl1, rl2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    cos_d = math.sin(rl1) * math.sin(rl2) + math.cos(rl1) * math.cos(rl2) * math.cos(dl)
    cos_d = max(-1.0, min(1.0, cos_d))
    return math.degrees(math.acos(cos_d))


def is_water(lat: float, lon: float, mask: Any | None = None) -> bool:
    """Simple land/sea heuristic. If a mask is provided, use it; else treat ocean basins as water.

    The crude heuristic flags only points well inside the major oceans. Pre-launch a real GSHHG mask
    can be loaded; for V1 testing this is good enough for unit-test-level glint geometry checks.
    """
    if mask is not None:
        return bool(mask(lat, lon))
    # Crude ocean heuristic: points more than ~5° from the named landmass bands
    # (approximate; real impl swaps in a binary GSHHG-derived mask)
    if -60 < lat < 60:
        # Pacific (approx) - large central band
        if 140 < lon < 180 or -180 < lon < -110:
            return True
        # Atlantic (approx)
        if -60 < lon < -20 and -50 < lat < 40:
            return True
        # Indian (approx)
        if 50 < lon < 100 and -50 < lat < 10:
            return True
    return False


def sun_glint_risk(
    sun_lat: float,
    sun_lon: float,
    target_lat: float,
    target_lon: float,
    iss_lat: float,
    iss_lon: float,
    mask: Any | None = None,
    iss_proximity_deg: float = 5.0,
) -> bool:
    """V1 sun-glint heuristic.

    Glint is plausible when:
      1. target is over water,
      2. sun is up at the target (regime != night), and
      3. the ISS subpoint is within `iss_proximity_deg` of the target (~550 km on the surface).

    This is an OVER-flagging approximation: real glint depends on solar zenith angle,
    sea state, and view geometry. V2 will swap in a precise specular-direction model.
    """
    if not is_water(target_lat, target_lon, mask):
        return False
    regime = lighting_regime(sun_lat, sun_lon, target_lat, target_lon)
    if regime == "night":
        return False
    iss_offset = angular_separation_deg(target_lat, target_lon, iss_lat, iss_lon)
    return iss_offset < iss_proximity_deg


class MockCloudSampler:
    """Deterministic in-memory sampler for tests."""

    def __init__(self, default_cf: float = 30.0, overrides: dict | None = None):
        self._default = default_cf
        self._overrides = overrides or {}

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        key = (round(lat, 1), round(lon, 1))
        cf = self._overrides.get(key, self._default)
        return CloudSample(cloud_fraction=cf, sample_time=when, source="mock")


class SatCORPSSampler:
    """Wraps an open xarray Dataset for the cached hour and samples at lat/lon."""

    def __init__(self, dataset_path: Path):
        import xarray as xr  # local import; lets mock-only tests skip the netCDF stack

        self._ds = xr.open_dataset(dataset_path)
        self._loaded = dataset_path
        for c in CLOUD_VAR_CANDIDATES:
            if c in self._ds.data_vars:
                self._var = c
                break
        else:
            raise ValueError(f"no recognized cloud-fraction variable in {dataset_path}")

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        try:
            v = float(self._ds[self._var].sel(lat=lat, lon=lon, method="nearest").item())
        except Exception as exc:  # noqa: BLE001
            log.warning("SatCORPS sample failed at (%s, %s): %s", lat, lon, exc)
            return CloudSample(
                cloud_fraction=50.0, sample_time=when, source="satcorps-fallback"
            )
        if v <= 1.0:
            v = v * 100.0
        v = max(0.0, min(100.0, v))
        return CloudSample(cloud_fraction=v, sample_time=when, source="satcorps")

    def close(self) -> None:
        self._ds.close()
