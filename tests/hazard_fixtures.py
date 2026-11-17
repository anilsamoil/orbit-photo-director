"""Real notice fixtures for the hazard tests, and an independent reading of their text.

The readers here do not import the generator's coordinate code. A parser change that
moves a vertex therefore disagrees with them.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from generator.hazard_match import Sighting, build_bundle
from generator.hazard_notices import (
    Notice,
    parse_broadcast_warning,
    parse_faa_tfr,
    parse_uscg_space_operations,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "frontend/test/fixtures"
NOTICES = FIXTURES / "notices"
GOLDEN = FIXTURES / "hazards-v2-2026-11-13.json"
V1_STARSHIP = FIXTURES / "hazards-v1-starship-flight15.json"
SCENARIO_NOW = datetime(2026, 11, 13, 23, 40, tzinfo=UTC)
STARSHIP = "0f867f0c-5422-4d44-93b8-d7faaae7019b"
VULCAN = "ef9850ad-1096-425b-9d27-f7bbd186e61a"
USSF_317 = "76617033-4dc0-4448-b50c-e5b0d5a18539"
NROL_136 = "951a341f-236b-42fe-a667-4ab2fcf36eac"
STARLINK_6_25 = "ec6b5681-566f-465e-a164-97cfe48b6172"
BROADCAST = (
    "navarea-iv-1080-26.txt",
    "navarea-iv-1078-26.txt",
    "navarea-iv-1099-26.txt",
    "navarea-iv-1081-26.txt",
    "hydropac-3246-26.txt",
    "hydropac-3245-26.txt",
    "hydropac-3308-26.txt",
    "navarea-xii-785-26.txt",
    "navarea-xii-in-force-2026-11-13.txt",
)
FAA = ("faa-tfr-6-7129.xml", "faa-tfr-6-7130.xml", "faa-tfr-6-7131.xml", "faa-tfr-6-7111.xml", "faa-tfr-6-7112.xml")
USCG = "uscg-space-ops-2026-11-13.geojson"
NGA_2023 = "nga-navarea-iv-active-2023-10-31.json"
_MONTHS = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split()
_HEADER_TIME = re.compile(r"^(\d{2})(\d{2})(\d{2})Z ([A-Z]{3}) (\d{2})$")
_HEADER_ID = re.compile(r"^(NAVAREA (?:IV|XII)|HYDROPAC|HYDROLANT) (\d+/\d{2})")
_DM = re.compile(r"(\d{2,3})-(\d{2}\.\d{2})([NSEW])")
_DMS = re.compile(r"(\d{2,3})-(\d{2})-(\d{2})([NSEW])")


def manifest(name: str) -> dict:
    rows = json.loads((NOTICES / "MANIFEST.json").read_text())["files"]
    return next(row for row in rows if row["file"] == name)


def file_sha256(name: str) -> str:
    return hashlib.sha256((NOTICES / name).read_bytes()).hexdigest()


def retrieved(name: str) -> datetime:
    return datetime.strptime(manifest(name)["retrieved_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def broadcast_blocks(name: str) -> list[tuple[str, datetime, str]]:
    """(notice id, issue time, body) for each warning in a text fixture."""
    found = []
    for block in (NOTICES / name).read_text().split("\n\n\n"):
        lines = block.strip("\n").splitlines()
        if len(lines) < 3:
            continue
        stamp, ident = _HEADER_TIME.match(lines[0]), _HEADER_ID.match(lines[1])
        day, hour, minute, month, year = stamp.groups()
        issued = datetime(2000 + int(year), _MONTHS.index(month) + 1, int(day), int(hour), int(minute), tzinfo=UTC)
        found.append((f"{ident.group(1)} {ident.group(2)}", issued, "\n".join(lines[2:]) + "\n"))
    return found


def broadcast_notices(name: str) -> list[Notice]:
    row = manifest(name)
    return [
        parse_broadcast_warning(body, notice_id, issued, row["source_url"], file_sha256(name))
        for notice_id, issued, body in broadcast_blocks(name)
    ]


def broadcast_notice(name: str, notice_id: str | None = None) -> Notice:
    notices = broadcast_notices(name)
    return notices[0] if notice_id is None else next(n for n in notices if n.notice_id == notice_id)


def broadcast_body(name: str, notice_id: str) -> str:
    return next(body for found, _, body in broadcast_blocks(name) if found == notice_id)


def faa_notice(name: str) -> Notice:
    return parse_faa_tfr((NOTICES / name).read_bytes(), manifest(name)["source_url"])


def uscg_notices() -> list[Notice]:
    return parse_uscg_space_operations((NOTICES / USCG).read_bytes(), manifest(USCG)["source_url"])


def uscg_notice(uid: int) -> Notice:
    return next(notice for notice in uscg_notices() if notice.notice_id == f"USCG LNM {uid}")


def uscg_description(uid: int) -> str:
    features = json.loads((NOTICES / USCG).read_text())["features"]
    return next(f["properties"]["DESCRIPTION"] for f in features if f["properties"]["MSI_UID"] == uid)


def scenario_sightings() -> list[Sighting]:
    """Every 2026 fixture as one run would have seen it, each at its own retrieval time."""
    found = [Sighting(notice, retrieved(name)) for name in BROADCAST for notice in broadcast_notices(name)]
    found += [Sighting(faa_notice(name), retrieved(name)) for name in FAA]
    found += [Sighting(notice, retrieved(USCG)) for notice in uscg_notices()]
    return found


def catalog_items() -> list[dict]:
    """Starship from the 10 Nov capture and every launch of the 13 Nov capture."""
    early = json.loads((FIXTURES / "starship-catalog-2026-11-10.json").read_text())["items"]
    late = json.loads((FIXTURES / "launch-catalog-2026-11-13.json").read_text())["items"]
    return [item for item in early if item["event_id"] == STARSHIP] + late


def item(event_id: str, **schedule: str) -> dict:
    found = json.loads(json.dumps(next(i for i in catalog_items() if i["event_id"] == event_id)))
    found["schedule"].update(schedule)
    return found


def scenario_bundle() -> tuple[dict, list[dict]]:
    return build_bundle(catalog_items(), scenario_sightings(), SCENARIO_NOW)


def launch(bundle: dict, event_id: str) -> dict:
    return next(entry for entry in bundle["launches"] if entry["event_id"] == event_id)


def ring(bundle: dict, event_id: str, notice_id: str, area_id: str) -> list[list[float]]:
    for feature in launch(bundle, event_id)["geojson"]["features"]:
        props = feature["properties"]
        if props["notice_id"] == notice_id and props["area_id"] == area_id:
            return feature["geometry"]["coordinates"][0]
    raise AssertionError((notice_id, area_id))


def _round5(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.00001"), rounding=ROUND_HALF_UP)


def read_dm_pairs(text: str) -> list[tuple[Decimal, Decimal]]:
    """(lon, lat) for each ``DD-MM.mmN DDD-MM.mmW`` pair, in the order written."""
    values = []
    for degrees, minutes, hemisphere in _DM.findall(text):
        value = _round5(Decimal(degrees) + Decimal(minutes) / Decimal(60))
        values.append(-value if hemisphere in "SW" else value)
    return [(values[index + 1], values[index]) for index in range(0, len(values), 2)]


def read_dms_pairs(text: str) -> list[tuple[Decimal, Decimal]]:
    """(lon, lat) for each ``DD-MM-SSN DDD-MM-SSW`` pair, in the order written."""
    values = []
    for degrees, minutes, seconds, hemisphere in _DMS.findall(text):
        value = _round5(Decimal(degrees) + Decimal(minutes) / Decimal(60) + Decimal(seconds) / Decimal(3600))
        values.append(-value if hemisphere in "SW" else value)
    return [(values[index + 1], values[index]) for index in range(0, len(values), 2)]


def read_tfr_ring(xml: str) -> list[tuple[Decimal, Decimal]]:
    """(lon, lat) of the merged area in an FAA detail file, without the closing repeat."""
    merged = xml.split("<abdMergedArea>", 1)[1].split("</abdMergedArea>", 1)[0]
    found = re.findall(r"<geoLat>([\d.]+)([NS])</geoLat>\s*<geoLong>([\d.]+)([EW])</geoLong>", merged)
    points = [
        (-Decimal(lon) if ew == "W" else Decimal(lon), -Decimal(lat) if ns == "S" else Decimal(lat))
        for lat, ns, lon, ew in found
    ]
    return points[:-1] if points[0] == points[-1] else points


def between(text: str, start: str, end: str) -> str:
    return text.split(start, 1)[1].split(end, 1)[0]


def same_ring(stored: list[list[float]], expected: list[tuple[Decimal, Decimal]]) -> bool:
    """A closed stored ring holds exactly the expected vertices, in either direction."""
    if len(stored) != len(expected) + 1 or stored[0] != stored[-1]:
        return False

    def matches(order: list[tuple[Decimal, Decimal]]) -> bool:
        size = len(order)
        return any(
            all(
                abs(Decimal(str(point[0])) - order[(offset + index) % size][0]) <= Decimal("0.00000001")
                and abs(Decimal(str(point[1])) - order[(offset + index) % size][1]) <= Decimal("0.00000001")
                for index, point in enumerate(stored[:-1])
            )
            for offset in range(size)
        )

    return matches(expected) or matches(list(reversed(expected)))


if __name__ == "__main__":
    GOLDEN.write_text(json.dumps(scenario_bundle()[0], indent=1, sort_keys=True) + "\n")
    print(f"wrote {GOLDEN.relative_to(ROOT)}")
