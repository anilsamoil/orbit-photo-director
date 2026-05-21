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
from datetime import UTC, datetime, timedelta
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


def _equation_of_time_minutes(day_of_year: float) -> float:
    """Equation of Time in minutes — the difference between apparent solar
    time and mean solar time. Positive when apparent noon is BEFORE mean
    noon (sun is "fast" / ahead). Two-component approximation (obliquity
    + eccentricity), accurate to ~30 seconds across the year. That's well
    within the precision we need for the ±5° sun-glint proximity check
    in sun_glint_risk; absolute error in sub_lon is bounded at ±0.13°.

    Without this correction, sub_lon has up to ±16 min ≈ ±4° error,
    which can flip glint-risk on/off near the proximity boundary
    (V2-P3 TODOS.md item, fixed 2026-05-17).
    """
    b = math.radians(360.0 * (day_of_year - 81) / 365.0)
    return 9.87 * math.sin(2 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)


def sun_subpoint(when: datetime) -> tuple[float, float]:
    """Sub-solar point at UTC time. Approximate (Cooper's declination + UTC noon hour angle).
    Sufficient for sun-glint check; not for precise solar geometry.

    Includes Equation of Time correction (added 2026-05-17): sub_lon is
    shifted by EoT × 15°/h to reflect apparent solar time vs mean solar
    time. Without EoT, sub_lon has ±4° error which could flip the ±5°
    sun-glint proximity check across its boundary."""
    if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
        raise ValueError("when must be UTC-aware")
    n = when.timetuple().tm_yday + (when.hour + when.minute / 60.0) / 24.0
    dec = 23.44 * math.sin(math.radians(360.0 * (284.0 + n) / 365.0))
    utc_h = when.hour + when.minute / 60.0 + when.second / 3600.0
    eot_min = _equation_of_time_minutes(n)
    # sub_lon = -15 * (mean solar time offset from noon).
    # mean noon at sub_lon meridian → apparent noon at sub_lon meridian + EoT
    # → for a given utc_h, the apparent-noon meridian is EoT/60 hours westward.
    sub_lon = -15.0 * (utc_h - 12.0 + eot_min / 60.0)
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
    # Explicit land exceptions inside the ocean bands. V1 stop-gap until a
    # real GSHHG binary mask replaces this whole heuristic. Each exception
    # was added because the V1 band was triggering false sun-glint flags on
    # known land targets (Hawaii has a non-trivial photography priority
    # for ISS operators; Vandenberg is a launch site whose score was
    # asymmetric vs Kennedy because KSC sits outside the band).
    if _is_known_land_in_ocean_band(lat, lon):
        return False
    # V1 heuristic. Lat band extended to ±70 so polar/sub-polar coastal targets
    # (Iceland ~65, Norway ~61, southern Patagonia ~-50) get a glint check.
    # V2 swaps in a real GSHHG-derived binary mask so coastlines are precise.
    if -70 < lat < 70:
        # Pacific - large central band. East boundary shrunk from -110 to
        # -125 (2026-05-17): -110 caught Vandenberg SLC-4E (-120.6) and
        # most of the US West Coast, triggering sun_glint_risk on land
        # launch sites. -125 keeps deep Pacific coverage while excluding
        # the CA / Baja coastal strip. Trade: some real Pacific water
        # off Mexico (-125 to -110) is no longer flagged. Per the V3.0
        # review note, ARCH-4's reserved-slot logic masks the user-visible
        # symptom for launches; this fix removes the underlying asymmetry.
        if 140 < lon < 180 or -180 < lon < -125:
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


def _is_known_land_in_ocean_band(lat: float, lon: float) -> bool:
    """Explicit exception list for known land masses that fall inside the
    V1 ocean-band heuristic. V2 GSHHG mask makes this list obsolete.

    Each entry is a bounding box (lat_min, lat_max, lon_min, lon_max).
    Keep entries narrow — overly wide boxes will reintroduce the
    over-flag problem from the other direction (water targets in the
    box would be wrongly classified as land).
    """
    # Hawaiian Islands (Kauai through Big Island, ~lat 18.9-22.2, lon -160 to -154.8).
    # Reported by anilsamoilenko 2026-05-17 (V2-P3 TODOS.md item).
    if 18 < lat < 23 and -161 < lon < -154:
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


# --------------------------------------------------------------------------
# Geostationary IR sampler — covers the gaps that MODIS swaths leave behind.
# --------------------------------------------------------------------------

GEO_IR_LAYERS = (
    # Each entry: (GIBS layer name, satellite nominal lon, source-tag suffix)
    ("GOES-East_ABI_Band13_Clean_Infrared", -75.0, "goes-e"),
    ("GOES-West_ABI_Band13_Clean_Infrared", -137.0, "goes-w"),
    # GIBS Himawari is broken (zoom 0 reprojects to wrong longitudes; zoom 1
    # dateline tile is HTTP 400). HimawariNICTSampler covers Asia via NICT;
    # MeteosatEUMETSATSampler covers Africa/Europe via EUMETSAT WMS.
)


# --- Himawari via NICT real-time true-color tiles (Asia/W.Pacific gap-filler) ---
# NICT publishes the JMA Himawari-9 imagery as zoomable PNG tiles, no auth, every
# 10 minutes. We use the 2d zoom level (2x2 grid of 550px tiles → 1100x1100 px
# coverage of the Himawari disk). It is true-color RGB, not IR — useful only on
# the daylight half. Night pixels are near-black and we surface "no-obs" so the
# CombinedCloudSampler falls through cleanly.
HIMAWARI_NICT_BASE = "https://himawari8-dl.nict.go.jp/himawari8/img/D531106"
HIMAWARI_NICT_LEVEL = 2  # "2d" in the URL — 2x2 tile grid
HIMAWARI_NICT_TILE_PX = 550
# Coverage of the stitched 2x2 image. Approximate plate-carrée bounds; the
# Himawari disk is centered at sub-satellite (0°, 140.7°E) and extends ~80° in
# each direction. NICT's level-2 tile grid maps:
#   (0,0)=NW, (1,0)=NE, (0,1)=SW, (1,1)=SE
HIMAWARI_NICT_LAT_N = 60.0
HIMAWARI_NICT_LAT_S = -60.0
HIMAWARI_NICT_LON_W = 60.0    # eastern hemisphere edge
HIMAWARI_NICT_LON_E = 220.0   # = -140°W (across dateline, expressed unwrapped)
HIMAWARI_NICT_NIGHT_THRESHOLD = 25  # avg-RGB below this → night / off-disk
# Brightness → cloud-fraction heuristic. Roughly: ocean/clear ≈ 40-80, cloud ≈
# 150-250. Linear map past the night cutoff. Coarser than IR but the calibration
# loop will refine over the mission. V2 swaps in proper RGB→cloud-mask classifier.
HIMAWARI_NICT_BRIGHT_FLOOR = 50.0
HIMAWARI_NICT_BRIGHT_RANGE = 150.0  # 50→cf=0, 200→cf=100


def _ir_pixel_to_cloud_fraction(ir_byte: int) -> float:
    """Map IR Band 13 brightness (0=cold/cloud, 255=warm/surface) to cloud fraction.

    Linear inverse: cf = 100 - (pixel/255)*100, clamped to [0, 100].
    Conservative; won't distinguish thin cirrus from thick cloud, and night-time
    surface cooling will look like cloud. Calibration loop tunes V2.
    """
    cf = 100.0 - (ir_byte / 255.0) * 100.0
    return max(0.0, min(100.0, cf))


class GeostationaryIRSampler:
    """Sample IR brightness temperature from 3 geostationary satellites via GIBS.

    Each satellite covers ~half its hemisphere; combined they cover most of the
    globe (Africa + Europe gap because Meteosat isn't on GIBS yet — V2). For a
    given lat/lon we walk the layers, check the alpha channel (0 = off-disk for
    that satellite), and use the first layer with a valid pixel.

    Tile fetch: 6 PNGs × 80-160KB ≈ 700KB per refresh. Geostationary updates
    every 10-15 min upstream so a 60-min generator tick gets fresh data.
    """

    def __init__(self, when: datetime, fetcher: Any | None = None):
        self._when = when
        date = when.strftime("%Y-%m-%d")
        self._layers: list[tuple[str, str, Any]] = []
        for layer_name, _sat_lon, tag in GEO_IR_LAYERS:
            try:
                arr = self._fetch_global_tile(layer_name, date, fetcher=fetcher)
                self._layers.append((layer_name, tag, arr))
            except Exception as exc:  # noqa: BLE001
                log.warning("Geo IR fetch failed for %s: %s", layer_name, exc)
        if not self._layers:
            raise RuntimeError(f"all {len(GEO_IR_LAYERS)} geo IR layers failed to fetch")

    @classmethod
    def _fetch_global_tile(
        cls, layer: str, date_str: str, *, fetcher: Any | None = None
    ) -> Any:
        """Download both halves of the globe at zoom 0 and stitch them.

        Geostationary tiles are RGBA: alpha=0 outside the satellite's disk, RGB
        is grayscale brightness on-disk.
        """
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
        # Stay in RGBA so alpha tells us off-disk pixels.
        west = np.asarray(Image.open(BytesIO(west_bytes)).convert("RGBA"))
        east = np.asarray(Image.open(BytesIO(east_bytes)).convert("RGBA"))
        return np.concatenate([west, east], axis=1)

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
            raise ValueError("when must be UTC-aware")
        if not self._layers:
            return CloudSample(50.0, when, "geo-ir-nodata")

        h, w = self._layers[0][2].shape[:2]
        row = int(round((90.0 - lat) / 180.0 * (h - 1)))
        col = int(round((lon + 180.0) / 360.0 * (w - 1)))
        row = max(0, min(h - 1, row))
        col = max(0, min(w - 1, col))

        for _layer_name, tag, arr in self._layers:
            pixel = arr[row, col]
            # RGBA: alpha=0 means off-disk for THIS satellite — try the next one.
            if pixel[3] == 0:
                continue
            ir_byte = int(pixel[0])  # grayscale, R == G == B
            cf = _ir_pixel_to_cloud_fraction(ir_byte)
            return CloudSample(
                cloud_fraction=cf,
                sample_time=when,
                source=f"geo-ir-{tag}",
            )

        return CloudSample(
            cloud_fraction=50.0, sample_time=when, source="geo-ir-no-coverage"
        )


# --------------------------------------------------------------------------
# Meteosat IR108 via EUMETSAT WMS — Africa / Europe day+night filler.
# --------------------------------------------------------------------------
#
# EUMETSAT publishes the MSG (Meteosat Second Generation) primary at 0° lon
# under `msg_fes` (Full Earth Scan). The IR108 channel (10.8 μm brightness
# temperature) is the same physical signal as GOES Band 13 — cold pixels
# (high cloud tops) read bright, warm pixels (ground/sea) read dark — so
# we can reuse the exact `_ir_pixel_to_cloud_fraction()` heuristic the
# GOES sampler already uses. Day+night, so this also covers the Asian
# nighttime gap that the daytime-only Himawari NICT sampler can't fill.
#
# Endpoint: WMS 1.3.0 GetMap on geoserver, no auth, free, public.
# Coverage: ~ 60°N-60°S × 60°W-60°E (the high-quality MSG-0° disk).
# Cadence: full disk every 15 min upstream.

EUMETSAT_WMS_BASE = "https://view.eumetsat.int/geoserver/wms"
EUMETSAT_WMS_LAYER = "msg_fes:ir108"
# MSG-0° disk centered at 0°/0°. Going past ±60° starts to lose
# geolocation accuracy quickly — keep within the high-quality region.
EUMETSAT_LAT_N = 60.0
EUMETSAT_LAT_S = -60.0
EUMETSAT_LON_W = -60.0
EUMETSAT_LON_E = 60.0
# 1024×1024 over a 120°×120° box → ~13 km per pixel — plenty for
# orbital-scale shot planning and matches MSG's ~3 km resolution roughly.
EUMETSAT_TILE_PX = 1024


class MeteosatEUMETSATSampler:
    """Sample IR108 brightness over Africa / Europe via EUMETSAT WMS.

    Day+night (true IR, not visible-band like Himawari NICT). One
    GetMap fetch per init — ~300 KB PNG — then in-memory sampling.
    """

    def __init__(self, when: datetime, fetcher: Any | None = None):
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
            raise ValueError("when must be UTC-aware")
        self._when = when

        from io import BytesIO

        import numpy as np
        from PIL import Image

        if fetcher is None:
            import requests

            def _get(url: str) -> bytes:
                resp = requests.get(url, timeout=30)
                resp.raise_for_status()
                return resp.content

            fetcher = _get

        # WMS 1.3 with EPSG:4326 uses lat,lon axis order: bbox is min_lat,
        # min_lon, max_lat, max_lon. Older 1.1.1 (and our intuitions)
        # use lon,lat — getting this wrong silently returns a wrong
        # geographic region with no error.
        url = (
            f"{EUMETSAT_WMS_BASE}?service=WMS&version=1.3.0&request=GetMap"
            f"&layers={EUMETSAT_WMS_LAYER}"
            f"&styles=&format=image/png&transparent=true"
            f"&width={EUMETSAT_TILE_PX}&height={EUMETSAT_TILE_PX}"
            f"&crs=EPSG:4326"
            f"&bbox={EUMETSAT_LAT_S},{EUMETSAT_LON_W},{EUMETSAT_LAT_N},{EUMETSAT_LON_E}"
        )
        png_bytes = fetcher(url)
        # IR108 returns RGB grayscale (R==G==B). Stay in RGBA when present
        # so transparent off-disk pixels survive and we can detect them.
        self._image = np.asarray(Image.open(BytesIO(png_bytes)).convert("RGBA"))

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
            raise ValueError("when must be UTC-aware")

        # Outside the high-quality MSG-0° disk → no coverage.
        if not (EUMETSAT_LAT_S <= lat <= EUMETSAT_LAT_N):
            return CloudSample(50.0, when, "meteosat-no-coverage")
        if not (EUMETSAT_LON_W <= lon <= EUMETSAT_LON_E):
            return CloudSample(50.0, when, "meteosat-no-coverage")

        h, w = self._image.shape[:2]
        # WMS image: top row is max-lat, left col is min-lon. Plate-carrée
        # mapping into our pre-fetched 1024×1024 array.
        row = int(round((EUMETSAT_LAT_N - lat) / (EUMETSAT_LAT_N - EUMETSAT_LAT_S) * (h - 1)))
        col = int(round((lon - EUMETSAT_LON_W) / (EUMETSAT_LON_E - EUMETSAT_LON_W) * (w - 1)))
        row = max(0, min(h - 1, row))
        col = max(0, min(w - 1, col))

        pixel = self._image[row, col]
        # Alpha=0 → off-disk (e.g., far southern Indian Ocean within bbox).
        if pixel[3] == 0:
            return CloudSample(50.0, when, "meteosat-off-disk")
        ir_byte = int(pixel[0])  # grayscale, R == G == B
        cf = _ir_pixel_to_cloud_fraction(ir_byte)
        return CloudSample(
            cloud_fraction=cf, sample_time=when, source="meteosat-ir108"
        )


# --------------------------------------------------------------------------
# Himawari real-time tiles via NICT — daytime Asia / Western-Pacific filler.
# --------------------------------------------------------------------------


def _himawari_nict_timestamp(when: datetime) -> str:
    """Floor `when` to the nearest 10-min mark and format as NICT-path components.

    NICT publishes a new image every 10 minutes; the path is
    `.../{Y}/{M}/{D}/HHMMSS_x_y.png` with HH:MM aligned to a 10-min boundary
    and SS=00.
    """
    if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
        raise ValueError("when must be UTC-aware")
    minute = (when.minute // 10) * 10
    floored = when.replace(minute=minute, second=0, microsecond=0)
    return floored.strftime("%Y/%m/%d/%H%M00")


def _himawari_nict_url(time_path: str, x: int, y: int) -> str:
    return (
        f"{HIMAWARI_NICT_BASE}/{HIMAWARI_NICT_LEVEL}d/{HIMAWARI_NICT_TILE_PX}/"
        f"{time_path}_{x}_{y}.png"
    )


class HimawariNICTSampler:
    """Sample cloud cover over Asia/W.Pacific from NICT's Himawari-9 tile service.

    DAYTIME ONLY. The NICT product is RGB true-color; at night pixels are
    near-black and we surface "himawari-night" so the upstream CombinedCloudSampler
    can fall through. Coverage area is the Himawari disk: roughly
    60°N–60°S × 60°E–140°W (across the dateline).

    Uses zoom level 2 (2×2 = 4 tiles × 550 px = 1100 px stitched). One refresh
    is ~4 PNGs × 30–80 KB ≈ 250 KB. Upstream cadence is 10 min.

    Why true-color and not IR? GIBS Himawari is broken (mis-projected) and the
    JMA IR endpoints either require auth or 404. NICT's true-color is the
    most reliable public option that fills the daytime Asia gap. Calibration
    will tune the brightness→cf heuristic.
    """

    def __init__(self, when: datetime, fetcher: Any | None = None):
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
            raise ValueError("when must be UTC-aware")
        self._when = when
        # NICT occasionally drops a 10-min slot. Step back up to 60 min in 10-min
        # increments looking for a complete 4-tile set. Initial offset of 20 min
        # avoids racing the publisher's most recent slot.
        last_exc: Exception | None = None
        for offset_min in (20, 30, 40, 50, 60, 70):
            try:
                self._stitched = self._fetch_stitched(
                    when - timedelta(minutes=offset_min), fetcher=fetcher
                )
                return
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                log.info(
                    "Himawari NICT slot at -%d min unavailable (%s); trying older",
                    offset_min,
                    exc,
                )
        raise RuntimeError(
            f"Himawari NICT: no usable slot in last 70 min (last error: {last_exc})"
        )

    @classmethod
    def _fetch_stitched(
        cls, when: datetime, *, fetcher: Any | None = None
    ) -> Any:
        """Fetch all 4 tiles for the floored 10-min mark and stitch into a 2D RGB array."""
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

        time_path = _himawari_nict_timestamp(when)
        n = HIMAWARI_NICT_LEVEL  # 2x2 grid
        rows = []
        for y in range(n):
            row_tiles = []
            for x in range(n):
                tile_bytes = fetcher(_himawari_nict_url(time_path, x, y))
                tile = np.asarray(Image.open(BytesIO(tile_bytes)).convert("RGB"))
                row_tiles.append(tile)
            rows.append(np.concatenate(row_tiles, axis=1))
        return np.concatenate(rows, axis=0)

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
            raise ValueError("when must be UTC-aware")

        # Outside the Himawari disk → no coverage.
        # Normalize lon into the unwrapped 60..220 frame: e.g., -120 → 240, -150 → 210.
        unwrapped = lon if lon >= HIMAWARI_NICT_LON_W else lon + 360.0
        if not (HIMAWARI_NICT_LAT_S <= lat <= HIMAWARI_NICT_LAT_N):
            return CloudSample(50.0, when, "himawari-no-coverage")
        if not (HIMAWARI_NICT_LON_W <= unwrapped <= HIMAWARI_NICT_LON_E):
            return CloudSample(50.0, when, "himawari-no-coverage")

        h, w = self._stitched.shape[:2]
        # Plate-carrée mapping: lat decreases top→bottom, lon increases left→right.
        lat_span = HIMAWARI_NICT_LAT_N - HIMAWARI_NICT_LAT_S
        lon_span = HIMAWARI_NICT_LON_E - HIMAWARI_NICT_LON_W
        row = int(round((HIMAWARI_NICT_LAT_N - lat) / lat_span * (h - 1)))
        col = int(round((unwrapped - HIMAWARI_NICT_LON_W) / lon_span * (w - 1)))
        row = max(0, min(h - 1, row))
        col = max(0, min(w - 1, col))

        pixel = self._stitched[row, col]
        brightness = (int(pixel[0]) + int(pixel[1]) + int(pixel[2])) / 3.0
        if brightness < HIMAWARI_NICT_NIGHT_THRESHOLD:
            return CloudSample(50.0, when, "himawari-night")

        cf = (brightness - HIMAWARI_NICT_BRIGHT_FLOOR) / HIMAWARI_NICT_BRIGHT_RANGE * 100.0
        cf = max(0.0, min(100.0, cf))
        return CloudSample(cloud_fraction=cf, sample_time=when, source="himawari-nict")


# --------------------------------------------------------------------------
# GFS Forecast sampler — forward cloud cover for pass-time planning.
# --------------------------------------------------------------------------
#
# Source: Open-Meteo's free GFS endpoint (https://api.open-meteo.com/v1/gfs).
# Same NOAA GFS data underneath the more-authoritative NOMADS GRIB2 path, but
# pure HTTP+JSON — no eccodes/pygrib/cfgrib binary deps to break in the field
# during an 8-month unattended run. The trade-off is a third-party CDN in the
# path; if Open-Meteo ever has issues, ground-side support can swap to NOMADS
# direct without changing the sampler's call shape.
#
# Cadence: GFS publishes every 6h (00/06/12/18 UTC) with hourly forecast
# steps. Open-Meteo serves the latest run, so we get forecast horizon up to
# ~16 days. We only ever care about the next 24-48 h.
#
# Free-tier limits: 10K calls/day, 5K/hour, 600/min. We hit ~24-72 calls/day
# (one batch per 60-min tick × 1-3 batches for 137 targets), well inside.

OPEN_METEO_GFS_BASE = "https://api.open-meteo.com/v1/gfs"
# Cap targets per request so the URL stays under reasonable length limits
# (servers + proxies typically tolerate up to 8 KB; 100 coords × ~14 chars =
# ~1.4 KB per axis, safe).
OPEN_METEO_BATCH_SIZE = 100
OPEN_METEO_TIMEOUT_SECONDS = 30


class GFSForecastSampler:
    """Forecast cloud-fraction sampler for any (lat, lon, when).

    Pre-fetches per-target forecast hourly time-series at construction time,
    one batched HTTP call per 100 targets. Subsequent .sample() calls are
    in-memory lookups — O(1) per pass scored.

    The forecast horizon defaults to 48 hours so passes anywhere in the next
    24 h fall comfortably inside the window. Target lat/lon mismatches with
    the GFS 0.25° grid are < 14 km and tolerated silently.
    """

    def __init__(
        self,
        targets: list[tuple[float, float]],
        forecast_days: int = 2,
        fetcher: Any | None = None,
        include_cape: bool = False,
    ):
        # v1.5.5.0 (weather v1.3.2): added optional `include_cape` to also
        # fetch CAPE (Convective Available Potential Energy) alongside
        # cloud_cover. CAPE > 1000 J/kg indicates strong thunderstorm
        # potential — the LightningCAPEForecastSampler reads this for the
        # forecast-side lightning_potential when GLM has no recent data
        # for the target's region.
        self._include_cape = include_cape
        if not targets:
            self._by_coord: dict[tuple[float, float], list[tuple[datetime, float]]] = {}
            self._cape_by_coord: dict[tuple[float, float], list[tuple[datetime, float]]] = {}
            return
        if fetcher is None:
            import requests

            def _get(url: str) -> Any:
                resp = requests.get(url, timeout=OPEN_METEO_TIMEOUT_SECONDS)
                resp.raise_for_status()
                return resp.json()

            fetcher = _get

        # Round target coords to the GFS grid step (0.25°) so duplicate
        # nearby targets share a single forecast time-series. This also
        # cuts batch size when many targets cluster (e.g., a city plus
        # its airport).
        rounded: list[tuple[float, float]] = []
        seen: set[tuple[float, float]] = set()
        for lat, lon in targets:
            key = (round(lat * 4) / 4.0, round(lon * 4) / 4.0)
            if key not in seen:
                seen.add(key)
                rounded.append(key)

        self._by_coord = {}
        self._cape_by_coord = {}
        for batch_start in range(0, len(rounded), OPEN_METEO_BATCH_SIZE):
            batch = rounded[batch_start : batch_start + OPEN_METEO_BATCH_SIZE]
            self._fetch_batch(batch, forecast_days, fetcher)

    @staticmethod
    def _build_url(
        batch: list[tuple[float, float]],
        forecast_days: int,
        include_cape: bool = False,
    ) -> str:
        lats = ",".join(f"{lat:.4f}" for lat, _ in batch)
        lons = ",".join(f"{lon:.4f}" for _, lon in batch)
        # v1.5.5.0: optionally include CAPE in the hourly variable list.
        # Open-Meteo supports `cape` as a free hourly variable on the GFS
        # endpoint — zero extra HTTP calls.
        hourly = "cloud_cover,cape" if include_cape else "cloud_cover"
        return (
            f"{OPEN_METEO_GFS_BASE}?latitude={lats}&longitude={lons}"
            f"&hourly={hourly}&forecast_days={forecast_days}"
        )

    def _fetch_batch(
        self,
        batch: list[tuple[float, float]],
        forecast_days: int,
        fetcher: Any,
    ) -> None:
        url = self._build_url(batch, forecast_days, self._include_cape)
        try:
            payload = fetcher(url)
        except Exception as exc:  # noqa: BLE001
            log.warning("GFS forecast fetch failed for %d targets: %s", len(batch), exc)
            return

        # Single-target requests return a dict; multi-target returns a list.
        items = payload if isinstance(payload, list) else [payload]
        if len(items) != len(batch):
            log.warning(
                "GFS forecast: requested %d targets, got %d back; truncating",
                len(batch), len(items),
            )
        for (lat, lon), item in zip(batch, items, strict=False):
            try:
                hourly = item.get("hourly") or {}
                times = hourly.get("time") or []
                covers = hourly.get("cloud_cover") or []
                capes = hourly.get("cape") or [] if self._include_cape else []
            except (AttributeError, TypeError):
                continue
            series: list[tuple[datetime, float]] = []
            cape_series: list[tuple[datetime, float]] = []
            for idx, t_str in enumerate(times):
                cf = covers[idx] if idx < len(covers) else None
                try:
                    # Open-Meteo defaults to UTC ISO8601 without timezone suffix
                    dt = datetime.fromisoformat(t_str)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=UTC)
                except (ValueError, TypeError):
                    continue
                if cf is not None:
                    try:
                        series.append((dt, float(cf)))
                    except (ValueError, TypeError):
                        pass
                if self._include_cape and idx < len(capes):
                    cape = capes[idx]
                    if cape is not None:
                        try:
                            cape_series.append((dt, float(cape)))
                        except (ValueError, TypeError):
                            pass
            self._by_coord[(lat, lon)] = series
            if self._include_cape:
                self._cape_by_coord[(lat, lon)] = cape_series

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        """Return forecast cloud-fraction at the hour bucket containing `when`.

        Snaps lat/lon to the nearest 0.25° grid cell to match the cache key.
        Returns a "gfs-forecast-no-data" placeholder if the target wasn't in
        the pre-fetched batch (defensive — should not happen in normal use).
        """
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
            raise ValueError("when must be UTC-aware")
        key = (round(lat * 4) / 4.0, round(lon * 4) / 4.0)
        series = self._by_coord.get(key)
        if not series:
            return CloudSample(50.0, when, "gfs-forecast-no-data")
        # Floor `when` to the hour, then find the matching forecast step.
        target_hour = when.replace(minute=0, second=0, microsecond=0)
        for dt, cf in series:
            if dt == target_hour:
                return CloudSample(
                    cloud_fraction=max(0.0, min(100.0, cf)),
                    sample_time=when,
                    source="gfs-forecast",
                )
        # `when` is past the forecast horizon — surface honestly.
        return CloudSample(50.0, when, "gfs-forecast-out-of-horizon")

    def cape_at(self, lat: float, lon: float, when: datetime) -> float | None:
        """Return forecast CAPE (J/kg) at the hour bucket containing `when`,
        or None when CAPE wasn't fetched / `when` is past the horizon /
        no data for the (lat, lon) cell. v1.5.5.0 — weather v1.3.2.

        Only meaningful when the sampler was constructed with
        `include_cape=True`. Otherwise always returns None.
        """
        if not self._include_cape:
            return None
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timedelta(0):
            raise ValueError("when must be UTC-aware")
        key = (round(lat * 4) / 4.0, round(lon * 4) / 4.0)
        series = self._cape_by_coord.get(key)
        if not series:
            return None
        target_hour = when.replace(minute=0, second=0, microsecond=0)
        for dt, cape in series:
            if dt == target_hour:
                return max(0.0, cape)
        return None
