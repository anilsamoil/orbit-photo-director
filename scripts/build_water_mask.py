#!/usr/bin/env python3
"""One-time builder for generator/data/water_mask.npz (general sun-glint water gate).

Source: Strandgren "Global Land Water Mask", Zenodo DOI 10.5281/zenodo.10076199,
        file gshhs_land_water_mask_3km_i.tif — GSHHG 2.3.7-derived, plate-carrée,
        north-up (row 0 = +90°, col 0 = -180°), 13500x6750, water=0 / land=100.
        GSHHG L2 lakes are WATER, so the Great Lakes / Caspian / Victoria / Baikal /
        Titicaca classify correctly (the whole reason for this mask over an
        elevation-derived land mask). Rivers are excluded by GSHHG (thin channels
        < 3 km read as land) — a known, documented limitation; lakes/coasts/estuaries
        are covered.

Build-time only — NEVER imported by the hourly generator tick. Reads the .tif with
Pillow (prod Pillow has libtiff; verified) so it needs NO new dependency beyond the
PIL + numpy the project already ships. The committed artifact (generator/data/
water_mask.npz, ~0.3-0.8 MB packed bits) is what the tick loads with numpy only.

Usage:
    python scripts/build_water_mask.py [path/to/gshhs_land_water_mask_3km_i.tif]

Then paste the printed SHA256s into the constants below, `git add
generator/data/water_mask.npz`, and commit (commit the .npz, NOT the .tif).
Attribution: Johan Strandgren, CC-BY-4.0 (Zenodo 10076199).
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Pinned provenance — fill OUTPUT after the first successful build so a re-build
# from the same source is detectably reproducible.
SOURCE_TIF_SHA256 = "96df83c57416217e191f95dde3d3c1ce0373a8fc220e929228873db246ca3569"
OUTPUT_NPZ_SHA256 = "68b12eaff4576b03dd09bc32c8fb682c52aab0e9dd6d8633b0e6d8af38b597fa"

EXPECTED_SHAPE = (6750, 13500)  # (rows=lat, cols=lon)

# Golden orientation + value-convention checks (north-up plate-carrée). These are
# the same coordinates the runtime loader test pins, so a flipped/transposed
# source fails the BUILD, not silently in production.
GOLDEN = [
    ("Lake Superior", 47.5, -87.5, True),
    ("Lake Michigan", 43.5, -87.0, True),
    ("Caspian Sea", 41.5, 50.0, True),
    ("Lake Victoria", -1.0, 33.0, True),
    ("Lake Baikal", 53.5, 108.0, True),
    ("Lake Titicaca", -15.8, -69.3, True),
    ("Sahara", 20.0, 10.0, False),
    ("Central Asia", 45.0, 80.0, False),
    ("Tokyo (land)", 35.68, 139.69, False),
    ("mid-Pacific", 0.0, -150.0, True),
    ("mid-Atlantic", 30.0, -40.0, True),
]


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/water_mask_src.tif")
    if not src.exists():
        print(f"ERROR: source TIFF not found: {src}", file=sys.stderr)
        print(
            "Download gshhs_land_water_mask_3km_i.tif from "
            "https://zenodo.org/records/10076199 first.",
            file=sys.stderr,
        )
        return 2

    # The 91 MP source trips Pillow's decompression-bomb guard; it's a trusted,
    # pinned-by-DOI artifact, so lift the limit for this one-time read.
    Image.MAX_IMAGE_PIXELS = None
    img = np.asarray(Image.open(src))
    if img.ndim != 2:
        print(f"ERROR: unexpected TIFF shape {img.shape} (want 2-D)", file=sys.stderr)
        return 2
    h, w = img.shape
    if (h, w) != EXPECTED_SHAPE:
        print(f"ERROR: unexpected grid {img.shape}, want {EXPECTED_SHAPE}", file=sys.stderr)
        return 2

    water = img == 0  # bool, True == water (land==100)

    def cell(lat: float, lon: float) -> bool:
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return bool(water[max(0, min(h - 1, r)), max(0, min(w - 1, c))])

    failures = [
        f"{name} ({lat},{lon}): got water={cell(lat, lon)} want {exp}"
        for name, lat, lon, exp in GOLDEN
        if cell(lat, lon) != exp
    ]
    if failures:
        print("GOLDEN CHECK FAILED — orientation/value convention is wrong:", file=sys.stderr)
        for f in failures:
            print("  ✗", f, file=sys.stderr)
        return 1

    out = Path(__file__).resolve().parent.parent / "generator" / "data" / "water_mask.npz"
    out.parent.mkdir(parents=True, exist_ok=True)
    packed = np.packbits(water, axis=None)  # 1 bit/cell, row-major
    np.savez_compressed(out, mask=packed, shape=np.array([h, w], dtype=np.int32))

    print(f"golden checks: {len(GOLDEN)}/{len(GOLDEN)} passed")
    print(f"water fraction: {float(water.mean()):.3f}")
    print(f"source sha256:  {_sha256(src)}")
    print(f"output sha256:  {_sha256(out)}")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
