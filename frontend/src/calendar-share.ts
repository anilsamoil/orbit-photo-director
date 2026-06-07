/** Hand a client-built .ics off to the OS so iOS offers "Add All to Calendar".
 *
 *  iOS does NOT offer Calendar when you SHARE or DOWNLOAD an .ics file — the
 *  share sheet shows document apps (Acrobat, Save to Files…), never Calendar
 *  (observed on-device 2026-06-07). It DOES offer "Add All to Calendar" when the
 *  .ics is opened from a URL served as `text/calendar`. So we open our Worker's
 *  `/api/cal` route, which echoes the .ics back with that content-type. The .ics
 *  rides in the query string — no backend storage. Falls back to a file download
 *  for oversized shot lists or when window.open is blocked (desktop).
 *
 *  SYNCHRONOUS on purpose: window.open must run inside the click gesture or iOS
 *  blocks it, so there must be no await between the tap and the open.
 */
export type ShareResult = 'opened' | 'downloaded' | 'failed';

const CAL_ENDPOINT = '/api/cal';
/** Keep the URL well under browser/CF limits; a shot list large enough to
 *  exceed this falls back to a download. ~28 KB ≈ a very large selection. */
const MAX_URL_LEN = 28_000;

function triggerDownload(ics: string, filename: string): void {
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function shareOrDownloadIcs(ics: string, filename: string): ShareResult {
  const url = `${CAL_ENDPOINT}?d=${encodeURIComponent(ics)}`;
  if (url.length <= MAX_URL_LEN) {
    try {
      // New tab keeps the PWA put; iOS sees text/calendar → "Add All to Calendar".
      const w = window.open(url, '_blank');
      if (w) return 'opened';
    } catch {
      // window.open threw (locked-down host) — fall through to download.
    }
  }
  try {
    triggerDownload(ics, filename);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
