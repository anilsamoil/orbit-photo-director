"""Generator orchestrator. One tick:
  1. Fetch + cache TLE
  2. Fetch + cache SatCORPS cloud composite (or use cached < TTL)
  3. Load targets
  4. For each target: find passes in next pass_window_hours; score each
  5. Write versioned artifacts (passes.json, track.json, status.json, iss_polynomial.json)
  6. Atomic write manifest.json pointer
  7. (Caller) rclone sync to R2
"""

from __future__ import annotations

import fcntl
import json
import logging
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import requests

from . import __version__
from .ascent import (
    ascent_score_multiplier,
    build_ascent_trajectory,
    predict_ascent_pass,
)
from .ascent_profiles import match_rocket
from .cloud import (
    CloudSample,
    CloudSampler,
    GeostationaryIRSampler,
    GFSForecastSampler,
    GIBSCloudSampler,
    HimawariNICTSampler,
    MeteosatEUMETSATSampler,
    MockCloudSampler,
    SatCORPSSampler,
    assess_obstruction,
    lighting_regime,
    sun_glint_risk,
    sun_subpoint,
)
from .config import (
    DEFAULT_TOP_MAP,
    DEFAULT_TOP_QUEUE,
    DEFAULT_TOP_UPCOMING,
    ENCOUNTER_PREROLL_SECONDS,
    OBSERVED_CLOUD_HORIZON_MINUTES,
    PASS_MAX_DISTANCE_KM,
    PASS_SAMPLE_STEP_SECONDS,
    Settings,
    load_targets,
)
from .launch_data import (
    PASS_WINDOW_SECONDS as LAUNCH_PASS_WINDOW_SECONDS,
)
from .launch_data import (
    Launch,
    fetch_upcoming_launches,
    filter_ascent_launches,
    filter_launches,
)
from .manifest import cleanup_old_versions, utcnow_iso, version_id, write_manifest
from .multiplex import (
    build_profile_target_list,
    fetch_profile_targets,
    multiplex_enabled,
    profile_names,
)
from .orbit import (
    TLE,
    angle_off_nadir_deg,
    detect_reboost,
    find_passes,
    fit_iss_polynomial,
    freshness_factor,
    great_circle_bearing_deg,
    great_circle_km,
    relative_bearing_deg,
    sample_track_points,
    tle_age_hours,
)
from .score import compute_score, top_n

# Hard-fail threshold: above this TLE age, sgp4 predictions degrade so badly
# the queue would mislead the user. Better to publish a stale-flag manifest
# than confidently-wrong shot times.
TLE_HARD_FAIL_HOURS = 96.0

log = logging.getLogger(__name__)


def fetch_tle(
    url: str,
    cache_path: Path,
    ttl_hours: float = 1.0,
    now: datetime | None = None,
) -> TLE:
    """Fetch latest TLE from Celestrak, cache to disk. If cache fresh, use it.

    Side effect: when fetching a NEW TLE, compares it to the previous cached one
    and logs a warning if a likely reboost is detected (mean motion change >
    0.005 rev/day). Reboost detection lets ground-side support know when the new
    TLE arrived and validates that pass times are now trustworthy.
    """
    n = now or datetime.now(tz=UTC)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.exists():
        age_h = (n.timestamp() - cache_path.stat().st_mtime) / 3600.0
        if age_h < ttl_hours:
            return TLE.from_text(cache_path.read_text())

    # Snapshot prior TLE for reboost comparison BEFORE overwriting.
    # If the cache is corrupted (partial write, disk hiccup), `prior` is
    # None and detect_reboost returns False — any real reboost in this
    # tick goes silently undetected. Log a warning so ground-side
    # support sees the corruption signal even if the next reboost is
    # missed. V2-P3 fix from TODOS.md (anilsamoilenko 2026-05-17).
    prior: TLE | None = None
    if cache_path.exists():
        try:
            prior = TLE.from_text(cache_path.read_text())
        except (ValueError, OSError) as exc:
            log.warning(
                "TLE cache parse failed (%s); reboost detection skipped for this tick. "
                "Cache will be overwritten on successful upstream fetch below.",
                exc,
            )
            prior = None

    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        text = resp.text
        # Parse FIRST. If the upstream returned a CDN error page or HTML
        # captured as 200, TLE.from_text raises and we fall through to the
        # cached copy below. Writing the cache BEFORE parsing would replace
        # our last good TLE with garbage.
        new_tle = TLE.from_text(text)
        cache_path.write_text(text)
        if detect_reboost(prior, new_tle):
            log.warning(
                "ISS reboost detected: TLE epoch advanced from %s to %s "
                "(mean motion changed > 0.005 rev/day)",
                prior.epoch.isoformat() if prior else "<none>",
                new_tle.epoch.isoformat(),
            )
        return new_tle
    except Exception as exc:  # noqa: BLE001
        log.warning("TLE fetch failed: %s; using cached if present", exc)
        if cache_path.exists():
            return TLE.from_text(cache_path.read_text())
        raise RuntimeError("TLE fetch failed and no cache available") from exc


class CombinedCloudSampler:
    """Four-tier observed-cloud sampler covering the full globe day+night.

    Tier 1: MODIS direct cloud fraction (most accurate, but only ~5/33 passes have it).
    Tier 2: GOES geostationary IR (~Americas + adjacent oceans, day+night, 10-15 min).
    Tier 3: Meteosat IR108 (Africa + Europe, day+night, 15 min).
    Tier 4: Himawari NICT true-color (Asia + W.Pacific, DAYTIME ONLY, 10 min).
    Fallback: cf=50 with source="combined-no-coverage" only when all tiers miss.

    For each lat/lon: prefer Tier 1; cascade through 2 → 3 → 4 on no-coverage.
    Meteosat goes BEFORE Himawari NICT because it's a real IR signal (day+night);
    NICT is visible-band (daytime only).
    """

    def __init__(
        self,
        modis: GIBSCloudSampler,
        geo_ir: GeostationaryIRSampler,
        meteosat: MeteosatEUMETSATSampler | None = None,
        himawari: HimawariNICTSampler | None = None,
    ):
        self._modis = modis
        self._geo_ir = geo_ir
        self._meteosat = meteosat
        self._himawari = himawari

    def sample(self, lat: float, lon: float, when: datetime) -> CloudSample:
        modis_sample = self._modis.sample(lat, lon, when)
        if modis_sample.source == "gibs":
            return modis_sample  # tier 1 wins

        geo_sample = self._geo_ir.sample(lat, lon, when)
        if (
            geo_sample.source.startswith("geo-ir-")
            and not geo_sample.source.endswith("-no-coverage")
            and not geo_sample.source.endswith("-nodata")
        ):
            return geo_sample

        if self._meteosat is not None:
            met_sample = self._meteosat.sample(lat, lon, when)
            if met_sample.source == "meteosat-ir108":
                return met_sample
            # meteosat-no-coverage / meteosat-off-disk → fall through

        if self._himawari is not None:
            him_sample = self._himawari.sample(lat, lon, when)
            if him_sample.source == "himawari-nict":
                return him_sample
            # himawari-night / himawari-no-coverage → fall through

        return CloudSample(
            cloud_fraction=50.0,
            sample_time=when,
            source="combined-no-coverage",
        )


def select_cloud_sampler(settings: Settings, now: datetime) -> tuple[CloudSampler, datetime, str]:
    """Pick a cloud sampler.

    Order of preference (V1):
      1. SatCORPS NetCDF if cached and < 90 min old (fetcher deferred to V2).
      2. CombinedCloudSampler — MODIS daily (tier 1) + geostationary IR (tier 2).
         Geo-IR provides 95%+ global coverage at 10-15 min cadence; MODIS where
         present is more accurate.
      3. Mock sampler (last-resort fallback when both real sources fail).

    Override via env var `OPD_CLOUD_SOURCE=mock` to force the mock sampler
    (tests use this so they don't hit the real GIBS API).
    """
    import os

    if os.environ.get("OPD_CLOUD_SOURCE") == "mock":
        log.info("OPD_CLOUD_SOURCE=mock; forcing mock sampler")
        composite_hour = now.replace(minute=0, second=0, microsecond=0)
        return MockCloudSampler(default_cf=30.0), composite_hour, "mock"

    # 1. SatCORPS hourly composite (preferred when present; fetcher V2)
    cached = settings.cache_dir / "satcorps_latest.nc"
    if cached.exists():
        age_min = (now.timestamp() - cached.stat().st_mtime) / 60.0
        if age_min < 90:
            try:
                sampler = SatCORPSSampler(cached)
                composite_hour = datetime.fromtimestamp(cached.stat().st_mtime, tz=UTC).replace(
                    minute=0, second=0, microsecond=0
                )
                return sampler, composite_hour, "satcorps"
            except Exception as exc:  # noqa: BLE001
                log.warning("SatCORPS open failed (%s); falling back to GIBS", exc)

    # 2. Combined: MODIS (tier 1) + GOES-IR (tier 2) + Meteosat (tier 3) + Himawari NICT (tier 4)
    modis: GIBSCloudSampler | None = None
    geo_ir: GeostationaryIRSampler | None = None
    meteosat: MeteosatEUMETSATSampler | None = None
    himawari: HimawariNICTSampler | None = None
    try:
        modis = GIBSCloudSampler(now)
    except Exception as exc:  # noqa: BLE001
        log.warning("MODIS GIBS fetch failed (%s); continuing without it", exc)
    try:
        geo_ir = GeostationaryIRSampler(now)
    except Exception as exc:  # noqa: BLE001
        log.warning("Geostationary IR fetch failed (%s); continuing without it", exc)
    try:
        meteosat = MeteosatEUMETSATSampler(now)
    except Exception as exc:  # noqa: BLE001
        log.warning("Meteosat EUMETSAT fetch failed (%s); continuing without it", exc)
    try:
        himawari = HimawariNICTSampler(now)
    except Exception as exc:  # noqa: BLE001
        log.warning("Himawari NICT fetch failed (%s); continuing without it", exc)

    if modis and geo_ir:
        tier_label = "combined-modis+geoir"
        tier_log = "MODIS + GOES-IR"
        if meteosat is not None:
            tier_label += "+meteosat"
            tier_log += " + Meteosat"
        if himawari is not None:
            tier_label += "+himawari"
            tier_log += " + Himawari-NICT"
        log.info("using combined %s cloud sampler", tier_log)
        composite_hour = now.replace(minute=0, second=0, microsecond=0)
        return (
            CombinedCloudSampler(modis, geo_ir, meteosat, himawari),
            composite_hour,
            tier_label,
        )
    if geo_ir:
        log.info("using geostationary IR only (MODIS unavailable)")
        composite_hour = now.replace(minute=0, second=0, microsecond=0)
        return geo_ir, composite_hour, "geo-ir"
    if modis:
        log.info("using MODIS only (geo IR unavailable)")
        composite_hour = (now - timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        return modis, composite_hour, "gibs"

    # 3. Mock fallback (only when all real sources fail)
    log.warning("no real cloud data available; using mock sampler with default cf=30")
    composite_hour = now.replace(minute=0, second=0, microsecond=0)
    return MockCloudSampler(default_cf=30.0), composite_hour, "mock"


def score_pass_for_target(
    target: dict[str, Any],
    pass_obj: Any,
    sampler: CloudSampler,
    tle_freshness: float,
    *,
    forecast_sampler: CloudSampler | None = None,
    now: datetime | None = None,
    observed_horizon_minutes: float = OBSERVED_CLOUD_HORIZON_MINUTES,
    composite_hour: datetime | None = None,
    lightning_sampler: Any | None = None,
    hurricane_tracker: Any | None = None,
) -> dict[str, Any]:
    when = pass_obj.closest_approach
    iss = pass_obj.iss_position
    sun_lat, sun_lon = sun_subpoint(when)
    regime = lighting_regime(sun_lat, sun_lon, pass_obj.target_lat, pass_obj.target_lon)

    glint = sun_glint_risk(
        sun_lat, sun_lon,
        pass_obj.target_lat, pass_obj.target_lon,
        iss.lat, iss.lon,
    )
    # Pick observed sampler for imminent passes (<= horizon); forecast for
    # everything beyond. Observed cloud is irrelevant for a pass 6h from now;
    # forecast is the only signal that makes sense.
    use_forecast = (
        forecast_sampler is not None
        and now is not None
        and (when - now).total_seconds() / 60.0 > observed_horizon_minutes
    )
    chosen = forecast_sampler if use_forecast else sampler
    assert chosen is not None  # forecast_sampler only None when use_forecast is False
    sample = chosen.sample(pass_obj.target_lat, pass_obj.target_lon, when)
    obs = assess_obstruction(sample, glint)

    p_unobs_adjusted = obs.p_unobstructed * tle_freshness
    sc = compute_score(
        p_unobstructed=p_unobs_adjusted,
        target_regime=target["regime"],
        pass_regime=regime,
        distance_km=pass_obj.nadir_distance_km,
        priority=target["priority"],
    )

    # Weather v1.3 fields. Both samplers/trackers are passed in (not
    # instantiated here) so tests can inject mocks and the flag-off path
    # in run_tick can pass None to mean "no lightning/hurricane work."
    # When None, the resulting PassEntry omits the fields entirely so
    # older readers don't see undefined dict keys.
    lightning_potential: float | None = None
    flash_rate_per_min: float | None = None
    lightning_source: str | None = None
    lightning_bonus_value: float = 0.0
    hurricane_dict: dict[str, Any] | None = None
    if lightning_sampler is not None:
        lsample = lightning_sampler.sample(
            pass_obj.target_lat, pass_obj.target_lon, when,
        )
        lightning_potential = round(lsample.lightning_potential, 3)
        flash_rate_per_min = round(lsample.flash_rate_per_min, 2)
        lightning_source = lsample.source
        # Local import to keep top-of-file deps minimal; lightning is a
        # leaf module without circular-import risk.
        from .lightning import lightning_bonus as _lightning_bonus
        lightning_bonus_value = _lightning_bonus(lsample.lightning_potential)
    if hurricane_tracker is not None:
        near = hurricane_tracker.check_proximity(
            pass_obj.target_lat, pass_obj.target_lon,
        )
        if near is not None:
            hurricane_dict = {
                "name": near.name,
                "classification": near.classification,
                "distance_km": round(near.distance_km, 1),
                "nhc_id": near.nhc_id,
            }

    # Lightning bonus is additive and capped at 100 (D3 — preserves the
    # operator-visible 0-100 score range without overflowing into >5-star).
    final_score_value = min(100.0, sc.final + lightning_bonus_value)

    out = {
        "target_id": target["id"],
        "target_name": target["name"],
        "target_regime": target["regime"],
        "target_priority": target["priority"],
        "target_lat": pass_obj.target_lat,
        "target_lon": pass_obj.target_lon,
        "closest_approach": utcnow_iso(when),
        "nadir_distance_km": round(pass_obj.nadir_distance_km, 2),
        # Angle off nadir lets the frontend show whether this is a WORF
        # shot (~<30°, nadir window in Destiny) or a Cupola shot (oblique).
        "angle_off_nadir_deg": round(
            angle_off_nadir_deg(pass_obj.nadir_distance_km, iss.alt_km), 1
        ),
        # Direction the target sits relative to ISS travel: 0 = ahead,
        # 90 = starboard, 180 = aft, 270 = port. Lets the frontend tell
        # the operator "look 35° to starboard" instead of just "shoot 35°"
        # (operator feedback 2026-05-17 — without this, the angle is
        # ambiguous between forward/port/starboard/aft directions).
        # Always present in V3 manifests (find_passes always computes it);
        # frontend treats absent as "old manifest, hide the tag."
        "iss_relative_bearing_deg": (
            round(pass_obj.iss_relative_bearing_deg, 1)
            if pass_obj.iss_relative_bearing_deg is not None
            else None
        ),
        # Initial-encounter geometry: when the target first becomes frameable
        # (off-nadir ≤60° scan-back from closest approach), plus the look
        # angle/side at that moment. None for grazing passes whose closest
        # approach is itself past 60°; frontend renders closest-only then.
        "encounter": (
            {
                "time": utcnow_iso(pass_obj.encounter.time),
                "off_nadir_deg": round(pass_obj.encounter.off_nadir_deg, 1),
                "rel_bearing_deg": round(pass_obj.encounter.rel_bearing_deg, 1),
            }
            if getattr(pass_obj, "encounter", None) is not None
            else None
        ),
        "pass_regime": regime,
        "obstruction_class": obs.obstruction_class,
        "p_unobstructed": round(p_unobs_adjusted, 2),
        "cloud_fraction": round(sample.cloud_fraction, 2),
        "cloud_source": sample.source,
        # Wall-clock time the cloud reading was actually taken.
        # Drives the frontend's "obs Nm ago" tag so the user can see at a
        # glance whether the cloud reading is fresh (10 min, GOES-IR) or
        # day-old (MODIS daily composite).
        #
        # The cloud samplers all default sample.sample_time = `when` (the
        # pass time), which is the FORECAST VALID-TIME for forecast sources
        # but useless for observed sources (always future-dated, so the
        # frontend's age formatter silently hides the tag). Override here:
        # observed sources use composite_hour (the imagery composite time
        # the manifest already declares); forecast keeps sample.sample_time.
        "sample_time": utcnow_iso(
            sample.sample_time
            if sample.source == "gfs-forecast" or composite_hour is None
            else composite_hour
        ),
        "score": round(final_score_value, 3),
        "score_components": {
            "p_unobstructed": round(sc.p_unobstructed, 2),
            "regime_fit": round(sc.regime_fit, 2),
            "nadir_proximity": round(sc.nadir_proximity, 2),
            "priority_weight": round(sc.priority_weight, 2),
            "tle_freshness": round(tle_freshness, 3),
        },
        "iss_at_closest": {
            "lat": round(iss.lat, 4),
            "lon": round(iss.lon, 4),
            "alt_km": round(iss.alt_km, 1),
        },
    }
    # Weather v1.3 fields are optional — only attach them when the
    # samplers/trackers were supplied (i.e., enable_weather=True). Keeps
    # the PassEntry shape unchanged for the flag-off path so existing
    # tests + the production manifest schema are byte-stable.
    if lightning_potential is not None:
        out["lightning_potential"] = lightning_potential
        out["flash_rate_per_min"] = flash_rate_per_min
        out["lightning_source"] = lightning_source
        out["lightning_bonus"] = round(lightning_bonus_value, 3)
    if hurricane_dict is not None:
        out["hurricane_nearby"] = hurricane_dict
    # Sprite watch (Unit 7): on a NIGHT pass (the ISS SUB-POINT in darkness —
    # its own computation, NOT the target regime: the limb air column along
    # the sightline must be genuinely dark for a faint mesospheric flash),
    # look for a strong storm cluster in the limb annulus around the ISS
    # sub-point. Observed-only (GLM); serialized conditionally so absent =
    # byte-identical. Frontend adds the moon-darkness gate + the honest row.
    if lightning_sampler is not None:
        iss_regime = lighting_regime(sun_lat, sun_lon, iss.lat, iss.lon)
        if iss_regime == "night" and hasattr(
            lightning_sampler, "strongest_cluster_in_annulus"
        ):
            cluster = lightning_sampler.strongest_cluster_in_annulus(iss.lat, iss.lon)
            if cluster is not None:
                out["sprite"] = {
                    "distance_km": cluster.distance_km,
                    "bearing_deg": cluster.bearing_deg,
                    "flash_count": cluster.flash_count,
                }

    # Curated category (big-terrain/volcano/...) — lets the frontend's
    # golden-hour row fire only on terrain-texture targets (Unit 4).
    # Conditionally inserted (Codex review 2026-06-14): omitting the key
    # entirely when absent keeps no-category passes byte-identical (manifest
    # version dedup) and matches the optional `category?:` frontend type. No
    # scorer interaction — advisory only.
    category = target.get("category")
    if category:
        out["category"] = category
    return out


def _synthesize_launch_target(la: Launch) -> dict[str, Any]:
    """Wrap a Launch in the shape `find_passes` + `score_pass_for_target`
    expect. priority=5 (max) so launches outrank median ground targets;
    regime='any' because we don't have a day/night preference for the rocket
    itself (the launch site lighting matters via the cloud forecast, not via
    pass-regime fit).
    """
    return {
        "id": f"launch:{la.id}",
        "name": f"🚀 {la.name}",  # tag is also rendered by the frontend; the
                                   # 🚀 in the name lets fallback views (RSS,
                                   # plain JSON inspection) still see it.
        "regime": "any",
        "priority": 5,
        "geom": {"lat": la.site_lat, "lon": la.site_lon},
    }


def _build_ascent_pass_entry(
    la: Launch, pred: Any, now: datetime,
) -> dict[str, Any]:
    """Shape an AscentPrediction into a PassEntry dict the existing
    sort/render pipeline can consume.

    Important shape decisions:
    - target_lat/lon are the ROCKET position at best instant (not the pad).
      The card's "look here" is the rocket, not the launch site.
    - nadir_distance_km uses the great-circle distance from ISS subpoint
      to the rocket's subpoint. Not a true "nadir distance" (rocket is at
      altitude) but the existing card layout reads it as "how close
      laterally," which is what the operator wants for an ascent shot.
    - score = 100 × ascent_score_multiplier so it integrates cleanly with
      the existing 0-100 score scale (OVERHEAD scores live in same range).
    - launch.kind = "ascent" drives the frontend's "ASCENT plume" tag.
    """
    rocket_subpoint_dist = great_circle_km(
        pred.iss_position.lat, pred.iss_position.lon,
        pred.rocket_lat, pred.rocket_lon,
    )
    iss_heading = great_circle_bearing_deg(
        pred.iss_position.lat, pred.iss_position.lon,
        # Bearing computed across +30s of ISS travel via the recorded ISS
        # position alone isn't possible here (we have one sample, not two).
        # Approximate using bearing-to-rocket as a proxy direction-of-look
        # since the operator's main use of this is "which way to face,"
        # not aircraft-navigation precision.
        pred.rocket_lat, pred.rocket_lon,
    )
    target_bearing = great_circle_bearing_deg(
        pred.iss_position.lat, pred.iss_position.lon,
        pred.rocket_lat, pred.rocket_lon,
    )
    # For ASCENT, the "relative bearing" of the target is its bearing
    # relative to ISS direction of travel — but we lack a heading sample
    # here, so we just use the absolute bearing as a placeholder direction
    # indicator. Soak data will tell us if this needs refinement.
    rel_bearing = relative_bearing_deg(iss_heading, target_bearing)
    multiplier = ascent_score_multiplier(pred)
    # Trajectory polyline for the frontend ascent-trajectory map layer.
    # Recomputed from the matched profile + pad + real launch azimuth so
    # the frontend doesn't need to know about ascent_profiles or the
    # great-circle math. ~35 points × 4 floats ≈ 1KB per launch.
    # The same {"full_name": la.rocket_type} resolver lookup that
    # predict_ascent_pass used to find the profile in the first place.
    profile = match_rocket({"full_name": la.rocket_type})
    trajectory_payload: list[dict[str, float]] = []
    if profile is not None:
        traj = build_ascent_trajectory(
            profile, pred.pad_lat, pred.pad_lon, pred.launch_azimuth_deg,
        )
        trajectory_payload = [
            {
                "t_offset_s": p.t_offset_seconds,
                "lat": round(p.lat, 4),
                "lon": round(p.lon, 4),
                "alt_km": round(p.alt_km, 1),
            }
            for p in traj
        ]
    return {
        "target_id": f"launch:{la.id}:ascent",
        "target_name": f"🚀 {la.name}",
        "target_regime": "any",
        "target_priority": 5,
        "target_lat": round(pred.rocket_lat, 4),
        "target_lon": round(pred.rocket_lon, 4),
        "closest_approach": utcnow_iso(pred.best_instant_utc),
        "nadir_distance_km": round(rocket_subpoint_dist, 2),
        "angle_off_nadir_deg": round(
            angle_off_nadir_deg(rocket_subpoint_dist, pred.iss_position.alt_km), 1
        ),
        "iss_relative_bearing_deg": round(rel_bearing, 1),
        "pass_regime": "night" if pred.background_dark_score > 0.5 else (
            "terminator" if pred.background_dark_score > 0.1 else "day"
        ),
        "obstruction_class": (
            "clear" if pred.obstruction_cloud_score > 0.7 else "cloudy"
        ),
        "p_unobstructed": round(pred.obstruction_cloud_score * 100.0, 2),
        "cloud_fraction": round(100.0 * (1.0 - pred.obstruction_cloud_score), 2),
        "cloud_source": "ascent-derived",
        "sample_time": utcnow_iso(now),
        "score": round(100.0 * multiplier, 3),
        "score_components": {
            "p_unobstructed": round(pred.obstruction_cloud_score * 100.0, 2),
            "regime_fit": 100.0,
            "nadir_proximity": round(100.0 * multiplier, 2),
            "priority_weight": 100.0,
            "tle_freshness": 1.0,
        },
        "iss_at_closest": {
            "lat": round(pred.iss_position.lat, 4),
            "lon": round(pred.iss_position.lon, 4),
            "alt_km": round(pred.iss_position.alt_km, 1),
        },
        "launch": {
            "name": la.name,
            "rocket_type": la.rocket_type,
            # `geometry` kept for v1.2.6.x reader compat; will retire when
            # all stored snapshots have rolled past kind-aware versions.
            "geometry": "ascent",
            "kind": "ascent",
            "site_name": la.site_name,
            "net_window_seconds": la.net_window_seconds,
            "t0": utcnow_iso(la.t0),
            "pad_lat": round(pred.pad_lat, 4),
            "pad_lon": round(pred.pad_lon, 4),
            "launch_azimuth_deg": round(pred.launch_azimuth_deg, 1),
            "trajectory": trajectory_payload,
        },
    }


def _reserve_launch_slot(
    upcoming: list[dict[str, Any]],
    launch_pass_entries: list[dict[str, Any]],
    now: datetime,
    horizon_minutes: float,
) -> list[dict[str, Any]]:
    """ARCH-4 (eng review 2026-05-05): if a qualifying launch exists in the
    upcoming time window (>=horizon_minutes from now, matching the upstream
    upcoming filter) AND it isn't already in the score-sorted top-N, insert
    it (displacing the lowest-scoring ground entry).

    'Qualifying' = pass_finding returned an opportunity (overhead geometry
    OK) AND the closest_approach is in the upcoming horizon window. Picking
    the soonest by t_closest is the right tiebreaker — operator's mental
    model is "what's coming next."
    """
    in_window = [
        p for p in launch_pass_entries
        if (datetime.fromisoformat(p["closest_approach"].replace("Z", "+00:00")) - now)
            >= timedelta(minutes=horizon_minutes)
    ]
    return _insert_soonest_if_missing(upcoming, in_window, DEFAULT_TOP_UPCOMING)


def _reserve_launch_slot_in_queue(
    next_90: list[dict[str, Any]],
    launch_pass_entries: list[dict[str, Any]],
    now: datetime,
    queue_horizon_minutes: float,
) -> list[dict[str, Any]]:
    """Queue (next-90-min) sibling of `_reserve_launch_slot` (added 2026-05-10
    after /review caught that the Upcoming-only ARCH-4 left imminent
    launches buried by score in the Queue view — exactly the highest-stakes
    case the operator must NOT miss).

    Predicate is the inverse: launches WITHIN the queue window (0 < t < 90min)
    qualify, vs upcoming's "outside the queue window" rule. Same insert/displace
    logic, same soonest-by-time tiebreaker.
    """
    in_window = [
        p for p in launch_pass_entries
        if timedelta(0) < (
            datetime.fromisoformat(p["closest_approach"].replace("Z", "+00:00")) - now
        ) < timedelta(minutes=queue_horizon_minutes)
    ]
    return _insert_soonest_if_missing(next_90, in_window, DEFAULT_TOP_QUEUE)


def _insert_soonest_if_missing(
    target_list: list[dict[str, Any]],
    in_window: list[dict[str, Any]],
    max_size: int,
) -> list[dict[str, Any]]:
    """Shared helper for both reserve-slot paths. Picks the soonest qualifying
    entry, inserts if not already present, displaces the lowest-scoring entry
    to keep `target_list` at `max_size`, returns score-sorted result."""
    if not in_window:
        return target_list
    already = {(p["target_id"], p["closest_approach"]) for p in target_list}
    missing = [p for p in in_window if (p["target_id"], p["closest_approach"]) not in already]
    if not missing:
        return target_list
    next_launch = min(missing, key=lambda p: p["closest_approach"])
    if len(target_list) >= max_size:
        target_list = target_list[:-1] + [next_launch]
    else:
        target_list = list(target_list) + [next_launch]
    return sorted(target_list, key=lambda p: p["score"], reverse=True)


@contextmanager
def _tick_lock(out_dir: Path) -> Iterator[None]:
    """Hold an exclusive flock for the duration of a tick.

    Two daemons or a manual `make tick` co-running with the daemon would
    both call cleanup_old_versions and both deploy, racing each other on
    R2 and the local out/ tree. The lock fails fast (LOCK_NB) so the
    second caller surfaces the misconfiguration as a RuntimeError rather
    than silently corrupting state.

    Lock file: <out_dir>/.tick.lock. Released on exit even if the body
    raises (file close also releases on Linux/macOS). POSIX-only — fine
    for Mac on Earth + the launchd setup we ship.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    lock_path = out_dir / ".tick.lock"
    f = open(lock_path, "w")
    try:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(
                f"another tick is already running (lock: {lock_path}); "
                "check `ps` for a stale daemon or manual tick before retrying"
            ) from exc
        yield
    finally:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        except Exception:  # noqa: BLE001, S110
            pass
        f.close()


def run_tick(settings: Settings, now: datetime | None = None) -> dict[str, Any]:
    """Run one generator tick. Returns the manifest contents."""
    n = now or datetime.now(tz=UTC)
    settings.ensure_dirs()

    with _tick_lock(settings.out_dir):
        return _run_tick_body(settings, n)


def _run_tick_body(settings: Settings, n: datetime) -> dict[str, Any]:
    """Inner tick body — runs under the flock from run_tick."""
    log.info("tick start: %s", utcnow_iso(n))

    # 1. TLE
    tle_cache = settings.cache_dir / "iss.tle"
    tle = fetch_tle(settings.tle_url, tle_cache, ttl_hours=1.0, now=n)
    age_h = tle_age_hours(tle, n)
    if age_h > TLE_HARD_FAIL_HOURS:
        # Predictions will be off by hundreds of km. Better to fail loudly than
        # silently publish wrong shot times. UptimeRobot will alert on staleness.
        raise RuntimeError(
            f"TLE age {age_h:.1f}h exceeds hard-fail threshold ({TLE_HARD_FAIL_HOURS}h); "
            "refusing to publish. Refresh Celestrak network access."
        )
    fresh = freshness_factor(age_h)
    log.info("TLE epoch=%s age=%.1fh freshness=%.2f", utcnow_iso(tle.epoch), age_h, fresh)

    # 2. Cloud sampler (observed: MODIS / GOES-IR / Himawari)
    sampler, composite_hour, source_label = select_cloud_sampler(settings, n)

    # 3. Targets
    targets = load_targets(settings.targets_file)
    log.info("loaded %d targets", len(targets))

    # 4. Forecast cloud sampler (GFS via Open-Meteo) — covers passes >90min
    # ahead where observed cloud is irrelevant. Pre-fetches all target
    # forecasts in batched HTTP calls so per-pass scoring is O(1) lookup.
    # If the fetch fails, downstream passes get "gfs-forecast-no-data" and
    # the tick keeps going.
    forecast_sampler: GFSForecastSampler | None = None
    try:
        target_coords = [(t["geom"]["lat"], t["geom"]["lon"]) for t in targets]
        forecast_sampler = GFSForecastSampler(target_coords)
        log.info("GFS forecast sampler ready for %d targets", len(target_coords))
    except Exception as exc:  # noqa: BLE001
        log.warning("GFS forecast init failed (%s); upcoming passes will use fallback", exc)

    # 4b. Weather v1.3 samplers (lightning + hurricane). Both gated on
    # settings.enable_weather. v1.5.5.0 (weather v1.3.2) replaces the
    # placeholder lightning sampler with the real CombinedLightningSampler
    # fusing GLM (observed) + GFS-CAPE (forecast). PlaceholderLightning
    # is still the final fallback if both real samplers fail.
    lightning_sampler_obj = None
    hurricane_tracker_obj = None
    # Function-scoped so the per-profile multiplex can top it up with personal
    # coords (same fix as the cloud forecast_sampler). None when weather is
    # disabled or CAPE init fails.
    cape_sampler_obj: Any = None
    if settings.enable_weather:
        from .lightning import (
            CombinedLightningSampler,
            GFSCAPELightningSampler,
            GLMSampler,
            NHCHurricaneTracker,
            PlaceholderLightningSampler,
        )
        # Build a GFS sampler that includes CAPE alongside cloud_cover.
        # Same Open-Meteo endpoint as the existing GFSForecastSampler —
        # zero extra HTTP calls.
        if targets:
            try:
                # GFSForecastSampler is already imported at module scope (line 34).
                cape_sampler_obj = GFSForecastSampler(
                    targets=[(t["geom"]["lat"], t["geom"]["lon"]) for t in targets],
                    forecast_days=settings.pass_window_hours // 24 + 1,
                    include_cape=True,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("GFS-CAPE sampler init failed (%s)", exc)
        # GLM is constructed once per tick — fetches the last 60 min of
        # granules from GOES-East+West, decodes into a spatial index.
        glm_obj: Any = None
        try:
            glm_obj = GLMSampler(when=n)
        except Exception as exc:  # noqa: BLE001
            log.warning("GLM sampler init failed (%s); falling back to forecast-only", exc)
        gfs_lightning_obj = GFSCAPELightningSampler(cape_sampler_obj) if cape_sampler_obj else None
        if glm_obj is not None or gfs_lightning_obj is not None:
            lightning_sampler_obj = CombinedLightningSampler(
                observed=glm_obj,
                forecast=gfs_lightning_obj,
            )
        else:
            lightning_sampler_obj = PlaceholderLightningSampler()
        hurricane_tracker_obj = NHCHurricaneTracker(
            cache_path=settings.cache_dir / "nhc-storms.json",
            ttl_hours=1.0,
        )
        try:
            hurricane_tracker_obj.refresh(now=n)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "NHC refresh raised (%s); proceeding without hurricane proximity this tick",
                exc,
            )

    # 5. Find + score passes
    window_end = n + timedelta(hours=settings.pass_window_hours)
    all_passes: list[dict[str, Any]] = []
    for target in targets:
        passes = find_passes(
            tle=tle,
            target=target,
            window_start=n,
            window_end=window_end,
            step_seconds=PASS_SAMPLE_STEP_SECONDS,
            max_distance_km=PASS_MAX_DISTANCE_KM,
            preroll_seconds=ENCOUNTER_PREROLL_SECONDS,
        )
        for p in passes:
            all_passes.append(score_pass_for_target(
                target, p, sampler, fresh,
                forecast_sampler=forecast_sampler,
                now=n,
                composite_hour=composite_hour,
                lightning_sampler=lightning_sampler_obj,
                hurricane_tracker=hurricane_tracker_obj,
            ))
    log.info("found %d passes across %d targets", len(all_passes), len(targets))

    # 5b. Launch pipeline (V3.0). Treat each upcoming launch's site as a
    # synthetic target with a ±5min window around T-0; reuse find_passes +
    # score_pass_for_target. Per the eng review:
    #   ARCH-1: launches health folds into status.json (no separate artifact)
    #   ARCH-2: card render gets a `launch` field for the 🚀 LAUNCH tag
    #   ARCH-4: reserved-slot guarantee — at least one qualifying launch
    #           always lands in upcoming, even if score loses to ground passes
    #
    # Failure mode: if LL2 is down, fetch_upcoming_launches returns an empty
    # FetchResult and we publish without launches. status.json reflects the
    # last_successful_fetch so the frontend can show the stale-launches
    # banner overlay (V4 work; not in this lane).
    launches_cache = settings.cache_dir / "launches.json"
    launch_fetch = fetch_upcoming_launches(launches_cache, ttl_hours=1.0, now=n)
    actionable_launches = filter_launches(launch_fetch.launches)
    launch_pass_entries: list[dict[str, Any]] = []
    for la in actionable_launches:
        site_target = _synthesize_launch_target(la)
        # Narrower window than ground targets because the launch has a hard
        # T-0 — there's no point asking for passes 4 hours after a 5-min
        # launch event.
        l_passes = find_passes(
            tle=tle,
            target=site_target,
            window_start=la.t0 - timedelta(seconds=LAUNCH_PASS_WINDOW_SECONDS),
            window_end=la.t0 + timedelta(seconds=LAUNCH_PASS_WINDOW_SECONDS),
            step_seconds=PASS_SAMPLE_STEP_SECONDS,
            max_distance_km=PASS_MAX_DISTANCE_KM,
        )
        for p in l_passes:
            entry = score_pass_for_target(
                site_target, p, sampler, fresh,
                forecast_sampler=forecast_sampler,
                now=n,
                composite_hour=composite_hour,
                lightning_sampler=lightning_sampler_obj,
                hurricane_tracker=hurricane_tracker_obj,
            )
            entry["launch"] = {
                "name": la.name,
                "rocket_type": la.rocket_type,
                # `geometry` is the V3.0 legacy field; `kind` is the V3-P2
                # discriminator (overhead vs ascent). Both written for now;
                # frontend reads `kind` with fallback to `geometry`.
                "geometry": "overhead",
                "kind": "overhead",
                "site_name": la.site_name,
                "net_window_seconds": la.net_window_seconds,
                "t0": utcnow_iso(la.t0),
            }
            launch_pass_entries.append(entry)
    if launch_pass_entries:
        log.info(
            "found %d launch-pass opportunities (out of %d actionable launches)",
            len(launch_pass_entries), len(actionable_launches),
        )
    all_passes.extend(launch_pass_entries)

    # 5c. ASCENT pipeline (V3-P2). Gated by OPD_ENABLE_ASCENT (on in prod
    # since 2026-05-17). Uses a much looser NET window than OVERHEAD —
    # filter_ascent_launches accepts up to 6h of t0 uncertainty because
    # the trajectory's ground track shape is t0-independent (only WHEN it
    # flies shifts, not WHERE). predict_ascent_pass walks the profile at
    # 15s cadence and picks the best viewable instant within the window.
    # The OVERHEAD + ASCENT entries for the same launch coexist per D7.
    ascent_actionable = filter_ascent_launches(launch_fetch.launches)
    ascent_pass_entries: list[dict[str, Any]] = []
    if settings.enable_ascent and ascent_actionable:
        for la in ascent_actionable:
            pred = predict_ascent_pass(
                launch={
                    "rocket": {"configuration": {
                        # match_rocket uses these strings to resolve a profile;
                        # we only have la.rocket_type (the LL2 `full_name`).
                        "full_name": la.rocket_type,
                    }},
                    # Inclination unknown at launch_data layer (LL2 stores it
                    # under mission.orbit.inclination but we don't surface it
                    # in Launch yet). Default to ISS-rendezvous inclination
                    # 51.6° — most ISS-photographable launches target that or
                    # similar; SSO/polar will be slightly off but the soak
                    # will surface any cases that need real inclination data.
                    "mission": {"orbit": {"inclination": 51.6}},
                },
                pad_lat_deg=la.site_lat,
                pad_lon_deg=la.site_lon,
                t0_utc=la.t0,
                iss_tle=tle,
                cloud_sampler=sampler,
            )
            if pred is None:
                continue
            ascent_pass_entries.append(_build_ascent_pass_entry(la, pred, n))
        if ascent_pass_entries:
            log.info(
                "found %d ASCENT opportunities out of %d ascent-eligible launches "
                "(OPD_ENABLE_ASCENT=1)",
                len(ascent_pass_entries), len(ascent_actionable),
            )
        all_passes.extend(ascent_pass_entries)
    # Reserved-slot logic (ARCH-4) treats both kinds as launch passes for
    # the slot guarantee. Combine for that step.
    launch_pass_entries = launch_pass_entries + ascent_pass_entries

    # 5. Write versioned artifacts
    version = version_id(n)
    v_dir = settings.out_dir / "v" / version
    v_dir.mkdir(parents=True, exist_ok=True)

    # 5a. Build the canonical (curated-only) views + status + write them
    # to the legacy artifact paths (passes.json, top5.json, top_24h.json,
    # status.json). These are kept untouched for back-compat with
    # pre-v1.6.7 frontend builds — the slot 5 dual-source merge consumes
    # the new per-profile variants instead.
    canonical_artifacts = _write_view_artifacts(
        v_dir=v_dir,
        all_passes=all_passes,
        launch_pass_entries=launch_pass_entries,
        n=n,
        settings=settings,
        source_label=source_label,
        composite_hour=composite_hour,
        age_h=age_h,
        fresh=fresh,
        target_count=len(targets),
        launch_fetch=launch_fetch,
        actionable_launches=actionable_launches,
        ascent_actionable=ascent_actionable,
        version=version,
        profile_name=None,
    )

    # Polynomial (120 min) — kept for legacy boot snapshots; v1.4.6.0
    # switched the live dot to SGP4-first so this no longer drives the
    # primary path.
    # track_points (372 min ≈ 4 ISS orbits @ 92.8 min) drives the map's
    # ground-track polyline. v1.5.0.0 (Pettit feedback 2026-05-19,
    # "multi-orbit display") extended the window from 200 → 372 min so
    # the frontend can render 4 future orbits with progressive opacity
    # under a single toggle. ~17.8 KB JSON, ~5 KB gzipped.
    track_data = {
        "iss_polynomial": fit_iss_polynomial(tle, n, minutes=120),
        "track_points": sample_track_points(tle, n, minutes=372, step_seconds=30),
        "tle": {"line1": tle.line1, "line2": tle.line2},
        "tle_epoch": utcnow_iso(tle.epoch),
        "tle_age_hours": round(age_h, 2),
        "tle_freshness_factor": round(fresh, 3),
    }
    (v_dir / "track.json").write_text(json.dumps(track_data, indent=2))

    # Targets snapshot for the frontend
    target_data_version = "v1"
    (v_dir / "targets.json").write_text(json.dumps(targets, indent=2))

    # 5b. Per-profile multiplex (Slot 4, design rev 2). For each profile
    # name in config.PROFILE_NAMES, fetch their personal targets from the
    # Worker, union them with the curated 137, and run the existing
    # scoring pipeline a second time against the per-profile target list.
    # Writes `passes_<name>.json` + friends; the canonical artifacts above
    # are untouched. Fetch failures fall through to curated-only per
    # profile (still writes per-profile artifacts so the frontend can
    # render that profile's view, just without their personal additions).
    profile_artifacts: dict[str, dict[str, Path]] = {}
    if multiplex_enabled():
        for name in profile_names():
            try:
                profile_artifacts[name] = _run_profile_multiplex(
                    profile_name=name,
                    curated_targets=targets,
                    tle=tle,
                    fresh=fresh,
                    sampler=sampler,
                    forecast_sampler=forecast_sampler,
                    cape_sampler_obj=cape_sampler_obj,
                    composite_hour=composite_hour,
                    lightning_sampler_obj=lightning_sampler_obj,
                    hurricane_tracker_obj=hurricane_tracker_obj,
                    launch_pass_entries=launch_pass_entries,
                    n=n,
                    settings=settings,
                    v_dir=v_dir,
                    source_label=source_label,
                    age_h=age_h,
                    launch_fetch=launch_fetch,
                    actionable_launches=actionable_launches,
                    ascent_actionable=ascent_actionable,
                    version=version,
                )
            except Exception as exc:  # noqa: BLE001
                # Per-profile failure must not fail the whole tick. The
                # multiplex helpers already catch fetch errors; this is a
                # belt-and-braces guard for anything unexpected in
                # find_passes/scoring/write under a profile target list.
                log.exception(
                    "profile multiplex failed for %s: %s — skipping this profile this tick",
                    name,
                    exc,
                )

    # 5d. Forecast cloud frames (V4-P2). Gated by OPD_ENABLE_FORECAST_CLOUDS.
    # Renders at most once per GFS run (write_frames no-ops between runs);
    # any failure logs + omits the manifest key so the frontend stays on the
    # observed layer (locked A4 fallback — never blank, never stale-labeled).
    forecast_clouds_index: dict[str, Any] | None = None
    if settings.enable_forecast_clouds:
        try:
            from .forecast_clouds import write_frames

            forecast_clouds_index = write_frames(settings.out_dir, n)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "forecast cloud frames failed (%s); manifest omits forecast_clouds",
                exc,
            )

    # 6. Manifest
    artifacts_block: dict[str, Path] = {
        "passes": canonical_artifacts["passes"],
        "top5": canonical_artifacts["top5"],
        "top_24h": canonical_artifacts["top_24h"],
        "track": v_dir / "track.json",
        "status": canonical_artifacts["status"],
        "targets": v_dir / "targets.json",
    }
    manifest_path = write_manifest(
        out_dir=settings.out_dir,
        version=version,
        generated_at=n,
        tle_epoch=tle.epoch,
        cloud_composite_hour=composite_hour,
        target_data_version=target_data_version,
        build_version=__version__,
        artifacts=artifacts_block,
        profile_artifacts=profile_artifacts,
        forecast_clouds=forecast_clouds_index,
    )

    deleted = cleanup_old_versions(settings.out_dir, keep_minutes=60)
    if deleted:
        log.info("cleaned %d old versions", len(deleted))

    log.info("tick complete: version=%s passes=%d profiles=%d", version,
             len(all_passes), len(profile_artifacts))
    return json.loads(manifest_path.read_text())


def _write_view_artifacts(
    *,
    v_dir: Path,
    all_passes: list[dict[str, Any]],
    launch_pass_entries: list[dict[str, Any]],
    n: datetime,
    settings: Settings,
    source_label: str,
    composite_hour: datetime,
    age_h: float,
    fresh: float,
    target_count: int,
    launch_fetch: Any,
    actionable_launches: list[Any],
    ascent_actionable: list[Any],
    version: str,
    profile_name: str | None,
) -> dict[str, Path]:
    """Compute the next-90-min queue, top-25 map list, upcoming window,
    status block from a given `all_passes` set, and write the per-view
    JSON artifacts to disk.

    When `profile_name` is None: writes the canonical files
    (passes.json / top5.json / top_24h.json / status.json) — preserves
    the existing pre-Slot-4 output paths.

    When `profile_name` is set: writes the per-profile files
    (passes_<name>.json / top5_<name>.json / top_24h_<name>.json /
    status_<name>.json) — new Slot 4 output. Returns the four artifact
    paths so the manifest builder can reference them.
    """
    next_90 = sorted(
        [p for p in all_passes if datetime.fromisoformat(
            p["closest_approach"].replace("Z", "+00:00")
        ) - n < timedelta(minutes=90)],
        key=lambda p: p["score"],
        reverse=True,
    )[:DEFAULT_TOP_QUEUE]

    # ARCH-4 extension (review 2026-05-10): same reserved-slot logic for the
    # Queue. Adversarial review caught that a mid-day Falcon 9 with average
    # cloud forecast routinely loses to 5 priority-5 ground passes — the
    # Queue is the operator's PRIMARY action surface, so burying a launch
    # there is the worst-case product failure for V3.
    next_90 = _reserve_launch_slot_in_queue(
        next_90, launch_pass_entries, n, queue_horizon_minutes=90,
    )

    top25 = top_n(all_passes, DEFAULT_TOP_MAP)

    upcoming = sorted(
        [
            p for p in all_passes
            if (datetime.fromisoformat(p["closest_approach"].replace("Z", "+00:00")) - n)
                >= timedelta(minutes=OBSERVED_CLOUD_HORIZON_MINUTES)
        ],
        key=lambda p: p["score"],
        reverse=True,
    )[:DEFAULT_TOP_UPCOMING]

    upcoming = _reserve_launch_slot(
        upcoming, launch_pass_entries, n, OBSERVED_CLOUD_HORIZON_MINUTES,
    )

    # "Real observation" = any source that gave a real measurement.
    # Match the frontend's no-observation set in card.ts:NO_OBSERVATION_SOURCES.
    observed_count = sum(
        1 for p in all_passes
        if p["cloud_source"] == "gibs"
        or (
            p["cloud_source"].startswith("geo-ir-")
            and not p["cloud_source"].endswith(("-nodata", "-no-coverage"))
        )
        or p["cloud_source"] == "meteosat-ir108"
        or p["cloud_source"] == "himawari-nict"
        or p["cloud_source"] == "satcorps"
        or p["cloud_source"] == "gfs-forecast"
    )
    status_data: dict[str, Any] = {
        "last_run": utcnow_iso(n),
        "tick_minutes": settings.tick_minutes,
        "tle_age_hours": round(age_h, 2),
        "tle_freshness_factor": round(fresh, 3),
        "cloud_source": source_label,
        "cloud_composite_hour": utcnow_iso(composite_hour),
        "target_count": target_count,
        "pass_count": len(all_passes),
        "passes_with_real_observation": observed_count,
        "passes_with_no_observation": len(all_passes) - observed_count,
        "version": version,
        "build_version": __version__,
        "launches_last_successful_fetch": (
            utcnow_iso(launch_fetch.last_successful_fetch)
            if launch_fetch.last_successful_fetch is not None else None
        ),
        "launches_count_upcoming": len(actionable_launches),
        "launches_count_ascent_eligible": len(ascent_actionable),
        "launches_count_pass_opportunities": len(launch_pass_entries),
        "launches_schema_hash": launch_fetch.schema_hash,
    }
    if profile_name is not None:
        # New field — surfaces which profile this status describes when a
        # status_<name>.json is fetched out of band (debugging, logs).
        status_data["profile"] = profile_name

    suffix = f"_{profile_name}" if profile_name else ""
    passes_path = v_dir / f"passes{suffix}.json"
    top5_path = v_dir / f"top5{suffix}.json"
    top_24h_path = v_dir / f"top_24h{suffix}.json"
    status_path = v_dir / f"status{suffix}.json"

    passes_path.write_text(json.dumps(top25, indent=2))
    top5_path.write_text(json.dumps(next_90, indent=2))
    top_24h_path.write_text(json.dumps(upcoming, indent=2))
    status_path.write_text(json.dumps(status_data, indent=2))

    return {
        "passes": passes_path,
        "top5": top5_path,
        "top_24h": top_24h_path,
        "status": status_path,
    }


def _run_profile_multiplex(
    *,
    profile_name: str,
    curated_targets: list[dict[str, Any]],
    tle: TLE,
    fresh: float,
    sampler: CloudSampler,
    forecast_sampler: Any,
    cape_sampler_obj: Any = None,
    composite_hour: datetime,
    lightning_sampler_obj: Any,
    hurricane_tracker_obj: Any,
    launch_pass_entries: list[dict[str, Any]],
    n: datetime,
    settings: Settings,
    v_dir: Path,
    source_label: str,
    age_h: float,
    launch_fetch: Any,
    actionable_launches: list[Any],
    ascent_actionable: list[Any],
    version: str,
) -> dict[str, Path]:
    """Run one profile's multiplex slice. Fetches the profile's targets,
    unions with curated, runs the existing pass-finding + scoring loop,
    and writes the four per-profile artifacts. Returns the artifact paths
    for the manifest.

    Launches are scored once globally (no per-profile launch list — every
    profile sees the same launches), so we reuse `launch_pass_entries`
    from the caller verbatim.
    """
    profile_data = fetch_profile_targets(profile_name)
    profile_target_list = build_profile_target_list(
        curated=curated_targets,
        personal=profile_data["targets"],
        removed_curated_ids=profile_data["removed_curated_ids"],
    )

    # Top up the (curated-seeded) forecast + CAPE samplers with this profile's
    # coords so personal targets get real GFS forecast cloud (and forecast-CAPE
    # lightning) in Upcoming instead of the cf=50 "gfs-forecast-no-data"
    # placeholder. add_targets only fetches 0.25° grid cells not already cached,
    # so curated coords are skipped — the cost is one batched call per profile
    # for genuinely new personal cells. Without this, personal-target Upcoming
    # scores run on a flat 50% cloud guess, silently mis-ranking exactly the
    # targets the operator added.
    profile_coords = [(t["geom"]["lat"], t["geom"]["lon"]) for t in profile_target_list]
    for label, smp in (("forecast", forecast_sampler), ("cape", cape_sampler_obj)):
        if smp is not None:
            try:
                smp.add_targets(profile_coords)
            except Exception as exc:  # noqa: BLE001
                log.warning("%s add_targets failed for %s (%s)", label, profile_name, exc)

    # Compute ground-target passes for the per-profile target list. We
    # iterate ALL targets here (not just personal): curated targets'
    # scores are deterministic given (target, TLE, sampler, n), so they
    # match the canonical run byte-for-byte. Re-running them costs ~tens
    # of ms per target — acceptable for v1; v2 can memoize curated
    # scores across profiles if tick time becomes a problem.
    window_end = n + timedelta(hours=settings.pass_window_hours)
    profile_passes: list[dict[str, Any]] = []
    for target in profile_target_list:
        passes = find_passes(
            tle=tle,
            target=target,
            window_start=n,
            window_end=window_end,
            step_seconds=PASS_SAMPLE_STEP_SECONDS,
            max_distance_km=PASS_MAX_DISTANCE_KM,
            preroll_seconds=ENCOUNTER_PREROLL_SECONDS,
        )
        for p in passes:
            profile_passes.append(score_pass_for_target(
                target, p, sampler, fresh,
                forecast_sampler=forecast_sampler,
                now=n,
                composite_hour=composite_hour,
                lightning_sampler=lightning_sampler_obj,
                hurricane_tracker=hurricane_tracker_obj,
            ))

    # Launches are shared across all profiles (Anil curates the launch
    # list, like the curated targets). Append the already-scored launch
    # entries to this profile's pass list before view building.
    all_passes = profile_passes + launch_pass_entries
    log.info(
        "profile %s: %d targets → %d ground passes (+%d launch entries)",
        profile_name, len(profile_target_list), len(profile_passes),
        len(launch_pass_entries),
    )

    return _write_view_artifacts(
        v_dir=v_dir,
        all_passes=all_passes,
        launch_pass_entries=launch_pass_entries,
        n=n,
        settings=settings,
        source_label=source_label,
        composite_hour=composite_hour,
        age_h=age_h,
        fresh=fresh,
        target_count=len(profile_target_list),
        launch_fetch=launch_fetch,
        actionable_launches=actionable_launches,
        ascent_actionable=ascent_actionable,
        version=version,
        profile_name=profile_name,
    )


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = Settings.from_env()
    try:
        run_tick(settings)
        return 0
    except Exception:
        log.exception("tick failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
