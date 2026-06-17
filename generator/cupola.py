"""Cupola keepsake-window finder (Loral 2026-06-15).

Finds the next handful of moments where a floating trinket in the Cupola has a
clear, bright Earth behind it. A "good window" is Loral's LOCKED spec, three
hard gates (no score blending):

  1. DAYLIT nadir (solar zenith < 70° — daylight only, no night/terminator).
  2. Cloud cover <= 30% at nadir (less is always better → ranked lowest-first).
  3. A LAND + OCEAN MIX in the keepsake-backdrop footprint (not open ocean, not
     all land) — a 25-point disc on the GSHHG water mask, 20–80% water.

Golden hour is a BONUS tag only, never a gate ("any type of day is good").

Design + adversarially verified by a multi-agent pass (2026-06-15): the disc
geometry was empirically checked against the committed GSHHG mask (9/9 coasts
accept; open ocean / interiors / island-specks reject), and the forecast cache
pre-pass below is load-bearing — without it every off-curated track cell returns
the cf=50 placeholder and the finder emits zero windows while looking healthy.

numpy/math-only on the tick; the only network is forecast_sampler.add_targets
(additive, batched). Flag-gated (OPD_ENABLE_CUPOLA_WINDOWS) + byte-stable.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Callable

from .ascent import _destination_along_bearing
from .cloud import lighting_regime, sun_subpoint
from .manifest import utcnow_iso
from .orbit import TLE, propagate

# --- window-scoring constants (Loral spec; tunable in soak) -----------------
CLOUD_MAX_PCT = 30.0          # hard cap; less is better
MIX_WATER_FLOOR = 0.20        # need >=20% water AND >=20% land in the disc
MIX_WATER_CEIL = 0.80
DISC_INNER_KM = 110.0         # 0.5R ring
DISC_OUTER_KM = 220.0         # 1.0R ring — ~27.6° off-nadir at 420km (Cupola FOV)
DISC_BEARINGS = tuple(range(0, 360, 30))  # 12 spokes
# The sub-point moves ~7.7 km/s, so a coastline "mix" is a brief moment. At 20s
# cadence (~154 km/sample, well inside the 220 km disc) a real crossing spans
# 2-4 samples; MIN_RUN=2 keeps those (≥40s of verified-good geometry) and drops
# single-sample flickers. (Empirically calibrated 2026-06-15: 60s/MIN_RUN=3 —
# the original design defaults — found ZERO windows because mix moments rarely
# persist 3 coarse samples.)
MIN_RUN_SAMPLES = 2
MAX_WINDOWS = 8
GOLDEN_ZENITH_LO = 80.0       # bonus tag band (low, warm sun) — never gates
GOLDEN_ZENITH_HI = 96.0
DAYLIT_CELL_CAP = 1500        # defensive cap on add_targets pre-pass cells

# Coarse region boxes for the card title (cosmetic — never a gate). First
# containing box wins; (name, lat_min, lat_max, lon_min, lon_max). Ordered
# specific seas → continents → ocean basins → polar zones, and the basins +
# poles tile the whole globe so a window never falls through to the generic
# fallback (operator feedback 2026-06-16: some windows showed "land").
_REGION_BOXES: tuple[tuple[str, float, float, float, float], ...] = (
    # Specific named waters (small — checked first for the nicest label;
    # the smaller/enclosed seas precede the basins they overlap).
    ("the Black Sea", 40.0, 48.0, 27.0, 42.0),
    ("the Mediterranean", 30.0, 46.0, -6.0, 37.0),
    ("the Red Sea", 12.0, 30.0, 32.0, 44.0),
    ("the Persian Gulf", 23.0, 31.0, 47.0, 57.0),
    ("the Caribbean", 8.0, 27.0, -90.0, -59.0),
    ("the Gulf of Mexico", 18.0, 31.0, -98.0, -80.0),
    ("the North Sea & Baltic", 50.0, 66.0, -5.0, 31.0),
    ("the Great Lakes", 41.0, 49.0, -93.0, -76.0),
    ("the Bay of Bengal", 5.0, 23.0, 80.0, 95.0),
    ("the South China Sea", 0.0, 23.0, 105.0, 122.0),
    ("the Sea of Japan", 33.0, 52.0, 127.0, 143.0),
    # Continents / land regions.
    ("North America", 15.0, 72.0, -168.0, -52.0),
    ("South America", -56.0, 15.0, -82.0, -34.0),
    ("Europe", 36.0, 71.0, -10.0, 40.0),
    ("Africa", -35.0, 37.0, -18.0, 52.0),
    ("the Middle East", 12.0, 40.0, 34.0, 63.0),
    ("Southeast Asia", -11.0, 28.0, 92.0, 141.0),
    ("Australia", -44.0, -10.0, 112.0, 154.0),
    ("New Zealand", -48.0, -33.0, 165.0, 179.0),
    ("Greenland", 59.0, 84.0, -73.0, -11.0),
    ("Asia", 5.0, 80.0, 40.0, 150.0),
    # Polar zones — all longitudes (guarantee coverage at the caps).
    ("the Arctic", 66.0, 90.0, -180.0, 180.0),
    ("the Southern Ocean", -90.0, -55.0, -180.0, 180.0),
    # Ocean basins — broad, generously overlapping so lat -55..66 is fully
    # tiled across all longitudes (the last-resort layer for offshore peaks).
    ("the North Atlantic", 0.0, 66.0, -80.0, 5.0),
    ("the South Atlantic", -55.0, 0.0, -70.0, 20.0),
    ("the Indian Ocean", -55.0, 30.0, 20.0, 122.0),
    ("the North Pacific", 0.0, 66.0, 105.0, 180.0),
    ("the North Pacific", 0.0, 66.0, -180.0, -70.0),
    ("the South Pacific", -55.0, 0.0, 118.0, 180.0),
    ("the South Pacific", -55.0, 0.0, -180.0, -68.0),
)


def _solar_zenith_deg(sun_lat: float, sun_lon: float, lat: float, lon: float) -> float:
    """Solar zenith angle (deg) at (lat,lon) — same math as lighting_regime."""
    rl_t = math.radians(lat)
    rl_s = math.radians(sun_lat)
    dl = math.radians(lon - sun_lon)
    cos_z = math.sin(rl_t) * math.sin(rl_s) + math.cos(rl_t) * math.cos(rl_s) * math.cos(dl)
    return math.degrees(math.acos(max(-1.0, min(1.0, cos_z))))


def _disc_water_fraction(lat: float, lon: float, water_mask: Callable[[float, float], bool]) -> float:
    """Fraction of the 25-point keepsake-backdrop disc that is water (0..1)."""
    points = [(lat, lon)]
    for bearing in DISC_BEARINGS:
        points.append(_destination_along_bearing(lat, lon, bearing, DISC_INNER_KM))
        points.append(_destination_along_bearing(lat, lon, bearing, DISC_OUTER_KM))
    water = sum(1 for (la, lo) in points if water_mask(la, lo))
    return water / len(points)


def _region_label(lat: float, lon: float, is_water: bool) -> str:
    for name, lat_min, lat_max, lon_min, lon_max in _REGION_BOXES:
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return name
    # The boxes tile the globe, so this is a defensive backstop only — never
    # a bare "land". Pick a graceful zone from latitude.
    if lat >= 60.0:
        return "the far north"
    if lat <= -60.0:
        return "the far south"
    return "the open ocean" if is_water else "a remote coast"


def _build_window(run: list[dict[str, Any]]) -> dict[str, Any]:
    """Build one PassEntry-compatible window dict from a run of good samples."""
    # Peak = lowest cloud; ties → most balanced mix; final tie → earliest.
    peak = min(run, key=lambda s: (s["cloud"], abs(s["water_frac"] - 0.5), s["t"]))
    cf = round(peak["cloud"], 1)
    water_pct = round(peak["water_frac"] * 100.0, 1)
    lat = round(peak["lat"], 3)
    lon = round(peak["lon"], 3)
    label = _region_label(lat, lon, peak["water_frac"] >= 0.5)
    peak_iso = utcnow_iso(peak["when"])
    # Stable id: peak time floored to the minute absorbs sub-minute TLE jitter.
    id_min = peak["when"].replace(second=0, microsecond=0)
    id_stamp = id_min.strftime("%Y-%m-%dT%H:%MZ")
    return {
        "target_id": f"cupola:{id_stamp}",
        "target_name": f"Keepsake — {label}",
        # Daylit-only region window; synthesize the fields the card + breakdown
        # panel read so nothing renders "undefined"/"NaN" (verifier note).
        "target_regime": "day",
        "target_priority": 5,
        "target_lat": lat,
        "target_lon": lon,
        "closest_approach": peak_iso,
        "pass_regime": "day",
        "obstruction_class": "clear" if cf <= 15.0 else "cloudy",
        "cloud_fraction": cf,
        "cloud_source": "gfs-forecast",
        "sample_time": peak_iso,
        "nadir_distance_km": 0.0,  # the peak IS the sub-point
        "score": round(100.0 - cf, 1),
        "p_unobstructed": round(1.0 - cf / 100.0, 2),
        "score_components": {
            "p_unobstructed": round(100.0 * (1.0 - cf / 100.0), 1),
            "regime_fit": 100.0,
            "nadir_proximity": 100.0,
            "priority_weight": 100.0,
            "tle_freshness": 1.0,
        },
        "iss_at_closest": {
            "lat": lat,
            "lon": lon,
            "alt_km": round(peak["alt"], 3),
        },
        "window_start": utcnow_iso(run[0]["when"]),
        "window_end": utcnow_iso(run[-1]["when"]),
        "golden_hour": bool(peak["golden"]),
        "water_pct": water_pct,
    }


def find_cupola_windows(
    tle: TLE,
    n: datetime,
    *,
    forecast_sampler: Any,
    water_mask_obj: Callable[[float, float], bool],
    minutes: int = 2160,
    step_seconds: int = 20,
) -> list[dict[str, Any]]:
    """Sweep the ISS sub-point over `minutes` and return up to MAX_WINDOWS
    good Cupola windows (lowest-cloud first), each a PassEntry-compatible dict.
    """
    # --- single propagation pass: sub-point + sun + day gate per sample ------
    samples: list[dict[str, Any]] = []
    steps = int(minutes * 60 / step_seconds)
    for i in range(steps + 1):
        when = n + timedelta(seconds=i * step_seconds)
        pos = propagate(tle, when)
        sun_lat, sun_lon = sun_subpoint(when)
        zenith = _solar_zenith_deg(sun_lat, sun_lon, pos.lat, pos.lon)
        day = zenith < 70.0
        # The land/ocean-MIX gate is a cheap LOCAL water-mask disc (no network),
        # so evaluate it HERE for daylit samples. The forecast pre-pass below
        # then seeds ONLY the daylit *coastline* cells, not the whole daylit
        # track. (429 fix 2026-06-16: seeding all ~1500 daylit cells/tick
        # rate-limited Open-Meteo to 0 windows; the mix gate cuts it ~15-30x.)
        water_frac = _disc_water_fraction(pos.lat, pos.lon, water_mask_obj) if day else 0.0
        mix = day and MIX_WATER_FLOOR <= water_frac <= MIX_WATER_CEIL
        samples.append({
            "t": i,
            "when": when,
            "lat": pos.lat,
            "lon": pos.lon,
            "alt": pos.alt_km,
            "zenith": zenith,
            "day": day,
            "water_frac": water_frac,
            "mix": mix,
            "golden": GOLDEN_ZENITH_LO <= zenith <= GOLDEN_ZENITH_HI,
        })

    # --- load-bearing pre-pass: seed the forecast cache for the daylit
    # COASTLINE cells only (samples already past the cheap daylit + mix gates).
    # Without seeding, off-curated cells return the cf=50 placeholder → 0
    # windows; seeding the WHOLE daylit track rate-limited Open-Meteo (429s),
    # so we seed only the mix cells — a small fraction. add_targets is additive.
    if hasattr(forecast_sampler, "add_targets"):
        seen: set[tuple[float, float]] = set()
        cells: list[tuple[float, float]] = []
        for s in samples:
            if not s["mix"]:
                continue
            cell = (round(s["lat"] * 4) / 4, round(s["lon"] * 4) / 4)
            if cell not in seen:
                seen.add(cell)
                cells.append(cell)
                if len(cells) >= DAYLIT_CELL_CAP:
                    break
        if cells:
            forecast_sampler.add_targets(cells)

    # --- score each daylit+mix sample on cloud<=30% (water_frac already set) --
    for s in samples:
        good = False
        if s["mix"]:
            cs = forecast_sampler.sample(s["lat"], s["lon"], s["when"])
            if cs.source == "gfs-forecast" and cs.cloud_fraction <= CLOUD_MAX_PCT:
                good = True
                s["cloud"] = float(cs.cloud_fraction)
        s["good"] = good

    # --- segment consecutive good samples into windows -----------------------
    windows: list[dict[str, Any]] = []
    run: list[dict[str, Any]] = []
    for s in samples:
        if s["good"]:
            run.append(s)
        else:
            if len(run) >= MIN_RUN_SAMPLES:
                windows.append(_build_window(run))
            run = []
    if len(run) >= MIN_RUN_SAMPLES:
        windows.append(_build_window(run))

    # --- rank lowest-cloud-first, cap ----------------------------------------
    windows.sort(key=lambda w: (w["cloud_fraction"], w["closest_approach"]))
    return windows[:MAX_WINDOWS]
