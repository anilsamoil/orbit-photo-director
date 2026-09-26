/**
 * Map-tab chrome floats over the canvas. Queue keeps the bars in normal flow.
 * happy-dom applies plain selectors. `:has()` is read from the CSSOM because
 * happy-dom does not match it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('src/style.css'), 'utf8');

function mount(viewClass: string): void {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.innerHTML = `
    <header class="topbar"><span class="brand-expansion">SNAP</span></header>
    <main id="view" class="${viewClass}">
      <section id="map-pane">
        <div class="map-toolbar"></div>
        <div class="map-control-dock"></div>
      </section>
    </main>
    <footer id="status-banner" class="banner banner-loading">Loading</footer>
    <button class="help-fab" type="button">?</button>
  `;
  document.querySelector('#map-pane')!.insertAdjacentHTML('beforeend', `
    <div id="map">
      <div class="maplibregl-ctrl-bottom-right">
        <div class="maplibregl-ctrl-attrib">coastlines</div>
      </div>
    </div>
    <div class="map-legend">legend</div>
    <div class="map-imagery-date">imagery</div>
  `);
}

function px(selector: string, prop: string): number {
  const value = getComputedStyle(document.querySelector(selector)!).getPropertyValue(prop);
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`${selector} ${prop} is ${value}`);
  return n;
}

function ruleStyle(selector: string): CSSStyleDeclaration {
  const sheet = document.styleSheets[0];
  if (!sheet) throw new Error('missing stylesheet');
  for (const rule of sheet.cssRules) {
    if (rule instanceof CSSStyleRule && rule.selectorText === selector) return rule.style;
  }
  throw new Error(`missing rule ${selector}`);
}

describe('map chrome layout', () => {
  it('floats the top bar and status banner over the map and stacks the dock as a rail', () => {
    mount('view-map');
    expect(ruleStyle('body:has(> #view.view-map) > .topbar').position).toBe('fixed');
    expect(ruleStyle('body:has(> #view.view-map) > .banner').position).toBe('fixed');
    const dock = getComputedStyle(document.querySelector('.map-control-dock')!);
    const toolbar = getComputedStyle(document.querySelector('.map-toolbar')!);
    expect(dock.position).toBe('absolute');
    expect(dock.flexDirection).toBe('column');
    expect(toolbar.position).toBe('absolute');
    expect(toolbar.backgroundColor).toBe('rgba(11, 13, 18, 0.7)');
    expect(ruleStyle('body:has(> #view.view-map) .brand-expansion').display).toBe('none');
  });

  it('keeps the legend, imagery date, and help button above the attribution', () => {
    mount('view-map');
    const creditsTop = px('.maplibregl-ctrl-bottom-right', 'bottom') + px('.maplibregl-ctrl-attrib', 'max-height');
    expect(px('.map-legend', 'bottom')).toBeGreaterThanOrEqual(creditsTop);
    expect(px('.map-imagery-date', 'bottom')).toBeGreaterThanOrEqual(creditsTop);
    expect(px('.help-fab', 'bottom')).toBeGreaterThanOrEqual(creditsTop);
  });

  it('leaves the queue top bar and banner in normal flow', () => {
    mount('view-queue');
    expect(getComputedStyle(document.querySelector('.topbar')!).position).not.toBe('fixed');
    expect(getComputedStyle(document.querySelector('.banner')!).position).not.toBe('fixed');
    expect(getComputedStyle(document.querySelector('.map-control-dock')!).flexDirection).not.toBe('column');
  });
});
