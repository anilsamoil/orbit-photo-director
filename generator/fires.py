"""Wildfire hotspot sampler backed by NASA FIRMS active-fire detections.

Fires and their smoke plumes are classic ISS photo targets (Pettit's guide has
a whole recipe family). This gives cards a 🔥 tag when a pass overflies a
significant active fire complex — same operator pattern as the ⚡ GLM tag.

Source: FIRMS public MODIS C6.1 global 24-hour CSV (no API key, ~1 MB,
~10-15k rows, refreshed continuously):
  https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv
Columns: latitude, longitude, brightness, scan, track, acq_date, acq_time,
satellite, confidence (0-100), version, bright_t31, frp (MW), daynight.

MODIS over VIIRS deliberately: 1 MB vs ~6 MB per fetch, and for "big
photographable fire complex" the coarser sensor is plenty — we THRESHOLD
aggressively anyway (see below), per the standing "don't make it busy" rule.

Resilience model (mirrors NHCHurricaneTracker):
- Disk cache with TTL; network failure falls back to the last good cache.
- Construction NEVER raises for network/parse trouble — an unusable feed just
  means an empty index, and lookup() returns None (no tag), never a crash.
- Fetches through the shared pooled keep-alive session (generator.netpool).

Spatial model (mirrors GLMSampler): detections bucketed into 5-degree
lat/lon cells; a 100 km lookup radius touches at most 4 adjacent cells.
"""

from __future__ import annotations

import csv
import io
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .orbit import great_circle_km

log = logging.getLogger(__name__)

FIRMS_CSV_URL = (
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/"
    "modis-c6.1/csv/MODIS_C6_1_Global_24h.csv"
)
FIRMS_FETCH_TIMEOUT_SECONDS = 30
# Refresh hourly — the 24h product updates continuously but a tick is hourly.
FIRMS_CACHE_TTL_HOURS = 1.0

# ── Significance thresholds ("don't make it busy") ────────────────────────
# A card only gets the 🔥 tag when the overflown activity is a genuinely
# photographable complex, not a lone agricultural burn:
#   - detection quality: MODIS confidence >= 60 (nominal-high band), AND
#   - cluster: >= FIRE_MIN_DETECTIONS detections within the lookup radius
#     AND the hottest one >= FIRE_MIN_CLUSTER_FRP_MW (a real fire front,
#     not three trash burns), OR
#   - solo: one detection with FRP >= FIRE_MIN_SOLO_FRP_MW.
# FRP = fire radiative power in megawatts. Calibrated against live FIRMS
# data on first deploy (2026-07-02): count-only clustering tagged "Chicago
# IL: 3 fires, max 20.6 MW" — urban heat noise, not a plume. Real wildfire
# fronts run 100s-1000s of MW. SOAK-TUNABLE the same way SPRITE_MIN_FLASHES
# is: raise if noisy, lower if mute.
FIRE_MIN_CONFIDENCE = 60
FIRE_MIN_DETECTIONS = 3
FIRE_MIN_CLUSTER_FRP_MW = 50.0
FIRE_MIN_SOLO_FRP_MW = 200.0
FIRE_LOOKUP_RADIUS_KM = 100.0

# 5° buckets: identical geometry to lightning.GLM_SPATIAL_BUCKET_DEG — a
# 100 km radius always lands within at most 4 adjacent buckets.
FIRE_SPATIAL_BUCKET_DEG = 5.0


@dataclass(frozen=True)
class FireActivity:
    """Significant active-fire cluster near a target at lookup time."""

    count: int          # qualifying detections within the radius
    max_frp_mw: float   # hottest single detection (MW)
    nearest_km: float   # distance from target to nearest detection


def _bucket_key(lat: float, lon: float) -> tuple[int, int]:
    return (
        int(lat // FIRE_SPATIAL_BUCKET_DEG),
        int(lon // FIRE_SPATIAL_BUCKET_DEG),
    )


def _parse_firms_csv(text: str) -> list[tuple[float, float, float]]:
    """Parse FIRMS CSV → [(lat, lon, frp_mw)] for confident detections.

    Malformed rows are skipped silently — the feed occasionally carries
    truncated last lines. An entirely unparseable body returns [].
    """
    out: list[tuple[float, float, float]] = []
    try:
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            try:
                confidence = float(row.get("confidence") or 0)
                if confidence < FIRE_MIN_CONFIDENCE:
                    continue
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                frp = float(row.get("frp") or 0.0)
            except (TypeError, ValueError, KeyError):
                continue
            if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                continue
            out.append((lat, lon, frp))
    except Exception as exc:  # noqa: BLE001 - a broken feed must not kill the tick
        log.warning("FIRMS CSV parse failed: %s", exc)
        return []
    return out


class FIRMSFireSampler:
    """Per-tick active-fire index with disk-cache fallback.

    `fetcher` is an optional callable for tests; defaults to the pooled
    keep-alive session (generator.netpool.get_session).
    """

    def __init__(
        self,
        cache_path: Path,
        ttl_hours: float = FIRMS_CACHE_TTL_HOURS,
        fetcher: Any | None = None,
    ):
        self._cache_path = cache_path
        self._ttl_hours = ttl_hours
        self._by_bucket: dict[tuple[int, int], list[tuple[float, float, float]]] = {}
        self.source_detections = 0

        text = self._load_csv_text(fetcher)
        detections = _parse_firms_csv(text) if text else []
        for lat, lon, frp in detections:
            self._by_bucket.setdefault(_bucket_key(lat, lon), []).append(
                (lat, lon, frp)
            )
        self.source_detections = len(detections)
        log.info(
            "FIRMS fire index built: %d confident detections in %d buckets",
            self.source_detections,
            len(self._by_bucket),
        )

    def _load_csv_text(self, fetcher: Any | None) -> str:
        """Fresh cache → use it. Else fetch (write cache on success). Any
        network failure falls back to a stale cache rather than raising —
        day-old fire data still marks the big complexes."""
        cache = self._cache_path
        if cache.exists():
            age_h = (time.time() - cache.stat().st_mtime) / 3600.0
            if age_h < self._ttl_hours:
                try:
                    return cache.read_text()
                except OSError as exc:
                    log.warning("FIRMS cache read failed: %s; refetching", exc)

        if fetcher is None:
            def _default_fetch(url: str) -> str:
                from .netpool import get_session

                resp = get_session().get(url, timeout=FIRMS_FETCH_TIMEOUT_SECONDS)
                resp.raise_for_status()
                return resp.text

            fetcher = _default_fetch

        try:
            text = fetcher(FIRMS_CSV_URL)
            # Sanity: a real payload starts with the CSV header. An HTML error
            # page captured as 200 must not overwrite a good cache (the
            # fetch_tle / LL2 never-cache-garbage pattern).
            if not text.lstrip().lower().startswith("latitude"):
                raise ValueError("FIRMS payload does not look like the CSV")
            try:
                self._cache_path.parent.mkdir(parents=True, exist_ok=True)
                self._cache_path.write_text(text)
            except OSError as exc:
                log.warning("FIRMS cache write failed: %s", exc)
            return text
        except Exception as exc:  # noqa: BLE001
            log.warning("FIRMS fetch failed (%s); falling back to cache", exc)
            if cache.exists():
                try:
                    return cache.read_text()
                except OSError:
                    pass
            return ""

    def lookup(
        self, lat: float, lon: float, radius_km: float = FIRE_LOOKUP_RADIUS_KM
    ) -> FireActivity | None:
        """Return significant fire activity within radius_km, else None."""
        if not self._by_bucket:
            return None
        base_i, base_j = _bucket_key(lat, lon)
        count = 0
        max_frp = 0.0
        nearest = float("inf")
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for flat, flon, frp in self._by_bucket.get(
                    (base_i + di, base_j + dj), []
                ):
                    d = great_circle_km(lat, lon, flat, flon)
                    if d <= radius_km:
                        count += 1
                        max_frp = max(max_frp, frp)
                        nearest = min(nearest, d)
        if count == 0:
            return None
        is_hot_cluster = (
            count >= FIRE_MIN_DETECTIONS and max_frp >= FIRE_MIN_CLUSTER_FRP_MW
        )
        is_hot_solo = max_frp >= FIRE_MIN_SOLO_FRP_MW
        if not (is_hot_cluster or is_hot_solo):
            return None  # below the "photographable complex" bar
        return FireActivity(
            count=count, max_frp_mw=round(max_frp, 1), nearest_km=round(nearest, 1)
        )
