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

// Full exifr (~25KB gz) — covers JPG + HEIC + TIFF + ICC. The previous
// `exifr/dist/lite.esm.js` import (v1.3.0.0 - v1.4.2.0) was JPG-only and
// silently rejected iPhone HEIC photos. The ~17KB gz extra is worth
// covering the dominant operator-side camera output (Nikon D5/D6 ship
// JPG but iPhone Photos defaults to HEIC, which is what Anil's Earth-
// side validation uses).
import exifr from 'exifr';

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

/** Diagnostic result of an EXIF extraction attempt. Lets the UI surface
 *  *why* a photo's timestamp couldn't be read (so the operator can fix
 *  the input or fall back to paste). v1.4.3.0 — replaces the prior
 *  null-only return that silently swallowed every failure.
 */
export interface ExifExtractResult {
  /** Successfully parsed UTC timestamp from DateTimeOriginal. */
  date: Date | null;
  /** Diagnostic state for the UI / console. */
  reason:
    | 'ok'
    | 'no-exif'
    | 'no-datetime-original'
    | 'invalid-date'
    | 'parser-error';
  /** When non-null, lists EXIF tags that WERE found in the file —
   *  helpful diagnostic ("we read EXIF but DateTimeOriginal wasn't one
   *  of the present tags"). */
  fieldsFound: string[];
  /** File metadata captured for the error chip (size + type). */
  fileMeta: { name: string; type: string; size: number };
}

/** Extract EXIF DateTimeOriginal from a File. Returns a result object
 *  (not just `Date | null`) so the UI can render an honest error chip.
 *
 *  Format coverage as of v1.4.3.0: JPEG, HEIC, TIFF (full `exifr`).
 *
 *  EXIF timestamps from cameras are typically in local time without
 *  timezone metadata unless OffsetTimeOriginal is set. ISS cameras
 *  (Nikon D5/D6) are set to UTC. iPhone (operator's testing device)
 *  embeds a local datetime + `OffsetTimeOriginal` like "+00:00" or
 *  "-04:00"; exifr applies the offset to produce a UTC Date.
 */
export async function extractExifTimestamp(file: File): Promise<ExifExtractResult> {
  const fileMeta = { name: file.name, type: file.type, size: file.size };
  let exifData: Record<string, unknown> | undefined;
  try {
    // Read a broader set of date / datetime tags. Some HEIC photos store
    // the original capture time in DateTimeOriginal; others use the
    // CreateDate tag. exifr returns whichever are present.
    exifData = await exifr.parse(file, {
      pick: [
        'DateTimeOriginal',
        'OffsetTimeOriginal',
        'CreateDate',
        'ModifyDate',
        'DateTime',
      ],
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[photo-lookup] EXIF parser threw:', err, fileMeta);
    return { date: null, reason: 'parser-error', fieldsFound: [], fileMeta };
  }

  if (!exifData || Object.keys(exifData).length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[photo-lookup] no EXIF found in file:', fileMeta);
    return { date: null, reason: 'no-exif', fieldsFound: [], fileMeta };
  }

  const fieldsFound = Object.keys(exifData);
  // eslint-disable-next-line no-console
  console.info('[photo-lookup] EXIF fields found:', fieldsFound, 'file:', fileMeta);

  // Try DateTimeOriginal first; fall back to CreateDate, then DateTime.
  // Each can be a Date (exifr's preferred return) or a string fallback.
  const candidates = ['DateTimeOriginal', 'CreateDate', 'DateTime'] as const;
  for (const key of candidates) {
    const raw = exifData[key];
    if (!raw) continue;
    if (raw instanceof Date && Number.isFinite(raw.getTime())) {
      return { date: raw, reason: 'ok', fieldsFound, fileMeta };
    }
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) {
        return { date: new Date(ms), reason: 'ok', fieldsFound, fileMeta };
      }
    }
  }

  // EXIF present but no usable datetime tag.
  if (fieldsFound.includes('DateTimeOriginal')
      || fieldsFound.includes('CreateDate')
      || fieldsFound.includes('DateTime')) {
    return { date: null, reason: 'invalid-date', fieldsFound, fileMeta };
  }
  return { date: null, reason: 'no-datetime-original', fieldsFound, fileMeta };
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
  const fileBtn = container.querySelector<HTMLButtonElement>('#lookup-file-btn');
  const fileInput = container.querySelector<HTMLInputElement>('#lookup-file-input');
  const resultEl = container.querySelector<HTMLElement>('#lookup-result');
  if (!input || !resolveBtn || !dropzone || !fileBtn || !fileInput || !resultEl) return;

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

  // Shared file-ingestion path used by both drag/drop and the file-picker
  // button (v1.4.4.0). Factoring this out lets the two entry points share
  // a single source of truth for EXIF errors, track-not-loaded handling,
  // and the resolve→pin flow.
  const ingestFile = async (file: File) => {
    const exif = await extractExifTimestamp(file);
    if (!exif.date) {
      // v1.4.3.0: surface *why* EXIF parsing failed so the operator can
      // decide whether to retry, re-export, or paste manually. Previously
      // every failure showed the same generic message.
      const fileLabel = `${exif.fileMeta.name} (${exif.fileMeta.type || 'unknown type'}, ${Math.round(exif.fileMeta.size / 1024)} KB)`;
      let msg: string;
      switch (exif.reason) {
        case 'no-exif':
          msg = `No EXIF metadata in ${fileLabel}. The file may have been stripped of EXIF (some upload pipelines do this) or it's not a photo format we can read. Paste the timestamp manually.`;
          break;
        case 'no-datetime-original':
          msg = `EXIF present but no DateTimeOriginal/CreateDate/DateTime tags in ${fileLabel}. Tags found: ${exif.fieldsFound.join(', ') || '(none)'}. Paste the timestamp manually.`;
          break;
        case 'invalid-date':
          msg = `EXIF datetime tag(s) present in ${fileLabel} but couldn't be parsed as a valid date. Tags found: ${exif.fieldsFound.join(', ')}. Paste the timestamp manually.`;
          break;
        case 'parser-error':
          msg = `EXIF parser threw an error reading ${fileLabel}. The file may be corrupt or in a format we don't support. See browser console for details. Paste the timestamp manually.`;
          break;
        default:
          msg = `Couldn't read EXIF from ${fileLabel}. Paste the timestamp manually.`;
      }
      showError(msg);
      return;
    }
    const ts = exif.date;
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
  };

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
    await ingestFile(file);
  });

  // File-picker button (v1.4.4.0). For on-orbit iPad/iPhone workflow:
  // tapping a button beats trying to drag from Files into a web page,
  // and gives access to camera-roll directly. The hidden <input
  // type="file"> is the standard pattern — click the button, the
  // OS picker opens, the change event fires once a file is chosen.
  fileBtn.addEventListener('click', () => {
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await ingestFile(file);
    // Reset value so picking the SAME file twice still fires `change`
    // (browsers suppress change when the new value equals the old).
    fileInput.value = '';
  });
}
