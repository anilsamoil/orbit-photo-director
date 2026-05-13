/**
 * Tests for frontend/src/aurora.ts — Kp topbar widget.
 *
 * Coverage:
 * - fetchKpData: happy path, 5xx, malformed JSON, network error → all null
 * - kpToColorClass: every Kp threshold boundary
 * - renderKpWidget: null state hides; valid state renders + applies class +
 *   tooltip; tooltip age format switches at 60min boundary
 * - initKpWidget: click and keyboard activation open SWPC dashboard
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SWPC_DASHBOARD_URL,
  fetchKpData,
  initKpWidget,
  kpToColorClass,
  renderKpWidget,
} from '../src/aurora';

describe('fetchKpData', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
  });

  it('returns parsed KpData on a successful response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ kp: 4.2, timestamp: '2026-05-13T11:55:00Z', age_min: 5 })),
    );
    const result = await fetchKpData(fetchSpy as unknown as typeof fetch);
    expect(result).toEqual({ kp: 4.2, timestamp: '2026-05-13T11:55:00Z', age_min: 5 });
  });

  it('returns null on 5xx response', async () => {
    fetchSpy.mockResolvedValue(new Response('error', { status: 502 }));
    expect(await fetchKpData(fetchSpy as unknown as typeof fetch)).toBeNull();
  });

  it('returns null on malformed JSON (missing fields)', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ kp: 4.2 })));
    expect(await fetchKpData(fetchSpy as unknown as typeof fetch)).toBeNull();
  });

  it('returns null on wrong field types (schema drift defense)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ kp: 'four', timestamp: '...', age_min: 5 })),
    );
    expect(await fetchKpData(fetchSpy as unknown as typeof fetch)).toBeNull();
  });

  it('returns null on network error (fetch throws)', async () => {
    fetchSpy.mockRejectedValue(new Error('net down'));
    expect(await fetchKpData(fetchSpy as unknown as typeof fetch)).toBeNull();
  });
});

describe('kpToColorClass', () => {
  it('classifies quiet range (Kp < 3) as kp-quiet', () => {
    expect(kpToColorClass(0)).toBe('kp-quiet');
    expect(kpToColorClass(2.9)).toBe('kp-quiet');
  });

  it('classifies active range (3 ≤ Kp < 5) as kp-active', () => {
    expect(kpToColorClass(3)).toBe('kp-active');
    expect(kpToColorClass(4.9)).toBe('kp-active');
  });

  it('classifies storm range (5 ≤ Kp < 7) as kp-storm', () => {
    expect(kpToColorClass(5)).toBe('kp-storm');
    expect(kpToColorClass(6.9)).toBe('kp-storm');
  });

  it('classifies severe range (Kp ≥ 7) as kp-severe', () => {
    expect(kpToColorClass(7)).toBe('kp-severe');
    expect(kpToColorClass(9)).toBe('kp-severe');
  });

  it('falls back to quiet for invalid input', () => {
    expect(kpToColorClass(NaN)).toBe('kp-quiet');
    expect(kpToColorClass(-1)).toBe('kp-quiet');
  });
});

describe('renderKpWidget', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'kp-widget';
  });

  it('hides the widget when state is null', () => {
    container.hidden = false;
    container.textContent = 'stale';
    renderKpWidget(null, container);
    expect(container.hidden).toBe(true);
    expect(container.textContent).toBe('');
  });

  it('renders Kp with the right color class', () => {
    renderKpWidget({ kp: 4.2, timestamp: '2026-05-13T11:55:00Z', age_min: 5 }, container);
    expect(container.hidden).toBe(false);
    expect(container.textContent).toBe('Kp 4.2');
    expect(container.className).toContain('kp-active');
  });

  it('applies kp-severe class for Kp ≥ 7', () => {
    renderKpWidget({ kp: 7.7, timestamp: 'x', age_min: 10 }, container);
    expect(container.className).toContain('kp-severe');
  });

  it('formats tooltip with minutes-only when age < 60', () => {
    renderKpWidget({ kp: 3.0, timestamp: 'x', age_min: 47 }, container);
    expect(container.title).toContain('47m ago');
  });

  it('formats tooltip with hours-and-minutes when age ≥ 60', () => {
    renderKpWidget({ kp: 3.0, timestamp: 'x', age_min: 102 }, container);
    expect(container.title).toContain('1h 42m ago');
  });

  it('is idempotent across re-renders (1Hz tick pattern)', () => {
    renderKpWidget({ kp: 4.2, timestamp: 'x', age_min: 5 }, container);
    renderKpWidget({ kp: 4.2, timestamp: 'x', age_min: 5 }, container);
    renderKpWidget({ kp: 4.2, timestamp: 'x', age_min: 5 }, container);
    expect(container.textContent).toBe('Kp 4.2');
  });

  it('updates from a previously rendered state to null state cleanly', () => {
    renderKpWidget({ kp: 4.2, timestamp: 'x', age_min: 5 }, container);
    renderKpWidget(null, container);
    expect(container.hidden).toBe(true);
    expect(container.title).toBe('');
  });
});

describe('initKpWidget', () => {
  let container: HTMLDivElement;
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.unstubAllGlobals();
  });

  it('opens SWPC dashboard on click', () => {
    initKpWidget(container);
    container.click();
    expect(openSpy).toHaveBeenCalledWith(SWPC_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
  });

  it('opens SWPC dashboard on Enter key', () => {
    initKpWidget(container);
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    container.dispatchEvent(evt);
    expect(openSpy).toHaveBeenCalled();
  });

  it('opens SWPC dashboard on Space key', () => {
    initKpWidget(container);
    const evt = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
    container.dispatchEvent(evt);
    expect(openSpy).toHaveBeenCalled();
  });

  it('sets role=button and tabindex for a11y', () => {
    initKpWidget(container);
    expect(container.getAttribute('role')).toBe('button');
    expect(container.getAttribute('tabindex')).toBe('0');
  });
});
