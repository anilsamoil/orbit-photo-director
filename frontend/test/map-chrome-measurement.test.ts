import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/style.css', 'utf8');
const html = readFileSync('index.html', 'utf8');
let footerHeight = 23;
let legendHeight = 206;
let stackedHeight = 140;
let paneBottom = 900;
let ownedPaneTop = 0;
const probes: Array<{ kind: string; width: number; height: string; wrap: string }> = [];
let fontChange: (() => void) | undefined;

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) };
}

async function mount(width: number, height: number, afterBind?: () => void): Promise<() => Promise<void>> {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  paneBottom = height;
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  document.body.className = '';
  document.body.removeAttribute('style');
  document.getElementById('view')!.className = 'view-map';
  document.getElementById('map-pane')!.hidden = false;
  localStorage.setItem('opd-map-chrome', 'shown');
  const { bindMapChrome } = await import('../src/map-chrome');
  bindMapChrome();
  afterBind?.();
  const sync = async () => {
    await Promise.resolve();
    (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome?.();
    await Promise.resolve();
  };
  await sync();
  return sync;
}

function slot(name: string, axis: string): number {
  return Number.parseFloat(document.body.style.getPropertyValue(`--slot-${name}-${axis}`));
}

describe('intrinsic map chrome measurement', () => {
  beforeEach(() => {
    vi.resetModules();
    footerHeight = 23;
    legendHeight = 206;
    stackedHeight = 140;
    ownedPaneTop = 0;
    probes.length = 0;
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    Object.defineProperty(document, 'fonts', { configurable: true, value: {
      ready: Promise.resolve(),
      addEventListener: (name: string, callback: () => void) => {
        if (name === 'loadingdone') fontChange = callback;
      },
    } });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const kind = this.getAttribute('data-map-chrome-measure');
      if (kind) {
        const width = Number.parseFloat(this.style.width);
        probes.push({ kind, width, height: this.style.height, wrap: this.style.flexWrap });
        expect(this.style.height).toBe('auto');
        expect(this.style.maxHeight).toBe('none');
        expect(this.style.visibility).toBe('hidden');
        return rect(0, 0, width, kind === 'footer' ? footerHeight : kind === 'legend' ? legendHeight : stackedHeight);
      }
      if (this.id === 'map-pane') {
        const top = document.body.classList.contains('map-slot-owned') ? ownedPaneTop : 0;
        return rect(0, top, innerWidth, paneBottom - top);
      }
      if (this.id === 'status-banner') return rect(0, innerHeight - 23, innerWidth, 23);
      if (this.id === 'map-legend-panel') return rect(0, 0, 176, 10);
      if (this.matches('.map-controls-time')) return rect(0, 0, 200, 44);
      if (this.matches('.map-toolbar')) return rect(0, 0, 180, 52);
      return rect(0, 0, Number.parseFloat(this.style.width) || 0, 0);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it.each([[320, 360], [320, 400], [1320, 440]])('reserves dynamic footer content, not its constrained live box at %ix%i', async (w, h) => {
    const sync = await mount(w, h);
    expect(slot('footer', 'h')).toBe(23);
    const oldHide = slot('hide', 'y');
    document.getElementById('status-banner')!.innerHTML = '<p class="banner-copy">Changed status</p><div class="banner-actions"><button>Reload</button></div>';
    footerHeight = 86;
    await sync();
    expect(slot('footer', 'h')).toBe(86);
    expect(slot('footer', 'y') + 86).toBe(h);
    expect(slot('hide', 'y')).toBeLessThan(oldHide);
    expect(slot('time', 'y') + slot('time', 'h')).toBeLessThanOrEqual(slot('footer', 'y'));
    footerHeight = 23;
    await sync();
    expect(slot('footer', 'h')).toBe(23);
    expect(document.querySelector('[data-map-chrome-measure]')).toBeNull();
  });

  it.each([[800, 600], [1400, 900]])('opens Legend at intrinsic height independent of its toggle shell at %ix%i', async (w, h) => {
    const sync = await mount(w, h);
    document.getElementById('map-legend-toggle')!.setAttribute('aria-expanded', 'true');
    await sync();
    expect(slot('legend', 'h')).toBe(206);
    expect(probes.filter(p => p.kind === 'legend').every(p => p.width === 176)).toBe(true);
    legendHeight = 240;
    await sync();
    expect(slot('legend', 'h')).toBe(240);
    expect(fontChange).toBeTypeOf('function');
    fontChange!();
    expect(requestAnimationFrame).toHaveBeenCalled();
  });

  it.each([[800, 600], [874, 402], [820, 1180], [834, 1194], [1400, 900]])('writes the capped Legend allocation, not oversized intrinsic content at %ix%i', async (w, h) => {
    legendHeight = 2400;
    footerHeight = 86;
    const sync = await mount(w, h);
    const solver = await import('../src/chrome-slots');
    const solve = vi.spyOn(solver, 'solveChromeSlots');
    document.getElementById('map-legend-toggle')!.setAttribute('aria-expanded', 'true');
    await sync();
    const allocated = solve.mock.results.at(-1)?.value.legend;
    expect(allocated).not.toBeNull();
    expect(slot('legend', 'h')).toBe(allocated.h);
    expect(slot('legend', 'h')).toBeGreaterThanOrEqual(32);
    expect(slot('legend', 'h')).toBeLessThan(legendHeight);
    expect(slot('legend', 'y') + slot('legend', 'h')).toBeLessThanOrEqual(slot('footer', 'y'));
    expect(probes.filter(p => p.kind === 'legend').length).toBeGreaterThan(0);
  });

  it.each([360, 400])('does not feed the 44px fallback into the stacked requirement at 320x%i', async (h) => {
    const sync = await mount(320, h);
    for (const expanded of ['false', 'true']) {
      document.getElementById('map-legend-toggle')!.setAttribute('aria-expanded', expanded);
      await sync();
      const stable = document.body.style.cssText;
      for (let i = 0; i < 8; i++) await sync();
      expect(document.body.style.cssText).toBe(stable);
      expect(probes.filter(p => p.kind === 'time').length).toBeGreaterThan(0);
      expect(probes.filter(p => p.kind === 'time').every(p => p.wrap === 'wrap')).toBe(true);
    }
  });

  it('reserves the independent stacked requirement at the proposed slot width', async () => {
    const sync = await mount(390, 900);
    expect(slot('time', 'h')).toBe(140);
    expect(probes.filter(p => p.kind === 'time').at(-1)?.width).toBe(slot('time', 'w'));
    stackedHeight = 184;
    await sync();
    expect(slot('time', 'h')).toBe(184);
  });

  it('uses single-line controls in the 52px short-wide allocation', async () => {
    await mount(1320, 440);
    expect(slot('time', 'h')).toBe(52);
    expect(document.body.classList.contains('map-slot-time-line')).toBe(true);
    const chip = document.querySelector('.map-controls-time')!;
    expect(getComputedStyle(chip).flexWrap).toBe('nowrap');
    expect(getComputedStyle(document.querySelector('.time-slider-row')!).flexBasis).toBe('auto');
  });

  it('passes the pane visible clip into the allocation', async () => {
    const sync = await mount(1400, 900);
    paneBottom = 820;
    await sync();
    for (const name of ['hide', 'legend-button', 'time', 'dock']) {
      expect(slot(name, 'y') + slot(name, 'h')).toBeLessThanOrEqual(820);
    }
  });

  it('places portrait corner buttons against the owned pane before the first frame', async () => {
    ownedPaneTop = 70;
    await mount(402, 874, () => {
      const pane = document.getElementById('map-pane')!.getBoundingClientRect();
      for (const name of ['hide', 'legend-button']) {
        expect(slot(name, 'y') + pane.top + slot(name, 'h')).toBe(874 - footerHeight - 8);
      }
    });
  });

  it('honors successive toggle and content syncs in the same task without waiting for a frame', async () => {
    await mount(402, 874);
    const sync = (window as Window & { __opdSyncMapChrome?: () => void }).__opdSyncMapChrome!;
    const legend = document.getElementById('map-legend-toggle')!;
    legend.setAttribute('aria-expanded', 'true');
    sync();
    expect(document.body.classList.contains('map-slot-legend')).toBe(true);
    const previousHideY = slot('hide', 'y');
    footerHeight = 86;
    legend.setAttribute('aria-expanded', 'false');
    sync();
    expect(document.body.classList.contains('map-slot-legend')).toBe(false);
    expect(slot('footer', 'h')).toBe(86);
    expect(slot('hide', 'y')).toBeLessThan(previousHideY);
    expect(slot('hide', 'y') + slot('hide', 'h')).toBeLessThanOrEqual(slot('footer', 'y'));
    legend.setAttribute('aria-expanded', 'true');
    sync();
    expect(document.body.classList.contains('map-slot-legend')).toBe(true);
  });

  it('measures the complete horizon button and the selected-time readout', async () => {
    const solver = await import('../src/chrome-slots');
    const solve = vi.spyOn(solver, 'solveChromeSlots');
    const sync = await mount(1400, 900);
    const pip = document.querySelector<HTMLElement>('[data-pip="horizon"]')!;
    pip.hidden = false;
    pip.style.display = 'block';
    vi.spyOn(pip, 'getBoundingClientRect').mockReturnValue(rect(1166, 89, 222, 144));
    vi.spyOn(pip.querySelector<HTMLElement>('[data-pip-frame]')!, 'getBoundingClientRect').mockReturnValue(rect(1167, 90, 220, 142));
    vi.spyOn(document.getElementById('time-slider-readout')!, 'getBoundingClientRect').mockReturnValue(rect(1109, 800, 85, 12));
    vi.spyOn(document.querySelector<HTMLElement>('.map-command')!, 'getBoundingClientRect').mockReturnValue(rect(8, 777, 1188, 96));
    await sync();
    expect(solve.mock.calls.at(-1)?.[0].pip).toEqual({ x: 1166, y: 89, w: 222, h: 144 });
    expect(solve.mock.calls.at(-1)?.[0].timeReadout).toEqual({ x: 1109, y: 800, w: 85, h: 12 });
    expect(solve.mock.calls.at(-1)?.[0].timeStrip).toEqual({ x: 8, y: 777, w: 1188, h: 96 });
  });

  it('does not paint an unallocated launch origin and recovers when room returns', async () => {
    footerHeight = 86;
    const sync = await mount(320, 240);
    document.getElementById('map-pane')!.insertAdjacentHTML('beforeend', '<div id="map-launch-coverage"><details><summary>Launch coverage</summary></details></div>');
    const launch = document.getElementById('map-launch-coverage')!;
    await sync();
    expect(document.body.classList.contains('map-slot-launch')).toBe(false);
    expect(getComputedStyle(launch).display).toBe('none');
    vi.stubGlobal('innerHeight', 900);
    paneBottom = 900;
    await sync();
    expect([window.innerWidth, window.innerHeight]).toEqual([320, 900]);
    expect(document.body.classList.contains('map-slot-launch')).toBe(true);
    expect(slot('launch', 'w')).toBeGreaterThanOrEqual(44);
    expect(slot('launch', 'h')).toBeGreaterThanOrEqual(44);
    expect(slot('launch', 'y')).toBeGreaterThan(slot('show', 'y') + slot('show', 'h'));
  });
});
