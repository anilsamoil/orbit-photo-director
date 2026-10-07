"""Geometry of pad and ascent subjects."""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from generator.ascent import real_launch_azimuth, rocket_position_at
from generator.ascent_profiles import ATLAS_V, AscentProfile, AscentSample
from generator.cloud import sun_subpoint
from generator.launch_opportunities import (
    Ascent,
    LightMode,
    Pad,
    Subject,
    limb_margin_deg,
    sample_liftoff,
    sample_liftoffs,
    sight_at,
)
from generator.orbit import EARTH_RADIUS_KM, Position, great_circle_km

EOL_CASES = Path(__file__).parent / "fixtures" / "launch_census" / "eol_cases.json"
SLC_41 = Pad(28.583, -80.583)
ISS_INCLINATION_DEG = 51.6


def _utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _oa4() -> dict:
    payload = json.loads(EOL_CASES.read_text())
    return next(case for case in payload["cases"] if case["case_id"] == "oa-4")


def _hold(position: Position):
    return lambda _when: position


def test_oa4_atlas_plume_is_in_sight_inside_the_slant_cap() -> None:
    case = _oa4()
    liftoff = _utc(case["launch_time_utc"])
    photo = _utc(case["photo_time_utc"])
    iss = Position(case["iss_nadir_lat"], case["iss_nadir_lon"], case["iss_altitude_km"], photo)
    azimuth = real_launch_azimuth(SLC_41.lat, ISS_INCLINATION_DEG)
    ascent = Ascent(ATLAS_V, azimuth)
    rocket_lat, rocket_lon, rocket_alt, _confidence = rocket_position_at(
        ATLAS_V, 252, SLC_41.lat, SLC_41.lon, azimuth,
    )
    rocket = sight_at(iss, photo, liftoff, Subject.ASCENT, rocket_lat, rocket_lon, rocket_alt)
    pad = sight_at(iss, photo, liftoff, Subject.PAD, SLC_41.lat, SLC_41.lon, 0.0)

    assert (photo - liftoff) == timedelta(minutes=4, seconds=12)
    assert great_circle_km(iss.lat, iss.lon, SLC_41.lat, SLC_41.lon) > 500
    assert pad.line_of_sight is False
    assert rocket.line_of_sight is True
    assert rocket.limb_margin_deg > 0
    assert 2900 <= rocket.slant_km <= 3400
    assert rocket.in_plan is True
    assert rocket.light is LightMode.TWILIGHT_PLUME

    scenario = sample_liftoff(liftoff, _hold(iss), SLC_41, ascent)
    covering = [
        span for span in scenario.spans
        if span.subject is Subject.ASCENT and span.start <= photo <= span.end
    ]
    assert len(covering) == 1
    assert covering[0].liftoff == liftoff
    assert not any(span.subject is Subject.PAD for span in scenario.spans)


def test_hidden_pad_becomes_visible_once_the_rocket_clears_the_limb() -> None:
    liftoff = datetime(2020, 1, 1, tzinfo=UTC)
    horizon = EARTH_RADIUS_KM * math.acos(
        EARTH_RADIUS_KM / (EARTH_RADIUS_KM + 404.0),
    )
    iss_lat = math.degrees((horizon + 150.0) / EARTH_RADIUS_KM)
    iss = Position(iss_lat, 0.0, 404.0, liftoff)
    pad = Pad(0.0, 0.0)
    scenario = sample_liftoff(liftoff, _hold(iss), pad, Ascent(ATLAS_V, 0.0))

    pad_at_flip = next(
        sample for sample in scenario.sights
        if sample.subject is Subject.PAD and sample.t_offset_s == 25
    )
    assert pad_at_flip.line_of_sight is False
    assert not any(span.subject is Subject.PAD for span in scenario.spans)
    ascent_spans = [span for span in scenario.spans if span.subject is Subject.ASCENT]
    assert len(ascent_spans) == 1
    assert ascent_spans[0].start == liftoff + timedelta(seconds=27)
    assert ascent_spans[0].closest.in_plan is True


def test_umbra_powered_flight_stays_night_engine() -> None:
    when = datetime(2015, 12, 6, 21, 49, 9, tzinfo=UTC)
    sun_lat, sun_lon = sun_subpoint(when)
    pad = Pad(-sun_lat, ((sun_lon + 180 + 180) % 360) - 180)
    iss = Position(pad.lat + 2.0, pad.lon, 404.0, when)
    scenario = sample_liftoff(when, _hold(iss), pad, Ascent(ATLAS_V, 90.0))
    kept = [
        sample for sample in scenario.sights
        if sample.subject is Subject.ASCENT
        and sample.light is LightMode.NIGHT_ENGINE
        and sample.in_plan
    ]
    assert kept
    assert any(
        span.subject is Subject.ASCENT and span.start <= kept[0].when <= span.end
        for span in scenario.spans
    )
    pad_sight = sight_at(iss, when, when, Subject.PAD, pad.lat, pad.lon, 0.0)
    assert pad_sight.light is LightMode.PAD_NIGHT


def test_sunlit_disk_plume_is_day_plume() -> None:
    when = datetime(2015, 12, 6, 21, 49, 9, tzinfo=UTC)
    lat, lon = sun_subpoint(when)
    iss = Position(lat, lon, 404.0, when)
    rocket = sight_at(iss, when, when, Subject.ASCENT, lat, lon + 0.5, 100.0)
    pad = sight_at(iss, when, when, Subject.PAD, lat, lon, 0.0)
    assert rocket.line_of_sight is True
    assert rocket.limb_margin_deg < 0
    assert rocket.light is LightMode.DAY_PLUME
    assert rocket.in_plan is True
    assert pad.light is LightMode.PAD_DAY


def test_line_of_sight_beyond_the_slant_cap_is_out_of_plan() -> None:
    when = datetime(2020, 1, 1, tzinfo=UTC)
    lat = math.degrees(3600.0 / EARTH_RADIUS_KM)
    iss = Position(0.0, 0.0, 404.0, when)
    seen = sight_at(iss, when, when, Subject.ASCENT, lat, 0.0, 200.0)
    assert seen.line_of_sight is True
    assert seen.slant_km > 3500
    assert seen.in_plan is False


def test_liftoff_scenarios_stay_separate() -> None:
    liftoff_a = datetime(2015, 12, 6, 21, 44, 57, tzinfo=UTC)
    liftoff_b = liftoff_a + timedelta(hours=2)
    sun_lat, sun_lon = sun_subpoint(liftoff_a)
    pad = Pad(-sun_lat, ((sun_lon + 180 + 180) % 360) - 180)
    near = Position(pad.lat + 2.0, pad.lon, 404.0, liftoff_a)
    far = Position(sun_lat, sun_lon, 404.0, liftoff_a)

    def observer_at(when: datetime) -> Position:
        if abs((when - liftoff_a).total_seconds()) <= 15 * 60:
            return near
        return far

    scenarios = sample_liftoffs(
        (liftoff_a, liftoff_b), observer_at, pad, Ascent(ATLAS_V, 90.0),
    )
    assert len(scenarios) == 2
    assert scenarios[0].liftoff == liftoff_a
    assert scenarios[1].liftoff == liftoff_b
    assert any(span.subject is Subject.ASCENT for span in scenarios[0].spans)
    assert scenarios[1].spans == ()
    for scenario in scenarios:
        for span in scenario.spans:
            assert span.liftoff == scenario.liftoff
            assert (span.end - span.start).total_seconds() <= 15 * 60
        for sample in scenario.sights:
            assert sample.liftoff == scenario.liftoff
            assert abs((sample.when - scenario.liftoff).total_seconds()) <= 10 * 60


def test_visible_run_ends_between_coarse_samples() -> None:
    liftoff = datetime(2020, 1, 1, tzinfo=UTC)
    near = Position(28.5, -80.5, 420.0, liftoff)
    far = Position(0.0, 120.0, 420.0, liftoff)

    def observer_at(when: datetime) -> Position:
        if (when - liftoff).total_seconds() <= 42:
            return near
        return far

    scenario = sample_liftoff(liftoff, observer_at, SLC_41, Ascent(ATLAS_V, 90.0))
    spans = [span for span in scenario.spans if span.subject is Subject.ASCENT]
    assert len(spans) == 1
    assert spans[0].end == liftoff + timedelta(seconds=42)


def test_run_that_opens_on_a_coarse_sample_stays_there() -> None:
    liftoff = datetime(2020, 1, 1, tzinfo=UTC)
    near = Position(28.5, -80.5, 420.0, liftoff)
    far = Position(0.0, 120.0, 420.0, liftoff)

    def observer_at(when: datetime) -> Position:
        if (when - liftoff).total_seconds() >= 30:
            return near
        return far

    scenario = sample_liftoff(liftoff, observer_at, SLC_41, Ascent(ATLAS_V, 90.0))
    spans = [span for span in scenario.spans if span.subject is Subject.ASCENT]
    assert len(spans) == 1
    assert spans[0].start == liftoff + timedelta(seconds=30)


def test_short_ascent_keeps_its_final_second() -> None:
    liftoff = datetime(2020, 1, 1, tzinfo=UTC)
    profile = AscentProfile(
        name="short",
        match_keywords=(),
        samples=(
            AscentSample(0, 0.0, 0.0, 90.0, 1.0),
            AscentSample(7, 10.0, 1.0, 80.0, 1.0),
        ),
        insertion_t_seconds=7,
    )
    iss = Position(28.5, -80.5, 420.0, liftoff)
    scenario = sample_liftoff(liftoff, _hold(iss), SLC_41, Ascent(profile, 90.0))
    offsets = [sample.t_offset_s for sample in scenario.sights if sample.subject is Subject.ASCENT]
    assert offsets[-1] == 7
    assert 6 not in offsets


def test_bad_azimuth_is_rejected() -> None:
    liftoff = datetime(2020, 1, 1, tzinfo=UTC)
    iss = Position(28.5, -80.5, 420.0, liftoff)
    with pytest.raises(ValueError, match="azimuth_deg"):
        sample_liftoff(liftoff, _hold(iss), SLC_41, Ascent(ATLAS_V, 360.0))


def test_coincident_subject_has_a_defined_limb_margin() -> None:
    iss = Position(10.0, 20.0, 400.0, datetime(2020, 1, 1, tzinfo=UTC))
    margin = limb_margin_deg(iss, 10.0, 20.0, 400.0)
    assert margin < -60


def test_missing_ascent_track_samples_the_pad_only() -> None:
    liftoff = datetime(2020, 6, 1, 12, tzinfo=UTC)
    iss = Position(28.5, -80.5, 420.0, liftoff)
    scenario = sample_liftoff(liftoff, _hold(iss), SLC_41, None)
    assert scenario.sights
    assert {sample.subject for sample in scenario.sights} == {Subject.PAD}
