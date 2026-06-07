/** Hand a generated .ics off to the OS so it lands in Calendar.
 *
 *  iOS is the constraint. A raw `<a download>` Blob on iOS Safari can silently
 *  just save a file the operator then has to find and open — it does NOT
 *  reliably open Calendar. The Web Share API (`navigator.share({ files })`,
 *  iOS Safari 15+) pops the native share sheet where "Add to Calendar" appears,
 *  which is the reliable path. We try share first and fall back to a download
 *  for desktop/older browsers without file-share support.
 *
 *  This is the one impure, DOM/host-API-touching part of the feature; the .ics
 *  string itself is built by the pure ics.ts so the hard-to-test glue stays
 *  thin and the correctness logic stays unit-tested.
 */

/** Outcome of the handoff, so the caller can tailor the follow-up hint.
 *  'failed' = both share and download paths errored — the caller must surface
 *  an error so the operator isn't left thinking the reminder was set. */
export type ShareResult = 'shared' | 'downloaded' | 'cancelled' | 'failed';

function triggerDownload(ics: string, filename: string): void {
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click's navigation has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function shareOrDownloadIcs(ics: string, filename: string): Promise<ShareResult> {
  // Build the File defensively: the File constructor is absent on some old
  // Android WebViews / embedded browsers where the Blob download below still
  // works, so a throw here must fall through to download, not dead-end.
  let file: File | null = null;
  try {
    file = new File([ics], filename, { type: 'text/calendar' });
  } catch {
    file = null;
  }
  // canShare with files is the feature test; it's false on desktop Chrome/
  // Firefox and on browsers without Web Share Level 2.
  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
  };
  if (file && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Orbit shots' });
      return 'shared';
    } catch (err) {
      // User dismissed the share sheet — not an error, just nothing happened.
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Any other share failure: fall through to a download rather than dead-end.
    }
  }
  // Never throw — a locked-down DOM could make triggerDownload fail; surface it
  // as 'failed' so the caller can warn instead of dead-ending silently.
  try {
    triggerDownload(ics, filename);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
