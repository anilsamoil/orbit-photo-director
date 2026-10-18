import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { devices, webkit } = require('playwright');

export const VIEWPORT_ALLOWLIST = {
  desktop: [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ],
  'iphone-13': [
    { width: 844, height: 390 },
  ],
  'ipad-pro-11': [
    { width: 834, height: 1210 },
    { width: 1210, height: 834 },
  ],
  'ipad-3': [
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
  ],
};

export const IPAD_M4_VIEWPORTS = VIEWPORT_ALLOWLIST['ipad-pro-11'];

function viewportToken(entry) {
  return `${entry.width}x${entry.height}`;
}

function viewportOverrideHelp() {
  const desktop = VIEWPORT_ALLOWLIST.desktop.map(viewportToken).join(' or ');
  const phone = VIEWPORT_ALLOWLIST['iphone-13'].map(viewportToken).join(' or ');
  const ipad = VIEWPORT_ALLOWLIST['ipad-pro-11'].map(viewportToken).join(' or ');
  const ipad3 = VIEWPORT_ALLOWLIST['ipad-3'].map(viewportToken).join(' or ');
  return `OPD_VERIFY_VIEWPORT requires OPD_VERIFY_SURFACE=desktop with ${desktop}, iphone-17-pro, iphone-13 with ${phone}, ipad-pro-11 with ${ipad}, or ipad-3 with ${ipad3}.`;
}

export function desktopViewport(surface, raw) {
  const override = surface === 'desktop' ? parseViewportOverride('desktop', raw) : null;
  return {
    width: override?.width ?? 1400,
    height: override?.height ?? 900,
    mobile: false,
  };
}

export function parseViewportOverride(surface, raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!match) throw new Error(`OPD_VERIFY_VIEWPORT must be WIDTHxHEIGHT, got ${text}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const size = { width, height, raw: text };
  if (surface === 'desktop' && ((width === 1440 && height === 900) || (width === 1280 && height === 800))) return size;
  if (surface === 'iphone-17-pro') return size;
  const allowed = VIEWPORT_ALLOWLIST[surface];
  if (allowed?.some((entry) => entry.width === width && entry.height === height)) return size;
  throw new Error(viewportOverrideHelp());
}

export const WEBKIT_DEVICES = [
  { name: 'iPhone 13', slug: 'iphone-13', standalone: true, tap: 'sign-in' },
  { name: 'iPad Pro 11', slug: 'ipad-pro-11', standalone: false, tap: 'reload' },
  {
    name: 'iPhone 17 Pro',
    slug: 'iphone-17-pro',
    standalone: true,
    tap: 'sign-in',
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 3,
  },
];

export const IPAD_3 = {
  name: 'iPad (3rd generation)',
  slug: 'ipad-3',
  standalone: false,
  tap: 'reload',
  viewport: { width: 768, height: 1024 },
  deviceScaleFactor: 2,
  deviceBase: 'iPad (gen 5)',
};

export const OPTIONAL_WEBKIT_DEVICES = [IPAD_3];

export const DEFAULT_SURFACE_NAMES = ['desktop', 'iphone-13', 'iphone-17-pro', 'ipad-pro-11'];

export function knownSurfaceNames() {
  return ['desktop', ...WEBKIT_DEVICES.map((spec) => spec.slug), ...OPTIONAL_WEBKIT_DEVICES.map((spec) => spec.slug)];
}

export function surfacesFor(raw) {
  const name = String(raw || 'all').trim() || 'all';
  if (name === 'all') return [...DEFAULT_SURFACE_NAMES];
  const known = knownSurfaceNames();
  if (!known.includes(name)) {
    throw new Error(`unknown OPD_VERIFY_SURFACE ${name}. Choose ${known.join(', ')}, or all.`);
  }
  return [name];
}

export function webkitCatalog() {
  return [...WEBKIT_DEVICES, ...OPTIONAL_WEBKIT_DEVICES];
}

export function deviceDescriptor(spec) {
  const known = devices[spec.name] || (spec.deviceBase ? devices[spec.deviceBase] : undefined);
  if (known?.viewport && !spec.viewport) return known;
  if (spec.viewport) {
    const base = known?.viewport ? known : devices['iPhone 13'];
    return {
      ...base,
      viewport: { width: spec.viewport.width, height: spec.viewport.height },
      deviceScaleFactor: spec.deviceScaleFactor ?? base.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
      defaultBrowserType: 'webkit',
    };
  }
  if (known?.viewport) return known;
  throw new Error(`Playwright has no ${spec.name} descriptor`);
}

export function deviceViewport(spec) {
  const device = deviceDescriptor(spec);
  return {
    width: device.viewport.width,
    height: device.viewport.height,
    mobile: Boolean(device.isMobile),
  };
}

export async function launchWebkit() {
  try {
    return await webkit.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`WebKit did not launch. From frontend run npx playwright install --with-deps webkit. ${message}`);
  }
}

const productViewportMeta = new WeakMap();

async function syncLayoutViewport(page, width, height) {
  const laid = await page.evaluate(({ width, height, product }) => {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="viewport"]');
    if (!root) return null;
    const current = meta ? meta.getAttribute('content') || '' : '';
    const remembered = product || (current.includes('width=device-width') ? current : '');
    const explicit = `width=${width}, height=${height}, initial-scale=1, viewport-fit=cover`;
    const matches = () => root.clientWidth === width && root.clientHeight === height;
    if (!matches() && meta) meta.setAttribute('content', explicit);
    if (matches() && meta && remembered && meta.getAttribute('content') !== remembered) {
      meta.setAttribute('content', remembered);
      if (!matches()) meta.setAttribute('content', explicit);
    }
    return {
      width: root.clientWidth,
      height: root.clientHeight,
      product: remembered,
    };
  }, { width, height, product: productViewportMeta.get(page) || '' });
  if (laid?.product) productViewportMeta.set(page, laid.product);
  if (laid && (laid.width !== width || laid.height !== height)) {
    throw new Error(`layout viewport ${laid.width}x${laid.height} after set ${width}x${height}`);
  }
}

export function playwrightSend(page) {
  return async function send(method, params = {}) {
    if (method === 'Runtime.evaluate') {
      try {
        const value = await page.evaluate(params.expression);
        return { result: { value } };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { exceptionDetails: { text }, result: {} };
      }
    }
    if (method === 'Page.captureScreenshot') {
      const options = { type: 'png' };
      if (params.clip) {
        options.clip = {
          x: params.clip.x,
          y: params.clip.y,
          width: params.clip.width,
          height: params.clip.height,
        };
      }
      const buffer = await page.screenshot(options);
      return { data: buffer.toString('base64') };
    }
    if (method === 'Page.navigate') {
      await page.goto(params.url, { waitUntil: 'domcontentloaded' });
      return {};
    }
    if (method === 'Page.reload') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      return {};
    }
    if (method === 'Page.enable') return {};
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      await page.addInitScript(params.source);
      return {};
    }
    if (method === 'Emulation.setDeviceMetricsOverride') {
      await page.setViewportSize({ width: params.width, height: params.height });
      await syncLayoutViewport(page, params.width, params.height);
      return {};
    }
    if (method === 'Emulation.setSafeAreaInsetsOverride') {
      throw new Error('safe area unsupported');
    }
    if (method === 'Emulation.setTouchEmulationEnabled') return {};
    if (method === 'Input.dispatchMouseEvent') {
      const button = params.button || 'left';
      await page.mouse.move(params.x, params.y);
      if (params.type === 'mouseWheel') {
        const deltaX = params.deltaX || 0;
        const deltaY = params.deltaY || 0;
        try {
          await page.mouse.wheel(deltaX, deltaY);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/not supported/i.test(message)) throw error;
          await page.evaluate(({ x, y, wheelX, wheelY }) => {
            const target = document.elementFromPoint(x, y) || document.body;
            target.dispatchEvent(new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              deltaX: wheelX,
              deltaY: wheelY,
            }));
          }, { x: params.x, y: params.y, wheelX: deltaX, wheelY: deltaY });
        }
        return {};
      }
      if (params.type === 'mousePressed') await page.mouse.down({ button, clickCount: params.clickCount || 1 });
      else if (params.type === 'mouseReleased') await page.mouse.up({ button, clickCount: params.clickCount || 1 });
      return {};
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.type !== 'keyDown' || !params.key) return {};
      const shifted = (params.modifiers & 8) === 8;
      const key = shifted ? `Shift+${params.key}` : params.key;
      await page.keyboard.press(key);
      return {};
    }
    if (method === 'Input.tap') {
      await page.touchscreen.tap(params.x, params.y);
      return {};
    }
    if (method === 'Input.touchscreenTap') {
      await page.touchscreen.tap(params.x, params.y);
      return {};
    }
    if (method === 'Input.dispatchTouchEvent') {
      const point = (params.touchPoints || [])[0];
      if (!point) return {};
      const type = params.type === 'touchStart' ? 'touchstart' : params.type === 'touchEnd' ? 'touchend' : 'touchmove';
      await page.evaluate(({ type: touchType, x, y }) => {
        const target = document.elementFromPoint(x, y) || document.body;
        const touch = document.createTouch(window, target, 1, x, y, x, y, x, y);
        const changed = document.createTouchList(touch);
        const active = touchType === 'touchend' ? document.createTouchList() : changed;
        target.dispatchEvent(new TouchEvent(touchType, {
          bubbles: true,
          cancelable: true,
          touches: active,
          targetTouches: active,
          changedTouches: changed,
        }));
      }, { type, x: point.x, y: point.y });
      return {};
    }
    throw new Error(`webkit send has no ${method}`);
  };
}

async function hit(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return null;
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const control = el?.closest('a, button');
    return { tag: control?.tagName || el?.tagName || null, text: (control?.textContent || '').trim() };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

export async function proveDeniedFooter(browser, spec, baseUrl, evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
  const device = deviceDescriptor(spec);
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'opd-verify-session', value: 'deny', url: baseUrl }]);
  if (spec.standalone) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    });
  }
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/?u=anil`, { waitUntil: 'domcontentloaded' });
    const signIn = page.locator('#status-banner').getByRole('link', { name: 'Sign in' });
    const reload = page.locator('#status-banner').getByRole('button', { name: 'Reload' });
    await signIn.waitFor({ timeout: 15000 });
    const signHit = await hit(page, signIn);
    const reloadHit = await hit(page, reload);
    if (signHit?.text !== 'Sign in' || signHit.tag !== 'A') throw new Error(`${spec.name} Sign in hit ${JSON.stringify(signHit)}`);
    if (reloadHit?.text !== 'Reload' || reloadHit.tag !== 'BUTTON') throw new Error(`${spec.name} Reload hit ${JSON.stringify(reloadHit)}`);
    await page.evaluate(() => localStorage.setItem('opd-calib-queue', '[{"private":"unsent"}]'));
    await page.screenshot({ path: resolve(evidenceDir, 'banner-auth.png') });
    const control = spec.tap === 'reload' ? reload : signIn;
    await control.click();
    await page.waitForURL(/\/api\/app/, { timeout: 8000 });
    const kept = await page.evaluate(() => localStorage.getItem('opd-calib-queue'));
    if (kept !== '[{"private":"unsent"}]') throw new Error(`${spec.name} recovery cleared saved ratings`);
    return `${spec.name} ${spec.tap} reached ${page.url()}`;
  } finally {
    await context.close();
  }
}
