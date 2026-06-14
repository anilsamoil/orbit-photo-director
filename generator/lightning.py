"""Lightning probability + hurricane proximity for weather v1.3 cards.

Origin: Astronaut Matthew Dominick (NASA Crew-8) emailed 2026-05-19, bullet 2
("Lightning predictions/probability") + bullet on storms ("major storms or
weather events"). Loral O'Hara CC'd as "earth obs photo machine."
Plan locked 2026-05-19 via /plan-eng-review. Design doc:
~/.gstack/projects/anilsamoil-orbit-photo-director/anilsamoilenko-weather-v1.3-eng-review-2026-05-19.md

v1.3.1 (this module) ships:
- LightningSampler Protocol + a PlaceholderLightningSampler that returns
  0.0 potential for every query. Wires the type + score-bonus path through
  the pipeline without committing to a specific upstream data source yet.
- NHCHurricaneTracker — fetches NHC active-storm JSON hourly, checks each
  pass's target_lat/lon against active named storms within
  HURRICANE_PROXIMITY_KM. Returns a HurricaneNearby with the storm name +
  classification for the operator-visible 🌀 tag.

v1.3.2 (next PR) will replace the placeholder with real GLM (NOAA S3) +
Blitzortung (WebSocket) + GFS CAPE samplers. The shape of LightningSample
is the contract those samplers will satisfy — they slot into the existing
CombinedLightningSampler tier-fallback pattern.

Architecture decisions (D1-D6 locked 2026-05-19):
- D1: full lake (observed lightning + forecast + hurricane) — phased per
      complexity; this PR is the hurricane + framework half
- D2: GLM + Blitzortung (skip MTG-LI auth) — deferred to v1.3.2
- D3: additive +30 score bonus, cap final at 100 (no overflow)
- D4: NHC-only named-storm tag — Atlantic + East Pacific; JTWC deferred
- D5: flex-wrap stack — all weather tags visible
- D6: OPD_ENABLE_WEATHER flag, 1-week Anil soak
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
import time
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import requests

from .orbit import great_circle_bearing_deg, great_circle_km

log = logging.getLogger(__name__)

# Score bonus cap per the locked D3 decision. Bonus is additive on top of
# the multiplicative score (final = min(100, base + 30 × lightning_potential)).
LIGHTNING_BONUS_MAX = 30.0

# NHC active storms JSON endpoint. Updated every 3-6h with advisory cycles.
# Atlantic + East Pacific basins only — JTWC (W.Pacific / Indian Ocean) is
# a separate API with text bulletins and is deferred (V4-P3 in TODOS.md).
NHC_API_URL = "https://www.nhc.noaa.gov/CurrentStorms.json"

# Proximity threshold for the 🌀 named-storm tag. Picked to match "visible
# from ISS" — at 408km ISS altitude, the horizon extends roughly 2200km;
# 1500km is a conservative inner radius where the storm is photogenically
# centered, not at the limb. Soak data will tune this; classification-tiered
# proximity (Cat 5 visible farther than TD) is V4-P3.
HURRICANE_PROXIMITY_KM = 1500.0


# ---------------------------------------------------------------------------
# Lightning sampling — Protocol + placeholder
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LightningSample:
    """Result of a lightning probability query at one lat/lon at one time.

    `lightning_potential` is in [0.0, 1.0] regardless of source. Observed
    sources (GLM, Blitzortung) derive this from recent flash density;
    forecast sources (GFS CAPE) derive from convective potential metrics.
    `flash_rate_per_min` is observed-only — forecast samplers report 0.
    """

    lightning_potential: float
    flash_rate_per_min: float
    sample_time: datetime
    source: str  # placeholder | glm | blitzortung | gfs-cape | combined-no-data


class LightningSampler(Protocol):
    """Same Protocol shape as CloudSampler — drop in samplers in v1.3.2.

    Implementations must be safe to call from the launchd-tick batch
    process; expensive setup (S3 client init, WebSocket subscribe) should
    happen at construction, not on each sample() call.
    """

    def sample(self, lat: float, lon: float, when: datetime) -> LightningSample: ...


class PlaceholderLightningSampler:
    """Returns 0.0 lightning_potential for every query.

    Ships the integration path without committing to a specific data source
    in v1.3.1. Score-bonus path is wired through (so v1.3.2 plug-in is a
    one-line swap in main.py:select_lightning_sampler) but no bonus actually
    applies during the soak — the named-storm tag is the operator-visible
    signal in this release.
    """

    def sample(self, lat: float, lon: float, when: datetime) -> LightningSample:
        return LightningSample(
            lightning_potential=0.0,
            flash_rate_per_min=0.0,
            sample_time=when,
            source="placeholder",
        )


# ---------------------------------------------------------------------------
# GLM (NOAA Geostationary Lightning Mapper) sampler — v1.5.5.0 (weather v1.3.2)
# ---------------------------------------------------------------------------
#
# Source: NOAA Big Data on AWS S3, anonymous public bucket
#   noaa-goes16 (GOES-East, lon -75.2°) — Americas + Atlantic
#   noaa-goes18 (GOES-West, lon -137.0°) — E.Pacific + Americas
# Format: GLM-L2-LCFA NetCDF granules, ~20s cadence, ~30-100KB each.
# Path: GLM-L2-LCFA/YYYY/DOY/HH/OR_GLM-L2-LCFA_G{16,18}_s{...}_e{...}_c{...}.nc
#
# v1.5.5.0 design (per /plan-eng-review 2026-05-21):
# - A1: 60-min window per tick (matches tick cadence; ~18MB/tick total)
# - A2: skip targets outside GOES coverage (lat outside [-60, 60] or lon
#       outside [-180, -25]) — no point fetching for Europe/Africa/Asia
# - A3: companion `make glm-smoke` target for live-S3 verification
# - A4: granule age carried in lightning_source (e.g., "glm-45m")
# - A5: log warning when expected listing is empty (silent-degrade detection)
# - P2: 5° × 5° spatial bucket index for O(1) per-target lookup
#
# Sim-env caveat: NOAA S3 only has data through 2025; in this dev
# environment the sampler returns 0-potential for "today's" date.
# Tests use mocked fixtures + the live path is verified only via
# `make glm-smoke` after real-world deployment.
#
# Structural similarity to GFSForecastSampler.fetch_batches: both list
# URLs in a time window, fetch each, parse, aggregate. Different formats
# (NetCDF vs JSON) and different cadences (20s vs 1h), so the
# generalization isn't worth a shared abstraction.

GLM_S3_BUCKETS = ("noaa-goes16", "noaa-goes18")
GLM_LISTING_TIMEOUT_SECONDS = 30
GLM_GRANULE_TIMEOUT_SECONDS = 30
# Parallelism for the per-tick granule fetch. NOAA S3 reliably handles 16
# parallel anonymous GETs; no 429 backoff in v1 — revisit if observed.
GLM_FETCH_MAX_WORKERS = 16
# Overall budget for the entire granule-fetch phase, in seconds. Any
# granule still pending when the budget expires is dropped (graceful
# degradation — partial lightning data is better than a stalled tick).
GLM_FETCH_BUDGET_SECONDS = 120
# Window of GLM granules to fetch per tick (60 min — matches default
# tick interval). ~3 granules/min × 60 min × 2 sats = ~360 files × ~50KB
# = ~18MB egress per tick. Well within budget; bandwidth note in P1.
GLM_WINDOW_MINUTES = 60
# Per-target lookup radius. 100km is "visible from a single ISS frame"
# (~3° lat at 408km altitude); matches operator's mental model of
# "lightning near my photo target."
GLM_LOOKUP_RADIUS_KM = 100.0

# ── Sprite watch (Unit 7) ────────────────────────────────────────────────
# Sprites are upward lightning at ~50-90km above STRONG storms, photographed
# from the ISS by looking at the dark LIMB toward a distant storm. The
# annulus of storm ground-distances from the ISS sub-point where a sprite is
# a genuine limb target (not the nadir-lightning ⚡ tag) and is above the
# ISS's visible horizon for a 75km-elevated source:
#   inner 900km  → ~61.7° off-nadir (clears the 60° initial-encounter /
#                  30° WORF-Cupola nadir-framing window — a true limb view).
#   outer 3200km → the elevated horizon for a 75km sprite seen from 420km
#                  (acos(R/(R+420)) + acos(R/(R+75)) ≈ 29.0° central angle →
#                  ~3227km, rounded down for refraction/occultation margin).
SPRITE_ANNULUS_INNER_KM = 900.0
SPRITE_ANNULUS_OUTER_KM = 3200.0
# Minimum GLM flashes in a winning 5° bucket over the 60-min window for the
# storm to count as sprite-capable. A COARSE VIGOR PROXY, not a derived
# charge-moment threshold — GLM total-flash count only loosely tracks the
# high-charge-moment +CG strokes in a storm's stratiform region that actually
# trigger sprites. Set conservatively (anti-over-fire; ~4 flashes/min average
# over the hour = a genuinely active mesoscale system) and SOAK-TUNABLE: the
# dev env has no live GLM past 2025, so this only exercises under `make
# glm-smoke` / production. Raise if the soak shows noise, lower if it never
# fires.
SPRITE_MIN_FLASHES = 250
# Coarse spatial-index bucket size (P2). 5° lat/lon ≈ 555km × 555km at
# the equator; a 100km lookup radius always lands within at most 4
# adjacent buckets, so the per-target retrieval is O(1) bucket fetch
# followed by an O(k) distance check across ≤4 buckets.
GLM_SPATIAL_BUCKET_DEG = 5.0
# GOES nominal full-disk coverage envelope. Real coverage is a circle
# centered on each satellite's sub-point; using a lat/lon box gates the
# work without over-fetching. Outside this envelope, GLM has nothing
# to say and the sampler skips immediately.
GLM_COVERAGE_LAT_MIN = -60.0
GLM_COVERAGE_LAT_MAX = 60.0
GLM_COVERAGE_LON_MIN = -180.0
GLM_COVERAGE_LON_MAX = -25.0


def _in_glm_coverage(lat: float, lon: float) -> bool:
    """A2: return False for points outside the combined GOES-East+West disk."""
    return (
        GLM_COVERAGE_LAT_MIN <= lat <= GLM_COVERAGE_LAT_MAX
        and GLM_COVERAGE_LON_MIN <= lon <= GLM_COVERAGE_LON_MAX
    )


def _glm_granule_urls(bucket: str, when: datetime, window_minutes: int) -> list[str]:
    """List GLM granule URLs from S3 covering the last `window_minutes`
    minutes ending at `when`. Uses S3's `list-type=2` XML endpoint.

    Returns absolute HTTPS URLs (one per granule). Empty list on listing
    failure — the caller logs a warning per A5 if a window where we
    expect data comes back empty.
    """
    if window_minutes <= 0:
        return []
    cutoff = when.timestamp() - window_minutes * 60
    out: list[str] = []
    # Walk hour-by-hour back from `when` until we've covered the window.
    hours_to_walk = (window_minutes // 60) + 2
    for hour_offset in range(hours_to_walk):
        t = datetime.fromtimestamp(when.timestamp() - hour_offset * 3600, tz=UTC)
        year = t.year
        doy = t.timetuple().tm_yday
        hour = t.hour
        prefix = f"GLM-L2-LCFA/{year}/{doy:03d}/{hour:02d}/"
        list_url = (
            f"https://{bucket}.s3.amazonaws.com/?prefix={prefix}&list-type=2"
        )
        try:
            resp = requests.get(list_url, timeout=GLM_LISTING_TIMEOUT_SECONDS)
            resp.raise_for_status()
        except requests.RequestException as exc:
            log.warning("GLM listing failed for %s/%s: %s", bucket, prefix, exc)
            continue
        # XML response — extract <Key>...</Key>. Avoid an XML-parser dep.
        body = resp.text
        idx = 0
        while True:
            start = body.find("<Key>", idx)
            if start < 0:
                break
            end = body.find("</Key>", start)
            if end < 0:
                break
            key = body[start + 5 : end]
            idx = end + 6
            # Filter granules whose start-time is within our window.
            # Key pattern: OR_GLM-L2-LCFA_G{N}_sYYYYDOYHHMMSSS_e...nc
            # The `s` timestamp marks granule start. Parse just enough.
            s_pos = key.find("_s")
            if s_pos < 0:
                continue
            try:
                stamp = key[s_pos + 2 : s_pos + 16]  # YYYYDOYHHMMSSS (14 chars)
                stamp_year = int(stamp[0:4])
                stamp_doy = int(stamp[4:7])
                stamp_h = int(stamp[7:9])
                stamp_m = int(stamp[9:11])
                stamp_s = int(stamp[11:13])
                granule_dt = datetime(stamp_year, 1, 1, tzinfo=UTC).replace(
                    month=1, day=1
                )
                from datetime import timedelta as _td
                granule_dt = granule_dt + _td(days=stamp_doy - 1, hours=stamp_h,
                                              minutes=stamp_m, seconds=stamp_s)
            except (ValueError, IndexError):
                continue
            if granule_dt.timestamp() < cutoff:
                continue
            out.append(f"https://{bucket}.s3.amazonaws.com/{key}")
    return out


@dataclass(frozen=True)
class _GLMFlash:
    """One decoded lightning flash from a GLM granule."""
    lat: float
    lon: float
    t: datetime


def _decode_glm_granule(buf: bytes) -> list[_GLMFlash]:
    """Parse one GLM-L2-LCFA NetCDF buffer; return list of (lat, lon, time)
    for each flash. Returns empty list on parse failure (caller silently
    skips and tries the next granule).

    GLM-L2-LCFA schema (per NOAA GOES-R Product Definition):
      variables: flash_lat[N], flash_lon[N],
                 flash_time_offset_of_first_event[N] (float seconds)
      attribute: time_coverage_start ISO 8601 string
    """
    try:
        import netCDF4
    except ImportError:
        log.warning("netCDF4 not available; cannot decode GLM granules")
        return []
    try:
        ds = netCDF4.Dataset("inmemory.nc", mode="r", memory=buf)
    except Exception as exc:  # noqa: BLE001
        log.warning("GLM granule decode failed: %s", exc)
        return []
    try:
        if "flash_lat" not in ds.variables:
            return []
        flash_lat = ds.variables["flash_lat"][:]
        flash_lon = ds.variables["flash_lon"][:]
        if "flash_time_offset_of_first_event" in ds.variables:
            flash_offsets = ds.variables["flash_time_offset_of_first_event"][:]
        else:
            flash_offsets = [0.0] * len(flash_lat)
        ref_str = getattr(ds, "time_coverage_start", None)
        if ref_str:
            try:
                ref = datetime.fromisoformat(str(ref_str).replace("Z", "+00:00"))
                if ref.tzinfo is None:
                    ref = ref.replace(tzinfo=UTC)
            except ValueError:
                ref = datetime.now(tz=UTC)
        else:
            ref = datetime.now(tz=UTC)
        from datetime import timedelta as _td
        flashes: list[_GLMFlash] = []
        for i in range(len(flash_lat)):
            try:
                lat = float(flash_lat[i])
                lon = float(flash_lon[i])
                offset = float(flash_offsets[i]) if i < len(flash_offsets) else 0.0
                t = ref + _td(seconds=offset)
                flashes.append(_GLMFlash(lat=lat, lon=lon, t=t))
            except (ValueError, TypeError):
                continue
        return flashes
    finally:
        ds.close()


def _bucket_key(lat: float, lon: float) -> tuple[int, int]:
    """5° × 5° lat/lon bucket key for the GLM spatial index (P2)."""
    return (
        int(lat // GLM_SPATIAL_BUCKET_DEG),
        int(lon // GLM_SPATIAL_BUCKET_DEG),
    )


@dataclass(frozen=True)
class StrongCluster:
    """A sprite-capable storm cluster found in the limb annulus."""

    distance_km: float   # ISS sub-point → cluster centroid (great-circle)
    bearing_deg: float   # true bearing [0,360) from sub-point to centroid
    flash_count: int     # in-annulus flashes in the winning 5° bucket


class GLMSampler:
    """Observed-lightning sampler via NOAA GLM AWS S3 buckets.

    Construction is once-per-tick: fetches GLM-L2-LCFA granules from
    GOES-East + GOES-West for the last GLM_WINDOW_MINUTES, decodes them
    into a 5°×5° spatial index, caches the result. Subsequent .sample()
    calls are O(1) bucket lookup + O(k) flashes-in-bucket distance check.

    Returns lightning_source="glm-{N}m" where N is the age in minutes
    of the OLDEST granule that contributed flashes (per A4 — operator
    visibility into freshness).
    """

    def __init__(
        self,
        when: datetime,
        window_minutes: int = GLM_WINDOW_MINUTES,
        fetcher: Any | None = None,
        lister: Any | None = None,
    ):
        if when.tzinfo is None:
            raise ValueError("when must be UTC-aware")
        self._when = when
        self._window_minutes = window_minutes
        self._flashes_by_bucket: dict[tuple[int, int], list[_GLMFlash]] = {}
        # Track the oldest granule we contributed from, for the lightning_source
        # age suffix.
        self._oldest_granule_age_min: int | None = None

        if fetcher is None:
            def _fetch_bytes(url: str) -> bytes:
                resp = requests.get(url, timeout=GLM_GRANULE_TIMEOUT_SECONDS)
                resp.raise_for_status()
                return resp.content
            fetcher = _fetch_bytes
        if lister is None:
            def _list_urls(bucket: str) -> list[str]:
                return _glm_granule_urls(bucket, when, window_minutes)
            lister = _list_urls

        all_urls: list[str] = []
        for bucket in GLM_S3_BUCKETS:
            urls = lister(bucket)
            if not urls:
                # A5: log warning when a window where we expect data is empty.
                log.info(
                    "GLM listing for %s in last %dm returned 0 granules — "
                    "expected ~%d. Either NOAA is having an issue or this "
                    "environment's wall-clock is ahead of the bucket's data.",
                    bucket, window_minutes, window_minutes * 3,
                )
            all_urls.extend(urls)

        # Parallel granule fetch. NOAA S3 is the per-tick latency hot-path:
        # when one of the two GOES buckets is empty and the other returns
        # ~180 granules at ~30s timeout each, the previous serial loop
        # could take 4-7+ minutes and push tick time past the daemon
        # watchdog. Fan-out + an overall budget caps the phase at
        # GLM_FETCH_BUDGET_SECONDS regardless of NOAA flakes.
        #
        # Decode runs in the main thread after as_completed; this is the
        # "decode is cheap, fetch dominates" assumption. The decode_seconds
        # log line below lets us verify that against real production data;
        # if aggregate decode is ever observed >30s, fold _decode_glm_granule
        # into the worker callable.
        decode_seconds = 0.0
        decoded_granules = 0
        # Note: not using `with ThreadPoolExecutor()` because its __exit__
        # blocks waiting for in-flight workers — `time.sleep` (or a stuck
        # socket recv) can't be cancelled, so a hung S3 worker would
        # negate the 120s budget. Use shutdown(wait=False, cancel_futures=True)
        # to ensure the budget actually bounds wall-clock time. Lingering
        # stuck workers continue in the background but are bounded by
        # `GLM_GRANULE_TIMEOUT_SECONDS` inside the default fetcher and
        # don't block tick completion.
        ex = concurrent.futures.ThreadPoolExecutor(
            max_workers=GLM_FETCH_MAX_WORKERS
        )
        futures = {ex.submit(fetcher, url): url for url in all_urls}
        try:
            for fut in concurrent.futures.as_completed(
                futures, timeout=GLM_FETCH_BUDGET_SECONDS
            ):
                url = futures[fut]
                try:
                    buf = fut.result()
                except requests.RequestException as exc:
                    log.warning("GLM granule fetch failed for %s: %s", url, exc)
                    continue
                decode_start = time.monotonic()
                flashes = _decode_glm_granule(buf)
                decode_seconds += time.monotonic() - decode_start
                decoded_granules += 1
                for flash in flashes:
                    key = _bucket_key(flash.lat, flash.lon)
                    self._flashes_by_bucket.setdefault(key, []).append(flash)
                    age_min = int((when - flash.t).total_seconds() / 60)
                    if (
                        self._oldest_granule_age_min is None
                        or age_min > self._oldest_granule_age_min
                    ):
                        self._oldest_granule_age_min = age_min
        except concurrent.futures.TimeoutError:
            completed = sum(1 for f in futures if f.done())
            log.warning(
                "GLM granule fetch budget exceeded (%ds); %d of %d "
                "granules completed; dropping rest",
                GLM_FETCH_BUDGET_SECONDS, completed, len(futures),
            )
        finally:
            # cancel_futures=True drops not-yet-started work; wait=False
            # returns immediately even if workers are stuck in a socket
            # read (the daemon's `GLM_GRANULE_TIMEOUT_SECONDS` request
            # timeout still bounds those threads to ≤30s background drain).
            ex.shutdown(wait=False, cancel_futures=True)
        if decoded_granules > 0:
            log.info(
                "GLM granule decode: %d granules in %.2fs (%.1fms/granule avg)",
                decoded_granules,
                decode_seconds,
                (decode_seconds * 1000.0) / decoded_granules,
            )

    def sample(self, lat: float, lon: float, when: datetime) -> LightningSample:
        # A2: skip GLM lookup for targets outside GOES coverage envelope.
        if not _in_glm_coverage(lat, lon):
            return LightningSample(
                lightning_potential=0.0,
                flash_rate_per_min=0.0,
                sample_time=when,
                source="glm-out-of-coverage",
            )
        # Lookup the 4 adjacent buckets (handles the 5°×5° grid + the 100km
        # lookup radius landing across bucket boundaries).
        candidates: list[_GLMFlash] = []
        center_key = _bucket_key(lat, lon)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                key = (center_key[0] + dy, center_key[1] + dx)
                candidates.extend(self._flashes_by_bucket.get(key, []))
        # Filter by distance + the window.
        nearby = 0
        for flash in candidates:
            if great_circle_km(lat, lon, flash.lat, flash.lon) <= GLM_LOOKUP_RADIUS_KM:
                nearby += 1
        flash_rate_per_min = nearby / max(1.0, self._window_minutes)
        # Convert flashes/min → potential. Saturate at 30 flashes/min
        # (active-storm threshold). Per D5.
        potential = min(1.0, flash_rate_per_min / 30.0)
        # A4: surface granule age in source so operator sees freshness.
        age = self._oldest_granule_age_min
        age_suffix = f"-{age}m" if age is not None else ""
        return LightningSample(
            lightning_potential=potential,
            flash_rate_per_min=flash_rate_per_min,
            sample_time=when,
            source=f"glm{age_suffix}",
        )

    def strongest_cluster_in_annulus(
        self,
        lat: float,
        lon: float,
        inner_km: float = SPRITE_ANNULUS_INNER_KM,
        outer_km: float = SPRITE_ANNULUS_OUTER_KM,
        min_flashes: int = SPRITE_MIN_FLASHES,
    ) -> StrongCluster | None:
        """Sprite-watch (Unit 7): strongest storm cluster in the limb annulus
        [inner_km, outer_km] around (lat, lon) — the ISS sub-point. Reuses
        the prebuilt 5° flash index (zero new I/O). Returns the densest 5°
        bucket's in-annulus flashes as a StrongCluster (flash-weighted
        centroid, distance + true bearing from the sub-point), or None if no
        bucket clears `min_flashes`. Cheap first cut: the sub-point must be
        inside GOES coverage (a non-None result outside it is impossible, and
        the box check avoids scanning when the orbit is over Asia/Pacific).
        """
        if not _in_glm_coverage(lat, lon):
            return None
        # Bucket window sized from the OUTER radius. cos-lat widens the
        # longitude span toward the poles; floor near the equator is fine.
        deg_pad = outer_km / 111.0
        clat, clon = _bucket_key(lat, lon)
        lat_span = int(deg_pad // GLM_SPATIAL_BUCKET_DEG) + 1
        coslat = max(0.2, math.cos(math.radians(lat)))
        lon_span = int((deg_pad / coslat) // GLM_SPATIAL_BUCKET_DEG) + 1

        best_flashes: list[_GLMFlash] | None = None
        best_count = 0
        for by in range(clat - lat_span, clat + lat_span + 1):
            for bx in range(clon - lon_span, clon + lon_span + 1):
                bucket = self._flashes_by_bucket.get((by, bx))
                if not bucket:
                    continue
                in_ann = [
                    f for f in bucket
                    if inner_km <= great_circle_km(lat, lon, f.lat, f.lon) <= outer_km
                ]
                if len(in_ann) >= min_flashes and len(in_ann) > best_count:
                    best_count = len(in_ann)
                    best_flashes = in_ann
        if best_flashes is None:
            return None
        # Flash-weighted centroid (simple mean — clusters are compact within
        # a 5° bucket so a planar mean is adequate for a bearing cue).
        clat_c = sum(f.lat for f in best_flashes) / len(best_flashes)
        clon_c = sum(f.lon for f in best_flashes) / len(best_flashes)
        return StrongCluster(
            distance_km=round(great_circle_km(lat, lon, clat_c, clon_c), 1),
            bearing_deg=round(great_circle_bearing_deg(lat, lon, clat_c, clon_c), 1),
            flash_count=best_count,
        )


# ---------------------------------------------------------------------------
# GFS-CAPE forecast lightning sampler — v1.5.5.0 (weather v1.3.2)
# ---------------------------------------------------------------------------


class GFSCAPELightningSampler:
    """Forecast-side lightning potential from GFS CAPE via Open-Meteo.

    Wraps a `cloud.GFSForecastSampler` constructed with `include_cape=True`.
    Converts CAPE (J/kg) into a 0.0-1.0 lightning_potential using the
    severe-thunderstorm threshold of 2500 J/kg (per D5).

    Use case: when the pass is >20 min in the future (out of GLM
    observation range) OR the target is outside GOES coverage.
    """

    def __init__(self, gfs_sampler: Any):
        # `gfs_sampler` is a cloud.GFSForecastSampler instance built with
        # include_cape=True. We don't import to avoid circular imports.
        self._gfs = gfs_sampler

    def sample(self, lat: float, lon: float, when: datetime) -> LightningSample:
        cape = None
        cape_at = getattr(self._gfs, "cape_at", None)
        if cape_at is not None:
            try:
                cape = cape_at(lat, lon, when)
            except ValueError:
                cape = None
        if cape is None:
            return LightningSample(
                lightning_potential=0.0,
                flash_rate_per_min=0.0,
                sample_time=when,
                source="gfs-cape-no-data",
            )
        # CAPE saturates at 2500 J/kg per D5.
        potential = min(1.0, cape / 2500.0)
        return LightningSample(
            lightning_potential=potential,
            flash_rate_per_min=0.0,  # forecast doesn't predict flash count
            sample_time=when,
            source="gfs-cape",
        )


# ---------------------------------------------------------------------------
# Combined sampler — fuses observed (GLM) + forecast (GFS-CAPE) — v1.5.5.0
# ---------------------------------------------------------------------------


class CombinedLightningSampler:
    """Fuses observed + forecast lightning into a single potential per pass.

    Per /plan-eng-review 2026-05-21 D5 + Q3:
    - `max(observed, forecast * 0.7)` — observed always wins. Forecast
      scaled to 70% to express forecast uncertainty.
    - Observed-zero is REAL DATA ("no lightning observed in 100km radius
      over the last hour"), NOT a missing-source signal. Don't fall back
      to forecast just because observed=0; do fall back when observed
      returns "no-data" / "out-of-coverage" source attributions.
    - Failure cascade (A3 + D7): if BOTH samplers return error states
      (network failure, parse failure, no-data), fall back to placeholder
      (lightning_bonus = 0).

    Attribution:
    - "glm-{N}m" — observed contributed (whether or not forecast also did)
    - "gfs-cape" — only forecast contributed
    - "placeholder" — both samplers had no data
    """

    FORECAST_WEIGHT = 0.7

    def __init__(
        self,
        observed: Any | None = None,
        forecast: Any | None = None,
    ):
        self._observed = observed
        self._forecast = forecast

    def strongest_cluster_in_annulus(
        self, lat: float, lon: float,
    ) -> "StrongCluster | None":
        """Sprite watch (Unit 7): delegate to the observed (GLM) sampler;
        forecast/placeholder samplers have no flash field → None."""
        obs = self._observed
        if obs is not None and hasattr(obs, "strongest_cluster_in_annulus"):
            return obs.strongest_cluster_in_annulus(lat, lon)
        return None

    def sample(self, lat: float, lon: float, when: datetime) -> LightningSample:
        obs: LightningSample | None = None
        fcst: LightningSample | None = None
        if self._observed is not None:
            try:
                obs = self._observed.sample(lat, lon, when)
            except Exception as exc:  # noqa: BLE001
                log.warning("GLM sample failed for (%.2f, %.2f): %s", lat, lon, exc)
        if self._forecast is not None:
            try:
                fcst = self._forecast.sample(lat, lon, when)
            except Exception as exc:  # noqa: BLE001
                log.warning("GFS-CAPE sample failed for (%.2f, %.2f): %s", lat, lon, exc)

        # Determine which samplers contributed REAL data (Q3: distinguish
        # "real zero" from "no data").
        def _has_data(s: LightningSample | None) -> bool:
            if s is None:
                return False
            return not s.source.endswith(("-no-data", "-out-of-coverage"))

        obs_has_data = _has_data(obs)
        fcst_has_data = _has_data(fcst)

        # All failed → placeholder.
        if not obs_has_data and not fcst_has_data:
            return LightningSample(
                lightning_potential=0.0,
                flash_rate_per_min=0.0,
                sample_time=when,
                source="placeholder",
            )

        # Apply fusion rule. Observed always wins when present (D5).
        obs_potential = obs.lightning_potential if obs_has_data else 0.0
        fcst_potential = fcst.lightning_potential if fcst_has_data else 0.0
        combined_potential = max(obs_potential, fcst_potential * self.FORECAST_WEIGHT)

        # Attribution: observed wins; if observed-has-data, source carries
        # its age suffix from GLMSampler (e.g., "glm-45m"). Otherwise fall
        # back to forecast attribution.
        if obs_has_data and obs is not None:
            source = obs.source
            flash_rate = obs.flash_rate_per_min
        elif fcst is not None:
            source = fcst.source
            flash_rate = 0.0
        else:
            source = "placeholder"
            flash_rate = 0.0

        return LightningSample(
            lightning_potential=combined_potential,
            flash_rate_per_min=flash_rate,
            sample_time=when,
            source=source,
        )


def lightning_bonus(potential: float) -> float:
    """Convert a 0.0-1.0 potential into an additive score bonus [0, 30].

    Caller adds this to the existing multiplicative score and caps at 100.
    Per D3: keeps the score_components dict's existing [0,1] convention
    intact — the bonus is its own field on PassEntry, not folded into
    the components.
    """
    clamped = max(0.0, min(1.0, potential))
    return LIGHTNING_BONUS_MAX * clamped


# ---------------------------------------------------------------------------
# Hurricane tracking — NHC CurrentStorms.json
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HurricaneNearby:
    """One named storm within HURRICANE_PROXIMITY_KM of a pass target."""

    name: str  # e.g., "Dorian"
    classification: str  # e.g., "Hurricane Cat 4", "Tropical Storm"
    distance_km: float  # great-circle distance from storm center to target
    nhc_id: str  # NHC storm ID for URL link from the card
    center_lat: float
    center_lon: float


@dataclass(frozen=True)
class _NhcStorm:
    """Normalized view of one NHC active-storm record. Internal."""

    id: str
    name: str
    classification: str
    center_lat: float
    center_lon: float


class NHCHurricaneTracker:
    """Pulls NHC CurrentStorms.json hourly, caches to disk, checks proximity.

    NHC publishes JSON like:
      {"activeStorms": [{"id": "AL052024", "name": "Dorian", "binNumber": ...,
        "classification": "HU", "intensity": "85", "pressure": "956",
        "latitude": "26.5N", "longitude": "78.2W", ...}, ...]}

    We normalize to internal _NhcStorm records (id, name, classification,
    center_lat, center_lon) and check proximity per pass.

    Failure modes:
    - NHC API down → use cached storms (graceful degradation)
    - cache missing too → return empty list (no hurricane tag rendered)
    - parse error → log warning, return empty
    - storm with non-ASCII name → JSON handles UTF-8 natively
    """

    def __init__(self, cache_path: Path, ttl_hours: float = 1.0):
        self._cache_path = cache_path
        self._ttl_hours = ttl_hours
        self._storms: list[_NhcStorm] | None = None
        self._last_fetch: datetime | None = None

    def _fetch_raw(self, now: datetime) -> dict[str, Any] | None:
        """Fetch + cache the NHC JSON. Returns None on hard failure.
        Honors the ttl_hours TTL — uses cached payload if fresh."""
        n = now
        if self._cache_path.exists():
            age_h = (n.timestamp() - self._cache_path.stat().st_mtime) / 3600.0
            if age_h < self._ttl_hours:
                try:
                    return json.loads(self._cache_path.read_text())
                except (json.JSONDecodeError, OSError) as exc:
                    log.warning("NHC cache parse failed: %s; will re-fetch", exc)

        try:
            resp = requests.get(NHC_API_URL, timeout=15)
            resp.raise_for_status()
            payload = resp.json()
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            self._cache_path.write_text(json.dumps(payload))
            return payload
        except Exception as exc:  # noqa: BLE001
            log.warning("NHC fetch failed: %s; falling back to cache", exc)
            if self._cache_path.exists():
                try:
                    return json.loads(self._cache_path.read_text())
                except (json.JSONDecodeError, OSError):
                    return None
            return None

    def _parse(self, payload: dict[str, Any]) -> list[_NhcStorm]:
        """Normalize NHC payload into _NhcStorm list. Drops malformed rows."""
        out: list[_NhcStorm] = []
        active = payload.get("activeStorms")
        if not isinstance(active, list):
            return out
        for raw in active:
            if not isinstance(raw, dict):
                continue
            try:
                storm = _parse_one_storm(raw)
                if storm is not None:
                    out.append(storm)
            except (KeyError, ValueError, TypeError) as exc:
                log.warning("NHC storm parse skipped (%s): %r", exc, raw.get("id"))
        return out

    def refresh(self, now: datetime | None = None) -> None:
        """Force a refresh of the in-memory storm list. Called once per
        run_tick. After this, check_proximity uses the cached parse."""
        n = now or datetime.now(tz=UTC)
        payload = self._fetch_raw(n)
        if payload is None:
            self._storms = []
            return
        self._storms = self._parse(payload)
        self._last_fetch = n
        if self._storms:
            log.info(
                "NHC: %d active named storms (%s)",
                len(self._storms),
                ", ".join(f"{s.name} ({s.classification})" for s in self._storms),
            )

    def check_proximity(
        self,
        lat: float,
        lon: float,
        max_distance_km: float = HURRICANE_PROXIMITY_KM,
    ) -> HurricaneNearby | None:
        """Closest named storm within max_distance_km of (lat, lon), or
        None if no storm qualifies. Picks the closest if multiple match."""
        if not self._storms:
            return None
        best: HurricaneNearby | None = None
        for s in self._storms:
            d = great_circle_km(lat, lon, s.center_lat, s.center_lon)
            if d > max_distance_km:
                continue
            if best is None or d < best.distance_km:
                best = HurricaneNearby(
                    name=s.name,
                    classification=s.classification,
                    distance_km=d,
                    nhc_id=s.id,
                    center_lat=s.center_lat,
                    center_lon=s.center_lon,
                )
        return best


# ---------------------------------------------------------------------------
# NHC storm parsing helpers
# ---------------------------------------------------------------------------


# NHC uses one-letter classification codes in the JSON. Expand to human labels.
_NHC_CLASSIFICATION_LABELS = {
    "HU": "Hurricane",
    "TS": "Tropical Storm",
    "TD": "Tropical Depression",
    "MH": "Major Hurricane",  # NHC sometimes uses this for Cat 3+
    "PT": "Post-Tropical",
    "PC": "Potential",
    "STS": "Subtropical Storm",
    "STD": "Subtropical Depression",
}


def _parse_one_storm(raw: dict[str, Any]) -> _NhcStorm | None:
    """Parse one NHC activeStorms[] entry into _NhcStorm.

    Returns None on any missing required field. Required:
    - id (storm ID like 'AL052024')
    - name
    - latitude / longitude (NHC publishes as e.g., '26.5N', '78.2W')
    - classification (one-letter code)

    For hurricanes, NHC sometimes publishes an `intensity` field (max
    wind speed in knots); we use it to add the Saffir-Simpson category
    (Cat 1-5) to the label when intensity is present and parseable.
    """
    storm_id = raw.get("id")
    name = raw.get("name")
    lat_raw = raw.get("latitude") or raw.get("latitudeNumeric")
    lon_raw = raw.get("longitude") or raw.get("longitudeNumeric")
    cls_code = raw.get("classification", "").upper()
    if not (storm_id and name and lat_raw is not None and lon_raw is not None):
        return None

    lat = _parse_lat_lon(lat_raw, ("N", "S"))
    lon = _parse_lat_lon(lon_raw, ("E", "W"))
    if lat is None or lon is None:
        return None

    base_label = _NHC_CLASSIFICATION_LABELS.get(cls_code, cls_code or "Storm")
    classification = base_label
    if cls_code == "HU":
        intensity_kt = _try_int(raw.get("intensity"))
        if intensity_kt is not None:
            cat = _saffir_simpson_category(intensity_kt)
            classification = f"Hurricane Cat {cat}"

    return _NhcStorm(
        id=str(storm_id),
        name=str(name),
        classification=classification,
        center_lat=lat,
        center_lon=lon,
    )


def _parse_lat_lon(raw: Any, suffixes: tuple[str, str]) -> float | None:
    """NHC encodes coordinates as e.g., '26.5N' or '78.2W'. Some endpoints
    provide a numeric alternative. Accept both."""
    if isinstance(raw, (int, float)):
        return float(raw)
    if not isinstance(raw, str):
        return None
    text = raw.strip().upper()
    if not text:
        return None
    sign = 1.0
    if text.endswith(suffixes[0]):
        text = text[: -len(suffixes[0])]
    elif text.endswith(suffixes[1]):
        text = text[: -len(suffixes[1])]
        sign = -1.0
    try:
        return float(text) * sign
    except ValueError:
        return None


def _try_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _saffir_simpson_category(wind_knots: int) -> int:
    """Saffir-Simpson hurricane scale, max-sustained-wind in knots."""
    if wind_knots < 64:
        return 0  # tropical storm strength
    if wind_knots < 83:
        return 1
    if wind_knots < 96:
        return 2
    if wind_knots < 113:
        return 3
    if wind_knots < 137:
        return 4
    return 5
