import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/style.css', 'utf8');
const html = readFileSync('index.html', 'utf8');
let footerHeight = 23;
let legendHeight = 206;
let stackedHeight = 140;
let paneBottom = 900;
const probes: Array<{ kind: string; width: number; height: string; wrap: string }> = [];
let fontChange: (() => void) | undefined;

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) };
}

async function mount(width: number, height: number): Promise<() => Promise<void>> {
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
      if (this.id === 'map-pane') return rect(0, 0, innerWidth, paneBottom);
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
