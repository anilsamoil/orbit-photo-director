"""Cloud cover adapter: derive `P(unobstructed)` and an obstruction class for a
target lat/lon at a UTC timestamp.

Three sources, in order of preference at runtime:
  1. NASA GIBS (GIBSCloudSampler) — public WMTS, no auth, daily MODIS Aqua cloud
     fraction global tile. The V1 production source. PNGs are 8-bit colormap;
     the pixel value 0-100 IS the cloud fraction percent (127 = nodata).
  2. NOAA SatCORPS (SatCORPSSampler) — NetCDF/HDF hourly composite via Earthdata.
     Higher temporal resolution; requires fetcher implementation that we left as
     a stub for V1 because the file-listing API isn't documented well.
  3. MockCloudSampler — deterministic for tests, used as a fallback when neither
     real source is fresh.

Three-class obstruction model: `clear` / `cloudy` / `sun-glint risk`. Thin cirrus
/ haze / snow-IR detection requires a real classifier and is deferred to V2.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger(__name__)

# GIBS cloud-fraction PNG encoding: pixel value 0-100 IS the cloud fraction %.
# Special values:
GIBS_NODATA_VALUE = 127  # the "no data" entry in the published colormap
GIBS_TILE_MATRIX_SET = "2km"
GIBS_BASE = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best"

# Each layer captures one MODIS pass: Aqua afternoon, Terra morning, day or night.
# Merging all four gives near-global coverage (each satellite observes ~half the
# globe per day; combined they fill most pixels). Within each layer, pixel value
# 0 + values >100 are conflated "no observation" — treated as no-data and
# we look for valid data in the next layer.
GIBS_LAYERS = (
    "MODIS_Aqua_Cloud_Fraction_Day",
    "MODIS_Terra_Cloud_Fraction_Day",
    "MODIS_Aqua_Cloud_Fraction_Night",
    "MODIS_Terra_Cloud_Fraction_Night",
)

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
    # V1 heuristic. Lat band extended to ±70 so polar/sub-polar coastal targets
    # (Iceland ~65, Norway ~61, southern Patagonia ~-50) get a glint check.
    # V2 swaps in a real GSHHG-derived binary mask so coastlines are precise.
    if -70 < lat < 70:
        # Pacific - large central band
        if 140 < lon < 180 or -180 < lon < -110:
            return True
        # Atlantic - includes north Atlantic to capture Iceland approaches
        if -60 < lon < -10 and -50 < lat < 65:
            return True
        # Indian
        if 50 < lon < 100 and -50 < lat < 10:
            return True
        # Norwegian/Arctic-fringe Atlantic
        if -10 < lon < 20 and 55 < lat < 70:
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


# --------------------------------------------------------------------------
# NASA GIBS sampler — V1 production cloud source.
# --------------------------------------------------------------------------


def _gibs_url(layer: str, date_iso: str, z: int, y: int, x: int) -> str:
    return f"{GIBS_BASE}/{layer}/default/{date_iso}/{GIBS_TILE_MATRIX_SET}/{z}/{y}/{x}.png"


def _date_iso(when: datetime) -> str:
    return when.strftime("%Y-%m-%d")


def _is_valid_gibs_pixel(value: int) -> bool:
    """A GIBS cloud-fraction pixel is valid only when 1-100. 0 and 127 and >100 are no-obs."""
    return 1 <= value <= 100


class GIBSCloudSampler:
    """Sample global cloud fraction from NASA GIBS WMTS by merging four MODIS layers.

    Each MODIS Aqua/Terra Day/Night layer captures one orbit's daylight or
    nighttime view; combined, they fill most of the globe per day. We fetch
    all four at zoom 0 (a 2x1 grid covering the world in two PNGs each) and
    sample the FIRST layer that returns a valid 1-100 pixel for the lat/lon.

    Zoom 0 → ~0.7° per pixel, plenty for orbital-scale shot planning. Higher zoom
    is V2 if needed. Total bandwidth per fetch: ~8 PNGs × 50-100 KB ≈ 0.5 MB.
    """

    def __init__(self, when: datetime, fetcher: Any | None = None):
        """Pre-fetch the four GIBS layers for the given date.

        `fetcher` is an optional callable for tests; defaults to requests.get.
        """
        self._when = when
        # Use yesterday's date — today's products may not be published yet.
        date = when - timedelta(days=1)
        self._date_str = _date_iso(date)
        self._layers: list[Any] = []
        for layer in GIBS_LAYERS:
            try:
                arr = self._fetch_global_tile(layer, self._date_str, fetcher=fetcher)
                self._layers.append(arr)
            except Exception as exc:  # noqa: BLE001
                log.warning("GIBS fetch failed for %s: %s", layer, exc)

        if not self._layers:
            raise RuntimeError(f"all {len(GIBS_LAYERS)} GIBS layers failed to fetch")

    @classmethod
    def _fetch_global_tile(
        cls, layer: str, date_str: str, *, fetcher: Any | None = None
    ) -> Any:
        """Download both halves of the globe at zoom 0 and stitch them."""
        from io import BytesIO

        import numpy as np
        from PIL import Image

        if fetcher is None:
            import requests

            def _get(url: str) -> bytes:
                resp = requests.get(url, timeout=20)
                resp.raise_for_status()
                return resp.content

            fetcher = _get

        west_bytes = fetcher(_gibs_url(layer, date_str, 0, 0, 0))
        east_bytes = fetcher(_gibs_url(layer, date_str, 0, 0, 1))
        west = np.asarray(Image.open(BytesIO(west_bytes)))
        east = np.asarray(Image.open(BytesIO(east_bytes)))
        return np.concatenate([west, east], axis=1)

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        """Return cloud fraction (0-100) for lat/lon.

        Walks the four loaded MODIS layers (Aqua/Terra × Day/Night) and returns
        the first valid 1-100 pixel. Falls back to 50 (uncertain) only if all
        four layers lack an observation for this lat/lon.

        MODIS pixel encoding nuances:
        - 127 = explicit nodata (per the published colormap)
        - 0 = ambiguous: colormap says "0% cloud" but MODIS also fills 0 for
          pixels not observed during the layer's pass. Treat as no-obs.
        - 1-100 = trustworthy cloud fraction percent.
        - 101+ = outside the documented range (most likely sea-ice/snow flag).
          Treat as no-obs.
        """
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
            raise ValueError("when must be UTC-aware")
        if not self._layers:
            return CloudSample(50.0, when, "gibs-nodata")

        sample_h, sample_w = self._layers[0].shape[:2]
        row = int(round((90.0 - lat) / 180.0 * (sample_h - 1)))
        col = int(round((lon + 180.0) / 360.0 * (sample_w - 1)))
        row = max(0, min(sample_h - 1, row))
        col = max(0, min(sample_w - 1, col))

        for layer_arr in self._layers:
            raw = int(layer_arr[row, col])
            if _is_valid_gibs_pixel(raw):
                return CloudSample(
                    cloud_fraction=float(raw),
                    sample_time=when,
                    source="gibs",
                )

        return CloudSample(
            cloud_fraction=50.0, sample_time=when, source="gibs-no-obs"
        )
