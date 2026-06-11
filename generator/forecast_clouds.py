"""Forecast cloud-frame renderer (V4-P2, eng review 2026-06-09, rev 2026-06-10).

Renders the GFS cloud-fraction forecast as WebMercator z0-3 PNG tile frames so
the map's cloud raster can follow the time-slider: scrub to +N and the
frontend swaps yesterday's observed GIBS composite for the forecast frame
nearest the view instant. Closes the pin-vs-raster trust mismatch the
operator reported 2026-05-20 ("the pins say forecast, the map underneath
says yesterday").

Shape (locked decisions A1-A7 + P1-P3 as revised):
- 5° global grid (36×72; P1 as revised — see the Revision 3 note at the
  grid constants) sampled through the existing GFSForecastSampler — one
  sweep returns the full multi-day hourly series, so every frame renders
  from that single paced sweep (~26 batched calls / 2,592 location-requests
  per render, twice a day).
- Tiered frames anchored at the GFS run (P3 rev 2026-06-10, slider eng
  review): hourly for run+0..6h, 3-hourly for run+9..48h → 21 frames. The
  +48h tail keeps the slider's full +36h range covered even at the end of a
  render cycle's ~12h life.
- Frames are white-alpha scalar tiles (A6): alpha ramps with cloud fraction,
  fully transparent under RAMP_FLOOR_CF so clear sky never hazes the
  basemap. Ramp constants are module-level for the /plan-design-review pass.
- REVISION 2 (2026-06-10, this implementation): frames live at the STABLE
  run-keyed path out/clouds-fcst/<run>/<validtime>/{z}/{x}/{y}.png — NOT
  under out/v/<version>/ as A1 originally keyed them. The versioned dir gets
  a new path every 60-min tick, so rclone would re-upload all ~1,615 tiles
  24×/day (~1.2M R2 writes/month) instead of once per GFS run (~194k/month,
  the cost the plan approved). Run-keyed paths preserve every property A1
  bought: new run → new path (cache-busting), index written last inside the
  dir + whole-dir atomic rename (publish atomicity, A7), and bounded storage
  via the KEEP_RUNS prune below. deploy.sh copies the dir additively before
  the manifest flip and syncs the prune after it.
- The GFS run id is the latest synoptic cycle (00/06/12/18Z) old enough to
  be published (~GFS_AVAILABILITY_LAG_H). Open-Meteo does not expose the
  actual model run, so this is the honest best label for "which forecast
  cycle these frames most likely derive from" — and, more importantly, it
  is the render-cadence gate (P2): one render per run, ticks in between
  no-op.

Manifest contract (consumed by frontend nearestForecastFrame):
    manifest.forecast_clouds = {
        "gfs_run":     "2026-06-10T06:00:00Z",
        "prefix":      "clouds-fcst/20260610T060000Z",
        "valid_times": ["2026-06-10T06:00:00Z", ...],
        "max_zoom":    3,
    }
Flag off / render failed / Open-Meteo down → the key is absent and the
frontend stays on the observed layer (locked three-layer fallback, A4).
"""

from __future__ import annotations

import io
import json
import logging
import shutil
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from PIL import Image

from .cloud import OPEN_METEO_TIMEOUT_SECONDS, GFSForecastSampler

log = logging.getLogger(__name__)

# --- Grid (P1 REVISED — Revision 3, live smoke 2026-06-10) ------------------
# The locked 2.5° grid assumed Open-Meteo meters HTTP requests (104/sweep);
# it actually meters LOCATIONS: 10,368 loc-req/sweep blew the ~5k/hour free
# cap (verified live: a 1.9h sweep of sustained 429s) and 4 runs/day would
# be ~41k/day against a 10k/day budget — while 429-starving the production
# daemon's pass-scoring fetches on this same IP. 5° × 2 renders/day =
# 5,184 loc-req/day (~52% of budget) and one sweep fits a single hourly
# window. Still synoptic-honest at z0-3; bump back via these constants if a
# paid key ever lands.
GRID_STEP_DEG = 5.0
GRID_LATS = np.arange(-87.5, 87.5 + 0.001, GRID_STEP_DEG)  # 36 rows, S→N
GRID_LONS = np.arange(-180.0, 180.0 - 0.001, GRID_STEP_DEG)  # 72 cols, W→E

# --- Tiles (A2: WebMercator z0-3 = 1+4+16+64 = 85 tiles/frame) --------------
MAX_ZOOM = 3
TILE_SIZE = 256
MERCATOR_LAT_LIMIT = 85.05112878

# --- Frame cadence (P2/P3 as revised for the continuous slider) -------------
HOURLY_HORIZON_H = 6     # run+0..6h at 1h cadence (near-term has GFS skill)
COARSE_STEP_H = 3        # beyond that, 3-hourly...
MAX_OFFSET_H = 48        # ...out to run+48h (covers +36h all render-cycle long)
GFS_AVAILABILITY_LAG_H = 5  # synoptic run is typically published ~4-5h after
RENDER_CADENCE_H = 12    # Revision 3: render the 00Z/12Z cycles only (daily
                         # loc-req budget); the run label stays the true
                         # 12h-floored synoptic cycle the data derives from
KEEP_RUNS = 2            # bounded storage; previous run survives the flip

# --- Render style (A6 — placeholder constants pending /plan-design-review) --
RAMP_FLOOR_CF = 12.5     # cloud% below this renders fully transparent
RAMP_MAX_ALPHA = 217     # alpha at 100% cloud ≈ 0.85, matches gibs opacity

# --- Open-Meteo pacing (live smoke 2026-06-10: an unpaced 104-call grid
# sweep trips the per-minute burst limiter with 429s — and this generator
# host ALSO runs the production tick whose pass-scoring fetches share the
# IP, so the sweep must stay polite). ~1.2s pacing ≈ 2-minute sweep, 4×/day.
OPEN_METEO_BATCH_DELAY_S = 1.2
OPEN_METEO_429_RETRIES = 3
OPEN_METEO_429_BACKOFF_S = 30.0

# A frame with big data holes erodes trust more than no frame: require this
# fraction of grid cells to carry real forecast data before publishing it.
MIN_GRID_COVERAGE = 0.6


class _Sampler(Protocol):
    def sample(self, lat: float, lon: float, when: datetime) -> Any: ...


def latest_gfs_run(now: datetime) -> datetime:
    """Latest rendered synoptic cycle old enough to be published.

    Revision 3: floored to RENDER_CADENCE_H (00Z/12Z) — the render-budget
    gate and the data label are the same value, so a frame set is always
    labeled with the cycle it actually derives from.
    """
    if now.tzinfo is None or now.tzinfo.utcoffset(now) != timedelta(0):
        raise ValueError("now must be UTC-aware")
    ref = now - timedelta(hours=GFS_AVAILABILITY_LAG_H)
    run_hour = (ref.hour // RENDER_CADENCE_H) * RENDER_CADENCE_H
    return ref.replace(hour=run_hour, minute=0, second=0, microsecond=0)


def compact_key(dt: datetime) -> str:
    """Path-safe UTC key, e.g. 20260610T060000Z (A1 — no ISO colons)."""
    return dt.strftime("%Y%m%dT%H%M%SZ")


def iso_z(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def frame_times(run: datetime) -> list[datetime]:
    """Tiered valid-times anchored at the run: hourly ≤6h, 3-hourly to 48h."""
    offsets = list(range(0, HOURLY_HORIZON_H + 1))  # 0..6
    offsets += list(
        range(HOURLY_HORIZON_H + COARSE_STEP_H, MAX_OFFSET_H + 1, COARSE_STEP_H)
    )  # 9..42
    return [run + timedelta(hours=h) for h in offsets]


def grid_coords() -> list[tuple[float, float]]:
    """All (lat, lon) cell centers, row-major S→N then W→E. 36×72 = 2,592."""
    return [(float(lat), float(lon)) for lat in GRID_LATS for lon in GRID_LONS]


def paced_fetcher(
    get: Any | None = None,
    sleep: Any = time.sleep,
) -> Any:
    """Open-Meteo fetcher with inter-batch pacing + 429 backoff.

    The shared GFSForecastSampler default fires batches back-to-back — fine
    for the 2-3 calls the target path makes, fatal for the 104-call grid
    sweep (verified live 2026-06-10: burst 429s). `get`/`sleep` injectable
    for tests.
    """
    if get is None:
        import requests

        def _default_get(url: str) -> Any:
            resp = requests.get(url, timeout=OPEN_METEO_TIMEOUT_SECONDS)
            return resp

        get = _default_get

    def _fetch(url: str) -> Any:
        for attempt in range(OPEN_METEO_429_RETRIES + 1):
            sleep(OPEN_METEO_BATCH_DELAY_S)
            resp = get(url)
            status = getattr(resp, "status_code", 200)
            if status == 429 and attempt < OPEN_METEO_429_RETRIES:
                sleep(OPEN_METEO_429_BACKOFF_S * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError("unreachable")  # pragma: no cover

    return _fetch


def build_grid_sampler(fetcher: Any | None = None) -> GFSForecastSampler:
    """One sampler over the whole 5° grid. forecast_days=3 comfortably
    covers run+48h even when the run is hours behind wall-clock now."""
    return GFSForecastSampler(
        grid_coords(), forecast_days=3, fetcher=fetcher or paced_fetcher()
    )


def sample_grid(sampler: _Sampler, when: datetime) -> np.ndarray:
    """(72, 144) float array of cloud% at `when`; NaN where the sampler has
    no real data (no-data / out-of-horizon sources render transparent)."""
    grid = np.full((GRID_LATS.size, GRID_LONS.size), np.nan, dtype=np.float64)
    for i, lat in enumerate(GRID_LATS):
        for j, lon in enumerate(GRID_LONS):
            s = sampler.sample(float(lat), float(lon), when)
            if getattr(s, "source", None) == "gfs-forecast":
                grid[i, j] = min(100.0, max(0.0, float(s.cloud_fraction)))
    return grid


def alpha_from_cloud(cf: np.ndarray) -> np.ndarray:
    """Vectorized A6 ramp: transparent below the floor, then linear to
    RAMP_MAX_ALPHA at 100% cloud. NaN → 0 (transparent)."""
    filled = np.nan_to_num(cf, nan=0.0)
    scaled = (filled - RAMP_FLOOR_CF) / (100.0 - RAMP_FLOOR_CF)
    alpha = np.clip(scaled, 0.0, 1.0) * RAMP_MAX_ALPHA
    alpha[filled < RAMP_FLOOR_CF] = 0.0
    return alpha.astype(np.uint8)


def _pixel_row_to_lat(global_rows: np.ndarray, n_pixels: int) -> np.ndarray:
    """Inverse WebMercator: global pixel row (0 = north) → latitude deg."""
    yn = (global_rows + 0.5) / n_pixels  # 0..1, top→bottom
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * yn))))
    return np.clip(lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT)


def pixel_grid_indices(z: int) -> tuple[np.ndarray, np.ndarray]:
    """Per-zoom global pixel → grid index maps (rows, cols).

    Shared by every tile at the zoom, so tile seams are continuous by
    construction. Rows clamp at the mercator limit (poles reuse the extreme
    grid rows); cols wrap modulo 144 (antimeridian continuity).
    """
    n = TILE_SIZE * (2**z)
    lats = _pixel_row_to_lat(np.arange(n, dtype=np.float64), n)
    rows = np.clip(
        np.round((lats - GRID_LATS[0]) / GRID_STEP_DEG).astype(np.int64),
        0,
        GRID_LATS.size - 1,
    )
    lons = ((np.arange(n, dtype=np.float64) + 0.5) / n) * 360.0 - 180.0
    cols = np.round((lons - GRID_LONS[0]) / GRID_STEP_DEG).astype(np.int64) % GRID_LONS.size
    return rows, cols


def render_frame_tiles(grid: np.ndarray) -> dict[tuple[int, int, int], bytes]:
    """All 85 z0-3 PNG tiles for one frame: white RGBA, alpha by cloud%."""
    alpha_grid = alpha_from_cloud(grid)
    tiles: dict[tuple[int, int, int], bytes] = {}
    for z in range(MAX_ZOOM + 1):
        rows, cols = pixel_grid_indices(z)
        for ty in range(2**z):
            r = rows[ty * TILE_SIZE : (ty + 1) * TILE_SIZE]
            for tx in range(2**z):
                c = cols[tx * TILE_SIZE : (tx + 1) * TILE_SIZE]
                alpha = alpha_grid[np.ix_(r, c)]
                rgba = np.empty((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
                rgba[..., 0:3] = 255  # white cloud body; ramp carries signal
                rgba[..., 3] = alpha
                buf = io.BytesIO()
                Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
                tiles[(z, tx, ty)] = buf.getvalue()
    return tiles


def _existing_index(run_dir: Path) -> dict[str, Any] | None:
    idx = run_dir / "index.json"
    if not idx.is_file():
        return None
    try:
        loaded = json.loads(idx.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return loaded if isinstance(loaded, dict) and loaded.get("valid_times") else None


def prune_old_runs(fcst_root: Path, keep: int = KEEP_RUNS) -> list[Path]:
    """Delete all but the newest `keep` complete run dirs. Lexicographic order
    IS chronological for compact keys. Incomplete dirs (no index.json — a
    crashed render) are always pruned."""
    if not fcst_root.is_dir():
        return []
    complete = sorted(d for d in fcst_root.iterdir() if d.is_dir() and not d.name.startswith("."))
    doomed = [d for d in complete if _existing_index(d) is None]
    keepers = [d for d in complete if _existing_index(d) is not None][-keep:]
    doomed += [d for d in complete if _existing_index(d) is not None and d not in keepers]
    for d in doomed:
        shutil.rmtree(d, ignore_errors=True)
    return doomed


def write_frames(
    out_dir: Path,
    now: datetime,
    *,
    sampler: _Sampler | None = None,
    fetcher: Any | None = None,
) -> dict[str, Any] | None:
    """Render (or reuse) this run's frame set. Returns the manifest index,
    or None when no real forecast data was available (key omitted →
    frontend stays on the observed layer, A4 layer-3 fallback).

    Run-change gate (P2): if this run's dir already has a complete index,
    skip the render entirely and return the existing index — ticks between
    GFS runs cost nothing.
    """
    run = latest_gfs_run(now)
    fcst_root = out_dir / "clouds-fcst"
    run_dir = fcst_root / compact_key(run)

    existing = _existing_index(run_dir)
    if existing is not None:
        return existing

    if sampler is None:
        sampler = build_grid_sampler(fetcher)

    tmp_dir = run_dir.with_name(run_dir.name + ".tmp")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    valid_times: list[datetime] = []
    try:
        for when in frame_times(run):
            grid = sample_grid(sampler, when)
            coverage = float(np.mean(~np.isnan(grid)))
            if coverage < MIN_GRID_COVERAGE:
                # Sparse/empty data for this hour (Open-Meteo holes, past
                # the model horizon) — omit the frame rather than publish a
                # hole-y layer; nearest-frame on the frontend bridges gaps.
                log.info(
                    "forecast clouds: frame %s coverage %.0f%% < %.0f%% — skipped",
                    iso_z(when), coverage * 100, MIN_GRID_COVERAGE * 100,
                )
                continue
            frame_dir = tmp_dir / compact_key(when)
            for (z, tx, ty), png in render_frame_tiles(grid).items():
                tile_path = frame_dir / str(z) / str(tx) / f"{ty}.png"
                tile_path.parent.mkdir(parents=True, exist_ok=True)
                tile_path.write_bytes(png)
            valid_times.append(when)

        if not valid_times:
            log.warning("forecast clouds: no usable GFS data for run %s — skipping publish", iso_z(run))
            return None

        index: dict[str, Any] = {
            "gfs_run": iso_z(run),
            "prefix": f"clouds-fcst/{compact_key(run)}",
            "valid_times": [iso_z(t) for t in valid_times],
            "max_zoom": MAX_ZOOM,
        }
        # Index written INSIDE the dir, then one atomic rename publishes the
        # whole run (A7) — a reader can never see a frame set without its
        # index or vice versa.
        (tmp_dir / "index.json").write_text(json.dumps(index, indent=2))
        shutil.rmtree(run_dir, ignore_errors=True)
        tmp_dir.rename(run_dir)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    prune_old_runs(fcst_root)
    log.info(
        "forecast clouds: rendered %d frames for run %s (%d tiles)",
        len(valid_times), iso_z(run), len(valid_times) * 85,
    )
    return index
