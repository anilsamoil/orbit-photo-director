"""Produce the independent, five-minute NOAA GLM map artifact."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import requests

from generator.lightning import (
    GLM_GRANULE_CADENCE,
    GLM_GRANULE_TIMEOUT_SECONDS,
    GLM_INNER_RADIUS_KM,
    GLM_SUBPOINT_LON,
    _decode_glm_granule,
    _glm_granule_urls,
    _GLMFlash,
    _GLMGranule,
)
from generator.orbit import great_circle_km

WINDOW = timedelta(minutes=5)
SOURCE_LAG = timedelta(minutes=2)
MAX_CELLS_PER_SECTOR = 512


def _cells(flashes: list[_GLMFlash], start: datetime) -> list[list[float | int]]:
    """One actual centroid per occupied cell. Coarsen until every cell fits."""
    size = 0.25
    while True:
        cells: dict[tuple[int, int], tuple[int, tuple[datetime, float, float]]] = {}
        for flash in flashes:
            key = (math.floor(flash.lat / size), math.floor(flash.lon / size))
            sample = (flash.t, flash.lon, flash.lat)
            previous = cells.get(key)
            cells[key] = (1, sample) if previous is None else (
                previous[0] + 1, max(previous[1], sample)
            )
        if len(cells) <= MAX_CELLS_PER_SECTOR:
            return [
                [round(lon, 3), round(lat, 3), int((time - start).total_seconds()), count]
                for _, (count, (time, lon, lat)) in sorted(cells.items())
            ]
        size *= 2


def build_overlay(
    end: datetime, generated_at: datetime,
    granules: Iterable[tuple[str, _GLMGranule]], *, window: timedelta = WINDOW,
) -> dict:
    start = end - window
    # A flash in the next file can start just before the boundary.
    slots = {start + i * GLM_GRANULE_CADENCE for i in range(window // GLM_GRANULE_CADENCE + 1)}
    by_sector: dict[str, dict[datetime, _GLMGranule]] = {sat: {} for sat in GLM_SUBPOINT_LON}
    for sat, granule in granules:
        if granule.start in slots:
            by_sector[sat][granule.start] = granule
    sectors = []
    for sat, center in GLM_SUBPOINT_LON.items():
        files = by_sector[sat]
        points = None
        if files.keys() == slots:
            flashes = []
            for granule in files.values():
                for flash in granule.flashes:
                    owner = min(GLM_SUBPOINT_LON, key=lambda s: abs(
                        (flash.lon - GLM_SUBPOINT_LON[s] + 180) % 360 - 180
                    ))
                    if (start <= flash.t < end and owner == sat
                            and great_circle_km(flash.lat, flash.lon, 0, center)
                            <= GLM_INNER_RADIUS_KM):
                        flashes.append(flash)
            points = _cells(flashes, start)
        sectors.append({"satellite": f"GOES-{sat[-2:]}", "center_lon": center, "cells": points})
    return {
        "schema": 1, "start": start.isoformat(), "end": end.isoformat(),
        "generated_at": generated_at.isoformat(), "radius_km": GLM_INNER_RADIUS_KM,
        "sectors": sectors,
    }


def _download(job: tuple[str, str]) -> bytes | None:
    try:
        response = requests.get(job[1], timeout=GLM_GRANULE_TIMEOUT_SECONDS)
        response.raise_for_status()
        return response.content
    except requests.RequestException:
        return None


def refresh(output: Path) -> dict:
    folder = output / "lightning"
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / ".publisher.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        end = datetime.now(UTC).replace(second=0, microsecond=0) - SOURCE_LAG
        jobs = sorted({
            (sat, url) for sat in GLM_SUBPOINT_LON
            for url in _glm_granule_urls(sat, end, WINDOW // timedelta(minutes=1))
        })
        granules = []
        # NetCDF/HDF5 decoding runs on one thread; only HTTP reads overlap.
        with ThreadPoolExecutor(max_workers=8) as pool:
            for (sat, _), body in zip(jobs, pool.map(_download, jobs), strict=True):
                if not body:
                    continue
                granule = _decode_glm_granule(body, overlay_platform=f"G{sat[-2:]}")
                if granule:
                    granules.append((sat, granule))
        artifact = build_overlay(end, datetime.now(UTC), granules)
        pending = folder / ".latest.tmp"
        pending.write_text(json.dumps(artifact, separators=(",", ":"), allow_nan=False))
        pending.replace(folder / "latest.json")
        return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Independent staging directory")
    artifact = refresh(parser.parse_args().output)
    for sector in artifact["sectors"]:
        cells = sector["cells"]
        print(sector["satellite"], "unavailable" if cells is None else f"{len(cells)} cells")


if __name__ == "__main__":
    main()
