import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { chromium, devices, webkit } = require('playwright');

const STANDALONE_INIT = `Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });`;

const desktopChrome = devices['Desktop Chrome'];
export const DESKTOP_CHROME_SPEC = {
  name: 'Desktop Chrome',
  descriptor: {
    ...desktopChrome,
    viewport: { width: 1400, height: 900 },
  },
};

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

export function deviceDescriptor(spec) {
  const known = devices[spec.name];
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

function chromeExecutable() {
  if (process.env.OPD_VERIFY_CHROME) return process.env.OPD_VERIFY_CHROME;
  if (existsSync('/usr/bin/google-chrome-stable')) return '/usr/bin/google-chrome-stable';
  if (existsSync('/usr/bin/google-chrome')) return '/usr/bin/google-chrome';
  return 'google-chrome';
}

export async function launchChrome() {
  return chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

function contextDescriptor(spec) {
  if (spec.descriptor) return spec.descriptor;
  return deviceDescriptor(spec);
}

export async function openDeviceContext(browser, spec, hooks = {}) {
  const descriptor = contextDescriptor(spec);
  const context = await browser.newContext({ ...descriptor });
  const initScripts = [...(hooks.initScripts || [])];
  if (spec.standalone && !initScripts.includes(STANDALONE_INIT)) initScripts.unshift(STANDALONE_INIT);
  for (const source of initScripts) await context.addInitScript(source);
  const page = await context.newPage();
  const requestHandlers = [...(hooks.requestHandlers || [])];
  for (const handler of requestHandlers) page.on('request', handler);
  return { browser, context, page, spec, descriptor, initScripts, requestHandlers };
}

async function capturePage(page) {
  const url = page.url();
  let storage = { local: {}, session: {} };
  try {
    storage = await page.evaluate(() => {
      const copy = (store) => {
        const out = {};
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          out[key] = store.getItem(key);
        }
        return out;
      };
      return { local: copy(localStorage), session: copy(sessionStorage) };
    });
  } catch {
    storage = { local: {}, session: {} };
  }
  let cookies = [];
  try {
    cookies = await page.context().cookies();
  } catch {
    cookies = [];
  }
  return { url, storage, cookies };
}

function specForMetrics(session, params) {
  if (!Number.isFinite(params.width) || !Number.isFinite(params.height)) {
    throw new Error(`context size needs width and height, got ${params.width}x${params.height}`);
  }
  const mobile = typeof params.mobile === 'boolean' ? params.mobile : Boolean(session.descriptor.isMobile);
  const deviceScaleFactor = mobile
    ? session.descriptor.deviceScaleFactor
    : (params.deviceScaleFactor ?? session.descriptor.deviceScaleFactor);
  const viewport = { width: params.width, height: params.height };
  if (!mobile) {
    return {
      name: session.spec.name,
      descriptor: {
        userAgent: session.descriptor.userAgent,
        viewport,
        deviceScaleFactor,
        isMobile: false,
        hasTouch: false,
      },
    };
  }
  return {
    name: session.spec.name,
    slug: session.spec.slug,
    standalone: Boolean(session.spec.standalone),
    tap: session.spec.tap,
    viewport,
    deviceScaleFactor,
  };
}

async function restorePage(session, snapshot) {
  if (!snapshot.url || snapshot.url === 'about:blank') return;
  if (snapshot.cookies.length) await session.context.addCookies(snapshot.cookies);
  const stored = Object.keys(snapshot.storage.local).length + Object.keys(snapshot.storage.session).length;
  if (stored) {
    await session.page.addInitScript((storage) => {
      for (const [key, value] of Object.entries(storage.local)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(storage.session)) sessionStorage.setItem(key, value);
    }, snapshot.storage);
  }
  await session.page.goto(snapshot.url, { waitUntil: 'domcontentloaded' });
}

export async function replaceDeviceContext(session, params) {
  const snapshot = await capturePage(session.page);
  const spec = specForMetrics(session, params);
  const opened = await openDeviceContext(session.browser, spec, {
    initScripts: session.initScripts,
    requestHandlers: session.requestHandlers,
  });
  const previous = session.context;
  session.context = opened.context;
  session.page = opened.page;
  session.spec = opened.spec;
  session.descriptor = opened.descriptor;
  session.initScripts = opened.initScripts;
  await previous.close();
  await restorePage(session, snapshot);
}

export async function readContextMetrics(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  }));
}

export function playwrightSend(session) {
  return async function send(method, params = {}) {
    if (method === 'Emulation.setDeviceMetricsOverride') {
      await replaceDeviceContext(session, params);
      return {};
    }
    const page = session.page;
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
      session.initScripts.push(params.source);
      await page.addInitScript(params.source);
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
  const session = await openDeviceContext(browser, spec);
  await session.context.addCookies([{ name: 'opd-verify-session', value: 'deny', url: baseUrl }]);
  const page = session.page;
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
    await session.context.close();
  }
}
