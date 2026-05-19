import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initSunWidget, SWPC_SUN_DASHBOARD_URL, SWPC_SUN_IMAGE_URL } from '../src/sun';

beforeEach(() => {
  document.body.innerHTML = '<div id="sun-widget" hidden></div>';
});

describe('initSunWidget', () => {
  it('starts hidden until the image loads', () => {
    const el = document.getElementById('sun-widget') as HTMLElement;
    initSunWidget(el);
    expect(el.hidden).toBe(true);
  });

  it('injects an img with the SWPC sun-image URL', () => {
    const el = document.getElementById('sun-widget') as HTMLElement;
    initSunWidget(el);
    const img = el.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.src).toContain(SWPC_SUN_IMAGE_URL);
  });

  it('reveals itself when the image loads successfully', () => {
    const el = document.getElementById('sun-widget') as HTMLElement;
    initSunWidget(el);
    const img = el.querySelector('img') as HTMLImageElement;
    // Simulate image load
    img.dispatchEvent(new Event('load'));
    if (img.onload) img.onload(new Event('load'));
    expect(el.hidden).toBe(false);
  });

  it('stays hidden on image error', () => {
    const el = document.getElementById('sun-widget') as HTMLElement;
    initSunWidget(el);
    const img = el.querySelector('img') as HTMLImageElement;
    if (img.onerror) img.onerror(new Event('error'));
    expect(el.hidden).toBe(true);
  });

  it('sets ARIA attributes for accessibility', () => {
    const el = document.getElementById('sun-widget') as HTMLElement;
    initSunWidget(el);
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('aria-label')).toBeTruthy();
  });

  it('opens SWPC dashboard on click', () => {
    const el = document.getElementById('sun-widget') as HTMLElement;
    initSunWidget(el);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    el.click();
    expect(open).toHaveBeenCalledWith(SWPC_SUN_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('opens SWPC dashboard on Enter key', () => {
    const el = document.getElementById('sun-widget') as HTMLElement;
    initSunWidget(el);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(open).toHaveBeenCalledWith(SWPC_SUN_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });
});
