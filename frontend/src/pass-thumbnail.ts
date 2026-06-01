/** Per-pass-card zoom imagery thumbnail (v2 — Jack feedback 2026-05-27).
 *
 *  Renders a small Esri World Imagery satellite tile centered on a pass's
 *  target, with the ISS ground-track polyline overlaid for the AOS → LOS
 *  window of the pass. Operator taps the 🌍 icon-button on a personal-
 *  target pass card; this module composes the thumbnail inline below.
 *
 *  Spec reference: astroanil-main-design-20260527-082638.md Component 1.
 *  Key contracts:
 *    - Static raster from Esri World_Imagery at z=12 (matches main Map tab basemap)
 *    - Single tile or 2×2 grid centered on (target_lat, target_lon)
 *    - 256×256 base pixel size, scaled by window.devicePixelRatio for retina
 *    - ISS polyline: polynomial first, SGP4 fallback via satellite.js
 *    - Sample at 30s intervals across AOS → LOS (approximated as
 *      closest_approach ± 5 min — most passes are 6-10 min total)
 *    - ISS marker at iss_at_closest (already in PassEntry)
 *    - "X° from nadir" annotation + countdown
 *    - Esri tile failure: gray placeholder + "Imagery unavailable — {error}"
 *    - Attribution: "© Esri, Maxar, Earthstar Geographics" caption
 *    - Browser HTTP cache only (no prefetch, no SW pre-cache for v1)
 *
 *  Design surface: a single exported `renderPassThumbnail(pass, track)` that
 *  returns an HTMLElement the caller appends below the card. Caller owns
 *  show/hide state — per-session per-card, not persisted.
 *
 *  XSS: all operator-controlled strings (target_name) use `textContent`.
 *  Imagery URLs are constructed from numeric tile coords; no interpolation
 *  of operator input.
 */

import type { PassEntry, Track } from './types';
import { liveIssPosition } from './iss';
import { liveIssPositionSGP4 } from './iss-sgp4';

/** Thumbnail tile zoom level. z=12 → ~9.5 km tile-width at equator.
 *  NOTE: the thumbnail renders the single slippy tile that CONTAINS the
 *  target, but the overlay draws the target marker at the canvas center —
 *  so the target can sit off-center by up to ~half a tile. At z=12 that's
 *  ~9.5 km (accepted since v1). Do NOT widen this zoom to add context
 *  without ALSO centering the tile composition on the target: a wider tile
 *  multiplies the off-center error and lets the reference-labels overlay
 *  confidently name a feature tens of km from the real target. The labels
 *  overlay below names whatever is in this tight, target-adjacent frame —
 *  the safe identifiability win. A properly target-centered wider view
 *  (2×2 grid offset so the target is the canvas center) is the follow-up
 *  that would let us zoom out for open-ocean targets without lying. */
export const THUMBNAIL_ZOOM = 12;

/** Base pixel size of the thumbnail (before devicePixelRatio scaling).
 *  256×256 is one Web Mercator tile at the chosen zoom. */
export const THUMBNAIL_PIXEL_SIZE = 256;

/** Number of seconds of pass window to sample around closest_approach.
 *  ±300 s = ±5 min, comfortably covers typical 6-10 min ISS passes. */
export const PASS_WINDOW_HALF_SECONDS = 300;

/** Sample step for the ISS polyline. 30s × ±300s = 21 samples per pass
 *  — enough to draw a smooth polyline at z=12 without overdrawing. */
export const PASS_SAMPLE_STEP_SECONDS = 30;

/** Build the Esri World Imagery tile URL for a (z, x, y) triple.
 *  Same source as the main Map tab's clouds-off basemap (visual consistency). */
export function esriImageryTileUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

/** Build the Esri reference-labels tile URL (place names + boundaries +
 *  coastlines) for a (z, x, y) triple. Same source as the main Map tab's
 *  🏷️ labels overlay. Composited as a transparent layer over the imagery
 *  tile so the operator can name what they're looking at. */
export function esriReferenceTileUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
}

/** Convert (lon, lat) → fractional (x, y) tile coordinates at zoom z.
 *  Web Mercator (EPSG:3857) standard slippy-map projection. Returns
 *  fractional coords so the caller can compute pixel offsets within
 *  the surrounding tile. */
export function lonLatToTileXY(
  lon: number, lat: number, z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

/** Sample the ISS ground-track at PASS_SAMPLE_STEP_SECONDS intervals across
 *  the [closest_approach - half, closest_approach + half] window. Tries the
 *  polynomial first (cheap, matches the live-track shape), falls back to
 *  SGP4 if the polynomial window doesn't cover.
 *
 *  Returns an array of [lon, lat] sample points (lon first to match the
 *  tile-projection convention used by the caller). Empty array means
 *  "neither polynomial nor SGP4 could resolve any sample" — the caller
 *  shows the tile without an overlay polyline.
 */
export function sampleIssTrackForPass(
  pass: PassEntry,
  track: Track,
  halfSeconds: number = PASS_WINDOW_HALF_SECONDS,
  stepSeconds: number = PASS_SAMPLE_STEP_SECONDS,
): Array<[number, number]> {
  const caMs = Date.parse(pass.closest_approach);
  if (!Number.isFinite(caMs)) return [];
  const samples: Array<[number, number]> = [];
  for (let dt = -halfSeconds; dt <= halfSeconds; dt += stepSeconds) {
    const tMs = caMs + dt * 1000;
    // Polynomial first — the design's "polynomial sampled at 30s intervals"
    // spec. liveIssPosition returns null if outside the polynomial window;
    // we then try SGP4 (the design's explicit fallback).
    const poly = liveIssPosition(track, tMs);
    if (poly) {
      samples.push([poly.lon, poly.lat]);
      continue;
    }
    const sgp4 = liveIssPositionSGP4(track, tMs);
    if (sgp4) {
      samples.push([sgp4.lon, sgp4.lat]);
      continue;
    }
    // Both null — skip this sample, keep walking. The polyline gets a gap.
  }
  return samples;
}

/** Project a (lon, lat) sample into pixel coordinates within the thumbnail.
 *  Origin is the top-left of the thumbnail canvas.
 *
 *  centerLon/centerLat = the target's coords (thumbnail is centered there).
 *  basePx = THUMBNAIL_PIXEL_SIZE (the un-DPR-scaled logical pixel size).
 *
 *  Returns null when the sample falls more than basePx/2 outside the
 *  thumbnail (caller's polyline path will move-to the next valid point
 *  for a clean break instead of drawing off-canvas).
 */
export function projectSampleToThumbnail(
  sampleLon: number, sampleLat: number,
  centerLon: number, centerLat: number,
  basePx: number = THUMBNAIL_PIXEL_SIZE,
  z: number = THUMBNAIL_ZOOM,
): { px: number; py: number } | null {
  const center = lonLatToTileXY(centerLon, centerLat, z);
  const sample = lonLatToTileXY(sampleLon, sampleLat, z);
  // Tile coords are in "tile units"; 1 tile = 256 px. Translate to pixel
  // delta from the thumbnail center, then to top-left origin.
  const pxPerTile = 256;
  const dx = (sample.x - center.x) * pxPerTile;
  const dy = (sample.y - center.y) * pxPerTile;
  const px = basePx / 2 + dx;
  const py = basePx / 2 + dy;
  // Clip: anything outside ±basePx is too far to be meaningful (the pass
  // ground-track sweeps faster than the thumbnail extent at z=12). Return
  // null so the caller can break the polyline cleanly.
  if (px < -basePx || px > basePx * 2) return null;
  if (py < -basePx || py > basePx * 2) return null;
  return { px, py };
}

/** Format the countdown to closest_approach (or "now" / "passed") for the
 *  thumbnail caption. Short form — the card's primary countdown carries
 *  the full label; this is a contextual reminder inside the thumbnail. */
export function formatThumbnailCountdown(closestApproachIso: string, nowMs: number): string {
  const t = Date.parse(closestApproachIso);
  if (!Number.isFinite(t)) return '';
  const deltaSec = Math.round((t - nowMs) / 1000);
  if (Math.abs(deltaSec) < 30) return 'now';
  if (deltaSec < 0) {
    const m = Math.round(-deltaSec / 60);
    return `${m} min ago`;
  }
  const m = Math.round(deltaSec / 60);
  if (m < 60) return `in ${m} min`;
  return `in ${Math.round(m / 60)} h`;
}

/** Render the pass thumbnail as a self-contained DOM subtree. Caller
 *  appends this element below the pass card; the returned element is
 *  un-styled beyond the .pass-thumbnail class (styles in style.css).
 *
 *  Visual structure:
 *    .pass-thumbnail
 *      .pass-thumbnail-image  (the Esri tile <img>)
 *      .pass-thumbnail-overlay  (the absolutely-positioned SVG polyline + marker)
 *      .pass-thumbnail-caption  ("X° nadir · in N min")
 *      .pass-thumbnail-attribution  (Esri attribution)
 *
 *  The Esri tile <img> uses the browser's HTTP cache (no SW pre-cache for
 *  v1 per design doc Component 1). Tile load failure swaps the <img> for
 *  a gray placeholder + error caption.
 */
export function renderPassThumbnail(
  pass: PassEntry,
  track: Track | null,
  nowMs: number = Date.now(),
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pass-thumbnail';

  // Compute the tile containing the target. We render a single tile for
  // the v1 simple-case (one 256×256 image); the polyline overlay is what
  // gives the spatial context.
  const tile = lonLatToTileXY(pass.target_lon, pass.target_lat, THUMBNAIL_ZOOM);
  const tileX = Math.floor(tile.x);
  const tileY = Math.floor(tile.y);

  // The target is at fractional (tile.x - tileX, tile.y - tileY) within the
  // tile; if the target sits near a tile edge, the thumbnail will show the
  // target off-center. v1 accepts this — single-tile fetch keeps the
  // dependency simple. A v2 enhancement could fetch a 2×2 grid.

  // Esri tile <img>. devicePixelRatio scaling: the underlying tile is
  // always 256 px, but we set the CSS size to logical THUMBNAIL_PIXEL_SIZE
  // and let the browser scale up on retina (slight blur is acceptable for
  // the operator UX; the alternative — fetching higher-zoom tiles — would
  // need a 2×2 grid).
  const img = document.createElement('img');
  img.className = 'pass-thumbnail-image';
  img.width = THUMBNAIL_PIXEL_SIZE;
  img.height = THUMBNAIL_PIXEL_SIZE;
  img.alt = '';  // decorative; the card's name is the screen-reader anchor
  img.loading = 'lazy';
  // Set the src ONLY after the load/error handlers are attached so a
  // synchronously-cached image doesn't fire before we can listen.
  let tileLoaded = false;
  img.addEventListener('load', () => { tileLoaded = true; });
  img.addEventListener('error', () => {
    if (tileLoaded) return;  // already swapped to placeholder
    showTileFailurePlaceholder(wrap, img, 'network error');
  });
  img.src = esriImageryTileUrl(THUMBNAIL_ZOOM, tileX, tileY);

  wrap.appendChild(img);

  // Reference-labels overlay: place names, boundaries, and coastlines from
  // the same Esri service the Map tab's 🏷️ toggle uses. Transparent PNG
  // composited over the imagery so the operator can identify the site by
  // its surroundings ("that's the lake north of the city") instead of
  // staring at unlabelled terrain. Decorative + best-effort: if it fails to
  // load we just leave it out (no placeholder), the imagery still stands.
  const labels = document.createElement('img');
  labels.className = 'pass-thumbnail-labels';
  labels.width = THUMBNAIL_PIXEL_SIZE;
  labels.height = THUMBNAIL_PIXEL_SIZE;
  labels.alt = '';
  labels.loading = 'lazy';
  labels.addEventListener('error', () => { labels.remove(); });
  labels.src = esriReferenceTileUrl(THUMBNAIL_ZOOM, tileX, tileY);
  wrap.appendChild(labels);

  // Overlay SVG: ISS polyline + marker + nadir-distance label. Position
  // absolute over the image. Sized to the same logical pixels.
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlay.setAttribute('class', 'pass-thumbnail-overlay');
  overlay.setAttribute('width', String(THUMBNAIL_PIXEL_SIZE));
  overlay.setAttribute('height', String(THUMBNAIL_PIXEL_SIZE));
  overlay.setAttribute('viewBox', `0 0 ${THUMBNAIL_PIXEL_SIZE} ${THUMBNAIL_PIXEL_SIZE}`);

  // Center cross-hair at the target location (always at the thumbnail
  // center because the tile is rendered with the target tile as the
  // canvas — the operator's reference point).
  const targetMarker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  targetMarker.setAttribute('cx', String(THUMBNAIL_PIXEL_SIZE / 2));
  targetMarker.setAttribute('cy', String(THUMBNAIL_PIXEL_SIZE / 2));
  targetMarker.setAttribute('r', '5');
  targetMarker.setAttribute('class', 'pass-thumbnail-target-marker');
  overlay.appendChild(targetMarker);

  // Target's fractional position within its containing tile. The image
  // displays the tile (tileX, tileY); the target may be near a tile edge.
  // Shift the polyline samples so the target appears at the geometric
  // center of the thumbnail canvas instead of its fractional offset.
  // (Equivalent to: project samples relative to (target_lon, target_lat)
  // → thumbnail-center; which is what projectSampleToThumbnail already does.)

  if (track) {
    const samples = sampleIssTrackForPass(pass, track);
    if (samples.length >= 2) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      let d = '';
      let lastInside = false;
      for (const [lon, lat] of samples) {
        const proj = projectSampleToThumbnail(lon, lat, pass.target_lon, pass.target_lat);
        if (!proj) { lastInside = false; continue; }
        const cmd = lastInside ? 'L' : 'M';
        d += `${cmd}${proj.px.toFixed(1)},${proj.py.toFixed(1)} `;
        lastInside = true;
      }
      if (d) {
        path.setAttribute('d', d.trim());
        path.setAttribute('class', 'pass-thumbnail-iss-track');
        // Insert track BEFORE the target marker so the marker dot stays
        // on top of any line crossing through the target tile.
        overlay.insertBefore(path, targetMarker);
      }
    }
  }

  // ISS marker at iss_at_closest. The closest_approach moment is special —
  // it's the geometric moment the operator's shot is anchored to. Marker
  // shows where the ISS is at that moment.
  if (
    typeof pass.iss_at_closest?.lat === 'number' &&
    typeof pass.iss_at_closest?.lon === 'number'
  ) {
    const issProj = projectSampleToThumbnail(
      pass.iss_at_closest.lon, pass.iss_at_closest.lat,
      pass.target_lon, pass.target_lat,
    );
    if (issProj) {
      const issMarker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      issMarker.setAttribute('cx', String(issProj.px));
      issMarker.setAttribute('cy', String(issProj.py));
      issMarker.setAttribute('r', '6');
      issMarker.setAttribute('class', 'pass-thumbnail-iss-marker');
      overlay.appendChild(issMarker);
    }
  }

  wrap.appendChild(overlay);

  // Caption: nadir distance + countdown. textContent only (operator-safe).
  const caption = document.createElement('div');
  caption.className = 'pass-thumbnail-caption';
  const captionParts: string[] = [];
  if (Number.isFinite(pass.nadir_distance_km)) {
    captionParts.push(`${Math.round(pass.nadir_distance_km)} km nadir`);
  }
  if (typeof pass.angle_off_nadir_deg === 'number') {
    captionParts.push(`${Math.round(pass.angle_off_nadir_deg)}° off`);
  }
  const countdown = formatThumbnailCountdown(pass.closest_approach, nowMs);
  if (countdown) captionParts.push(countdown);
  caption.textContent = captionParts.join(' · ');
  wrap.appendChild(caption);

  // Esri attribution (ToS requirement; free-tier non-commercial use).
  const attr = document.createElement('div');
  attr.className = 'pass-thumbnail-attribution';
  attr.textContent = '© Esri, Maxar, Earthstar Geographics';
  wrap.appendChild(attr);

  return wrap;
}

/** Replace the tile <img> with a gray placeholder + caption when the
 *  Esri tile fails to load. Caller-side use only — this is internal to
 *  renderPassThumbnail's error handler. */
function showTileFailurePlaceholder(
  wrap: HTMLElement,
  img: HTMLImageElement,
  errorText: string,
): void {
  const placeholder = document.createElement('div');
  placeholder.className = 'pass-thumbnail-placeholder';
  placeholder.style.width = `${THUMBNAIL_PIXEL_SIZE}px`;
  placeholder.style.height = `${THUMBNAIL_PIXEL_SIZE}px`;
  // textContent guards against any conceivable error-text injection.
  placeholder.textContent = `Imagery unavailable — ${errorText}`;
  img.replaceWith(placeholder);
  // The polyline overlay still renders — operator gets the orbital
  // geometry even when the tile is missing.
  wrap.classList.add('pass-thumbnail-tile-failed');
}
