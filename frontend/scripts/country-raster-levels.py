#!/usr/bin/env python3
"""Regenerate country-raster-levels.json from current Esri tiles.

Each zoom is one stitched neighborhood plus the centroid tile, not a pile of
separate OCRs. A name split by a tile edge is readable only on the stitch.
Reference tiles are PNG. The dark basemap is JPEG. Pillow decodes both.
A cache-bust query is tried first. A CloudFront miss and a later hit of the
same path are the same bytes, so the plain CDN URL is the fallback.

The token rule matches plan-label-verdict.mjs. An exact name counts. A longer
token that starts with the name (INDIAN) does not, and it suppresses a bare
name token in that same image so Indian Ocean is not India. The centroid tile
is judged on its own, so a real INDIA label still counts when a neighbor only
says INDIAN.
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

try:
    from PIL import Image, ImageOps
except ImportError as error:
    raise SystemExit("country raster levels need Pillow") from error

THROUGH = 6
OUT = Path(__file__).resolve().parents[1] / "src/map/adapters/maplibre/country-raster-levels.json"
COUNTRIES = (
    ("Canada", -100.0, 50.0),
    ("Mexico", -102.0, 23.0),
    ("Brazil", -55.0, -10.0),
    ("Argentina", -64.0, -34.0),
    ("France", 2.0, 46.0),
    ("Egypt", 30.0, 26.0),
    ("Nigeria", 8.0, 10.0),
    ("Kenya", 38.0, 1.0),
    ("China", 104.0, 35.0),
    ("India", 79.0, 22.0),
    ("Japan", 138.0, 36.0),
    ("Australia", 134.0, -25.0),
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
    fresh = url + ("&" if "?" in url else "?") + "nocache=fu183"
    for target in (fresh, url):
        request = urllib.request.Request(
            target,
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache", "User-Agent": "opd-verify"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            continue
        if body[:8] == b"\x89PNG\r\n\x1a\n" or body[:2] == b"\xff\xd8":
            return body
    return None


def ocr_image(image: Image.Image) -> str:
    if image.getextrema()[3][1] == 0:
        return ""

    def paint(bg: tuple[int, int, int, int], scale: int) -> str:
        base = Image.new("RGBA", image.size, bg)
        gray = Image.alpha_composite(base, image).convert("L")
        big = ImageOps.autocontrast(gray.resize((gray.width * scale, gray.height * scale), Image.Resampling.LANCZOS))
        buf = io.BytesIO()
        big.save(buf, format="PNG")
        result = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", "eng", "--psm", "11"],
            input=buf.getvalue(),
            capture_output=True,
            timeout=20,
            check=False,
        )
        return result.stdout.decode("utf8", "replace")

    return paint((32, 35, 38, 255), 3) + "\n" + paint((255, 255, 255, 255), 4)


def neighborhood(lng: float, lat: float, zoom: int) -> list[tuple[int, int]]:
    n = 2**zoom
    cx, cy = tile_xy(lng, lat, zoom)
    if zoom <= 1:
        return [(x, y) for y in range(n) for x in range(n)]
    coords = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            x, y = cx + dx, cy + dy
            if 0 <= x < n and 0 <= y < n:
                coords.append((x, y))
    return coords


def open_tile(png: bytes | None) -> Image.Image | None:
    if not png:
        return None
    return Image.open(io.BytesIO(png)).convert("RGBA")


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    levels: dict[str, list[int]] = {name: [] for name, _lng, _lat in COUNTRIES}
    cache: dict[str, bytes | None] = {}
    for name, lng, lat in COUNTRIES:
        for zoom in range(THROUGH + 1):
            words = []
            cx, cy = tile_xy(lng, lat, zoom)
            coords = neighborhood(lng, lat, zoom)
            xs = sorted({x for x, _y in coords})
            ys = sorted({y for _x, y in coords})
            for service in SERVICES:
                mosaic = Image.new("RGBA", (256 * len(xs), 256 * len(ys)), (0, 0, 0, 0))
                center = None
                for x, y in coords:
                    url = service.format(z=zoom, y=y, x=x)
                    if url not in cache:
                        cache[url] = fetch_tile(url)
                    tile = open_tile(cache[url])
                    if tile is None:
                        continue
                    mosaic.paste(tile, ((x - xs[0]) * 256, (y - ys[0]) * 256))
                    if (x, y) == (cx, cy):
                        center = tile
                words.append(ocr_image(mosaic))
                if center is not None:
                    words.append(ocr_image(center))
            if any(raster_painted(text, name) for text in words):
                levels[name].append(zoom)
            print(f"{name} z{zoom} {levels[name]}", file=sys.stderr)
    payload = {"through": THROUGH, "countries": levels}
    out.write_text(json.dumps(payload, indent=2) + "\n")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
