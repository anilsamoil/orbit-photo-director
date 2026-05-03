import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchLog, mergeLogEntries, renderLog } from '../src/log';
import type { LogEntry, MergedRow } from '../src/log';
import { setToken } from '../src/calib';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('mergeLogEntries', () => {
  it('returns empty for no entries', () => {
    expect(mergeLogEntries([])).toEqual([]);
  });

  it('groups shoot + rate on same target+pass_time into one row', () => {
    const entries: LogEntry[] = [
      { target_id: 'tokyo-night', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', score_at_time: 87, received_at: '2024-10-17T12:00:30Z' },
      { target_id: 'tokyo-night', pass_time: '2024-10-17T12:00:00Z', action: 'rate', rating: 4, observed_obstruction: 'clear', received_at: '2024-10-17T13:00:00Z' },
    ];
    const merged = mergeLogEntries(entries);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.action).toBe('shoot');
    expect(merged[0]?.rating).toBe(4);
    expect(merged[0]?.observed_obstruction).toBe('clear');
  });

  it('keeps shoot + skip events even without ratings', () => {
    const entries: LogEntry[] = [
      { target_id: 't1', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', received_at: '2024-10-17T12:00:30Z' },
      { target_id: 't2', pass_time: '2024-10-17T12:30:00Z', action: 'skip', received_at: '2024-10-17T12:30:30Z' },
    ];
    const merged = mergeLogEntries(entries);
    expect(merged).toHaveLength(2);
  });

  it('orders by received_at descending', () => {
    const entries: LogEntry[] = [
      { target_id: 'old', pass_time: '2024-10-17T11:00:00Z', action: 'shoot', received_at: '2024-10-17T11:00:00Z' },
      { target_id: 'newer', pass_time: '2024-10-17T13:00:00Z', action: 'shoot', received_at: '2024-10-17T13:00:00Z' },
      { target_id: 'mid', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', received_at: '2024-10-17T12:00:00Z' },
    ];
    const merged = mergeLogEntries(entries);
    expect(merged.map((m) => m.target_id)).toEqual(['newer', 'mid', 'old']);
  });

  it('latest rate wins when two ratings exist', () => {
    const entries: LogEntry[] = [
      { target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', received_at: '2024-10-17T12:00:30Z' },
      { target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'rate', rating: 2, received_at: '2024-10-17T13:00:00Z' },
      { target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'rate', rating: 5, received_at: '2024-10-17T14:00:00Z' },
    ];
    const merged = mergeLogEntries(entries);
    expect(merged[0]?.rating).toBe(5);
  });

  it('orphan rate (no matching shoot) is dropped', () => {
    const entries: LogEntry[] = [
      { target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'rate', rating: 4, received_at: '2024-10-17T12:00:00Z' },
    ];
    expect(mergeLogEntries(entries)).toEqual([]);
  });
});

describe('fetchLog', () => {
  it('returns [] when no token set', async () => {
    const entries = await fetchLog();
    expect(entries).toEqual([]);
  });

  it('hits /api/log with the token header', async () => {
    setToken('abc');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ entries: [{ target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const entries = await fetchLog();
    expect(entries).toHaveLength(1);
    const calls = fetchMock.mock.calls as unknown[][];
    const headers = (calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    expect(headers?.['x-calib-token']).toBe('abc');
  });

  it('returns [] on non-2xx', async () => {
    setToken('abc');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    const entries = await fetchLog();
    expect(entries).toEqual([]);
  });

  it('returns [] on network error', async () => {
    setToken('abc');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const entries = await fetchLog();
    expect(entries).toEqual([]);
  });
});

describe('renderLog', () => {
  it('shows empty state when zero rows', () => {
    document.body.innerHTML = '<div id="list"></div><div id="empty" hidden></div><div id="stats"></div>';
    const list = document.getElementById('list')!;
    const empty = document.getElementById('empty')!;
    const stats = document.getElementById('stats')!;
    const count = renderLog(list, empty, stats, [], () => undefined);
    expect(count).toBe(0);
    expect(empty.hidden).toBe(false);
    expect(stats.children.length).toBe(0);
  });

  it('renders a row per merged entry', () => {
    document.body.innerHTML = '<div id="list"></div><div id="empty" hidden></div><div id="stats"></div>';
    const list = document.getElementById('list')!;
    const empty = document.getElementById('empty')!;
    const stats = document.getElementById('stats')!;
    const rows: MergedRow[] = [
      { target_id: 'a', target_name: 'A', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', received_at: '2024-10-17T12:00:30Z' },
      { target_id: 'b', target_name: 'B', pass_time: '2024-10-17T12:30:00Z', action: 'skip', received_at: '2024-10-17T12:30:30Z' },
    ];
    const count = renderLog(list, empty, stats, rows, () => undefined);
    expect(count).toBe(2);
    expect(empty.hidden).toBe(true);
    expect(list.querySelectorAll('.log-row')).toHaveLength(2);
  });

  it('shows Rate button for unrated shoots only', () => {
    document.body.innerHTML = '<div id="list"></div><div id="empty" hidden></div><div id="stats"></div>';
    const list = document.getElementById('list')!;
    const empty = document.getElementById('empty')!;
    const stats = document.getElementById('stats')!;
    const rows: MergedRow[] = [
      { target_id: 'a', target_name: 'A', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', received_at: '2024-10-17T12:00:30Z' },
      { target_id: 'b', target_name: 'B', pass_time: '2024-10-17T12:30:00Z', action: 'shoot', received_at: '2024-10-17T12:30:30Z', rating: 4 },
      { target_id: 'c', target_name: 'C', pass_time: '2024-10-17T13:00:00Z', action: 'skip', received_at: '2024-10-17T13:00:30Z' },
    ];
    renderLog(list, empty, stats, rows, () => undefined);
    expect(list.querySelectorAll('.row-rate-btn')).toHaveLength(1);
    expect(list.querySelectorAll('.row-rating-stars')).toHaveLength(1);
  });

  it('emits onRate callback when Rate clicked', () => {
    document.body.innerHTML = '<div id="list"></div><div id="empty" hidden></div><div id="stats"></div>';
    const list = document.getElementById('list')!;
    const empty = document.getElementById('empty')!;
    const stats = document.getElementById('stats')!;
    const rows: MergedRow[] = [
      { target_id: 'a', target_name: 'A', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', received_at: '2024-10-17T12:00:30Z' },
    ];
    const onRate = vi.fn();
    renderLog(list, empty, stats, rows, onRate);
    list.querySelector<HTMLButtonElement>('.row-rate-btn')!.click();
    expect(onRate).toHaveBeenCalledOnce();
    expect(onRate.mock.calls[0]![0].target_id).toBe('a');
  });

  it('shows aggregate stats', () => {
    document.body.innerHTML = '<div id="list"></div><div id="empty" hidden></div><div id="stats"></div>';
    const list = document.getElementById('list')!;
    const empty = document.getElementById('empty')!;
    const stats = document.getElementById('stats')!;
    const rows: MergedRow[] = [
      { target_id: 'a', target_name: 'A', pass_time: '2024-10-17T12:00:00Z', action: 'shoot', received_at: '2024-10-17T12:00:30Z', rating: 5 },
      { target_id: 'b', target_name: 'B', pass_time: '2024-10-17T12:30:00Z', action: 'shoot', received_at: '2024-10-17T12:30:30Z' },
      { target_id: 'c', target_name: 'C', pass_time: '2024-10-17T13:00:00Z', action: 'skip', received_at: '2024-10-17T13:00:30Z' },
    ];
    renderLog(list, empty, stats, rows, () => undefined);
    expect(stats.textContent).toContain('total: 3');
    expect(stats.textContent).toContain('shoots: 2');
    expect(stats.textContent).toContain('rated: 1/2');
  });
});
