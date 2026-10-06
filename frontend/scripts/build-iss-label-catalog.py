#!/usr/bin/env python3
"""Natural Earth is public domain. This scene cannot take a source that needs a
visible credit: fullscreen hides the attribution control.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import shapefile


def max_fov(min_zoom: float) -> int:
    fov = 78 - float(min_zoom) * 10
    return int(max(8, min(60, round(fov))))


def text(value: object) -> str:
    if value is None:
        return ''
    return str(value).strip()


def number(value: object, default: float = 99) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def mean_point(shape: shapefile.Shape) -> tuple[float, float] | None:
    points = [(pt[0], pt[1]) for pt in shape.points if pt[0] is not None and pt[1] is not None]
    if not points:
        return None
    lon = sum(pt[0] for pt in points) / len(points)
    lat = sum(pt[1] for pt in points) / len(points)
    if abs(lon) > 180 or abs(lat) > 90:
        return None
    return lon, lat


def midpoint(shape: shapefile.Shape) -> tuple[float, float] | None:
    parts = list(shape.parts) + [len(shape.points)]
    best: list[tuple[float, float]] = []
    for start, end in zip(parts, parts[1:]):
        ring = [(pt[0], pt[1]) for pt in shape.points[start:end]]
        if len(ring) > len(best):
            best = ring
    if not best:
        return None
    lon, lat = best[len(best) // 2]
    return lon, lat


def main() -> None:
    root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    hand = {
        'Beijing', 'Bogota', 'Cairo', 'Cape Town', 'Hong Kong', 'Istanbul', 'Jakarta',
        'Kolkata', 'Lagos', 'London', 'Los Angeles', 'Mexico City', 'Moscow', 'Mumbai',
        'Nairobi', 'New York', 'Paris', 'Rio de Janeiro', 'Riyadh', 'Rome', 'Santiago',
        'Shanghai', 'Singapore', 'Sydney', 'São Paulo', 'Tokyo', 'Washington D.C.',
    }
    rows: list[tuple[str, str, float, float, int, float]] = []
    seen: set[tuple[str, str]] = set()

    def add(kind: str, name: str, lon: float, lat: float, fov: int, rank: float) -> None:
        name = ' '.join(name.split())
        if not name or len(name) > 48:
            return
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            return
        key = (kind, name)
        if key in seen:
            return
        seen.add(key)
        rows.append((kind, name, lon, lat, fov, rank))

    places = shapefile.Reader(str(next((root / 'ne_50m_populated_places_simple').glob('*.shp'))))
    fields = [field[0] for field in places.fields[1:]]
    names_50m: set[str] = set()
    for record, shape in zip(places.records(), places.shapes()):
        name = text(record[fields.index('name')])
        names_50m.add(name)
        if name in hand:
            continue
        pop = number(record[fields.index('pop_max')], 0)
        kind = 'city' if pop >= 300_000 else 'town'
        fov = max_fov(number(record[fields.index('min_zoom')]))
        if kind == 'town':
            fov = min(fov, 18)
        lon, lat = shape.points[0]
        add(kind, name, lon, lat, fov, pop)

    towns = shapefile.Reader(str(next((root / 'ne_10m_populated_places_simple').glob('*.shp'))))
    town_fields = [field[0] for field in towns.fields[1:]]
    for record, shape in zip(towns.records(), towns.shapes()):
        name = text(record[town_fields.index('name')])
        if name in names_50m or name in hand:
            continue
        pop = number(record[town_fields.index('pop_max')], 0)
        if pop < 50_000:
            continue
        fov = min(max_fov(number(record[town_fields.index('min_zoom')])), 18)
        lon, lat = shape.points[0]
        add('town', name, lon, lat, fov, pop)

    admin = shapefile.Reader(str(next((root / 'ne_50m_admin_1').glob('*.shp'))))
    admin_fields = [field[0] for field in admin.fields[1:]]
    for record in admin.records():
        name = text(record[admin_fields.index('name')])
        lat = number(record[admin_fields.index('latitude')], 999)
        lon = number(record[admin_fields.index('longitude')], 999)
        area = number(record[admin_fields.index('area_sqkm')], 0)
        fov = min(max_fov(number(record[admin_fields.index('min_zoom')])), 42)
        add('region', name, lon, lat, fov, area)

    lakes = shapefile.Reader(str(next((root / 'ne_50m_lakes').glob('*.shp'))))
    lake_fields = [field[0] for field in lakes.fields[1:]]
    for record, shape in zip(lakes.records(), lakes.shapes()):
        name = text(record[lake_fields.index('name')])
        zoom = number(record[lake_fields.index('min_zoom')])
        if zoom > 5:
            continue
        point = mean_point(shape)
        if point is None:
            continue
        fov = min(max_fov(zoom), 24 if zoom <= 3 else 12)
        add('water', name, point[0], point[1], fov, -zoom)

    rivers = shapefile.Reader(str(next((root / 'ne_50m_rivers').glob('*.shp'))))
    river_fields = [field[0] for field in rivers.fields[1:]]
    for record, shape in zip(rivers.records(), rivers.shapes()):
        name = text(record[river_fields.index('name')])
        if number(record[river_fields.index('scalerank')], 99) > 4:
            continue
        point = midpoint(shape)
        if point is None:
            continue
        fov = min(max_fov(number(record[river_fields.index('min_zoom')])), 16)
        add('water', name, point[0], point[1], fov, 0)

    marine = shapefile.Reader(str(next((root / 'ne_50m_marine').glob('*.shp'))))
    marine_fields = [field[0] for field in marine.fields[1:]]
    for record, shape in zip(marine.records(), marine.shapes()):
        name = text(record[marine_fields.index('name')])
        if 'Ocean' in name:
            continue
        point = mean_point(shape)
        if point is None:
            continue
        if any(word in name for word in ('Gulf', 'Bay', 'Sea')):
            fov = 44
        elif any(word in name for word in ('Strait', 'Channel', 'Sound')):
            fov = 30
        else:
            continue
        add('water', name, point[0], point[1], fov, 0)

    rows.sort(key=lambda row: (row[0], row[1], row[2], row[3]))
    near = [row for row in rows if row[0] != 'town']
    towns = [row for row in rows if row[0] == 'town']
    write_catalog(out, 'LABEL_CATALOG', near)
    write_catalog(out.with_name('label-catalog-towns.ts'), 'LABEL_TOWNS', towns)
    print(f'near {len(near)} ({out.stat().st_size} bytes), towns {len(towns)} ({out.with_name("label-catalog-towns.ts").stat().st_size} bytes)')


def write_catalog(path: Path, symbol: str, rows: list[tuple[str, str, float, float, int, float]]) -> None:
    payload = [
        [kind, name, round(lon, 2), round(lat, 2), fov]
        for kind, name, lon, lat, fov, _rank in rows
    ]
    # One string, not an object-literal union. tsc cannot represent the latter.
    literal = json.dumps(json.dumps(payload, separators=(',', ':')))
    path.write_text(
        "import { readCatalog } from './catalog-read';\n\n"
        f'export const {symbol} = readCatalog(JSON.parse({literal}));\n'
    )


if __name__ == '__main__':
    main()
