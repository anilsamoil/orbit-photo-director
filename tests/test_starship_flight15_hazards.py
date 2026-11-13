"""Starship Flight 15 hazard vertices against the retained notice text."""

from __future__ import annotations

import json
import re
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HAZARD = ROOT / "frontend/public/hazards/v1/0f867f0c-5422-4d44-93b8-d7faaae7019b.json"
NAVAREA = ROOT / "frontend/test/fixtures/notices/navarea-iv-1080-26.txt"
LNM = ROOT / "frontend/test/fixtures/notices/uscg-lnm-45-2026-starship-flight15.txt"
TFR = ROOT / "frontend/test/fixtures/notices/faa-tfr-6-7129.xml"
EVENT = "0f867f0c-5422-4d44-93b8-d7faaae7019b"
LABEL = "Published hazard areas \u2014 not a flight path or navigation guidance"
PAIR = re.compile(r"(\d{2,3}-\d{2}\.\d{2}[NS])\s+(\d{2,3}-\d{2}\.\d{2}[EW])")


def _round5(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.00001"), rounding=ROUND_HALF_UP)


def _dm(token: str) -> Decimal:
    hemi = token[-1]
    degrees, minutes = token[:-1].split("-")
    value = Decimal(degrees) + (Decimal(minutes) / Decimal(60))
    if hemi in "SW":
        value = -value
    return _round5(value)


def _pairs(text: str, start: str, end: str) -> list[tuple[Decimal, Decimal]]:
    chunk = text.split(start, 1)[1].split(end, 1)[0]
    return [(_dm(lon), _dm(lat)) for lat, lon in PAIR.findall(chunk)]


def _faa(token: str) -> Decimal:
    match = re.fullmatch(r"(\d+(?:\.\d+)?)([NSEW])", token.strip())
    if match is None:
        raise AssertionError(token)
    value = Decimal(match.group(1))
    return -value if match.group(2) in "SW" else value


def _tfr_ring(xml: str) -> list[tuple[Decimal, Decimal]]:
    found = re.findall(r"<geoLat>([^<]+)</geoLat>\s*<geoLong>([^<]+)</geoLong>", xml)
    ring: list[tuple[Decimal, Decimal]] = []
    for lat_token, lon_token in found:
        point = (_faa(lon_token), _faa(lat_token))
        if len(ring) >= 3 and point == ring[0]:
            break
        ring.append(point)
    return ring


def _near(left: float, right: Decimal) -> bool:
    return abs(Decimal(str(left)) - right) <= Decimal("0.00000001")


def _same_ring(stored: list[list[float]], expected: list[tuple[Decimal, Decimal]]) -> bool:
    if len(stored) != len(expected) + 1:
        return False
    if stored[0] != stored[-1]:
        return False
    open_ring = stored[:-1]

    def matches(order: list[tuple[Decimal, Decimal]]) -> bool:
        return all(
            _near(point[0], order[index][0]) and _near(point[1], order[index][1])
            for index, point in enumerate(open_ring)
        )

    return matches(expected) or matches(list(reversed(expected)))


def _bundle() -> dict:
    return json.loads(HAZARD.read_text())


def _ring(bundle: dict, area_id: str) -> list[list[float]]:
    for feature in bundle["geojson"]["features"]:
        if feature["properties"]["area_id"] == area_id:
            return feature["geometry"]["coordinates"][0]
    raise AssertionError(area_id)


def _matches(bundle: dict, navarea: str, lnm: str, xml: str) -> bool:
    area_a = _pairs(navarea, "A. ", "B. ")
    area_b = _pairs(navarea, "B. ", "2. CANCEL")
    if len(area_a) != 30 or len(area_b) != 16:
        return False
    if _pairs(lnm, "High Risk Hazard Area:", ". Hazard Area:") != area_b:
        return False
    if _pairs(lnm, ". Hazard Area:", "Primary and backup") != area_a:
        return False
    if not _same_ring(_ring(bundle, "A"), area_a):
        return False
    if not _same_ring(_ring(bundle, "B"), area_b):
        return False
    tfr = _tfr_ring(xml)
    return len(tfr) == 6 and _same_ring(_ring(bundle, "6/7129"), tfr)


def test_hazard_vertices_match_the_original_notices():
    bundle = _bundle()
    assert bundle["event_id"] == EVENT
    assert bundle["label"] == LABEL
    assert "shots" not in bundle
    assert "direction" not in bundle
    assert "tier" not in bundle
    assert _matches(
        bundle,
        NAVAREA.read_text(),
        LNM.read_text(),
        TFR.read_text(encoding="utf-8-sig"),
    )
    assert all(feature["geometry"]["type"] == "Polygon" for feature in bundle["geojson"]["features"])
    assert "LineString" not in HAZARD.read_text()


def test_moved_navarea_vertex_fails_the_notice_check():
    bundle = _bundle()
    _ring(bundle, "A")[4][0] += 0.01
    notices = (NAVAREA.read_text(), LNM.read_text(), TFR.read_text(encoding="utf-8-sig"))
    assert _matches(bundle, *notices) is False


def test_moved_tfr_vertex_fails_the_notice_check():
    bundle = _bundle()
    _ring(bundle, "6/7129")[1][1] += 0.01
    notices = (NAVAREA.read_text(), LNM.read_text(), TFR.read_text(encoding="utf-8-sig"))
    assert _matches(bundle, *notices) is False


def test_starship_catalog_item_stays_watch_without_a_trajectory():
    catalog = json.loads(
        (ROOT / "frontend/test/fixtures/starship-catalog-2026-11-10.json").read_text()
    )
    item = next(row for row in catalog["items"] if row["event_id"] == EVENT)
    assert item["tier"] == "watch"
    assert item["schedule"]["status"] == "TBC"
    assert item["direction"]["kind"] == "none"
    assert item["shots"] == []
