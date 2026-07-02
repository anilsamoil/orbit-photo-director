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
import { buildConditionRows, renderConditionBlock } from './photo-conditions';
import { renderWxColumn } from './wx';
import { liveIssPosition } from './iss';
import { liveIssPositionSGP4 } from './iss-sgp4';
import { formatTrackOffset } from './track-offset';

/** Thumbnail tile zoom level. z=11 → ~19 km tile-width at equator.
 *  Widened from z=12 (~9.5 km) for more context (a coastline / city / lake
 *  in frame for offshore + remote targets). This is only safe because the
 *  tile layer is now CENTERED on the target (appendCenteredTileLayer): the
 *  marker at canvas center sits exactly on the target, and the labels name
 *  what's actually around it. Before centering, widening would have
 *  multiplied the off-center error and let labels name the wrong feature. */
export const THUMBNAIL_ZOOM = 11;

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

/** Format the countdown to closest_approach (or "now") for the thumbnail
 *  caption. Compact form ("in 8m" / "3m ago" / "in 2h") — the card's primary
 *  countdown carries the full "in 8 min" label; this is a contextual reminder
 *  inside the thumbnail, kept short so the three-part value row (countdown ·
 *  tilt · aim) fits the 256px width even with an "aft" qualifier. */
export function formatThumbnailCountdown(closestApproachIso: string, nowMs: number): string {
  const t = Date.parse(closestApproachIso);
  if (!Number.isFinite(t)) return '';
  const deltaSec = Math.round((t - nowMs) / 1000);
  if (Math.abs(deltaSec) < 30) return 'now';
  if (deltaSec < 0) {
    const m = Math.round(-deltaSec / 60);
    return `${m}m ago`;
  }
  const m = Math.round(deltaSec / 60);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}


/** Lay out the slippy tiles that fill the basePx×basePx thumbnail with the
 *  target at the canvas CENTER. Positions the 1-4 tiles that intersect the
 *  centered view by pixel offset (target's exact fractional position maps to
 *  the canvas center), so the marker drawn at center sits on the target and
 *  the labels name what's actually around it. Returns the img whose tile
 *  CONTAINS the target (the center tile) so the caller can attach offline
 *  handling to the one that matters; null if the target tile is off-grid.
 *
 *  `removeOnError`: when true, each tile removes itself on load failure
 *  (used for the decorative labels layer, where a gap beats a broken icon).
 */
function appendCenteredTileLayer(
  wrap: HTMLElement,
  urlFor: (z: number, x: number, y: number) => string,
  className: string,
  lon: number,
  lat: number,
  z: number = THUMBNAIL_ZOOM,
  basePx: number = THUMBNAIL_PIXEL_SIZE,
  removeOnError = false,
): HTMLImageElement | null {
  const t = lonLatToTileXY(lon, lat, z);
  const half = basePx / 2;
  // Canvas top-left in world-tile-pixels, chosen so the target → canvas center.
  const originX = t.x * 256 - half;
  const originY = t.y * 256 - half;
  const n = 2 ** z;
  const centerTileX = Math.floor(t.x);
  const centerTileY = Math.floor(t.y);
  let centerImg: HTMLImageElement | null = null;
  for (let tx = Math.floor(originX / 256); tx <= Math.floor((originX + basePx - 1) / 256); tx++) {
    for (let ty = Math.floor(originY / 256); ty <= Math.floor((originY + basePx - 1) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;  // no tiles past the poles
      const img = document.createElement('img');
      img.className = className;
      img.width = 256;
      img.height = 256;
      img.alt = '';
      img.loading = 'lazy';
      img.style.position = 'absolute';
      img.style.left = `${Math.round(tx * 256 - originX)}px`;
      img.style.top = `${Math.round(ty * 256 - originY)}px`;
      if (removeOnError) img.addEventListener('error', () => img.remove());
      img.src = urlFor(z, ((tx % n) + n) % n, ty);  // wrap x for the antimeridian
      wrap.appendChild(img);
      if (tx === centerTileX && ty === centerTileY) centerImg = img;
    }
  }
  return centerImg;
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

  // Imagery tiles, laid out so the TARGET is at the canvas center (not just
  // the containing tile, which left the target off-center by up to half a
  // tile). The marker at canvas center then sits exactly on the target.
  const centerImg = appendCenteredTileLayer(
    wrap, esriImageryTileUrl, 'pass-thumbnail-image', pass.target_lon, pass.target_lat,
  );
  // The center tile carries the offline placeholder — its failure swaps the
  // thumbnail for a gray placeholder (the SVG overlay still renders on top).
  if (centerImg) {
    let tileLoaded = false;
    centerImg.addEventListener('load', () => { tileLoaded = true; });
    centerImg.addEventListener('error', () => {
      if (tileLoaded) return;
      showTileFailurePlaceholder(wrap, centerImg, 'network error');
    });
  }

  // Reference-labels (place names / boundaries / coastlines) — the same
  // centered grid over the imagery so the operator can identify the site by
  // its surroundings. Best-effort: each label tile removes itself on failure.
  appendCenteredTileLayer(
    wrap, esriReferenceTileUrl, 'pass-thumbnail-labels', pass.target_lon, pass.target_lat,
    THUMBNAIL_ZOOM, THUMBNAIL_PIXEL_SIZE, true,
  );

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

  // Caption: two labeled rows (ENCOUNTER / CLOSEST) + a context line. The
  // look angle sweeps fore→nadir→aft across a pass, so the encounter and
  // closest rows carry different angles/sides — the operator sees where the
  // target first appears AND where it sits at the anchor moment. Labeled rows
  // (dim uppercase, matching the SORT/SHOW control style) keep the four extra
  // numbers scannable instead of TMI. textContent only (operator-safe).
  const caption = document.createElement('div');
  caption.className = 'pass-thumbnail-caption';

  // One labeled row: dim uppercase label + value span. Skips empty values.
  const addRow = (label: string, value: string): void => {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'pass-thumbnail-caption-row';
    const l = document.createElement('span');
    l.className = 'pass-thumbnail-caption-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'pass-thumbnail-caption-value';
    v.textContent = value;
    row.append(l, v);
    caption.appendChild(row);
  };

  // INITIAL row — when the target first enters the frameable cone (off-nadir
  // ≤60° scan-back). The target rises AHEAD of the abeam point (the look sweeps
  // fore → abeam), so the row is a lead-time heads-up: "in Nm · rising ahead".
  // The direction (degrees right/left of track) is the same cross-track as
  // CLOSEST — constant across the pass — and is shown on the CLOSEST row, not
  // repeated here. Absent for grazing/window-edge/older-manifest passes
  // (closest-only render, no error, no empty row).
  // "rising ahead" is safe to hardcode: the generator's _find_encounter scans
  // BACK from closest and only emits an encounter that is fore of (earlier than)
  // the closest sample (returns None when enc_idx == closest_idx), so the target
  // is always rising and ahead at the INITIAL moment by construction.
  if (pass.encounter && Number.isFinite(Date.parse(pass.encounter.time))) {
    const cd = formatThumbnailCountdown(pass.encounter.time, nowMs);
    addRow('INITIAL', [cd, 'rising ahead'].filter(Boolean).join(' · '));
  }

  // CLOSEST row — the shot, abeam. "in Nm · x° right/left of track" — at closest
  // the target is directly abeam, so off-nadir IS the degrees right/left of the
  // ground track (CEO-target-sheet convention; operator feedback 2026-06-04).
  // Side from the bearing half (robust); magnitude from off-nadir (the bearing
  // magnitude is a 30s-sampling artifact at the closest sample).
  {
    const cd = formatThumbnailCountdown(pass.closest_approach, nowMs);
    let dir = '';
    if (typeof pass.angle_off_nadir_deg === 'number' && Number.isFinite(pass.angle_off_nadir_deg)) {
      dir = typeof pass.iss_relative_bearing_deg === 'number'
        && Number.isFinite(pass.iss_relative_bearing_deg)
        ? formatTrackOffset(pass.angle_off_nadir_deg, pass.iss_relative_bearing_deg)
        : `${Math.round(pass.angle_off_nadir_deg)}°`;
    }
    addRow('CLOSEST', [cd, dir].filter(Boolean).join(' · '));
  }

  // No nadir/window context line: the pass card directly above the expanded
  // thumbnail already shows "nadir N km" and the WORF/Cupola tag, so repeating
  // them here was pure duplication. The timed rows are the thumbnail's unique
  // contribution (countdown + the initial encounter the card lacks).

  wrap.appendChild(caption);

  // Esri attribution (ToS requirement; free-tier non-commercial use).
  const attr = document.createElement('div');
  attr.className = 'pass-thumbnail-attribution';
  attr.textContent = '© Esri, Maxar, Earthstar Geographics';
  wrap.appendChild(attr);

  // Photo conditions (Unit 1, D4): the block must be a SIBLING of the
  // 256px thumbnail box, not a child — .pass-thumbnail is overflow:hidden
  // with a fixed height, which silently clips any in-box content below the
  // image (visual QA 2026-06-11: DOM checks passed while the block was
  // invisible). The panel root spans the card width, so the conditions
  // rows get the full-width layout D4 locked.
  // Always build the panel so the nearest-station weather column has a home
  // beside the thumbnail (in the space right of the 256px image). The column
  // self-collapses when there's no nearby station (ocean/remote) or offline,
  // so this adds no clutter for those passes. The thumbnail + weather share a
  // flex top row; the photo-conditions block (if any) spans full-width below.
  const rows = buildConditionRows({ pass, manifest: null, track, nowMs });
  const panel = document.createElement('div');
  panel.className = 'pass-thumbnail-panel';
  const top = document.createElement('div');
  top.className = 'pass-thumbnail-top';
  top.appendChild(wrap);
  top.appendChild(renderWxColumn(pass));
  panel.appendChild(top);
  if (rows.length > 0) renderConditionBlock(rows, panel);
  return panel;
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
