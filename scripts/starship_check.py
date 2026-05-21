"""Diagnostic: walk predict_ascent_pass for Starship Flight 12 and report
which gate filters it out at every 15-second step."""

from datetime import UTC, datetime, timedelta
from math import degrees, radians

from generator.ascent import (
    INTERPOLATION_CADENCE_SECONDS,
    SunState,
    apparent_plume_angle_mrad,
    plume_angle_score,
    real_launch_azimuth,
    rocket_position_at,
    rocket_sun_state,
    slant_range_km,
    tangent_clearance,
)
from generator.ascent_profiles import match_rocket
from generator.orbit import TLE, propagate

# Live values pulled from the deploy 2026-05-21
ISS_TLE = TLE.from_text(
    "ISS\n"
    "1 25544U 98067A   26141.29411058  .00005910  00000+0  11416-3 0  9994\n"
    "2 25544  51.6329  73.2330 0007523  82.0965 278.0877 15.49293486567584"
)

# Starship Flight 12 — Starbase TX, NET 2026-05-21T22:30:01Z
PAD_LAT = 25.997
PAD_LON = -97.156
T0 = datetime(2026, 5, 21, 22, 30, 1, tzinfo=UTC)

# Fake the LL2 launch dict shape (just enough for match_rocket).
LAUNCH = {
    "rocket": {"configuration": {"full_name": "Starship V3", "name": "Starship", "family": "Starship"}},
    "mission": {"orbit": {"inclination": 25.5}},  # Flight 12 sub-orbital, ~25° inclination
}


def main() -> None:
    profile = match_rocket(LAUNCH["rocket"]["configuration"])
    print(f"Matched profile: {profile.name if profile else 'NONE'}")
    if profile is None:
        return
    inclination = LAUNCH["mission"]["orbit"]["inclination"]
    azimuth = real_launch_azimuth(PAD_LAT, inclination)
    print(f"Launch azimuth: {azimuth:.2f}° from north")
    print(f"Profile insertion at T+{profile.insertion_t_seconds}s")
    print()
    print(f"{'T+s':>5} {'rkt lat':>7} {'rkt lon':>8} {'alt km':>6} "
          f"{'iss lat':>7} {'iss lon':>8} {'slant km':>9} {'tangent':>8} "
          f"{'sun':>10} {'plume mrad':>10} {'plume sc':>8}")

    any_passed = False
    for t_offset in range(0, profile.insertion_t_seconds + 1, INTERPOLATION_CADENCE_SECONDS):
        when = T0 + timedelta(seconds=t_offset)
        rocket_lat, rocket_lon, rocket_alt, _conf = rocket_position_at(
            profile, t_offset, PAD_LAT, PAD_LON, azimuth,
        )
        iss = propagate(ISS_TLE, when)
        tc = tangent_clearance(iss, rocket_lat, rocket_lon, rocket_alt)
        sun = rocket_sun_state(when, rocket_lat, rocket_lon, rocket_alt)
        sr = slant_range_km(iss, rocket_lat, rocket_lon, rocket_alt)
        plume_mrad = apparent_plume_angle_mrad(sr, rocket_alt)
        plume = plume_angle_score(plume_mrad)
        passed = tc and sun != SunState.UMBRA and plume > 0
        if passed:
            any_passed = True
        print(
            f"{t_offset:5d} {rocket_lat:7.3f} {rocket_lon:8.3f} {rocket_alt:6.1f} "
            f"{iss.lat:7.3f} {iss.lon:8.3f} {sr:9.1f} "
            f"{'YES' if tc else 'NO':>8} {sun.name:>10} "
            f"{plume_mrad:10.4f} {plume:8.3f}  {'<-- PASS' if passed else ''}"
        )

    print()
    if not any_passed:
        print("Verdict: NO t_offset in the ascent profile passes all gates.")
        print("predict_ascent_pass would return None (no opportunity).")
    else:
        print("Verdict: at least one t_offset would generate an AscentPrediction.")


if __name__ == "__main__":
    main()
