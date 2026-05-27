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

/** Build night-side shading polygon features (v2 — Chris feedback 2026-05-27).
 *  Returns a small set of GeoJSON Polygon features that cover the night-side
 *  hemisphere at the given UTC time. Rendered as a 0.30-opacity black fill
 *  under the terminator-line layer so the day/night boundary reads at a glance
 *  the way GoISSWatch's "clean dark night-side" does.
 *
 *  Strategy: for each latitude in 1° steps, sample the two terminator
 *  longitudes (dawn + dusk). The night arc between them is whichever
 *  longitude span is FARTHER from the subsolar longitude. We emit a thin
 *  polygon per pair of adjacent latitudes (so we cleanly avoid the
 *  antimeridian + pole sagas the v1 module deferred): the polygon is a
 *  quadrilateral [lat_i_night_west, lat_i_night_east, lat_i+1_night_east,
 *  lat_i+1_night_west]. Splits at antimeridian crossings by emitting two
 *  quads (the western part and the eastern part).
 *
 *  Polar regions (full day or full night per `terminatorLonAtLat` returning
 *  null) handled at the calling boundary: when a latitude has no terminator
 *  AND the subsolar point is on the OPPOSITE hemisphere → polar night → emit
 *  a full-width slab. When the subsolar point is on the SAME hemisphere →
 *  polar day → emit nothing for that latitude band.
 *
 *  Performance: ~180 latitude steps × constant work per step → renders in
 *  ~5ms. Called from map.ts's refreshTerminatorSources, same cadence as the
 *  line (30s tick + lookahead-scrub).
 */
export function terminatorNightPolygonFeatures(when: Date): GeoJSON.Feature[] {
  const subsolar = subsolarPoint(when);
  const LAT_STEP = 2; // 2° step is plenty for visual fill; halves polygon count vs 1° step
  const features: GeoJSON.Feature[] = [];

  // Build per-latitude night-arc descriptors: either a [west_lon, east_lon]
  // pair where the arc is "from west going east (possibly across the
  // antimeridian)" — that arc is on the night side — or 'all' for polar
  // night or null for polar day.
  type NightArc = { west: number; east: number } | 'all' | null;
  const arcs: NightArc[] = [];
  // Sample one extra latitude on each end to ensure top/bottom polygons close.
  const lats: number[] = [];
  for (let lat = -90; lat <= 90; lat += LAT_STEP) lats.push(lat);

  for (const lat of lats) {
    const lons = terminatorLonAtLat(lat, subsolar.lat, subsolar.lon);
    if (lons === null) {
      // Polar day or polar night. Same-hemisphere as subsolar → polar day.
      // Opposite hemisphere → polar night. (At |lat| ≈ 90, sin(lat)*sin(dec)
      // signs determine which.)
      const sameHemi = (lat >= 0) === (subsolar.lat >= 0);
      arcs.push(sameHemi ? null : 'all');
      continue;
    }
    // Two terminator crossings; the night arc is the one farther from the
    // subsolar longitude. Compute which lon is "evening" (west of subsolar
    // going east, into night) vs "morning" (east of subsolar going east,
    // out of night). Use angular distance to the antisolar meridian.
    const antisolar = wrapLon(subsolar.lon + 180);
    const [a, b] = lons;
    // The night arc goes from one terminator-lon through the antisolar
    // meridian to the other terminator-lon. We name it "west → east" walking
    // east; if the arc crosses the antimeridian, downstream code splits it.
    // The terminator longitudes are symmetric ±H about subsolar; the one
    // closer to subsolar+180 going one way is the "evening" boundary, the
    // other is "morning".
    // Simpler: pick the arc that CONTAINS the antisolar longitude.
    const arcContains = (west: number, east: number, lon: number): boolean => {
      // Walk east from west to east, possibly across antimeridian.
      let span = east - west;
      while (span < 0) span += 360;
      let off = lon - west;
      while (off < 0) off += 360;
      return off <= span;
    };
    if (arcContains(a, b, antisolar)) {
      arcs.push({ west: a, east: b });
    } else {
      arcs.push({ west: b, east: a });
    }
  }

  // Emit one quad per adjacent latitude band.
  for (let i = 0; i < lats.length - 1; i++) {
    const latS = lats[i]!;
    const latN = lats[i + 1]!;
    const arcS = arcs[i]!;
    const arcN = arcs[i + 1]!;
    // Both polar day → skip.
    if (arcS === null && arcN === null) continue;
    // Either all-night → emit full-width slab.
    if (arcS === 'all' || arcN === 'all') {
      // Full-width slab covers the world-copy too via duplication below.
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-180, latS], [180, latS], [180, latN], [-180, latN], [-180, latS],
          ]],
        },
      });
      continue;
    }
    // If one side is polar-day, use the other side's arc on both rows
    // (the band is tiny — 2° at most — and the visual approximation is
    // imperceptible vs the math complexity).
    const safeS = arcS === null ? arcN as { west: number; east: number } : arcS;
    const safeN = arcN === null ? arcS as { west: number; east: number } : arcN;

    // Walk from safeS.west → safeS.east going east; same for north row.
    // To produce clean quads that never span > 180° of longitude (which
    // would cause MapLibre to render the polygon across the wrong side
    // of the antimeridian), parameterize the eastward walk in [0, 360)
    // for both rows in their own continuous space, then split at the
    // first +180-crossing the band as a whole encounters.
    const buildQuads = (
      sw: number, se: number, nw: number, ne: number,
    ): [number, number][][] => {
      // Normalize so each row's east >= west; track each row's offset
      // so we can map back to wrapped lons after computing quad bounds.
      let seN = se, neN = ne;
      if (seN < sw) seN += 360;
      if (neN < nw) neN += 360;
      // Convert each row's [west, east] into a continuous parametric
      // range expressed as raw eastward-walk lons (possibly > 180).
      // Then unify: take the unioned start = min(sw, nw), unioned end
      // = max(seN, neN). This guarantees both row endpoints lie inside
      // the unified band, so the resulting quads enclose the night arc
      // without spanning the wrong way around the globe.
      //
      // The unified band's total width is bounded by max(seN-sw, neN-nw)
      // — both row widths are independently < 180° (night arcs at one
      // latitude can be at most 360° - 2H_min which is ≤ 180° at extreme
      // latitudes; the geometry guarantees this). The union widens at
      // most by the latitude-to-latitude wobble of the terminator lon,
      // which is small per 2° step.
      const startN = Math.min(sw, nw);
      const endN = Math.max(seN, neN);
      // If the unified band fits in [startN, startN+180], single quad;
      // otherwise split it at the antimeridian (lon = 180 in absolute).
      // Express the antimeridian crossing as the first multiple of 180
      // strictly greater than startN.
      const totalSpan = endN - startN;
      if (totalSpan <= 0) return [];
      // Find the antimeridian crossing inside the unioned walk (the lon
      // value that's congruent to 180 mod 360 and falls in (startN, endN)).
      let crossing: number | null = null;
      // Try +180 and +180+360 — startN ∈ [-180, 540] practically; the
      // crossing of interest is the smallest 180+k*360 > startN.
      for (let k = -1; k <= 2; k++) {
        const c = 180 + k * 360;
        if (c > startN && c < endN) { crossing = c; break; }
      }
      const wrapBackToWorld = (lon: number): number => {
        // Wrap into [-180, 180]. The "world-copy duplication" loop later
        // emits the +360 / -360 copies separately, so we keep the quad
        // ring in the canonical world here.
        let v = lon;
        while (v > 180) v -= 360;
        while (v <= -180) v += 360;
        return v;
      };
      // Build per-row endpoint lons in the unioned coordinate frame, then
      // wrap back. The polygon ring uses the unioned-frame values for the
      // interior calculation (no wrap), then we wrap_back when emitting
      // the final coordinates — but the wrap-back can re-introduce the
      // 180-bleed. Easier: emit the quad in the UNIONED frame (lons may
      // exceed 180), then split at the crossing, then wrap each split
      // piece back to world coords.
      const quadsRaw: [number, number][][] = [];
      if (crossing === null) {
        // Single quad in unioned frame.
        quadsRaw.push([
          [sw, latS], [seN, latS], [neN, latN], [nw, latN], [sw, latS],
        ]);
      } else {
        // Split at `crossing` (= 180 + k*360). Piece-1: [startN, crossing].
        // Piece-2: [crossing, endN]. For each row, clip the [west, east]
        // segment at `crossing` and emit either or both pieces depending
        // on which side the row's lons fall.
        // West piece (row segments restricted to <= crossing):
        const piece1 = (
          rowWest: number, rowEast: number,
        ): [number, number] | null => {
          if (rowEast <= crossing!) return [rowWest, rowEast];
          if (rowWest >= crossing!) return null;
          return [rowWest, crossing!];
        };
        // East piece (row segments restricted to >= crossing):
        const piece2 = (
          rowWest: number, rowEast: number,
        ): [number, number] | null => {
          if (rowWest >= crossing!) return [rowWest, rowEast];
          if (rowEast <= crossing!) return null;
          return [crossing!, rowEast];
        };
        const s1 = piece1(sw, seN), n1 = piece1(nw, neN);
        if (s1 && n1) {
          quadsRaw.push([
            [s1[0], latS], [s1[1], latS],
            [n1[1], latN], [n1[0], latN],
            [s1[0], latS],
          ]);
        }
        const s2 = piece2(sw, seN), n2 = piece2(nw, neN);
        if (s2 && n2) {
          quadsRaw.push([
            [s2[0], latS], [s2[1], latS],
            [n2[1], latN], [n2[0], latN],
            [s2[0], latS],
          ]);
        }
      }
      // Wrap each raw quad as a WHOLE: compute a single offset (multiple
      // of 360) that brings the quad's MIDPOINT into [-180, 180], then
      // apply that offset to every vertex. This keeps the quad's lons
      // monotonic across the antimeridian rather than wrapping individual
      // vertices independently (which would tear a [180, 250] piece into
      // [180, -110]).
      return quadsRaw.map((q) => {
        const lons = q.map(([lon]) => lon);
        const mid = (Math.min(...lons) + Math.max(...lons)) / 2;
        let offset = 0;
        while (mid + offset > 180) offset -= 360;
        while (mid + offset <= -180) offset += 360;
        return q.map(([lon, lat]) => [lon + offset, lat] as [number, number]);
      });
    };
    const quads = buildQuads(safeS.west, safeS.east, safeN.west, safeN.east);
    for (const q of quads) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [q] },
      });
    }
  }

  // World-copy duplication so the night shading renders continuously when
  // the operator pans east/west across world copies. Mirrors the line
  // duplication pattern above.
  const duplicated: GeoJSON.Feature[] = [];
  for (const f of features) {
    duplicated.push(f);
    const g = f.geometry as GeoJSON.Polygon;
    duplicated.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: g.coordinates.map((ring) =>
          (ring as [number, number][]).map(
            ([lon, lat]) => [lon + 360, lat] as [number, number],
          ),
        ),
      },
    });
    duplicated.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: g.coordinates.map((ring) =>
          (ring as [number, number][]).map(
            ([lon, lat]) => [lon - 360, lat] as [number, number],
          ),
        ),
      },
    });
  }
  return duplicated;
}

/** Build day-side (sun-side) polygon features (v3.1 — Anil same-day feedback
 *  2026-05-26). The geometric complement of `terminatorNightPolygonFeatures`:
 *  for each latitude in 2° steps, the day arc spans the longitudes NOT in the
 *  night arc (i.e. the arc that does NOT contain the antisolar meridian).
 *
 *  Operator request: when the day-night terminator overlay is ON together with
 *  the VIIRS night-lights overlay, mask the city-lights raster on the sun
 *  side so the lights only show in the actual current shadow. Drawn as a
 *  solid basemap-colored fill above the night-lights raster but below the
 *  terminator line. See map.ts:`terminator-day-mask-layer`.
 *
 *  Symmetric to the night polygon: same lat sampling, same antimeridian
 *  handling, same world-copy duplication. Polar caps are inverted —
 *  polar-day latitudes (where the night function returns null) get a
 *  full-width slab here; polar-night latitudes get nothing.
 *
 *  Performance: ~5ms per call. Called from refreshTerminatorSources every
 *  30s + on time-scrub, same cadence as the night polygon.
 */
export function terminatorDayPolygonFeatures(when: Date): GeoJSON.Feature[] {
  const subsolar = subsolarPoint(when);
  const LAT_STEP = 2;
  const features: GeoJSON.Feature[] = [];

  // Per-latitude day-arc descriptors. Mirrors the night-polygon logic but
  // picks the OTHER arc (the one that does NOT contain the antisolar
  // meridian — i.e. the one that DOES contain the subsolar meridian).
  type DayArc = { west: number; east: number } | 'all' | null;
  const arcs: DayArc[] = [];
  const lats: number[] = [];
  for (let lat = -90; lat <= 90; lat += LAT_STEP) lats.push(lat);

  for (const lat of lats) {
    const lons = terminatorLonAtLat(lat, subsolar.lat, subsolar.lon);
    if (lons === null) {
      // Same-hemisphere as subsolar → polar DAY (emit full slab here).
      // Opposite hemisphere → polar NIGHT (emit nothing).
      const sameHemi = (lat >= 0) === (subsolar.lat >= 0);
      arcs.push(sameHemi ? 'all' : null);
      continue;
    }
    const antisolar = wrapLon(subsolar.lon + 180);
    const [a, b] = lons;
    const arcContains = (west: number, east: number, lon: number): boolean => {
      let span = east - west;
      while (span < 0) span += 360;
      let off = lon - west;
      while (off < 0) off += 360;
      return off <= span;
    };
    // Day arc = the one that does NOT contain antisolar (equivalently, the
    // one that DOES contain subsolar). Picking by antisolar mirrors the
    // night-arc test exactly with the boolean flipped.
    if (arcContains(a, b, antisolar)) {
      arcs.push({ west: b, east: a });
    } else {
      arcs.push({ west: a, east: b });
    }
  }

  for (let i = 0; i < lats.length - 1; i++) {
    const latS = lats[i]!;
    const latN = lats[i + 1]!;
    const arcS = arcs[i]!;
    const arcN = arcs[i + 1]!;
    if (arcS === null && arcN === null) continue;
    if (arcS === 'all' || arcN === 'all') {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-180, latS], [180, latS], [180, latN], [-180, latN], [-180, latS],
          ]],
        },
      });
      continue;
    }
    const safeS = arcS === null ? arcN as { west: number; east: number } : arcS;
    const safeN = arcN === null ? arcS as { west: number; east: number } : arcN;

    // Same buildQuads helper as the night polygon — copied locally to avoid
    // factoring (keeps the surgical-change footprint small and the two
    // functions independently auditable for the antimeridian saga).
    const buildQuads = (
      sw: number, se: number, nw: number, ne: number,
    ): [number, number][][] => {
      let seN = se, neN = ne;
      if (seN < sw) seN += 360;
      if (neN < nw) neN += 360;
      const startN = Math.min(sw, nw);
      const endN = Math.max(seN, neN);
      const totalSpan = endN - startN;
      if (totalSpan <= 0) return [];
      let crossing: number | null = null;
      for (let k = -1; k <= 2; k++) {
        const c = 180 + k * 360;
        if (c > startN && c < endN) { crossing = c; break; }
      }
      const quadsRaw: [number, number][][] = [];
      if (crossing === null) {
        quadsRaw.push([
          [sw, latS], [seN, latS], [neN, latN], [nw, latN], [sw, latS],
        ]);
      } else {
        const piece1 = (
          rowWest: number, rowEast: number,
        ): [number, number] | null => {
          if (rowEast <= crossing!) return [rowWest, rowEast];
          if (rowWest >= crossing!) return null;
          return [rowWest, crossing!];
        };
        const piece2 = (
          rowWest: number, rowEast: number,
        ): [number, number] | null => {
          if (rowWest >= crossing!) return [rowWest, rowEast];
          if (rowEast <= crossing!) return null;
          return [crossing!, rowEast];
        };
        const s1 = piece1(sw, seN), n1 = piece1(nw, neN);
        if (s1 && n1) {
          quadsRaw.push([
            [s1[0], latS], [s1[1], latS],
            [n1[1], latN], [n1[0], latN],
            [s1[0], latS],
          ]);
        }
        const s2 = piece2(sw, seN), n2 = piece2(nw, neN);
        if (s2 && n2) {
          quadsRaw.push([
            [s2[0], latS], [s2[1], latS],
            [n2[1], latN], [n2[0], latN],
            [s2[0], latS],
          ]);
        }
      }
      return quadsRaw.map((q) => {
        const lons = q.map(([lon]) => lon);
        const mid = (Math.min(...lons) + Math.max(...lons)) / 2;
        let offset = 0;
        while (mid + offset > 180) offset -= 360;
        while (mid + offset <= -180) offset += 360;
        return q.map(([lon, lat]) => [lon + offset, lat] as [number, number]);
      });
    };
    const quads = buildQuads(safeS.west, safeS.east, safeN.west, safeN.east);
    for (const q of quads) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [q] },
      });
    }
  }

  // World-copy duplication so the day mask renders continuously when the
  // operator pans east/west. Same pattern as the night polygon.
  const duplicated: GeoJSON.Feature[] = [];
  for (const f of features) {
    duplicated.push(f);
    const g = f.geometry as GeoJSON.Polygon;
    duplicated.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: g.coordinates.map((ring) =>
          (ring as [number, number][]).map(
            ([lon, lat]) => [lon + 360, lat] as [number, number],
          ),
        ),
      },
    });
    duplicated.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: g.coordinates.map((ring) =>
          (ring as [number, number][]).map(
            ([lon, lat]) => [lon - 360, lat] as [number, number],
          ),
        ),
      },
    });
  }
  return duplicated;
}

/** ISS illumination state at a (when, lat, lon) tuple — used by v1.5.3.0
 *  (Chris feedback 2026-05-21) to color the ground-track line by whether
 *  the ISS itself is in sunlight, in Earth's shadow, or in the "twilight"
 *  band where ISS is sunlit but the ground below is dark (poor for
 *  photos — reflected glare from cabin against dark backdrop).
 *
 *  Three states:
 *    'iss-day'      — ground sub-point sunlit AND ISS sunlit (daytime pass)
 *    'iss-twilight' — ground sub-point dark, ISS sunlit (warning state)
 *    'iss-eclipse'  — ground sub-point dark AND ISS in Earth's shadow (night pass)
 *
 *  The 4th combination (ground sunlit + ISS eclipsed) is geometrically
 *  impossible — Sun is always on the same side of Earth as a sub-point
 *  in daylight.
 *
 *  Math: angle θ between (Earth-center → Sun) and (Earth-center → point).
 *    θ < 90°               → ground sunlit (and ISS sunlit, since ISS is higher).
 *    90° ≤ θ < 90° + α     → ground dark, ISS still sunlit.
 *    θ ≥ 90° + α           → ISS in shadow.
 *  where α = arccos(R / (R + h)) is the half-angle from Earth's center
 *  to ISS's local horizon. For R=6378.14 km, h=408 km: α ≈ 19.9°,
 *  so the twilight band runs 90°-109.9°.
 *
 *  v1.5.3.0 — frontend-only math; NOT computed in generator/cloud.py
 *  (yet). If/when generator-side ascent or scoring needs it, port this
 *  to Python and keep the two in sync the same way subsolarPoint /
 *  terminator math is synced today.
 */
export type IssIllumination = 'iss-day' | 'iss-twilight' | 'iss-eclipse';

const EARTH_RADIUS_KM = 6378.137;
const ISS_ALT_KM = 408;
/** Cached arccos(R/(R+h)) in degrees — ~19.9° for ISS. */
const ISS_HORIZON_HALF_ANGLE_DEG =
  Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + ISS_ALT_KM)) * 180 / Math.PI;
/** Sun-from-zenith angle (at Earth center) above which ISS is eclipsed.
 *  ~109.9° for ISS altitude. */
const ISS_ECLIPSE_THRESHOLD_DEG = 90 + ISS_HORIZON_HALF_ANGLE_DEG;

/** Great-circle angle (in degrees) between two points on a unit sphere
 *  given (lat, lon) in degrees. Used to find the angle from the Sun's
 *  subsolar point to an arbitrary sub-point. */
function greatCircleAngleDeg(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  let c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  // Clamp to [-1, 1] to defend against floating-point drift past the
  // arccos domain (A7 from /plan-eng-review 2026-05-21).
  if (c > 1) c = 1;
  if (c < -1) c = -1;
  return Math.acos(c) * 180 / Math.PI;
}

/** Classify the ISS illumination state at a given UTC time and ground
 *  sub-point (lat, lon). Exported for unit tests. */
export function classifyIssIllumination(
  when: Date,
  lat: number,
  lon: number,
): IssIllumination {
  const sub = subsolarPoint(when);
  const theta = greatCircleAngleDeg(sub.lat, sub.lon, lat, lon);
  // A7 from /plan-eng-review: use `<=` for the day boundary to avoid
  // flicker at exact 90° (consecutive 30s samples crossing the
  // terminator land on the same side deterministically).
  if (theta <= 90) return 'iss-day';
  if (theta < ISS_ECLIPSE_THRESHOLD_DEG) return 'iss-twilight';
  return 'iss-eclipse';
}
