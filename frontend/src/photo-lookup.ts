/** Photo-timestamp reverse lookup — Pettit feedback 2026-05-19.
 *
 *  Operator types or drops a photo timestamp; we propagate the cached TLE
 *  to that moment and surface ISS lat/lon/alt as (a) a pin on the Map tab,
 *  (b) a downloadable .kml file for Google Earth Desktop, (c) a deep-link
 *  to Google Earth Web.
 *
 *  Stateless: each lookup is fresh. The .kml file is the durable record.
 *  Walking-window: uses the TLE from track.json, accurate ~3-4 days from
 *  epoch. Older timestamps render with a "low confidence" warning chip.
 *
 *  Architecture locked 2026-05-19; design doc at
 *  ~/.gstack/projects/anilsamoil-orbit-photo-director/anilsamoilenko-photo-lookup-v1-eng-review-2026-05-19.md
 */

// exifr/lite is the smaller (~8KB gz) ESM bundle that parses just the EXIF
// date fields we need. No TypeScript types are shipped for the /dist/lite
// path so we declare a minimal shape inline. The full exifr package has
// types but pulls ~25KB more code we don't use.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — exifr ships no types for the /dist/lite ESM bundle
import exifr from 'exifr/dist/lite.esm.js';

import type { Track } from './types';
import { issPositionWithAltSGP4 } from './iss-sgp4';
import { downloadKml, googleEarthWebUrl, type LookupResult } from './kml';

// Re-export so callers can import the type from a single module.
export type { LookupResult } from './kml';

/** Parse a free-text timestamp. Accepts ISO 8601 with or without trailing
 *  Z, ISO 8601 with space separator instead of T, and fractional seconds.
 *  Naive timestamps (no Z, no ±HH:MM offset) are assumed UTC — the
 *  operator UI labels the input "Timestamp (UTC)" so the assumption is
 *  surfaced. Returns null on unparseable input. */
export function parseTimestamp(s: string): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // Normalize "YYYY-MM-DD HH:MM:SS" to ISO by replacing the space.
  let candidate = trimmed.includes('T') || !/^\d{4}-\d{2}-\d{2}[ ]/.test(trimmed)
    ? trimmed
    : trimmed.replace(' ', 'T');
  // If no timezone marker, append Z so Date.parse treats it as UTC rather
  // than browser-local-time.
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(candidate)) {
    candidate = `${candidate}Z`;
  }
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/** Extract EXIF DateTimeOriginal from a File. Returns null on no EXIF /
 *  no DateTimeOriginal / unparseable date / corrupt file.
 *
 *  EXIF timestamps from cameras are typically in local time without
 *  timezone metadata unless OffsetTimeOriginal is set. ISS cameras
 *  (Nikon D5/D6) are set to UTC, so we assume the bare DateTimeOriginal
 *  IS UTC unless OffsetTimeOriginal explicitly says otherwise. */
export async function extractExifTimestamp(file: File): Promise<Date | null> {
  try {
    // exifr/lite parses just the EXIF date fields without pulling in the
    // full parser. We pass an options object instead of a fields array so
    // we don't get TS overload errors with the lite build.
    const exifData = await exifr.parse(file, { pick: ['DateTimeOriginal', 'OffsetTimeOriginal'] });
    if (!exifData || !exifData.DateTimeOriginal) return null;
    const raw = exifData.DateTimeOriginal;
    // exifr returns DateTimeOriginal as a Date object already (parsed using
    // OffsetTimeOriginal if present, else assumed UTC by our convention).
    if (raw instanceof Date) {
      if (!Number.isFinite(raw.getTime())) return null;
      return raw;
    }
    // Defensive: if exifr returned a string (older versions), try Date.parse.
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms)) return null;
      return new Date(ms);
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve a timestamp to an ISS LookupResult using the supplied track's TLE.
 *  Returns null if the track has no TLE or SGP4 fails.
 *
 *  Confidence is from |timestamp - tle.epoch|:
 *    < 24h  -> 'high'   (SGP4 accuracy ~1 km)
 *    24-72h -> 'medium' (~10 km, fine for the photographer use case)
 *    > 72h  -> 'low'    (degraded; warn operator)
 */
export function resolveTimestampToIssPosition(
  ts: Date, track: Track | null, source: 'paste' | 'exif',
): LookupResult | null {
  if (!track || !track.tle || !track.tle_epoch) return null;
  const epochMs = Date.parse(track.tle_epoch);
  if (!Number.isFinite(epochMs)) return null;
  const pos = issPositionWithAltSGP4(track, ts.getTime());
  if (!pos) return null;
  const tle_age_at_lookup_hours = Math.abs(ts.getTime() - epochMs) / 3_600_000;
  let confidence: 'high' | 'medium' | 'low';
  if (tle_age_at_lookup_hours < 24) confidence = 'high';
  else if (tle_age_at_lookup_hours < 72) confidence = 'medium';
  else confidence = 'low';
  return {
    timestamp_utc: ts,
    lat: pos.lat,
    lon: pos.lon,
    alt_km: pos.alt_km,
    tle_age_at_lookup_hours,
    confidence,
    source,
  };
}

// ---------------------------------------------------------------------------
// UI binding
// ---------------------------------------------------------------------------

/** Lookup-tab UI controller. Wires the input + dropzone + Resolve button,
 *  renders the result section, and invokes the on-resolve callback so
 *  main.ts can drop the pin on the Map tab and switch tabs.
 *
 *  ASCII flow:
 *
 *      paste text → parseTimestamp() ─┐
 *                                     ├─→ resolveTimestampToIssPosition()
 *      drop file → extractExifTimestamp() ─┘                 │
 *                                                            ▼
 *                                                       LookupResult
 *                                                            │
 *                              ┌─────────────────────────────┼─────────────────────┐
 *                              ▼                             ▼                     ▼
 *                       render result card          downloadKml(result)     open Google Earth
 *                       (lat/lon/alt/conf)          (Blob + anchor)         (window.open)
 *                              │
 *                              ▼
 *                       onResolve(result) → main.ts switches to Map tab + dropLookupPin()
 */
export function renderLookupTab(
  container: HTMLElement,
  getTrack: () => Track | null,
  onResolve: (result: LookupResult) => void,
): void {
  const input = container.querySelector<HTMLInputElement>('#lookup-input');
  const resolveBtn = container.querySelector<HTMLButtonElement>('#lookup-resolve');
  const dropzone = container.querySelector<HTMLElement>('#lookup-dropzone');
  const resultEl = container.querySelector<HTMLElement>('#lookup-result');
  if (!input || !resolveBtn || !dropzone || !resultEl) return;

  const showError = (msg: string) => {
    resultEl.hidden = false;
    resultEl.textContent = '';
    const chip = document.createElement('div');
    chip.className = 'lookup-error';
    chip.textContent = msg;
    resultEl.appendChild(chip);
  };

  const showResult = (result: LookupResult) => {
    resultEl.hidden = false;
    resultEl.textContent = '';

    const conf = document.createElement('div');
    conf.className = `lookup-chip lookup-confidence-${result.confidence}`;
    conf.textContent = `${result.confidence} confidence — TLE age ${result.tle_age_at_lookup_hours.toFixed(1)} h`;

    const pos = document.createElement('div');
    pos.className = 'lookup-pos';
    pos.textContent =
      `ISS at ${result.timestamp_utc.toISOString()}: ` +
      `${result.lat.toFixed(4)}°, ${result.lon.toFixed(4)}° (alt ${result.alt_km.toFixed(1)} km)`;

    const actions = document.createElement('div');
    actions.className = 'lookup-actions';

    const mapBtn = document.createElement('button');
    mapBtn.type = 'button';
    mapBtn.className = 'lookup-btn';
    mapBtn.textContent = 'Pin on map';
    mapBtn.addEventListener('click', () => onResolve(result));

    const kmlBtn = document.createElement('button');
    kmlBtn.type = 'button';
    kmlBtn.className = 'lookup-btn';
    kmlBtn.textContent = 'Download .kml';
    kmlBtn.addEventListener('click', () => downloadKml(result));

    const geBtn = document.createElement('button');
    geBtn.type = 'button';
    geBtn.className = 'lookup-btn';
    geBtn.textContent = 'Open in Google Earth';
    geBtn.addEventListener('click', () => {
      window.open(googleEarthWebUrl(result), '_blank', 'noopener,noreferrer');
    });

    actions.append(mapBtn, kmlBtn, geBtn);
    resultEl.append(conf, pos, actions);

    // Auto-drop the pin on the map immediately (saves a click for the
    // dominant workflow: resolve → see-on-map). The Pin-on-map button
    // remains for re-pinning after the user navigates away.
    onResolve(result);
  };

  const doResolveFromText = () => {
    const text = input.value;
    const ts = parseTimestamp(text);
    if (!ts) {
      showError("Couldn't parse — try `2024-10-17T12:23:00Z`.");
      return;
    }
    const track = getTrack();
    if (!track) {
      showError('Track data not loaded yet — wait a moment and try again.');
      return;
    }
    const result = resolveTimestampToIssPosition(ts, track, 'paste');
    if (!result) {
      showError('Calculation failed — TLE may be missing or malformed.');
      return;
    }
    showResult(result);
  };

  resolveBtn.addEventListener('click', doResolveFromText);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doResolveFromText();
  });

  // Drag/drop handling. Use dragover for visual hover state, drop for
  // the actual file ingestion. preventDefault on dragover is required
  // by the HTML5 DnD spec to allow drop events.
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('lookup-dropzone-active');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('lookup-dropzone-active');
  });
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('lookup-dropzone-active');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = files.item(0);
    if (!file) return;
    const ts = await extractExifTimestamp(file);
    if (!ts) {
      showError('No EXIF DateTimeOriginal in this image. Paste the timestamp manually instead.');
      return;
    }
    const track = getTrack();
    if (!track) {
      showError('Track data not loaded yet — wait a moment and try again.');
      return;
    }
    const result = resolveTimestampToIssPosition(ts, track, 'exif');
    if (!result) {
      showError('Calculation failed — TLE may be missing or malformed.');
      return;
    }
    showResult(result);
  });
}
