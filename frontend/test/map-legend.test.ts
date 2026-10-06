import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { bindLegendDisclosure } from '../src/map-legend';

const css = readFileSync(resolve('src/style.css'), 'utf8');

function mount(expanded = false): HTMLButtonElement {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.className = '';
  document.body.innerHTML = `
    <main id="view" class="view-map">
      <section id="map-pane" class="pane">
        <div id="map-legend" class="map-legend">
          <button id="map-legend-toggle" class="map-legend-toggle" type="button" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="map-legend-panel">Legend</button>
          <div id="map-legend-panel" class="map-legend-panel">
            <div class="map-legend-rows">
              <span class="map-legend-item">launch</span>
              <span class="map-legend-item">day</span>
              <span class="map-legend-item">twilight</span>
              <span class="map-legend-item">eclipse</span>
            </div>
            <div class="map-imagery-date">Imagery: 2026-05-04 · ~1h old</div>
          </div>
        </div>
      </section>
    </main>
  `;
  return document.getElementById('map-legend-toggle') as HTMLButtonElement;
}

function panelDisplay(): string {
  return getComputedStyle(document.getElementById('map-legend-panel')!).display;
}

describe('map legend disclosure', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts collapsed, toggles from the tab, and closes on Escape', () => {
    const button = mount(true);
    bindLegendDisclosure();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('map-legend-panel');
    expect(panelDisplay()).toBe('none');
    expect(document.getElementById('map-legend')!.textContent).toContain('launch');
    expect(document.getElementById('map-legend')!.textContent).toContain('eclipse');
    expect(document.querySelector('.map-imagery-date')!.textContent).toBe('Imagery: 2026-05-04 · ~1h old');
    expect(getComputedStyle(button).minHeight).toBe('44px');
    expect(getComputedStyle(button).minWidth).toBe('44px');

    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panelDisplay()).not.toBe('none');
    expect(document.activeElement).toBe(button);

    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panelDisplay()).toBe('none');

    button.click();
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: true }));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.length).toBe(0);
  });

  it('marks the Legend button while an IR warning is the imagery line', async () => {
    const button = mount(false);
    bindLegendDisclosure();
    const badge = document.querySelector('.map-imagery-date') as HTMLElement;
    const dot = () => button.querySelector('.map-legend-warning-dot') as HTMLElement;
    const note = () => document.getElementById('map-legend-warning');
    expect(dot().hidden).toBe(true);
    expect(button.hasAttribute('aria-describedby')).toBe(false);

    badge.textContent = 'IR · GOES-East · feed unavailable';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dot().hidden).toBe(false);
    expect(button.getAttribute('aria-describedby')).toBe('map-legend-warning');
    expect(note()?.textContent).toBe('IR · GOES-East · feed unavailable');
    expect(panelDisplay()).toBe('none');
    expect(getComputedStyle(badge).display === 'none' || badge.getBoundingClientRect().width === 0).toBe(true);

    badge.textContent = 'IR · Meteosat-11 · LIVE now (not the scrubbed time) · misses low cloud';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dot().hidden).toBe(false);
    expect(note()?.textContent).toContain('LIVE now (not the scrubbed time)');

    badge.textContent = 'Imagery: 2026-05-04 · ~1h old';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dot().hidden).toBe(true);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(note()?.textContent).toBe('');
  });

  it('keeps the legend clear of the zoom stack on a short screen', () => {
    expect(css).toContain('left: calc(8px + env(safe-area-inset-left, 0px) + 52px + 8px)');
    expect(css).toContain('max-width: calc(100% - 92px - 60px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))');
    expect(css).toContain('.view-map #map .maplibregl-ctrl-top-left {\n    left: calc(8px + env(safe-area-inset-left, 0px));');
    expect(css).toContain('body.shotlist-bar-visible .view-map .map-legend {\n    left: calc(8px + env(safe-area-inset-left, 0px) + 52px + 8px);');
  });

  it('collapses again when the page is shown', () => {
    const button = mount(false);
    bindLegendDisclosure();
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    window.dispatchEvent(new Event('pageshow'));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panelDisplay()).toBe('none');
  });
});