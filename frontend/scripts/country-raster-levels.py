#!/usr/bin/env python3
"""Regenerate country-raster-levels.json from current Esri tiles.

Each zoom uses a stitched neighborhood, retrying the centroid tile only when
needed. A name split by a tile edge is readable only on the stitch.
Reference tiles are PNG. The dark basemap is JPEG. Pillow decodes both.
A cache-bust query is tried first. A CloudFront miss and a later hit of the
same path are the same bytes, so the plain CDN URL is the fallback.

The token rule matches plan-label-verdict.mjs. An exact name counts even when
an unrelated adjective (AUSTRALIAN) occurs elsewhere. Regional/ocean phrases
are excluded locally, not by vetoing every sovereign name in the image.
TSV glyph bounds are normalized Mercator coordinates, including a one-pixel
margin, so the inset can distinguish raster ownership from readable lettering.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import unicodedata
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
FETCH_NONCE = str(time.time_ns())


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
    for line in words.upper().splitlines():
        tokens = re.findall(r"[A-Z]+", line)
        for index, word in enumerate(tokens):
            if not sovereign_context(tokens, index, index + 1):
                continue
            if word.startswith(name) and len(word) > len(name):
                continue
            if word in stem_list:
                return True
            for stem in stem_list:
                if stem != name and stem in word and len(stem) < len(word) <= len(stem) + 4:
                    return True
    return False


def sovereign_context(tokens: list[str], start: int, end: int) -> bool:
    prefix = tokens[start - 1] if start else ""
    suffix = tokens[end] if end < len(tokens) else ""
    return prefix not in {"SOUTH", "WESTERN", "WEST", "NORTH", "NORTHERN", "NEW"} and suffix not in {"OCEAN", "SEA", "BIGHT"} and tokens[max(0, start - 2):start] != ["GULF", "OF"]


def fetch_tile(url: str) -> bytes | None:
    fresh = url + ("&" if "?" in url else "?") + "nocache=" + FETCH_NONCE
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


def ocr_observations(image: Image.Image) -> list[list[dict]]:
    if image.getextrema()[3][1] == 0:
        return []

    def paint(bg: tuple[int, int, int, int], scale: int, threshold: bool = False) -> list[list[dict]]:
        base = Image.new("RGBA", image.size, bg)
        gray = Image.alpha_composite(base, image).convert("L")
        if threshold:
            gray = gray.point(lambda pixel: 0 if pixel >= 85 else 255)
        big = ImageOps.autocontrast(gray.resize((gray.width * scale, gray.height * scale), Image.Resampling.LANCZOS))
        buf = io.BytesIO()
        big.save(buf, format="PNG")
        result = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", "eng", "--psm", "11", "tsv"],
            input=buf.getvalue(),
            capture_output=True,
            timeout=60,
            check=True,
            env={**os.environ, "OMP_THREAD_LIMIT": "1"},
        )
        lines: dict[tuple[str, str, str], list[dict]] = {}
        for row in csv.DictReader(io.StringIO(result.stdout.decode("utf8", "replace")), delimiter="\t", quoting=csv.QUOTE_NONE):
            if row["level"] != "5" or not row["text"].strip():
                continue
            key = (row["block_num"], row["par_num"], row["line_num"])
            left, top, width, height = (int(row[key]) / scale for key in ("left", "top", "width", "height"))
            lines.setdefault(key, []).append({"text": row["text"], "box": [left, top, left + width, top + height]})
        return list(lines.values())

    return paint((32, 35, 38, 255), 3) + paint((255, 255, 255, 255), 4) + paint((32, 35, 38, 255), 4, True)


def observation_text(lines: list[list[dict]]) -> str:
    return "\n".join(" ".join(word["text"] for word in line) for line in lines)


def ocr_image(image: Image.Image) -> str:
    return observation_text(ocr_observations(image))


def name_boxes(lines: list[list[dict]], country: str) -> list[list[float]]:
    name = country.upper()
    boxes = []
    for line in lines:
        tokens = [re.sub(r"[^A-Z]", "", unicodedata.normalize("NFKD", word["text"]).upper()) for word in line]
        for start in range(len(tokens)):
            for end in range(start + 1, min(len(tokens), start + len(name)) + 1):
                joined = "".join(tokens[start:end])
                if joined not in stems(name) or not sovereign_context(tokens, start, end):
                    continue
                if not all(word["text"].isupper() for word in line[start:end]):
                    continue
                picked = [word["box"] for word in line[start:end]]
                box = [min(b[0] for b in picked) - 1, min(b[1] for b in picked) - 1, max(b[2] for b in picked) + 1, max(b[3] for b in picked) + 1]
                existing = next((b for b in boxes if min(b[2], box[2]) > max(b[0], box[0]) and min(b[3], box[3]) > max(b[1], box[1])), None)
                if existing is None:
                    boxes.append(box)
                else:
                    existing[:] = [min(existing[0], box[0]), min(existing[1], box[1]), max(existing[2], box[2]), max(existing[3], box[3])]
    return boxes


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
    bounds: dict[str, dict[int, list[dict]]] = {name: {} for name, _lng, _lat in COUNTRIES}
    cache: dict[str, bytes | None] = {}
    ocr_cache: dict[str, list[list[dict]]] = {}

    def observations(image: Image.Image) -> list[list[dict]]:
        key = hashlib.sha256(str(image.size).encode() + image.tobytes()).hexdigest()
        if key not in ocr_cache:
            ocr_cache[key] = ocr_observations(image)
        return ocr_cache[key]

    for name, lng, lat in COUNTRIES:
        for zoom in range(THROUGH + 1):
            words = []
            cx, cy = tile_xy(lng, lat, zoom)
            coords = neighborhood(lng, lat, zoom)
            xs = sorted({x for x, _y in coords})
            ys = sorted({y for _x, y in coords})
            for service_name, service in zip(("reference", "dark"), SERVICES):
                mosaic = Image.new("RGBA", (256 * len(xs), 256 * len(ys)), (0, 0, 0, 0))
                center = None
                for x, y in coords:
                    url = service.format(z=zoom, y=y, x=x)
                    if url not in cache:
                        cache[url] = fetch_tile(url)
                    tile = open_tile(cache[url])
                    if tile is None:
                        raise RuntimeError(f"missing raster tile: {url}")
                    mosaic.paste(tile, ((x - xs[0]) * 256, (y - ys[0]) * 256))
                    if (x, y) == (cx, cy):
                        center = tile
                observed = observations(mosaic)
                words.append(observation_text(observed))
                boxes = name_boxes(observed, name)
                if center is not None and not boxes:
                    center_observed = observations(center)
                    words.append(observation_text(center_observed))
                    boxes.extend([[left + (cx - xs[0]) * 256, top + (cy - ys[0]) * 256, right + (cx - xs[0]) * 256, bottom + (cy - ys[0]) * 256] for left, top, right, bottom in name_boxes(center_observed, name)])
                for left, top, right, bottom in boxes:
                    scale = 256 * 2**zoom
                    box = [(left + 256 * xs[0]) / scale, (top + 256 * ys[0]) / scale, (right + 256 * xs[0]) / scale, (bottom + 256 * ys[0]) / scale]
                    bounds[name].setdefault(zoom, []).append({"service": service_name, "box": [round(value, 9) for value in box]})
            if any(raster_painted(text, name) for text in words):
                if not bounds[name].get(zoom):
                    raise RuntimeError(f"{name} z{zoom}: OCR name has no readable glyph bounds")
                levels[name].append(zoom)
            print(f"{name} z{zoom} {levels[name]}", file=sys.stderr)
    payload = {"through": THROUGH, "countries": levels, "bounds": bounds}
    temporary = out.with_name(f".{out.name}.{FETCH_NONCE}.tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    temporary.replace(out)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
