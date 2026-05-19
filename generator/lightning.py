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

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import requests

from .orbit import great_circle_km

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
