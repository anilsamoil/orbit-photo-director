#!/usr/bin/env python3
"""Natural Earth is public domain. This scene cannot take a source that needs a
visible credit: fullscreen hides the attribution control.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import shapefile

SAME_PLACE_KM = 50
EARTH_KM = 6371.0

# Coordinates match PLACE_CITIES. A catalog row within 50 km is that city.
HAND = (
    ('Beijing', 116.39, 39.9),
    ('Bogota', -74.09, 4.6),
    ('Cairo', 31.25, 30.05),
    ('Cape Town', 18.43, -33.92),
    ('Hong Kong', 114.18, 22.31),
    ('Istanbul', 28.97, 41.02),
    ('Jakarta', 106.83, -6.17),
    ('Kolkata', 88.37, 22.57),
    ('Lagos', 3.39, 6.45),
    ('London', -0.12, 51.5),
    ('Los Angeles', -118.23, 34.05),
    ('Mexico City', -99.13, 19.44),
    ('Moscow', 37.61, 55.75),
    ('Mumbai', 72.88, 19.07),
    ('Nairobi', 36.81, -1.28),
    ('New York', -74.0, 40.72),
    ('Paris', 2.35, 48.86),
    ('Rio de Janeiro', -43.21, -22.91),
    ('Riyadh', 46.72, 24.63),
    ('Rome', 12.48, 41.9),
    ('Santiago', -70.65, -33.44),
    ('Shanghai', 121.43, 31.22),
    ('Singapore', 103.85, 1.29),
    ('Sydney', 151.21, -33.87),
    ('São Paulo', -46.63, -23.56),
    ('Tokyo', 139.75, 35.69),
    ('Washington D.C.', -77.01, 38.9),
)


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


def wrap_lon(lon: float) -> float:
    return ((lon + 180) % 360) - 180


def circular_mean(lons: list[float]) -> float | None:
    east = sum(math.sin(math.radians(lon)) for lon in lons)
    north = sum(math.cos(math.radians(lon)) for lon in lons)
    if east == 0 and north == 0:
        return None
    return wrap_lon(math.degrees(math.atan2(east, north)))


def km_between(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    haversine = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lon / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(min(1, haversine)))


def mean_point(shape: shapefile.Shape) -> tuple[float, float] | None:
    points = [(pt[0], pt[1]) for pt in shape.points if pt[0] is not None and pt[1] is not None]
    if not points:
        return None
    lon = circular_mean([pt[0] for pt in points])
    lat = sum(pt[1] for pt in points) / len(points)
    if lon is None or abs(lat) > 90:
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
    lons = [pt[0] for pt in best]
    if max(lons) - min(lons) < 180:
        return best[len(best) // 2]
    center = circular_mean(lons)
    if center is None:
        return best[len(best) // 2]

    def turn(lon: float) -> float:
        return abs(wrap_lon(lon - center))

    return min(best, key=lambda pt: turn(pt[0]))


def main() -> None:
    root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    rows: list[tuple[str, str, float, float, int, float]] = []
    placed: dict[tuple[str, str], list[tuple[float, float]]] = {}
    places_50m: list[tuple[str, float, float]] = []

    def same_place(lon: float, lat: float, other_lon: float, other_lat: float) -> bool:
        return km_between(lon, lat, other_lon, other_lat) <= SAME_PLACE_KM

    def covers_hand(lon: float, lat: float) -> bool:
        return any(same_place(lon, lat, hand_lon, hand_lat) for _name, hand_lon, hand_lat in HAND)

    def add(kind: str, name: str, lon: float, lat: float, fov: int, rank: float) -> None:
        name = ' '.join(name.split())
        if not name or len(name) > 48:
            return
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            return
        key = (kind, name)
        priors = placed.get(key, [])
        if any(same_place(lon, lat, prior_lon, prior_lat) for prior_lon, prior_lat in priors):
            return
        priors.append((lon, lat))
        placed[key] = priors
        rows.append((kind, name, lon, lat, fov, rank))

    places = shapefile.Reader(str(next((root / 'ne_50m_populated_places_simple').glob('*.shp'))))
    fields = [field[0] for field in places.fields[1:]]
    for record, shape in zip(places.records(), places.shapes()):
        name = text(record[fields.index('name')])
        lon, lat = shape.points[0]
        places_50m.append((name, lon, lat))
        if covers_hand(lon, lat):
            continue
        pop = number(record[fields.index('pop_max')], 0)
        kind = 'city' if pop >= 300_000 else 'town'
        fov = max_fov(number(record[fields.index('min_zoom')]))
        if kind == 'town':
            fov = min(fov, 18)
        add(kind, name, lon, lat, fov, pop)

    towns = shapefile.Reader(str(next((root / 'ne_10m_populated_places_simple').glob('*.shp'))))
    town_fields = [field[0] for field in towns.fields[1:]]
    for record, shape in zip(towns.records(), towns.shapes()):
        name = text(record[town_fields.index('name')])
        lon, lat = shape.points[0]
        if any(name == prior_name and same_place(lon, lat, prior_lon, prior_lat) for prior_name, prior_lon, prior_lat in places_50m):
            continue
        pop = number(record[town_fields.index('pop_max')], 0)
        if pop < 50_000:
            continue
        if covers_hand(lon, lat):
            continue
        fov = min(max_fov(number(record[town_fields.index('min_zoom')])), 18)
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
    near_path = out.with_name('label-catalog.json')
    town_path = out.with_name('label-catalog-towns.json')
    write_catalog(near_path, near)
    write_catalog(town_path, towns)
    print(f'near {len(near)} ({near_path.stat().st_size} bytes), towns {len(towns)} ({town_path.stat().st_size} bytes)')


def write_catalog(path: Path, rows: list[tuple[str, str, float, float, int, float]]) -> None:
    payload = [
        [kind, name, round(lon, 2), round(lat, 2), fov, int(round(rank))]
        for kind, name, lon, lat, fov, rank in rows
    ]
    path.write_text(json.dumps(payload, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
