import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('src/style.css'), 'utf8');

function mount(viewClass: string): void {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.innerHTML = `
    <header class="topbar">
      <span class="brand-expansion">SNAP</span>
      <nav class="tabs"><button class="tab" type="button">Queue</button></nav>
    </header>
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
        <div class="maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact">
          <button class="maplibregl-ctrl-attrib-button" type="button">i</button>
          <div class="maplibregl-ctrl-attrib-inner">coastlines</div>
        </div>
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
    expect(ruleStyle('.topbar').position).toBe('fixed');
    expect(ruleStyle('body:has(> #view.view-map) > .banner').position).toBe('fixed');
    const dock = getComputedStyle(document.querySelector('.map-control-dock')!);
    const toolbar = getComputedStyle(document.querySelector('.map-toolbar')!);
    expect(dock.position).toBe('absolute');
    expect(dock.flexDirection).toBe('column');
    expect(toolbar.position).toBe('absolute');
    expect(toolbar.backgroundColor).toBe('rgba(11, 13, 18, 0.7)');
    expect(ruleStyle('body:has(> #view.view-map) .brand-expansion').display).toBe('none');
  });

  it('keeps the legend and help clear of the collapsed info button', () => {
    mount('view-map');
    const buttonTop = px('.maplibregl-ctrl-bottom-right', 'bottom') + px('.maplibregl-ctrl-attrib-button', 'height');
    expect(Number.parseFloat(ruleStyle('.view-map ~ .help-fab').bottom)).toBeGreaterThanOrEqual(buttonTop);
    expect(px('.map-legend', 'bottom')).toBeGreaterThanOrEqual(px('.maplibregl-ctrl-bottom-right', 'bottom'));
    expect(px('.map-imagery-date', 'bottom')).toBeGreaterThan(px('.map-legend', 'bottom'));
  });

  it('leaves the queue status banner in normal flow', () => {
    mount('view-queue');
    expect(getComputedStyle(document.querySelector('.banner')!).position).not.toBe('fixed');
    expect(getComputedStyle(document.querySelector('.map-control-dock')!).flexDirection).not.toBe('column');
  });

  it('uses one top bar box on every tab', () => {
    const views = ['view-map', 'view-queue', 'view-upcoming', 'view-profile', 'view-log'];
    const boxes = views.map((view) => {
      mount(view);
      const bar = getComputedStyle(document.querySelector('.topbar')!);
      const tab = getComputedStyle(document.querySelector('.tab')!);
      const box = {
        position: bar.position,
        top: bar.top,
        left: bar.left,
        right: bar.right,
        padding: bar.padding,
        flexWrap: bar.flexWrap,
        minHeight: tab.minHeight,
        tabPadding: tab.padding,
        weight: tab.fontWeight,
      };
      document.querySelector('.tab')!.classList.add('active');
      return { ...box, activeWeight: getComputedStyle(document.querySelector('.tab')!).fontWeight };
    });
    expect(new Set(boxes.map((box) => JSON.stringify(box))).size).toBe(1);
    expect(boxes[0]).toEqual({
      position: 'fixed',
      top: '0px',
      left: '0px',
      right: '0px',
      padding: '4px 8px',
      flexWrap: 'nowrap',
      minHeight: '44px',
      tabPadding: '0px 8.8px',
      weight: '600',
      activeWeight: '600',
    });
    mount('view-queue');
    const bar = document.querySelector('.topbar')!;
    const main = document.querySelector('main')!;
    expect(getComputedStyle(main).paddingTop).toBe(getComputedStyle(bar).height);
    mount('view-map');
    expect(getComputedStyle(document.querySelector('main')!).paddingTop).toBe('0px');
  });

  it('collapses credits to a 44px info button and does not keep the wide band', () => {
    mount('view-map');
    const corner = getComputedStyle(document.querySelector('.maplibregl-ctrl-bottom-right')!);
    const button = getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib-button')!);
    const attrib = getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib')!);
    expect(corner.left).toBe('auto');
    expect(corner.right).toBe('8px');
    expect(button.width).toBe('44px');
    expect(button.height).toBe('44px');
    expect(Number.parseFloat(attrib.width)).toBeLessThanOrEqual(44);
    expect(px('.map-legend', 'bottom')).toBeLessThan(100);
    expect(px('.map-imagery-date', 'bottom')).toBeLessThan(136);
    expect(Number.parseFloat(ruleStyle('.view-map ~ .help-fab').bottom)).toBeLessThan(100);
  });

  it('lifts the legend, imagery date, and help above expanded credits', () => {
    mount('view-map');
    document.querySelector('.maplibregl-ctrl-attrib')!.classList.add('maplibregl-compact-show');
    const creditsTop = px('.maplibregl-ctrl-bottom-right', 'bottom') + px('.maplibregl-ctrl-attrib', 'max-height');
    expect(px('.map-legend', 'bottom')).toBeGreaterThanOrEqual(creditsTop);
    expect(px('.map-imagery-date', 'bottom')).toBeGreaterThanOrEqual(creditsTop);
    expect(getComputedStyle(document.querySelector('.maplibregl-ctrl-bottom-right')!).left).toBe('8px');
    const helpBottom = Number.parseFloat(
      ruleStyle('.view-map:has(.maplibregl-ctrl-attrib.maplibregl-compact-show) ~ .help-fab').bottom,
    );
    expect(helpBottom).toBeGreaterThanOrEqual(creditsTop);
  });
});
