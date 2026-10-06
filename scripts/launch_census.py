#!/usr/bin/env python3
"""Replay a saved launch feed and print a census. No fetch and no publish."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from sgp4.api import Satrec, jday

from generator.ascent import (
    SunState,
    _surface_sun_elevation_deg,
    apparent_plume_angle_mrad,
    plume_angle_score,
    rocket_position_at,
    rocket_sun_state,
    slant_range_km,
    tangent_clearance,
)
from generator.ascent_profiles import match_rocket
from generator.launch_data import parse_response
from generator.launch_evidence import build_launch_artifact
from generator.orbit import TLE, _gmst_rad, great_circle_km, propagate

FIXTURE_DIR = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "launch_census"
HORIZON_14_DAYS = 14 * 24 * 3600
MAP_HORIZON = timedelta(days=7)
UPCOMING_HORIZON = timedelta(hours=36)
SCHEDULE_FRESH = timedelta(hours=3)
G1_STATUS = frozenset({"Go", "Confirmed", "TBC"})
G1_PRECISION = frozenset({"second", "minute", "hour"})
SLANT_CAP_KM = 3500.0
SHOT_TLE_AGE_H = 24.0
LIKELY_TLE_AGE_H = 48.0
SHOT_SCORE = 40
LIKELY_SCORE = 25
ISS_BOUND_NAMES = (
    "Dragon",
    "Crew-",
    "Cygnus",
    "Progress",
    "Soyuz MS",
    "HTV",
    "Starliner",
    "Dream Chaser",
)
RESEARCH_RULE = (
    "research-only, uncalibrated. "
    "Shot needs TLE age at NET of 24 h or less, status Go or Confirmed, "
    "precision second or minute, line of sight inside 3500 km, "
    "point score at least 40, and samples that cover plus or minus 2 sigma. "
    "Likely needs TLE age of 48 h or less, line of sight inside 3500 km, "
    "and point score at least 25. "
    "Hour precision and TBC stop at watch. "
    "night_engine counts. "
    "A miss with TLE age over 24 h is watch, not none. "
    "Score weights are the prototype solver's guesses."
)
TierName = Literal["shot", "likely", "watch", "unassessed", "none"]
ViewName = Literal["map", "upcoming"]


@dataclass(frozen=True)
class TierCounts:
    shot: int
    likely: int
    watch: int
    unassessed: int
    none: int

    def as_dict(self) -> dict[str, int]:
        return {
            "shot": self.shot,
            "likely": self.likely,
            "watch": self.watch,
            "unassessed": self.unassessed,
            "none": self.none,
        }


@dataclass(frozen=True)
class Census:
    rows_received: int
    rows_in_14_days: int
    g1_pass: int
    shown_map: int
    shown_upcoming: int
    shown_iss: int
    tiers: TierCounts
    research_rule: str


@dataclass(frozen=True)
class PadSample:
    name: str
    lat: float
    lon: float
    azimuth_deg: float


@dataclass(frozen=True)
class PadRate:
    name: str
    samples: int
    line_of_sight: int
    slant_under_1500: int
    slant_under_1000: int


STANDIN_AZIMUTH_PADS = (
    PadSample("Cape Canaveral 28.6N", 28.56, -80.58, 45.0),
    PadSample("Vandenberg 34.6N", 34.63, -120.61, 190.0),
    PadSample("Baikonur 46.0N", 45.99, 63.56, 62.0),
    PadSample("Wenchang 19.6N", 19.6, 110.94, 100.0),
    PadSample("Kourou 5.3N", 5.26, -52.79, 90.0),
    PadSample("Mahia 39.3S", -39.26, 177.86, 90.0),
)


def tle_checksum_digit(line: str) -> int:
    if len(line) < 69:
        raise ValueError("TLE line is shorter than 69 characters")
    total = 0
    for char in line[:68]:
        if char.isdigit():
            total += int(char)
        elif char == "-":
            total += 1
    return total % 10


def load_replay(fixture_dir: Path) -> tuple[dict, TLE, datetime]:
    raw = (fixture_dir / "launches.json").read_bytes()
    receipt = json.loads((fixture_dir / "launches.json.receipt.json").read_text())
    digest = hashlib.sha256(raw).hexdigest()
    if digest != receipt["sha256"]:
        raise ValueError("launch feed sha256 does not match the receipt")
    fetched_at = datetime.fromisoformat(receipt["fetched_at"])
    if fetched_at.tzinfo is None or fetched_at.utcoffset() != timedelta(0):
        raise ValueError("receipt fetched_at must be UTC")
    tle_text = (fixture_dir / "iss.tle").read_text()
    for line in tle_text.strip().splitlines():
        if str(tle_checksum_digit(line)) != line[-1]:
            raise ValueError("TLE checksum does not match")
    return json.loads(raw), TLE.from_text(tle_text), fetched_at


def _stamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        return None
    return parsed


def _schedule_fresh(artifact: dict, now: datetime) -> bool:
    generated = _stamp(artifact["generated_at"])
    if generated is None or generated > now:
        return False
    reasons = artifact["coverage"]["reasons"]
    blocked = {"SOURCE_AGE_UNKNOWN", "SOURCE_AGE_MTIME_ONLY", "REPLAY_SOURCE_MISMATCH"}
    if any(reason in blocked for reason in reasons):
        return False

    def recent(value: str | None) -> bool:
        fetched = _stamp(value)
        if fetched is None or generated is None:
            return False
        return fetched <= generated and (now - fetched) < SCHEDULE_FRESH

    if not recent(artifact["coverage"]["fetched_at"]):
        return False
    for item in artifact["items"]:
        sources = item["sources"]
        if not sources or not all(recent(source["fetched_at"]) for source in sources):
            return False
    return True


def _candidate(artifact: dict, item: dict, now: datetime, view: ViewName) -> dict | None:
    start = _stamp(item["launch_window"]["net"])
    if "TIME_CONFLICT" in item["reason_codes"]:
        end = start
    else:
        end = _stamp(item["launch_window"]["end"]) or start
    coverage_from = _stamp(artifact["coverage"]["from"])
    coverage_until = _stamp(artifact["coverage"]["until"])
    if start is None or end is None or coverage_from is None or coverage_until is None:
        return None
    horizon = MAP_HORIZON if view == "map" else UPCOMING_HORIZON
    if end < coverage_from or start > coverage_until or start > now + horizon:
        return None
    expired = end <= now
    if expired and (view != "upcoming" or now - end >= timedelta(minutes=30)):
        return None
    return {"item": item, "expired": expired}


def _is_chance(artifact: dict, candidate: dict, now: datetime) -> bool:
    if candidate["expired"] or not _schedule_fresh(artifact, now):
        return False
    item = candidate["item"]
    if "TIME_CONFLICT" in item["reason_codes"] or "LAUNCH_UNCONFIRMED" in item["reason_codes"]:
        return False
    precision = (item["launch_window"].get("precision") or "").lower()
    if precision in {"day", "month", "year"}:
        return False
    assessment = item.get("assessment")
    if not assessment:
        return False
    checked = _stamp(assessment["checked_at"])
    valid_until = _stamp(assessment["valid_until"])
    net_at = _stamp(assessment["net"]["at"])
    if checked is None or valid_until is None or net_at is None:
        return False
    if not (checked <= now < valid_until):
        return False
    if assessment["window"]["verdict"] == "too_far" or net_at < now:
        return False
    look = assessment["net"].get("look")
    return assessment["net"]["verdict"] == "possible" and look is not None


def shown_launch_ids(artifact: dict, now: datetime, view: ViewName) -> tuple[str, ...]:
    """Chance ids for one view."""
    chosen: list[tuple[datetime, str]] = []
    for item in artifact["items"]:
        candidate = _candidate(artifact, item, now, view)
        if candidate is None or not _is_chance(artifact, candidate, now):
            continue
        start = _stamp(item["launch_window"]["net"])
        if start is None:
            continue
        chosen.append((start, item["event_id"]))
    chosen.sort(key=lambda pair: (pair[0], pair[1]))
    return tuple(event_id for _, event_id in chosen)


def _g1(launch) -> bool:
    precision = (launch.time_precision or "").lower()
    return launch.status_abbrev in G1_STATUS and precision in G1_PRECISION


def _sigma_km(age_h: float) -> float:
    days = max(0.0, age_h) / 24.0
    return 1.0 + 2.0 * days**1.5


def _iss_plane_azimuth(tle: TLE, when: datetime, lat: float, lon: float) -> tuple[float, float]:
    sat = Satrec.twoline2rv(tle.line1, tle.line2)
    jd, fraction = jday(
        when.year,
        when.month,
        when.day,
        when.hour,
        when.minute,
        when.second + when.microsecond / 1e6,
    )
    error, position, velocity = sat.sgp4(jd, fraction)
    if error != 0:
        raise ValueError("SGP4 error while deriving an ISS-plane azimuth")
    rx, ry, rz = position
    vx, vy, vz = velocity
    hx = ry * vz - rz * vy
    hy = rz * vx - rx * vz
    hz = rx * vy - ry * vx
    norm = math.sqrt(hx * hx + hy * hy + hz * hz)
    hx, hy, hz = hx / norm, hy / norm, hz / norm
    gmst = _gmst_rad(when)
    lat_r = math.radians(lat)
    lon_r = math.radians(lon + math.degrees(gmst))
    px = math.cos(lat_r) * math.cos(lon_r)
    py = math.cos(lat_r) * math.sin(lon_r)
    pz = math.sin(lat_r)
    off_plane = math.degrees(math.asin(max(-1.0, min(1.0, hx * px + hy * py + hz * pz))))
    dx = hy * pz - hz * py
    dy = hz * px - hx * pz
    dz = hx * py - hy * px
    east = (-math.sin(lon_r), math.cos(lon_r), 0.0)
    north = (
        -math.sin(lat_r) * math.cos(lon_r),
        -math.sin(lat_r) * math.sin(lon_r),
        math.cos(lat_r),
    )
    azimuth = math.degrees(
        math.atan2(
            dx * east[0] + dy * east[1] + dz * east[2],
            dx * north[0] + dy * north[1] + dz * north[2],
        )
    ) % 360.0
    return azimuth, off_plane


def research_tier(launch, tle: TLE) -> TierName:
    """Prototype tier. Not a product verdict."""
    if not _g1(launch):
        return "unassessed"
    age_h = abs((launch.t0 - tle.epoch).total_seconds()) / 3600.0
    profile = match_rocket({"full_name": launch.rocket_type})
    azimuth = None
    trajectory = "none"
    if any(name in launch.name for name in ISS_BOUND_NAMES):
        try:
            azimuth, off_plane = _iss_plane_azimuth(
                tle, launch.t0, launch.site_lat, launch.site_lon
            )
        except (ValueError, RuntimeError, ArithmeticError):
            azimuth = None
        else:
            if abs(off_plane) < 1.5:
                trajectory = "iss_plane"
    best_score = None
    hits = 0
    for offset in range(-300, 601, 15):
        when = launch.t0 + timedelta(seconds=offset)
        iss = propagate(tle, when)
        if offset <= 0 or trajectory == "none" or profile is None or azimuth is None:
            altitude = 0.0 if offset <= 0 else 50.0
            target = (launch.site_lat, launch.site_lon, altitude)
            mode = "pad"
        else:
            lat, lon, altitude, _confidence = rocket_position_at(
                profile, offset, launch.site_lat, launch.site_lon, azimuth
            )
            target = (lat, lon, altitude)
            mode = "ascent"
        if not tangent_clearance(iss, *target):
            continue
        slant = slant_range_km(iss, *target)
        if slant > SLANT_CAP_KM:
            continue
        if mode == "ascent":
            light = rocket_sun_state(when, *target) if target[2] > 20 else None
            background = _surface_sun_elevation_deg(when, iss.lat, iss.lon)
            geometry = plume_angle_score(apparent_plume_angle_mrad(slant, target[2]))
            if light == SunState.UMBRA:
                light_term = 0.6
            elif background < -6:
                light_term = 1.0
            else:
                light_term = 0.5
        else:
            ground = great_circle_km(iss.lat, iss.lon, launch.site_lat, launch.site_lon)
            geometry = max(0.0, 1.0 - ground / 2250.0)
            sun = _surface_sun_elevation_deg(when, launch.site_lat, launch.site_lon)
            light_term = 0.7 if sun > 0 else 0.4
        hits += 1
        score = geometry * light_term
        if best_score is None or score > best_score:
            best_score = score
    if best_score is None:
        return "none" if age_h <= SHOT_TLE_AGE_H else "watch"
    points = round(100 * best_score)
    robust = hits * 15 >= 4 * _sigma_km(age_h) / 7.66
    precision = (launch.time_precision or "").lower()
    capped = launch.status_abbrev == "TBC" or precision == "hour"
    shot_ok = (
        age_h <= SHOT_TLE_AGE_H
        and robust
        and points >= SHOT_SCORE
        and launch.status_abbrev in {"Go", "Confirmed"}
        and precision in {"second", "minute"}
    )
    likely_ok = age_h <= LIKELY_TLE_AGE_H and points >= LIKELY_SCORE
    if capped:
        return "watch"
    if shot_ok:
        return "shot"
    if likely_ok:
        return "likely"
    return "watch"


def census_from(payload: dict, tle: TLE, now: datetime) -> Census:
    received = len(payload["results"])
    parsed = parse_response(payload, now=now)
    upcoming = [
        launch
        for launch in parsed
        if 0 <= (launch.t0 - now).total_seconds() <= HORIZON_14_DAYS
    ]
    g1 = sum(1 for launch in upcoming if _g1(launch))
    counts = {"shot": 0, "likely": 0, "watch": 0, "unassessed": 0, "none": 0}
    for launch in upcoming:
        counts[research_tier(launch, tle)] += 1
    artifact = build_launch_artifact(payload, tle, now, fetched_at=now)
    shown_map = len(shown_launch_ids(artifact, now, "map"))
    shown_upcoming = len(shown_launch_ids(artifact, now, "upcoming"))
    shown_iss = len(shown_launch_ids(artifact, now, "map"))
    return Census(
        rows_received=received,
        rows_in_14_days=len(upcoming),
        g1_pass=g1,
        shown_map=shown_map,
        shown_upcoming=shown_upcoming,
        shown_iss=shown_iss,
        tiers=TierCounts(**counts),
        research_rule=RESEARCH_RULE,
    )


def base_rates(tle: TLE, *, samples: int, seed: int, start: datetime) -> tuple[PadRate, ...]:
    """Random-liftoff line of sight. Geometry only."""
    profile = match_rocket({"full_name": "Falcon 9 Block 5"})
    if profile is None:
        raise ValueError("Falcon 9 Block 5 profile is missing")
    draw = random.Random(seed)  # noqa: S311
    offsets = range(0, 541, 30)
    rates: list[PadRate] = []
    for pad in STANDIN_AZIMUTH_PADS:
        line_of_sight = under_1500 = under_1000 = 0
        for _ in range(samples):
            liftoff = start + timedelta(seconds=draw.uniform(0, 30 * 86400))
            best = 1e9
            saw = False
            for offset in offsets:
                lat, lon, alt, _confidence = rocket_position_at(
                    profile, offset, pad.lat, pad.lon, pad.azimuth_deg
                )
                if alt < 20:
                    continue
                iss = propagate(tle, liftoff + timedelta(seconds=offset))
                if tangent_clearance(iss, lat, lon, alt):
                    saw = True
                    best = min(best, slant_range_km(iss, lat, lon, alt))
            line_of_sight += int(saw)
            under_1500 += int(best < 1500)
            under_1000 += int(best < 1000)
        rates.append(
            PadRate(pad.name, samples, line_of_sight, under_1500, under_1000)
        )
    return tuple(rates)


def format_census(report: Census) -> str:
    tiers = report.tiers
    lines = [
        f"rows_received {report.rows_received}",
        f"rows_in_14_days {report.rows_in_14_days}",
        f"g1_pass {report.g1_pass}",
        f"shown_map {report.shown_map}",
        f"shown_upcoming {report.shown_upcoming}",
        f"shown_iss {report.shown_iss}",
        f"tier_shot {tiers.shot}",
        f"tier_likely {tiers.likely}",
        f"tier_watch {tiers.watch}",
        f"tier_unassessed {tiers.unassessed}",
        f"tier_none {tiers.none}",
        f"research_rule {report.research_rule}",
    ]
    return "\n".join(lines)


def format_rates(rates: tuple[PadRate, ...]) -> str:
    lines = []
    for rate in rates:
        lines.append(
            f"base_rate {rate.name} n={rate.samples} "
            f"los={rate.line_of_sight} under_1500={rate.slant_under_1500} "
            f"under_1000={rate.slant_under_1000}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=FIXTURE_DIR)
    parser.add_argument("--base-rate", action="store_true")
    parser.add_argument("--base-rate-n", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args(argv)
    if args.base_rate_n < 1:
        raise SystemExit("base-rate-n must be at least 1")
    payload, tle, now = load_replay(args.fixtures)
    report = census_from(payload, tle, now)
    print(format_census(report))
    if args.base_rate:
        print(format_rates(base_rates(tle, samples=args.base_rate_n, seed=args.seed, start=now)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
