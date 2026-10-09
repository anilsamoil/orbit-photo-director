#!/usr/bin/env python3
"""Regenerate country-raster-levels.json from current Esri tiles.

Fetches Reference/World_Boundaries_and_Places and Canvas/World_Dark_Gray_Base
around each centroid. A cache-bust query is tried first; a CloudFront miss and
a later hit of the same path are the same bytes, so a plain CDN fetch is the
fallback. OCR matches plan-label-verdict.mjs rasterPainted: exact stem, or a
drop-one stem inside a token at most four letters longer. A longer token that
starts with the name (INDIAN) blocks the exact name.
"""

from __future__ import annotations

import io
import json
import math
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

THROUGH = 6
OUT = Path(__file__).resolve().parents[1] / "src/map/adapters/maplibre/country-raster-levels.json"
COUNTRIES = (
    ("Canada", -100, 50),
    ("Mexico", -102, 23),
    ("Brazil", -55, -10),
    ("Argentina", -64, -34),
    ("France", 2, 46),
    ("Egypt", 30, 26),
    ("Nigeria", 8, 10),
    ("Kenya", 38, 1),
    ("China", 104, 35),
    ("India", 79, 22),
    ("Japan", 138, 36),
    ("Australia", 134, -25),
)
SERVICES = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
)


def tile_xy(lng: float, lat: float, zoom: int) -> tuple[int, int]:
    n = 2**zoom
    x = math.floor(((lng + 180) / 360) * n)
    rad = math.radians(lat)
    y = math.floor((1 - math.log(math.tan(rad) + 1 / math.cos(rad)) / math.pi) / 2 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def stems(name: str) -> list[str]:
    found = [name]
    for index in range(len(name)):
        stem = name[:index] + name[index + 1 :]
        if len(stem) >= 4:
            found.append(stem)
    return found


def raster_painted(words: str, country: str) -> bool:
    name = country.upper()
    if len(name) < 4:
        return False
    stem_list = stems(name)
    tokens = [word for word in "".join(ch if ch.isalpha() else " " for ch in words.upper()).split() if len(word) >= 4]
    extended = any(word.startswith(name) and len(word) > len(name) for word in tokens)
    for word in tokens:
        if extended and word == name:
            continue
        if word.startswith(name) and len(word) > len(name):
            continue
        if word in stem_list:
            return True
        for stem in stem_list:
            if stem != name and stem in word and len(stem) < len(word) <= len(stem) + 4:
                return True
    return False


def fetch_tile(url: str) -> bytes | None:
    fresh = url + ("&" if "?" in url else "?") + "nocache=fu121"
    for target in (fresh, url):
        for _attempt in range(3):
            request = urllib.request.Request(target, headers={"Cache-Control": "no-cache", "Pragma": "no-cache"})
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    if response.status != 200:
                        continue
                    body = response.read()
                    if body[:8] == b"\x89PNG\r\n\x1a\n" and len(body) > 200:
                        return body
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                continue
    return None


def ocr_tile(png: bytes) -> str:
    from PIL import Image, ImageOps

    image = Image.open(io.BytesIO(png)).convert("RGBA")
    if image.getextrema()[3][1] == 0:
        return ""

    def paint(bg: tuple[int, int, int, int], scale: int, nearest: bool, contrast: bool) -> str:
        base = Image.new("RGBA", image.size, bg)
        gray = Image.alpha_composite(base, image).convert("L")
        resample = Image.Resampling.NEAREST if nearest else Image.Resampling.LANCZOS
        big = gray.resize((gray.width * scale, gray.height * scale), resample)
        if contrast:
            big = ImageOps.autocontrast(big)
        buf = io.BytesIO()
        big.save(buf, format="PNG")
        result = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", "eng", "--psm", "11"],
            input=buf.getvalue(),
            capture_output=True,
            timeout=12,
            check=False,
        )
        return result.stdout.decode("utf8", "replace")

    return paint((32, 35, 38, 255), 4, True, True) + "\n" + paint((255, 255, 255, 255), 8, False, False)


def neighborhood(lng: float, lat: float, zoom: int) -> list[tuple[int, int]]:
    n = 2**zoom
    x, y = tile_xy(lng, lat, zoom)
    coords = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nx, ny = x + dx, y + dy
            if 0 <= nx < n and 0 <= ny < n:
                coords.append((nx, ny))
    return coords


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    levels: dict[str, list[int]] = {name: [] for name, _lng, _lat in COUNTRIES}
    seen: dict[str, str] = {}
    for name, lng, lat in COUNTRIES:
        for zoom in range(THROUGH + 1):
            words = []
            for service in SERVICES:
                for x, y in neighborhood(lng, lat, zoom):
                    url = service.format(z=zoom, y=y, x=x)
                    if url not in seen:
                        png = fetch_tile(url)
                        seen[url] = ocr_tile(png) if png else ""
                        print(f"{name} z{zoom} {x},{y} {len(seen[url])} chars", file=sys.stderr)
                    words.append(seen[url])
            if raster_painted("\n".join(words), name):
                levels[name].append(zoom)
        print(f"{name} {levels[name]}", file=sys.stderr)
    payload = {"through": THROUGH, "countries": levels}
    out.write_text(json.dumps(payload, indent=2) + "\n")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
