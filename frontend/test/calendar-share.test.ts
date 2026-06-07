/** Tests for calendar-share.ts — the iOS-reliable .ics hand-off.
 *
 *  Primary path opens the hosted /api/cal URL (served as text/calendar by the
 *  Worker) so iOS offers "Add All to Calendar"; falls back to a file download
 *  when window.open is blocked or the URL would be too long. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { shareOrDownloadIcs } from '../src/calendar-share';

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shareOrDownloadIcs', () => {
  it('opens the hosted /api/cal URL with the URL-encoded ics (iOS path)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    expect(shareOrDownloadIcs(ICS, 'orbit-shots.ics')).toBe('opened');
    expect(open).toHaveBeenCalledWith(`/api/cal?d=${encodeURIComponent(ICS)}`, '_blank');
  });

  it('falls back to a download when window.open is blocked (returns null)', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = vi.fn(() => 'blob:x');
      URL.revokeObjectURL = vi.fn();
    }
    const clicked = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = clicked;
      return el;
    });
    expect(shareOrDownloadIcs(ICS, 'orbit-shots.ics')).toBe('downloaded');
    expect(clicked).toHaveBeenCalled();
  });

  it('falls back to a download for an oversized shot list (URL too long)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = vi.fn(() => 'blob:x');
      URL.revokeObjectURL = vi.fn();
    }
    const bigIcs = 'BEGIN:VCALENDAR\r\n' + 'X'.repeat(40_000);
    expect(shareOrDownloadIcs(bigIcs, 'orbit-shots.ics')).toBe('downloaded');
    expect(open).not.toHaveBeenCalled(); // too long → never tries to open
  });
});
