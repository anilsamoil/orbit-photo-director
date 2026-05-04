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
    OBSERVED_CLOUD_HORIZON_MINUTES,
    PASS_MAX_DISTANCE_KM,
    PASS_SAMPLE_STEP_SECONDS,
    Settings,
    load_targets,
)
from .manifest import cleanup_old_versions, utcnow_iso, version_id, write_manifest
from .orbit import (
    TLE,
    angle_off_nadir_deg,
    detect_reboost,
    find_passes,
    fit_iss_polynomial,
    freshness_factor,
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
    prior: TLE | None = None
    if cache_path.exists():
        try:
            prior = TLE.from_text(cache_path.read_text())
        except (ValueError, OSError):
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
    return {
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
        "pass_regime": regime,
        "obstruction_class": obs.obstruction_class,
        "p_unobstructed": round(p_unobs_adjusted, 2),
        "cloud_fraction": round(sample.cloud_fraction, 2),
        "cloud_source": sample.source,
        "score": round(sc.final, 3),
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
        )
        for p in passes:
            all_passes.append(score_pass_for_target(
                target, p, sampler, fresh,
                forecast_sampler=forecast_sampler,
                now=n,
            ))
    log.info("found %d passes across %d targets", len(all_passes), len(targets))

    # 5. Write versioned artifacts
    version = version_id(n)
    v_dir = settings.out_dir / "v" / version
    v_dir.mkdir(parents=True, exist_ok=True)

    next_90 = sorted(
        [p for p in all_passes if datetime.fromisoformat(
            p["closest_approach"].replace("Z", "+00:00")
        ) - n < timedelta(minutes=90)],
        key=lambda p: p["score"],
        reverse=True,
    )[:DEFAULT_TOP_QUEUE]

    top25 = top_n(all_passes, DEFAULT_TOP_MAP)

    # Upcoming view: top forecast-scored passes spanning the full pass window
    # (defaults to 24h). Excludes the next-90-min passes already in `next_90`
    # so the two views don't double up.
    upcoming = sorted(
        [
            p for p in all_passes
            if (datetime.fromisoformat(p["closest_approach"].replace("Z", "+00:00")) - n)
                >= timedelta(minutes=OBSERVED_CLOUD_HORIZON_MINUTES)
        ],
        key=lambda p: p["score"],
        reverse=True,
    )[:DEFAULT_TOP_UPCOMING]

    # Polynomial (120 min) drives the precise live ISS marker.
    # track_points (200 min ≈ 2 ISS orbits) drives the map's ground-track
    # polyline — same SGP4 source as the polynomial but no fit drift past
    # the polynomial's window. ~9.6 KB JSON, ~3 KB gzipped.
    track_data = {
        "iss_polynomial": fit_iss_polynomial(tle, n, minutes=120),
        "track_points": sample_track_points(tle, n, minutes=200, step_seconds=30),
        "tle": {"line1": tle.line1, "line2": tle.line2},
        "tle_epoch": utcnow_iso(tle.epoch),
        "tle_age_hours": round(age_h, 2),
        "tle_freshness_factor": round(fresh, 3),
    }

    # "Real observation" = any source that gave a real measurement, not a fallback:
    #   gibs            (MODIS direct cloud fraction, 1-100)
    #   geo-ir-{tag}    (GOES-East/-West IR converted via brightness threshold)
    #   himawari-nict   (NICT Himawari true-color RGB; daytime Asia/W.Pacific only)
    #   satcorps        (SatCORPS NetCDF when wired up)
    #   gfs-forecast    (GFS forecast for passes >90 min ahead — different
    #                   confidence band but still a real signal, not a guess)
    # Match the frontend's no-observation set in card.ts:NO_OBSERVATION_SOURCES.
    # `startswith("geo-ir-")` alone would over-count: geo-ir-nodata and
    # geo-ir-no-coverage are fallback cf=50 placeholders, not real observations.
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
    status_data = {
        "last_run": utcnow_iso(n),
        "tick_minutes": settings.tick_minutes,
        "tle_age_hours": round(age_h, 2),
        "tle_freshness_factor": round(fresh, 3),
        "cloud_source": source_label,
        "cloud_composite_hour": utcnow_iso(composite_hour),
        "target_count": len(targets),
        "pass_count": len(all_passes),
        "passes_with_real_observation": observed_count,
        "passes_with_no_observation": len(all_passes) - observed_count,
        "version": version,
        "build_version": __version__,
    }

    (v_dir / "passes.json").write_text(json.dumps(top25, indent=2))
    (v_dir / "top5.json").write_text(json.dumps(next_90, indent=2))
    (v_dir / "top_24h.json").write_text(json.dumps(upcoming, indent=2))
    (v_dir / "track.json").write_text(json.dumps(track_data, indent=2))
    (v_dir / "status.json").write_text(json.dumps(status_data, indent=2))

    # Targets snapshot for the frontend
    target_data_version = "v1"
    (v_dir / "targets.json").write_text(json.dumps(targets, indent=2))

    # 6. Manifest
    manifest_path = write_manifest(
        out_dir=settings.out_dir,
        version=version,
        generated_at=n,
        tle_epoch=tle.epoch,
        cloud_composite_hour=composite_hour,
        target_data_version=target_data_version,
        build_version=__version__,
        artifacts={
            "passes": v_dir / "passes.json",
            "top5": v_dir / "top5.json",
            "top_24h": v_dir / "top_24h.json",
            "track": v_dir / "track.json",
            "status": v_dir / "status.json",
            "targets": v_dir / "targets.json",
        },
    )

    deleted = cleanup_old_versions(settings.out_dir, keep_minutes=60)
    if deleted:
        log.info("cleaned %d old versions", len(deleted))

    log.info("tick complete: version=%s passes=%d", version, len(all_passes))
    return json.loads(manifest_path.read_text())


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
