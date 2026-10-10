import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('index.html'), 'utf8');
import { describe, expect, it } from 'vitest';
import { layoutMapNavigation } from '../src/map-navigation-layout';
import { paintEqualDigits } from '../src/digits';

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
    <div id="map-legend" class="map-legend">
      <button id="map-legend-toggle" class="map-legend-toggle" type="button" aria-expanded="false" aria-controls="map-legend-panel">Legend</button>
      <div id="map-legend-panel" class="map-legend-panel">
        <div class="map-imagery-date">imagery</div>
      </div>
    </div>
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
    expect(toolbar.backgroundColor).toBe('#10161c');
    expect(ruleStyle('body:has(> #view.view-map) .brand-expansion').display).toBe('none');
  });

  it('keeps the legend and help clear of the collapsed info button', () => {
    mount('view-map');
    const buttonTop = px('.maplibregl-ctrl-bottom-right', 'bottom') + px('.maplibregl-ctrl-attrib-button', 'height');
    expect(Number.parseFloat(ruleStyle('.view-map ~ .help-fab').bottom)).toBeGreaterThanOrEqual(buttonTop);
    expect(px('.map-legend', 'bottom')).toBeGreaterThanOrEqual(px('.maplibregl-ctrl-bottom-right', 'bottom'));
    expect(getComputedStyle(document.querySelector('.map-imagery-date')!).position).toBe('static');
    expect(document.querySelector('#map-legend-panel')!.contains(document.querySelector('.map-imagery-date'))).toBe(true);
    expect(getComputedStyle(document.querySelector('#map-legend-panel')!).display).toBe('none');
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
      padding: '0px 16px',
      flexWrap: 'nowrap',
      minHeight: '44px',
      tabPadding: '0px 12px',
      weight: '400',
      activeWeight: '400',
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
    expect(tabs.overflowX).not.toBe('auto');
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
    expect(hidden('.help-fab')).toBe('none');
    expect(hidden('.maplibregl-ctrl-bottom-right')).toBe('none');
    expect(hidden('#status-banner')).not.toBe('none');
    mount('view-queue');
    expect(getComputedStyle(document.querySelector('.help-fab')!).display).not.toBe('none');
  });

  it('keeps the hide control in the same place when the control bar opens', () => {
    mount('view-map');
    document.body.classList.add('map-chrome-hidden');
    document.querySelector('#map-pane')!.classList.add('map-chrome-hidden');
    document.querySelector('#map-pane')!.insertAdjacentHTML(
      'beforeend',
      '<button id="map-chrome-toggle" class="map-chrome-toggle" type="button">Controls</button>',
    );
    const button = document.querySelector('#map-chrome-toggle')!;
    const place = () => {
      const style = getComputedStyle(button);
      return [style.position, style.left, style.right, style.top, style.bottom, style.transform].join('|');
    };
    const hiddenPlace = place();
    document.body.classList.remove('map-chrome-hidden');
    document.querySelector('#map-pane')!.classList.remove('map-chrome-hidden');
    button.textContent = 'Hide';
    expect(place()).toBe(hiddenPlace);
    const style = getComputedStyle(button);
    expect(style.right).toBe('12px');
    expect(style.minWidth).toBe('88px');
    expect(hiddenPlace).not.toContain('50%');
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
    expect(getComputedStyle(document.querySelector('.map-imagery-date')!).position).toBe('static');
    expect(Number.parseFloat(ruleStyle('.view-map ~ .help-fab').bottom)).toBeLessThan(100);
  });

  it('gives the right control bar the space the map info controls used', () => {
    mount('view-map');
    expect(getComputedStyle(document.querySelector('.help-fab')!).display).toBe('none');
    expect(getComputedStyle(document.querySelector('.maplibregl-ctrl-bottom-right')!).display).toBe('none');
    const reserves = [
      '.view-map .map-control-dock',
      '.view-map:has(.maplibregl-ctrl-attrib.maplibregl-compact-show) .map-control-dock',
    ].flatMap((selector) => rulesFor(selector).map((style) => reservedPx(style.maxHeight)));
    expect(reserves.length).toBeGreaterThan(0);
    expect(Math.max(...reserves)).toBeLessThanOrEqual(16);
    expect(css).not.toContain('- 169px');
    expect(css).not.toContain('- 189px');
  });

  it('keeps the legend to the left of hide, including when credits expand', () => {
    mount('view-map');
    document.querySelector('#map-pane')!.insertAdjacentHTML(
      'beforeend',
      '<button id="map-chrome-toggle" class="map-chrome-toggle" type="button">Hide</button>',
    );
    document.querySelector('.maplibregl-ctrl-attrib')!.classList.add('maplibregl-compact-show');
    const legend = getComputedStyle(document.querySelector('.map-legend')!);
    const hide = getComputedStyle(document.querySelector('#map-chrome-toggle')!);
    expect(legend.position).toBe('absolute');
    expect(legend.bottom).toBe(hide.bottom);
    const sumPx = (value: string) => {
      const parts = value.match(/[\d.]+px/g);
      if (!parts) throw new Error(value);
      return parts.reduce((sum, part) => sum + Number.parseFloat(part), 0);
    };
    expect(sumPx(legend.right)).toBe(108);
    expect(sumPx(hide.right)).toBe(12);
    expect(sumPx(legend.right)).toBeGreaterThan(sumPx(hide.right) + Number.parseFloat(hide.width));
    expect(legend.flexDirection).toBe('column-reverse');
    expect(legend.width).toBe('88px');
    expect(getComputedStyle(document.querySelector('.maplibregl-ctrl-bottom-right')!).display).toBe('none');
    expect(getComputedStyle(document.querySelector('.map-imagery-date')!).position).toBe('static');
    expect(getComputedStyle(document.querySelector('.maplibregl-ctrl-bottom-right')!).left).toBe('8px');
    const creditsTop = px('.maplibregl-ctrl-bottom-right', 'bottom') + px('.maplibregl-ctrl-attrib', 'max-height');
    const helpBottom = Number.parseFloat(
      ruleStyle('.view-map:has(.maplibregl-ctrl-attrib.maplibregl-compact-show) ~ .help-fab').bottom,
    );
    expect(helpBottom).toBeGreaterThanOrEqual(creditsTop);
  });

  it('drops the Time label and gives that row back to the map', () => {
    const command = html.slice(html.indexOf('class="map-command"'), html.indexOf('map-control-dock'));
    expect(command).not.toContain('>Time<');
    expect(command).toContain('id="time-slider"');
    const heights = rulesFor('body:has(> #view.view-map):not(.map-chrome-hidden)')
      .map((style) => style.getPropertyValue('--map-command-height'));
    expect(heights).toContain('calc(64px + env(safe-area-inset-bottom, 0px))');
    expect(heights).toContain('calc(140px + env(safe-area-inset-bottom, 0px))');
    expect(heights).toContain('52px');
    expect(heights).not.toContain('calc(72px + env(safe-area-inset-bottom, 0px))');
    const narrowShort = css.slice(css.indexOf('@media (max-height: 520px) {'), css.indexOf('@media (max-height: 520px) and (min-width: 720px)'));
    const wideShort = css.slice(css.indexOf('@media (max-height: 520px) and (min-width: 720px)'), css.indexOf('@media (max-height: 520px) and (max-width: 899px)'));
    expect(narrowShort).not.toContain('flex-wrap: nowrap');
    expect(narrowShort).toContain('overflow-x: auto');
    expect(wideShort).toContain('flex-wrap: nowrap');
    expect(wideShort).toContain('height: 52px;');
    expect(css).toContain('--map-banner-clearance: calc(0.2rem + 0.75rem * 1.3 + 0.2rem + 1px);');
    expect(css).toContain('--map-command-bottom: calc(var(--map-banner-clearance) + env(safe-area-inset-bottom, 0px));');
    expect(css).toContain('bottom: var(--map-command-bottom, env(safe-area-inset-bottom, 0px));');
    expect(css).toContain('max-height: calc(100% - var(--topbar-height) - var(--map-command-height) - var(--map-command-bottom, 0px) - 16px);');
    expect(css).toContain('--map-command-bottom: calc(4rem + env(safe-area-inset-bottom, 0px));');
    expect(css).toContain('--map-corner-bottom: calc(4rem + 4px + env(safe-area-inset-bottom, 0px));');
    expect(css).toContain('body.shotlist-bar-visible:has(> #view.view-map) main {\n    padding-bottom: 0;');
    expect(heights).not.toContain('156px');
    expect(heights).not.toContain('104px');
  });

  it.each([
    { name: '320×568 closed', width: 320, height: 568, timeTop: 262.40625, timeWidth: 108, shotlist: false },
    { name: '320×568 shot list', width: 320, height: 568, timeTop: 182.40625, timeWidth: 108, shotlist: true },
    { name: '320×568 shot list and legend', width: 320, height: 568, timeTop: 182.40625, timeWidth: 108, shotlist: true },
    { name: '320×568 deep scrub, shot list and legend', width: 320, height: 568, timeTop: 182.40625, timeWidth: 108, shotlist: true },
    { name: '390×564 closed', width: 390, height: 564, timeTop: 354.40625, timeWidth: 178, shotlist: false },
    { name: '390×564 shot list', width: 390, height: 564, timeTop: 274.40625, timeWidth: 178, shotlist: true },
    { name: '390×564 shot list and legend', width: 390, height: 564, timeTop: 274.40625, timeWidth: 178, shotlist: true },
    { name: '430×400 closed with expanded legend', width: 430, height: 400, timeTop: 243.40625, timeWidth: 202, shotlist: false },
    { name: '430×400 shot list', width: 430, height: 400, timeTop: 202.40625, timeWidth: 202, shotlist: true },
    { name: '430×400 shot list and legend', width: 430, height: 400, timeTop: 202.40625, timeWidth: 202, shotlist: true },
    { name: '664×390 shot list', width: 664, height: 390, timeTop: 222, timeWidth: 436, shotlist: true },
    { name: '844×390 shot list', width: 844, height: 390, timeTop: 270, timeWidth: 604.765625, shotlist: true },
  ])('keeps all three full navigation hit areas clear of the measured time strip: $name', (sample) => {
    mount('view-map');
    const pane = document.getElementById('map-pane')!;
    const map = document.getElementById('map')!;
    const short = sample.height <= 520;
    const mapTop = short ? 48 : 89;
    const toolbarBottom = short ? 105 : 146;
    const inset = short ? 16 : 8;
    const rect = (x: number, y: number, width: number, height: number) => new DOMRect(x, y, width, height);
    pane.style.setProperty('--map-nav-toolbar-gap', `${short ? 5 : 14}px`);
    map.getBoundingClientRect = () => rect(0, mapTop, sample.width, sample.height - mapTop - (sample.shotlist && !short ? 80 : 0));
    const toolbar = pane.querySelector('.map-toolbar')!;
    toolbar.getBoundingClientRect = () => rect(8, mapTop + 5, sample.width === 320 ? 193.8125 : 203.40625, toolbarBottom - mapTop - 5);
    const dock = pane.querySelector('.map-control-dock')!;
    const dockBottom = short ? sample.height - (sample.shotlist ? 215 : 174) : sample.height - (sample.shotlist ? 231 : 151);
    dock.getBoundingClientRect = () => rect(sample.width - 74.15625, mapTop + 5, 66.15625, dockBottom - mapTop - 5);
    const legend = pane.querySelector('.map-legend-panel')!;
    const deep = sample.name.includes('deep scrub');
    const legendTop = short ? (sample.shotlist ? 132 : 164) : sample.height - 235.953125 - (sample.shotlist ? 80 : 0) - (deep ? 18 : 0);
    if (sample.name.includes('legend')) legend.getBoundingClientRect = () => rect(sample.width - 196, legendTop, 88, deep ? 169.953125 : 151.953125);
    const legendToggle = pane.querySelector('.map-legend-toggle')!;
    const cornerTop = short ? sample.height - (sample.shotlist ? 112 : 80) : sample.height - (sample.shotlist ? 160 : 80);
    legendToggle.getBoundingClientRect = () => rect(sample.width - 196, cornerTop, 88, 44);
    pane.insertAdjacentHTML('beforeend', '<button class="map-chrome-toggle">Hide</button>');
    const hide = pane.querySelector('.map-chrome-toggle')!;
    hide.getBoundingClientRect = () => rect(sample.width - 100, cornerTop, 88, 44);
    map.insertAdjacentHTML('beforeend', `<div class="maplibregl-ctrl-top-left"><div class="maplibregl-ctrl maplibregl-ctrl-group">
      <button class="maplibregl-ctrl-zoom-in"></button><button class="maplibregl-ctrl-zoom-out"></button><button class="maplibregl-ctrl-compass"></button>
    </div></div>`);
    pane.insertAdjacentHTML('beforeend', '<div class="map-command"><div class="map-controls-time"><div class="time-slider-row"><input class="time-slider" /><span class="time-slider-readout"></span></div></div></div>');
    const time = pane.querySelector<HTMLElement>('.map-controls-time')!;
    time.getBoundingClientRect = () => rect(inset, sample.timeTop, sample.timeWidth, sample.height - sample.timeTop - (sample.shotlist ? 108 : 28));
    const row = time.querySelector<HTMLElement>('.time-slider-row')!;
    row.getBoundingClientRect = () => rect(inset + 8, sample.timeTop + 4, Math.max(160, sample.timeWidth - 16), 24);
    const slider = time.querySelector<HTMLElement>('.time-slider')!;
    slider.getBoundingClientRect = () => rect(inset + 39, sample.timeTop - 6, 27, 44);
    const readout = time.querySelector<HTMLElement>('.time-slider-readout')!;
    readout.getBoundingClientRect = () => deep ? rect(108, 186.40625, 64, 24) : rect(0, 0, 0, 0);
    const corner = map.querySelector<HTMLElement>('.maplibregl-ctrl-top-left')!;
    const group = corner.querySelector<HTMLElement>('.maplibregl-ctrl-group')!;
    const buttons = [...group.querySelectorAll('button')];
    const horizontal = () => pane.dataset.mapNavigation === 'row'
      && ruleStyle('.view-map #map-pane[data-map-navigation="row"] .maplibregl-ctrl-top-left .maplibregl-ctrl-group').display === 'flex';
    group.getBoundingClientRect = () => {
      const style = getComputedStyle(corner);
      const shift = Number.parseFloat(style.transform.match(/translateX\(\s*([-\d.]+)px/)?.[1] ?? '0');
      return rect(8 + shift, mapTop + Number.parseFloat(style.top), horizontal() ? 132 : 44, horizontal() ? 44 : 132);
    };
    for (const [index, button] of buttons.entries()) {
      button.getBoundingClientRect = () => {
        const box = group.getBoundingClientRect();
        return rect(box.left + (horizontal() ? index * 44 : 0), box.top + (horizontal() ? 0 : index * 44), px(`.${button.className}`, 'width'), px(`.${button.className}`, 'height'));
      };
    }

    layoutMapNavigation(pane);
    const first = group.getBoundingClientRect();
    layoutMapNavigation(pane);
    expect(group.getBoundingClientRect()).toEqual(first);
    const obstacles = [time, row, slider, readout, toolbar, dock, legendToggle, hide].map((element) => element.getBoundingClientRect());
    if (sample.name.includes('legend')) obstacles.push(legend.getBoundingClientRect());
    if (sample.name === '430×400 closed with expanded legend') {
      expect(first.left).toBe(8);
    }
    for (const button of buttons) {
      const box = button.getBoundingClientRect();
      expect(box.width).toBe(44);
      expect(box.height).toBe(44);
      expect(box.top).toBeGreaterThanOrEqual(mapTop);
      expect(box.right).toBeLessThanOrEqual(sample.width);
      expect(box.bottom).toBeLessThanOrEqual(map.getBoundingClientRect().bottom);
      for (const obstacle of obstacles) {
        expect(box.left >= obstacle.right || box.right <= obstacle.left || box.top >= obstacle.bottom || box.bottom <= obstacle.top,
          JSON.stringify({ control: button.className, box, obstacle, layout: pane.dataset.mapNavigation })).toBe(true);
      }
      for (const [x, y] of [[box.left + 1, box.top + 1], [box.right - 1, box.top + 1], [box.left + 1, box.bottom - 1], [box.right - 1, box.bottom - 1], [box.left + 22, box.top + 22]] as const) {
        expect(obstacles.some((obstacle) => x >= obstacle.left && x < obstacle.right && y >= obstacle.top && y < obstacle.bottom)).toBe(false);
      }
    }
    if (sample.name === '390×564 closed') {
      expect(first.left).toBe(8);
      expect(time.getBoundingClientRect().top - buttons[2]!.getBoundingClientRect().bottom).toBeCloseTo(62.40625, 4);
    }
  });

  it('wraps the complete deep-scrub time and stale-TLE warning inside its measured readout', () => {
    mount('view-map');
    document.getElementById('map-pane')!.insertAdjacentHTML('beforeend', '<div class="map-command"><div class="map-controls-time"><span class="time-slider-readout time-slider-scrubbed time-slider-stale"></span></div></div>');
    const readout = document.querySelector<HTMLElement>('.time-slider-readout')!;
    const label = '+2d 04:54Z · stale TLE';
    paintEqualDigits(readout, label);
    const style = getComputedStyle(readout);
    expect(readout.textContent).toBe(label);
    expect(style.whiteSpace).toBe('normal');
    expect(style.overflowWrap).toBe('anywhere');
    expect(style.overflow).not.toBe('hidden');
    expect(style.textOverflow).not.toBe('ellipsis');
  });

  it('lays the time strip on the map', () => {
    mount('view-map');
    document.querySelector('#map-pane')!.insertAdjacentHTML(
      'beforeend',
      `<div class="map-command">
        <div class="map-controls map-controls-time">
          <input id="time-slider" class="time-slider" type="range" />
        </div>
      </div>`,
    );
    const command = getComputedStyle(document.querySelector('.map-command')!);
    const controls = getComputedStyle(document.querySelector('.map-controls-time')!);
    expect(command.backgroundColor).toBe('transparent');
    expect(command.borderTopWidth).toBe('0px');
    expect(command.bottom).toBe('0px');
    expect(css).toContain('padding: 0 0 calc(28px + env(safe-area-inset-bottom, 0px));');
    expect(css).toContain('@media (min-height: 521px)');
    expect(css).toContain('.view-map .map-command .map-controls-time {\n    padding-bottom: 8px;');
    expect(controls.backgroundColor).toBe('rgba(7, 10, 13, 0.86)');
    expect(controls.pointerEvents).toBe('auto');
    expect(ruleStyle('.view-map #map').bottom).toBe('0px');
  });

  it('ships the map page without the corner help button', () => {
    expect(html).toContain('id="help-fab"');
    expect(html).toMatch(/id="help-fab"[^>]*\shidden[\s>]/);
  });

  it('keeps the Launches label inside its map toolbar button', () => {
    mount('view-map');
    document.querySelector('.map-toolbar')!.innerHTML = `
      <div class="map-controls map-controls-filter">
        <span class="map-group-label">Show</span>
        <button id="filter-all-map" class="filter-btn" type="button">All</button>
        <button id="filter-mine-map" class="filter-btn" type="button">Mine</button>
        <button id="filter-launches-map" class="filter-btn" type="button">Launches</button>
      </div>
    `;
    const launches = getComputedStyle(document.querySelector('#filter-launches-map')!);
    expect(launches.flexShrink).toBe('0');
    expect(launches.whiteSpace).toBe('nowrap');
    expect(launches.minWidth).toBe('44px');
    mount('view-queue');
    document.querySelector('#map-pane')!.insertAdjacentHTML(
      'beforeend',
      '<button id="filter-launches-queue" class="filter-btn" type="button">Launches</button>',
    );
    expect(getComputedStyle(document.querySelector('#filter-launches-queue')!).flexShrink).toBe('');
  });

  it('reserves a map hit height when the narrow inspector would cover the credit strip', () => {
    mount('view-map');
    const blocks = rulesFor('#map-pane.map-inspector-open').map((style) => style.getPropertyValue('--map-inspector-block'));
    expect(blocks).toContain(
      'min(40dvh, 260px, max(0px, calc(100dvh - var(--topbar-height) - var(--map-command-height) - var(--map-hit-min))))',
    );
    expect(blocks).toContain('min(28dvh, 120px)');
    const hit = rulesFor('#map-pane.map-inspector-open').map((style) => style.getPropertyValue('--map-hit-min')).find(Boolean);
    expect(hit).toBe('calc(2 * (28px + 64px + 24px + env(safe-area-inset-bottom, 0px)))');
  });
});
