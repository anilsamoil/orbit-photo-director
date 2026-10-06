export type LonLat = { lon: number; lat: number };

/** South-west and north-east in `[lon, lat]`. Copies shifted by a world are ignored. */
export function insetTrackBounds(
  features: readonly GeoJSON.Feature[],
  position: LonLat | null,
): [[number, number], [number, number]] | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const take = (lon: number, lat: number): void => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < -180 || lon > 180) return;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  };
  for (const feature of features) {
    const geometry = feature.geometry;
    if (geometry.type !== 'LineString') continue;
    for (const pair of geometry.coordinates) {
      const lon = pair[0];
      const lat = pair[1];
      if (lon === undefined || lat === undefined) continue;
      take(lon, lat);
    }
  }
  if (position) take(position.lon, position.lat);
  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  if (east - west < 1 && north - south < 1) {
    west -= 20;
    east += 20;
    south = Math.max(-80, south - 20);
    north = Math.min(80, north + 20);
  }
  return [[west, south], [east, north]];
}
