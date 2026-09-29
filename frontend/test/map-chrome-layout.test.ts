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
  const [first] = rulesFor(selector);
  if (!first) throw new Error(`missing rule ${selector}`);
  return first;
}

function rulesFor(selector: string): CSSStyleDeclaration[] {
  const sheet = document.styleSheets[0];
  if (!sheet) throw new Error('missing stylesheet');
  const found: CSSStyleDeclaration[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && rule.selectorText === selector) found.push(rule.style);
      if ('cssRules' in rule && rule.cssRules) visit(rule.cssRules as CSSRuleList);
    }
  };
  visit(sheet.cssRules);
  return found;
}

function reservedPx(maxHeight: string): number {
  const match = maxHeight.match(/- (\d+)px\)$/);
  if (!match) throw new Error(`no reserved px in ${maxHeight}`);
  return Number(match[1]);
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

  it('scrolls the top bar when a long username and the tabs are wider than the screen', () => {
    mount('view-queue');
    document.querySelector('.topbar')!.innerHTML = `
      <div class="brand"><span class="brand-mark">J</span><span class="brand-name">SNAP</span></div>
      <div class="kp-badge">Kp 4</div>
      <div class="sun-badge"></div>
      <span class="profile-badge">anilsamoilenko-astro</span>
      <nav class="tabs">
        <button class="tab" type="button">Queue</button>
        <button class="tab" type="button">Upcoming</button>
        <button class="tab" type="button">Map</button>
        <button class="tab" type="button">Profile</button>
        <button class="tab" type="button">Log</button>
      </nav>
    `;
    const bar = getComputedStyle(document.querySelector('.topbar')!);
    const tabs = getComputedStyle(document.querySelector('.tabs')!);
    const tab = getComputedStyle(document.querySelector('.tab')!);
    expect(bar.overflowX).toBe('auto');
    expect(bar.overflowY).toBe('hidden');
    expect(bar.touchAction).toBe('none');
    expect(getComputedStyle(document.querySelector('.tab')!).touchAction).toBe('none');
    expect(getComputedStyle(document.querySelector('.profile-badge')!).touchAction).toBe('none');
    expect(rulesFor('.tabs').some((style) => style.overflowX === 'auto')).toBe(false);
    expect(tabs.flexShrink).toBe('0');
    expect(getComputedStyle(document.querySelector('.profile-badge')!).flexShrink).toBe('0');
    expect(getComputedStyle(document.querySelector('.kp-badge')!).flexShrink).toBe('0');
    expect(tab.flexShrink).toBe('0');
    expect(tab.minHeight).toBe('44px');
    expect(getComputedStyle(document.querySelector('.brand')!).flexShrink).toBe('0');
    expect(css).toContain('env(safe-area-inset-left)');
    expect(css).toContain('env(safe-area-inset-right)');
  });

  it('hides map controls until Controls is used and leaves the bar and banner up', () => {
    mount('view-map');
    document.body.classList.add('map-chrome-hidden');
    document.querySelector('#map-pane')!.classList.add('map-chrome-hidden');
    const hidden = (selector: string) => getComputedStyle(document.querySelector(selector)!).display;
    expect(hidden('.map-toolbar')).toBe('none');
    expect(hidden('.map-control-dock')).toBe('none');
    expect(hidden('.map-legend')).toBe('none');
    expect(hidden('.map-imagery-date')).toBe('none');
    expect(hidden('.maplibregl-ctrl-bottom-right')).toBe('none');
    expect(hidden('.help-fab')).toBe('none');
    expect(hidden('.topbar')).not.toBe('none');
    expect(hidden('#status-banner')).not.toBe('none');
    document.body.classList.remove('map-chrome-hidden');
    document.querySelector('#map-pane')!.classList.remove('map-chrome-hidden');
    expect(hidden('.map-toolbar')).not.toBe('none');
    expect(hidden('.help-fab')).not.toBe('none');
    expect(hidden('#status-banner')).not.toBe('none');
  });

  it('draws one centered info icon on the credit toggle, collapsed and expanded', () => {
    mount('view-map');
    const read = () => getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib-button')!);
    const collapsed = read();
    expect(collapsed.backgroundRepeat).toBe('no-repeat');
    expect(collapsed.backgroundPosition).toBe('center center');
    document.querySelector('.maplibregl-ctrl-attrib')!.classList.add('maplibregl-compact-show');
    const expanded = read();
    expect(expanded.backgroundRepeat).toBe('no-repeat');
    expect(expanded.backgroundPosition).toBe('center center');
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

  it('keeps the dock above the help button in both credit states', () => {
    mount('view-map');
    const helpHeight = px('.help-fab', 'height');
    const dockTop = ruleStyle('.view-map .map-control-dock').top;
    const topExtra = Number(dockTop.match(/\+ (\d+)px\)/)?.[1] ?? 0);
    const check = (helpSelector: string, dockSelector: string) => {
      const helpBottom = Number.parseFloat(ruleStyle(helpSelector).bottom);
      const needed = helpBottom + helpHeight;
      const docks = rulesFor(dockSelector);
      expect(docks.length).toBeGreaterThan(0);
      expect(docks.some((style) => style.maxHeight.includes('safe-area-inset-bottom'))).toBe(true);
      for (const style of docks) {
        expect(reservedPx(style.maxHeight) - topExtra).toBeGreaterThanOrEqual(needed);
      }
    };
    check('.view-map ~ .help-fab', '.view-map .map-control-dock');
    check(
      '.view-map:has(.maplibregl-ctrl-attrib.maplibregl-compact-show) ~ .help-fab',
      '.view-map:has(.maplibregl-ctrl-attrib.maplibregl-compact-show) .map-control-dock',
    );
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
