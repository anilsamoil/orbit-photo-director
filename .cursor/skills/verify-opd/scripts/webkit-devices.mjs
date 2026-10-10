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
  const context = await browser.newContext({ ...descriptor, serviceWorkers: 'block' });
  const initScripts = [...(hooks.initScripts || [])];
  if (spec.standalone && !initScripts.includes(STANDALONE_INIT)) initScripts.unshift(STANDALONE_INIT);
  for (const source of initScripts) await context.addInitScript(source);
  const page = await context.newPage();
  const requestHandlers = [...(hooks.requestHandlers || [])];
  for (const handler of requestHandlers) page.on('request', handler);
  return { browser, context, page, spec, descriptor, initScripts, requestHandlers };
}

function metricsMatch(session, params) {
  if (!Number.isFinite(params.width) || !Number.isFinite(params.height)) return false;
  const mobile = typeof params.mobile === 'boolean' ? params.mobile : Boolean(session.descriptor.isMobile);
  const deviceScaleFactor = mobile
    ? session.descriptor.deviceScaleFactor
    : (params.deviceScaleFactor ?? session.descriptor.deviceScaleFactor);
  const viewport = session.descriptor.viewport || {};
  return viewport.width === params.width
    && viewport.height === params.height
    && session.descriptor.deviceScaleFactor === deviceScaleFactor
    && Boolean(session.descriptor.isMobile) === mobile;
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
  let pose = null;
  try {
    pose = await page.evaluate(() => {
      const viewEl = document.getElementById('view');
      const view = viewEl ? (viewEl.className || '').split(/\s+/).find((token) => token.startsWith('view-')) || '' : '';
      if (!view) return null;
      const map = window.__opdMap;
      let camera = null;
      if (map && map.getCenter && map.getZoom) {
        const center = map.getCenter();
        camera = {
          lng: center.lng,
          lat: center.lat,
          zoom: map.getZoom(),
          bearing: map.getBearing ? map.getBearing() : 0,
          pitch: map.getPitch ? map.getPitch() : 0,
        };
      }
      const iss = window.__opdIss;
      let issCamera = null;
      if (iss && iss.getCenter && iss.getZoom) {
        const center = iss.getCenter();
        issCamera = {
          lng: center.lng,
          lat: center.lat,
          zoom: iss.getZoom(),
          bearing: iss.getBearing ? iss.getBearing() : 0,
          pitch: iss.getPitch ? iss.getPitch() : 0,
          fov: iss.getVerticalFieldOfView ? iss.getVerticalFieldOfView() : null,
        };
      }
      const scene = document.querySelector('[data-iss-scene]');
      const picker = document.querySelector('[data-iss-launch-picker]');
      return {
        view,
        chromeShown: !document.body.classList.contains('map-chrome-hidden'),
        shotlist: document.body.classList.contains('shotlist-bar-visible'),
        legendOpen: document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true',
        telemetryOpen: document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'true',
        fullscreen: !!(scene && scene.hasAttribute('data-iss-fullscreen-active')),
        launchValue: picker instanceof HTMLSelectElement ? picker.value : '',
        frozenNow: typeof window.__opdRealNow === 'function' && Date.now !== window.__opdRealNow ? Date.now() : null,
        fovWatch: typeof window.__opdFovWatch === 'object' && window.__opdFovWatch !== null,
        camera,
        issCamera,
      };
    });
  } catch {
    pose = null;
  }
  let cookies = [];
  try {
    cookies = await page.context().cookies();
  } catch {
    cookies = [];
  }
  return { url, storage, cookies, pose };
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

const VIEW_TABS = {
  'view-queue': '#tab-queue',
  'view-upcoming': '#tab-upcoming',
  'view-map': '#tab-map',
  'view-iss': '#tab-iss',
  'view-profile': '#tab-profile',
  'view-log': '#tab-log',
};

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function pollPage(page, read, label, timeoutMs, arg) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(read, arg);
    if (last && last.ok === true) return last;
    await sleep(250);
  }
  throw new Error(`${label} timed out. Last value: ${JSON.stringify(last)}`);
}

async function matchesSoon(page, read, arg, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const last = await page.evaluate(read, arg);
    if (last && last.ok === true) return true;
    await sleep(100);
  }
  return false;
}

async function clickSelector(page, selector) {
  await page.evaluate((target) => {
    const el = document.querySelector(target);
    if (el) el.click();
  }, selector);
}

async function waitForContextSize(page, descriptor) {
  const viewport = descriptor.viewport || {};
  const expected = { width: viewport.width, height: viewport.height, deviceScaleFactor: descriptor.deviceScaleFactor };
  await pollPage(page, (size) => ({
    ok: window.innerWidth === size.width
      && window.innerHeight === size.height
      && window.devicePixelRatio === size.deviceScaleFactor,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }), `context ${viewport.width}x${viewport.height}`, 10000, expected);
}

async function applyPose(page, pose) {
  if (!pose) return;
  await pollPage(page, () => {
    const text = document.getElementById('status-banner')?.textContent || '';
    return text && !text.includes('Loading') ? { ok: true } : { text };
  }, 'snap after context replace', 30000);
  if (pose.fovWatch) {
    await page.evaluate(() => {
      if (window.__opdFovWatch) return;
      const watch = { bad: null, settled: false };
      const read = () => {
        if (watch.bad || watch.settled) return;
        const label = document.querySelector('[data-iss-fov]');
        if (!label || label.getAttribute('data-iss-fov-state') !== 'live') return;
        const text = (label.textContent || '').trim();
        const shown = Number.parseFloat(text);
        const phase = document.querySelector('[data-iss-scene]')?.getAttribute('data-iss-phase') || '';
        const map = window.__opdIss;
        const fov = map && typeof map.getVerticalFieldOfView === 'function' ? map.getVerticalFieldOfView() : null;
        const roll = map && typeof map.getRoll === 'function' ? ((map.getRoll() % 360) + 360) % 360 : null;
        const matched = text.length > 0
          && phase === 'running'
          && typeof fov === 'number' && Number.isFinite(fov)
          && Number.isFinite(shown)
          && Math.abs(shown - fov) <= 0.15
          && typeof roll === 'number' && Math.abs(roll - 180) <= 0.5;
        if (matched) watch.settled = true;
        else watch.bad = { text, shown, phase, fov, roll };
      };
      new MutationObserver(read).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const pump = () => {
        read();
        if (!watch.bad && !watch.settled) requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
      window.__opdFovWatch = watch;
    });
  }
  const tab = VIEW_TABS[pose.view];
  if (tab) {
    const current = await page.evaluate(() => {
      const view = document.getElementById('view');
      return view ? (view.className || '').split(/\s+/).find((token) => token.startsWith('view-')) || '' : '';
    });
    if (current !== pose.view) await clickSelector(page, tab);
  }
  if (pose.view === 'view-map') {
    await pollPage(page, () => {
      const map = window.__opdMap;
      const canvas = document.querySelector('#map .maplibregl-canvas');
      if (!map || !canvas || !document.querySelector('.iss-marker') || !document.querySelector('.map-legend')) return { step: 'map' };
      return { ok: true };
    }, 'map after context replace', 45000);
    if (pose.camera) {
      await page.evaluate((camera) => {
        const map = window.__opdMap;
        if (map && map.jumpTo) {
          map.jumpTo({
            center: [camera.lng, camera.lat],
            zoom: camera.zoom,
            bearing: camera.bearing,
            pitch: camera.pitch,
          });
        }
      }, pose.camera);
    }
    const chromeSettled = await matchesSoon(page, (shown) => {
      const hidden = document.body.classList.contains('map-chrome-hidden');
      return (shown ? !hidden : hidden) ? { ok: true } : null;
    }, pose.chromeShown, 2000);
    if (!chromeSettled) await clickSelector(page, '#map-chrome-toggle');
    await pollPage(page, (shown) => {
      const hidden = document.body.classList.contains('map-chrome-hidden');
      const toggle = (document.getElementById('map-chrome-toggle')?.textContent || '').trim();
      const strip = document.querySelector('.map-command');
      const zoom = document.querySelector('.maplibregl-ctrl-zoom-in');
      const step = document.getElementById('time-fwd-90');
      const stepBox = step ? step.getBoundingClientRect() : null;
      if (shown) {
        if (hidden || toggle !== 'Hide' || !strip || getComputedStyle(strip).display === 'none' || !zoom) {
          return { step: 'chrome', hidden, toggle };
        }
        if (!stepBox || stepBox.width < 8 || stepBox.height < 8) return { step: 'time' };
        return { ok: true };
      }
      if (!hidden || toggle !== 'Controls') return { step: 'hidden', hidden, toggle };
      return { ok: true };
    }, 'map chrome after context replace', 10000, pose.chromeShown);
    if (pose.legendOpen) {
      const open = await page.evaluate(() => document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true');
      if (!open) await clickSelector(page, '#map-legend-toggle');
    }
  } else if (pose.view === 'view-iss') {
    await pollPage(page, () => {
      const scene = document.querySelector('[data-iss-scene]');
      const frame = document.querySelector('[data-iss-frame]');
      const box = frame ? frame.getBoundingClientRect() : null;
      const telemetry = document.querySelector('[data-iss-telemetry]');
      const fullscreen = document.querySelector('[data-iss-fullscreen]');
      const telemetryBox = telemetry ? telemetry.getBoundingClientRect() : null;
      const fullscreenBox = fullscreen ? fullscreen.getBoundingClientRect() : null;
      if (!scene || !box || box.width < 40) return { step: 'scene' };
      if (!telemetryBox || telemetryBox.width < 8 || !fullscreenBox || fullscreenBox.width < 8) return { step: 'controls' };
      if (window.innerHeight <= 564 && !scene.hasAttribute('data-iss-short')) return { step: 'short' };
      return { ok: true };
    }, 'iss after context replace', 45000);
    if (pose.issCamera && Number.isFinite(pose.issCamera.fov)) {
      const fov = pose.issCamera.fov;
      const held = await matchesSoon(page, (expected) => {
        const current = window.__opdIss && window.__opdIss.getVerticalFieldOfView ? window.__opdIss.getVerticalFieldOfView() : null;
        return Number.isFinite(current) && Math.abs(current - expected) <= 0.5 ? { ok: true } : { current };
      }, fov, 5000);
      if (!held) {
        await page.evaluate((expected) => {
          const map = window.__opdIss;
          if (map && map.setVerticalFieldOfView) map.setVerticalFieldOfView(expected);
        }, fov);
        await pollPage(page, (expected) => {
          const current = window.__opdIss && window.__opdIss.getVerticalFieldOfView ? window.__opdIss.getVerticalFieldOfView() : null;
          return Number.isFinite(current) && Math.abs(current - expected) <= 0.5 ? { ok: true, current } : { current };
        }, 'iss fov after context replace', 10000, fov);
      }
    }
    if (pose.fullscreen) {
      const held = await page.evaluate(() => document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-fullscreen-active'));
      if (!held) await clickSelector(page, '[data-iss-fullscreen]');
      await pollPage(page, () => (
        document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-fullscreen-active') ? { ok: true } : null
      ), 'iss fullscreen after context replace', 10000);
    }
    if (pose.telemetryOpen) {
      const open = await page.evaluate(() => document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'true');
      if (!open) await clickSelector(page, '[data-iss-telemetry]');
      await pollPage(page, () => (
        document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'true' ? { ok: true } : null
      ), 'iss telemetry after context replace', 10000);
    }
    if (Number.isFinite(pose.frozenNow)) {
      await page.evaluate((frozen) => {
        if (typeof window.__opdRealNow !== 'function') window.__opdRealNow = Date.now;
        Date.now = () => frozen;
      }, pose.frozenNow);
    }
    if (pose.launchValue) {
      await page.evaluate((value) => { window.__opdRestoreLaunch = value; }, pose.launchValue);
      await pollPage(page, () => {
        const value = window.__opdRestoreLaunch;
        const picker = document.querySelector('[data-iss-launch-picker]');
        if (!(picker instanceof HTMLSelectElement)) return { step: 'picker' };
        if (!window.__opdRestoreLaunchArmed) {
          if (![...picker.options].some((entry) => entry.value === value)) return { step: 'option', count: picker.options.length };
          picker.value = value;
          picker.dispatchEvent(new Event('change', { bubbles: true }));
          window.__opdRestoreLaunchArmed = true;
        }
        if (value === 'none') return picker.value === 'none' ? { ok: true } : { step: 'none', value: picker.value };
        const card = document.querySelector('[data-iss-launch-card]');
        const name = card && card.querySelector('[data-iss-launch-name]') ? card.querySelector('[data-iss-launch-name]').textContent : '';
        if (!card || card.hasAttribute('hidden') || !name) return { step: 'card', value: picker.value };
        return { ok: true, name };
      }, 'iss launch after context replace', 15000);
    }
  } else if (tab) {
    await pollPage(page, (view) => {
      const current = (document.getElementById('view')?.className || '').split(/\s+/).find((token) => token.startsWith('view-')) || '';
      return current === view ? { ok: true } : { current };
    }, `${pose.view} after context replace`, 20000, pose.view);
  }
  if (pose.shotlist) {
    await page.evaluate(() => document.body.classList.add('shotlist-bar-visible'));
  }
}

async function restorePage(session, snapshot) {
  if (!snapshot.url || snapshot.url === 'about:blank') return;
  if (snapshot.cookies.length) await session.context.addCookies(snapshot.cookies);
  const stored = Object.keys(snapshot.storage.local).length + Object.keys(snapshot.storage.session).length;
  if (stored) {
    await session.page.addInitScript((storage) => {
      if (sessionStorage.getItem('__opdContextStorage') === '1') return;
      for (const [key, value] of Object.entries(storage.local)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(storage.session)) {
        if (key === '__opdContextStorage') continue;
        sessionStorage.setItem(key, value);
      }
      sessionStorage.setItem('__opdContextStorage', '1');
    }, snapshot.storage);
  }
  await session.page.goto(snapshot.url, { waitUntil: 'domcontentloaded' });
  await waitForContextSize(session.page, session.descriptor);
  await applyPose(session.page, snapshot.pose);
}

export async function replaceDeviceContext(session, params) {
  if (metricsMatch(session, params)) return;
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
