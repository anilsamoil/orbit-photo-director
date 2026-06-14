"""Runtime loader for the GSHHG-derived land/water mask (general sun-glint gate).

numpy-only, loaded ONCE per tick (never per pass). Returns a `mask(lat, lon) -> bool`
callable that is exactly the pluggable hook `is_water(lat, lon, mask=)` already
accepts (cloud.py) — so the gate logic in cloud.py is unchanged.

The artifact (data/water_mask.npz) is built once by scripts/build_water_mask.py from
the Strandgren Global Land Water Mask (Zenodo 10.5281/zenodo.10076199, GSHHG 2.3.7,
CC-BY-4.0). When the artifact is ABSENT, load_water_mask returns None, which drives a
clean fallback to the legacy V1 ocean-band heuristic — byte-identical to the
pre-water-mask manifest (see is_water + the conditional `water` serialization).

Grid: plate-carrée, north-up (row 0 = +90°, col 0 = -180°), 13500x6750, ~0.0267° / 3 km.
Lookup is a pure integer index + one packed-bit test, ~1 µs/call, fully deterministic.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np

_DEFAULT_PATH = Path(__file__).parent / "data" / "water_mask.npz"


def load_water_mask(path: Path | None = None) -> Callable[[float, float], bool] | None:
    """Load the committed water mask and return a `mask(lat, lon) -> bool` callable.

    Returns None when the artifact is absent (a fresh checkout / CI without the
    committed .npz) — callers treat None as "use the V1 heuristic", preserving the
    current shipped behaviour and manifest bytes.
    """
    p = path or _DEFAULT_PATH
    if not p.exists():
        return None

    data = np.load(p)
    packed: np.ndarray = data["mask"]
    h, w = (int(x) for x in data["shape"])
    # Keep the packed bits resident (~11 MB) and bit-test per call rather than
    # unpacking to a ~91 MB uint8 array — lighter on the long-lived daemon.

    def water_mask(lat: float, lon: float) -> bool:
        row = int(round((90.0 - lat) / 180.0 * (h - 1)))
        col = int(round((lon + 180.0) / 360.0 * (w - 1)))
        row = max(0, min(h - 1, row))
        col = max(0, min(w - 1, col))
        flat = row * w + col
        byte = int(packed[flat >> 3])
        return bool((byte >> (7 - (flat & 7))) & 1)

    return water_mask
