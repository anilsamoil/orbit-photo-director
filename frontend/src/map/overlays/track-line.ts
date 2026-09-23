import { wrapLon } from '../../geo';

type Pt = [number, number];

/** `[lat, lon]` samples become LineStrings split at the antimeridian, each
 *  copied one world east and one world west so a pan across the seam shows
 *  the same line. */
export function buildLineFeatures(samples: [number, number][]): GeoJSON.Feature[] {
  const segments: Pt[][] = [];
  let current: Pt[] = [];
  let prevLon: number | null = null;

  for (const [lat, lonRaw] of samples) {
    const lon = wrapLon(lonRaw);
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push([lon, lat]);
    prevLon = lon;
  }
  if (current.length > 1) segments.push(current);

  const duplicated: GeoJSON.Feature[] = [];
  for (const coords of segments) {
    for (const shift of [0, 360, -360]) {
      duplicated.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: shift === 0 ? coords : coords.map(([lon, lat]) => [lon + shift, lat]),
        },
      });
    }
  }
  return duplicated;
}
