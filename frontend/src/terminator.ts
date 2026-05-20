/** Day-night terminator computation for the map overlay (v1.4.2.0).
 *
 *  Operator request: Pettit 2026-05-19 — "day-night shading" on the map
 *  view, paired with the 3-4-future-orbits display. v1.4.0.0 shipped
 *  the time-scrub; this module adds the visual signal of which side of
 *  the world is in sunlight vs darkness at the current view time.
 *
 *  Math is a TypeScript port of the existing Python `sun_subpoint` +
 *  `_equation_of_time_minutes` helpers (generator/cloud.py:92-130). We
 *  keep them in sync — any drift would mean the JS-rendered terminator
 *  disagrees with the Python-computed lighting_regime that drives
 *  pin scoring. Tests pin the JS math against known fixtures from the
 *  Python implementation so we catch divergence early.
 *
 *  v1 = terminator LINE only. Shading polygon fill is V4-P2 follow-up
 *  (antimeridian + pole crossings are a small saga that doesn't fit a
 *  one-evening implementation).
 */

/** Equation of Time in minutes — apparent solar time minus mean solar
 *  time. Positive when apparent noon is BEFORE mean noon. Spencer's
 *  two-component approximation (obliquity + eccentricity), accurate
 *  to ~30 seconds across the year. Port of generator/cloud.py:92. */
export function equationOfTimeMinutes(dayOfYear: number): number {
  const b = (Math.PI * 2) * (dayOfYear - 81) / 365;
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

/** Subsolar point at a given UTC time. Returns [lat, lon] where the
 *  sun is directly overhead. Cooper's declination + UTC noon hour
 *  angle with Equation of Time correction. Sufficient for terminator
 *  rendering (accurate to ~0.5° lat/lon); not for precise solar
 *  geometry. Port of generator/cloud.py:108. */
export function subsolarPoint(when: Date): { lat: number; lon: number } {
  const ms = when.getTime();
  // Day of year (1-based, fractional for the time-of-day component).
  const yearStart = Date.UTC(when.getUTCFullYear(), 0, 1);
  const msPerDay = 86_400_000;
  const dayOfYear = (ms - yearStart) / msPerDay + 1;
  const dec = 23.44 * Math.sin((Math.PI * 2) * (284 + dayOfYear) / 365);

  const utcH = when.getUTCHours()
    + when.getUTCMinutes() / 60
    + when.getUTCSeconds() / 3600;
  const eotMin = equationOfTimeMinutes(dayOfYear);
  // Generator note: "sub_lon = -15 * (mean solar time offset from noon)";
  // EoT correction shifts apparent noon meridian eastward when EoT > 0.
  let subLon = -15.0 * (utcH - 12.0 + eotMin / 60.0);
  while (subLon > 180) subLon -= 360;
  while (subLon < -180) subLon += 360;
  return { lat: dec, lon: subLon };
}

/** Wrap a longitude into the [-180, 180] interval. */
function wrapLon(lon: number): number {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

/** Compute the longitude where the day-night terminator crosses a
 *  given latitude θ_t, given solar declination δ and the subsolar
 *  longitude (which is the longitude of solar noon).
 *
 *  Standard formula (e.g., leaflet-terminator):
 *
 *    cos(H) = -tan(θ_t) × tan(δ)
 *
 *  where H is the hour-angle offset from solar noon. The terminator
 *  has TWO longitudes per latitude (dawn + dusk); we return both so
 *  the caller can build a closed great-circle line.
 *
 *  Polar regions: when |tan(θ_t) × tan(δ)| > 1 the latitude is in
 *  full sun OR full darkness (polar day/night) and no terminator
 *  crosses it. We return null for those latitudes; the caller skips
 *  them when building the polyline.
 */
export function terminatorLonAtLat(
  latDeg: number,
  subsolarLatDeg: number,
  subsolarLonDeg: number,
): [number, number] | null {
  const lat = latDeg * Math.PI / 180;
  const dec = subsolarLatDeg * Math.PI / 180;
  const cosH = -Math.tan(lat) * Math.tan(dec);
  if (cosH < -1 || cosH > 1) return null;  // polar day/night
  const hRad = Math.acos(cosH);
  const hDeg = hRad * 180 / Math.PI;
  // The two terminator crossings: subsolar_lon ± H. Wrap to [-180, 180].
  return [wrapLon(subsolarLonDeg - hDeg), wrapLon(subsolarLonDeg + hDeg)];
}

/** Build the terminator polyline (closed loop) as GeoJSON LineString
 *  features. Samples latitudes from -89 to +89 in 1° steps, computes
 *  the two terminator longitudes per latitude, and stitches them into
 *  a closed line (dawn side going up, dusk side going down).
 *
 *  Splits at antimeridian crossings so MapLibre doesn't draw long
 *  horizontal lines across the world. Also duplicates the features
 *  at lon ±360 so the line renders continuously when the operator
 *  pans across world copies (matches the existing ground-track
 *  duplication pattern from v1.2.9.0).
 */
export function terminatorFeatures(when: Date): GeoJSON.Feature[] {
  const subsolar = subsolarPoint(when);
  // Collect the two terminator longitudes per latitude.
  const dawn: [number, number][] = [];
  const dusk: [number, number][] = [];
  for (let lat = -89; lat <= 89; lat += 1) {
    const lons = terminatorLonAtLat(lat, subsolar.lat, subsolar.lon);
    if (!lons) continue;
    const [a, b] = lons;
    // Dawn = where sun rises (east side at sunrise); we don't strictly
    // need to disambiguate which is dawn vs dusk because we render
    // both as the same colored line. Just keep them separated.
    dawn.push([a, lat]);
    dusk.push([b, lat]);
  }

  // Stitch into a single closed loop: walk dawn south-to-north, then
  // dusk north-to-south. Each consecutive segment with |Δlon| > 180
  // crosses the antimeridian and gets split.
  const loop: [number, number][] = [...dawn, ...dusk.slice().reverse()];

  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let prev: [number, number] | null = null;
  for (const pt of loop) {
    if (prev !== null && Math.abs(pt[0] - prev[0]) > 180) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(pt);
    prev = pt;
  }
  if (current.length > 1) segments.push(current);

  const features: GeoJSON.Feature[] = [];
  for (const seg of segments) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: seg },
    });
    // World-copy duplication so the line renders continuously across
    // the antimeridian when the user pans east/west.
    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: seg.map(([lon, lat]) => [lon + 360, lat]),
      },
    });
    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: seg.map(([lon, lat]) => [lon - 360, lat]),
      },
    });
  }
  return features;
}

/** Build the subsolar-point marker feature (single Point) for the
 *  operator-visible "sun is here" icon. Drives the day-side direction
 *  signal until we add full polygon shading. */
export function subsolarFeature(when: Date): GeoJSON.Feature {
  const { lat, lon } = subsolarPoint(when);
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}
