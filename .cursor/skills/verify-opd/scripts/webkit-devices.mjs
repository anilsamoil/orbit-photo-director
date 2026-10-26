import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { installOneShotClock } from './fixture-clock.mjs';

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
  const base = spec.descriptor || devices[spec.name] || devices[spec.deviceBase]
    || (spec.name === 'iPhone 17 Pro' ? devices['iPhone 13'] : null);
  if (!base?.viewport) throw new Error(`Playwright has no ${spec.name} descriptor`);
  const descriptor = structuredClone(base);
  if (spec.viewport) descriptor.viewport = { ...spec.viewport };
  if (spec.deviceScaleFactor !== undefined) descriptor.deviceScaleFactor = spec.deviceScaleFactor;
  if (!spec.descriptor && !descriptor.screen) descriptor.screen = { ...descriptor.viewport };
  return descriptor;
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
  const descriptor = deviceDescriptor(spec);
  for (const key of ['viewport', 'screen']) {
    for (const dimension of ['width', 'height']) {
      if (!Number.isInteger(descriptor[key]?.[dimension]) || descriptor[key][dimension] <= 0) {
        throw new Error(`device descriptor needs ${key}.${dimension}`);
      }
    }
  }
  for (const key of ['isMobile', 'hasTouch']) {
    if (typeof descriptor[key] !== 'boolean') throw new Error(`device descriptor needs ${key}`);
  }
  if (!Number.isFinite(descriptor.deviceScaleFactor) || descriptor.deviceScaleFactor <= 0) {
    throw new Error('device descriptor needs deviceScaleFactor');
  }
  for (const key of ['userAgent', 'defaultBrowserType']) {
    if (typeof descriptor[key] !== 'string' || !descriptor[key]) throw new Error(`device descriptor needs ${key}`);
  }
  return descriptor;
}

function freezeDescriptor(descriptor) {
  for (const value of Object.values(descriptor)) {
    if (value && typeof value === 'object') freezeDescriptor(value);
  }
  return Object.freeze(descriptor);
}

function disclosureApi() {
  function summaryText(el) {
    return el.querySelector(':scope > summary')?.textContent?.trim() || '';
  }

  function ownerId(el) {
    return el.parentElement?.closest('[id]')?.id || '';
  }

  function explicitToken(el) {
    if (el.id) return `id:${el.id}`;
    const control = el.getAttribute('data-opd-control');
    if (control) return `control:${control}`;
    const names = el.getAttributeNames().filter((name) => name.startsWith('data-') && el.getAttribute(name) === '').sort();
    if (!names.length) return '';
    return `data:${names.join('&')}`;
  }

  function roleToken(el) {
    const classes = [...el.classList].filter(Boolean).sort();
    return classes.length ? `role:${classes.join('.')}` : 'role:details';
  }

  function identityOf(el) {
    const owner = ownerId(el);
    const explicit = explicitToken(el);
    if (explicit) return `${explicit}@${owner}`;
    const role = roleToken(el);
    const scope = owner ? document.getElementById(owner) : document;
    const peers = [...(scope?.querySelectorAll('details') || [])].filter((entry) => (
      ownerId(entry) === owner && !explicitToken(entry) && roleToken(entry) === role
    ));
    return `${role}@${owner}#${peers.indexOf(el)}`;
  }

  function find(saved) {
    if (!saved?.key) return null;
    return [...document.querySelectorAll('details')].find((el) => identityOf(el) === saved.key) || null;
  }

  function retired(saved) {
    if (!saved || find(saved)) return false;
    if (!saved.ownerId) return false;
    const owner = document.getElementById(saved.ownerId);
    if (!owner) return false;
    const replacements = [...owner.querySelectorAll('details')].filter((el) => (
      ownerId(el) === saved.ownerId && identityOf(el) !== saved.key
    ));
    if (!replacements.length) return false;
    const summary = saved.summary || '';
    if (summary && replacements.some((el) => summaryText(el) === summary)) return false;
    return true;
  }

  function capture(el) {
    if (el.classList.contains('maplibregl-ctrl-attrib')) return null;
    return { key: identityOf(el), ownerId: ownerId(el), summary: summaryText(el), open: el.open };
  }

  return { capture, find, retired };
}

const DISCLOSURE_BOOT = `window.__opdDisclosure = (${disclosureApi.toString()})();`;

export async function openDeviceContext(browser, spec, hooks = {}) {
  const baseDescriptor = hooks.baseDescriptor || freezeDescriptor(contextDescriptor(spec));
  const descriptor = freezeDescriptor({
    ...baseDescriptor,
    viewport: { ...(spec.viewport || baseDescriptor.viewport) },
  });
  const context = await browser.newContext({
    ...descriptor,
    serviceWorkers: 'block',
    ...(hooks.storageState ? { storageState: hooks.storageState } : {}),
  });
  try {
    const initScripts = (hooks.initScripts || []).filter((source) => source !== STANDALONE_INIT);
    if (spec.standalone) initScripts.unshift(STANDALONE_INIT);
    if (!initScripts.includes(DISCLOSURE_BOOT)) initScripts.push(DISCLOSURE_BOOT);
    for (const source of initScripts) await context.addInitScript(source);
    const page = await context.newPage();
    const requestHandlers = [...(hooks.requestHandlers || [])];
    for (const handler of requestHandlers) page.on('request', handler);
    return { browser, context, page, spec: freezeDescriptor(structuredClone(spec)), baseDescriptor, descriptor, initScripts, requestHandlers };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function metricsMatch(session, params) {
  if (!Number.isFinite(params.width) || !Number.isFinite(params.height)) return false;
  const viewport = session.descriptor.viewport || {};
  if (viewport.width !== params.width || viewport.height !== params.height) return false;
  if (!params.deviceSpec) return true;
  return Boolean(params.deviceSpec.standalone) === Boolean(session.spec.standalone)
    && isDeepStrictEqual({ ...contextDescriptor(params.deviceSpec), viewport }, session.descriptor);
}

async function capturePage(page) {
  const url = page.url();
  let storage = { session: {} };
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
      return { session: copy(sessionStorage) };
    });
  } catch {
    storage = { session: {} };
  }
  const pose = await page.evaluate(async () => {
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
      // This is the local Vite verification harness. Use the app's existing
      // clock accessor so a scrub retains its absolute instant, not a rounded
      // slider minute that would creep forwards on every replacement.
      const viteApp = !!document.querySelector('script[type="module"][src*="/src/main.ts"]');
      let viewTimeMs = null;
      if (viteApp && map) {
        const clock = await import('/src/map/features/time-scrub/index.ts');
        viewTimeMs = clock._getViewTimeMsForTest();
      }
      const slider = document.getElementById('time-slider');
      const follow = document.getElementById('toggle-follow-iss');
      const followPressed = follow?.getAttribute('aria-pressed');
      if (!window.__opdDisclosure) throw new Error('disclosure identity missing');
      const details = [...document.querySelectorAll('details')].flatMap((el) => {
        const saved = window.__opdDisclosure.capture(el);
        return saved ? [saved] : [];
      });
      const scene = document.querySelector('[data-iss-scene]');
      const picker = document.querySelector('[data-iss-launch-picker]');
      return {
        view,
        viteApp,
        chromeShown: !document.body.classList.contains('map-chrome-hidden'),
        shotlist: document.body.classList.contains('shotlist-bar-visible'),
        legendOpen: document.getElementById('map-legend-toggle')?.getAttribute('aria-expanded') === 'true',
        details,
        expanded: [...document.querySelectorAll('[id][aria-expanded][aria-controls]')].map((el) => ({ id: el.id, open: el.getAttribute('aria-expanded') === 'true' })),
        aimHelpOpen: document.querySelector('[data-iss-aim-help]')?.getAttribute('aria-expanded') === 'true',
        follow: followPressed === 'true' ? true : followPressed === 'false' ? false : null,
        time: slider && map ? {
          minutes: Number(slider.value),
          live: !document.getElementById('time-slider-readout')?.classList.contains('time-slider-scrubbed'),
          viewTimeMs,
          viteApp,
        } : null,
        telemetryOpen: document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'true',
        fullscreen: !!(scene && scene.hasAttribute('data-iss-fullscreen-active')),
        launchValue: picker instanceof HTMLSelectElement ? picker.value : '',
        frozenNow: typeof window.__opdRealNow === 'function' && Date.now !== window.__opdRealNow ? Date.now() : null,
        fovWatch: typeof window.__opdFovWatch === 'object' && window.__opdFovWatch !== null,
        camera,
        issCamera,
      };
    });
  const storageState = await page.context().storageState();
  return { url, storage, storageState, pose };
}

function specForMetrics(session, params) {
  if (!Number.isInteger(params.width) || params.width <= 0 || !Number.isInteger(params.height) || params.height <= 0) {
    throw new Error(`context size needs width and height, got ${params.width}x${params.height}`);
  }
  const viewport = { width: params.width, height: params.height };
  const spec = params.deviceSpec || session.spec;
  return {
    ...spec,
    descriptor: params.deviceSpec ? contextDescriptor(spec) : session.baseDescriptor,
    viewport,
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

async function restoreMapClockAndFollow(page, pose) {
  await page.evaluate(async ({ follow, time }) => {
    const toggle = document.getElementById('toggle-follow-iss');
    if (typeof follow === 'boolean' && toggle
      && (toggle.getAttribute('aria-pressed') === 'true') !== follow) toggle.click();
    if (!time) return;
    if (time.viteApp) {
      const clock = await import('/src/map/features/time-scrub/index.ts');
      const now = Date.now;
      const minutes = time.live ? 0 : Math.max(1, time.minutes);
      try {
        // setLookahead accepts whole minutes. Anchor its calculation at the
        // captured instant, then immediately restore the real/fixture clock.
        if (!time.live && Number.isFinite(time.viewTimeMs)) {
          Date.now = () => time.viewTimeMs - minutes * 60_000;
        }
        clock.setLookahead(minutes, false);
      } finally {
        Date.now = now;
      }
      clock.updateTimeStepLabels();
    } else {
      const slider = document.getElementById('time-slider');
      if (time.live) document.getElementById('time-now')?.click();
      else if (slider) {
        slider.value = String(time.minutes);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }, pose);
  // Drain the slider's RAF and any follow/recenter animation before replaying
  // the captured camera. Otherwise the very next app tick can undo the pose.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function renderedFrame(page, view) {
  await page.evaluate((activeView) => new Promise((done, reject) => {
    const map = activeView === 'view-iss' ? window.__opdIss : window.__opdMap;
    const cleanup = () => {
      clearTimeout(timer);
      map.off('render', painted);
    };
    const painted = () => {
      // A render event also fires for a clear-only frame while the restored
      // camera's tiles are pending. Wait for MapLibre's loaded lifecycle;
      // settled tile failures count as loaded, so this does not require every
      // remote imagery request to succeed.
      if (!map.loaded()) return;
      const canvas = map.getCanvas();
      const gl = map.painter?.context?.gl;
      cleanup();
      if (!canvas?.width || !canvas?.height || !gl || gl.isContextLost()) {
        reject(new Error(`${activeView} renderer has no live drawing buffer`));
      } else requestAnimationFrame(() => done());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${activeView} renderer did not finish painting`));
    }, 30000);
    map.on('render', painted);
    map.triggerRepaint();
  }), view);
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
  // SNAP keeps the Map instance while another tab is open. Rebuild that
  // off-tab state too, then return to the captured active tab.
  if (pose.view !== 'view-map' && pose.camera) await applyPose(page, { ...pose, view: 'view-map' });
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
      if (!map || !canvas || !map.getLayer('iss-track-layer') || !document.querySelector('.iss-marker') || !document.querySelector('.map-legend')) return { step: 'map' };
      return { ok: true };
    }, 'map after context replace', 45000);
    await restoreMapClockAndFollow(page, pose);
    if (pose.camera) {
      await page.evaluate((camera) => {
        const map = window.__opdMap;
        if (map && map.jumpTo) {
          map.stop();
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
      const renderer = window.__opdIss;
      const canvas = renderer?.getCanvas();
      if (scene.getAttribute('data-iss-phase') !== 'running' || !canvas?.width || !canvas?.height
        || document.querySelector('[data-iss-fov]')?.getAttribute('data-iss-fov-state') !== 'live') {
        return { step: 'renderer', phase: scene.getAttribute('data-iss-phase') };
      }
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
          const frame = document.querySelector('[data-iss-frame]');
          const current = map?.getVerticalFieldOfView();
          if (frame && Number.isFinite(current)) {
            // Replay the control, not just the renderer property: SNAP's next
            // timer tick reads its optical-FOV state and must keep this value.
            frame.dispatchEvent(new WheelEvent('wheel', {
              deltaY: Math.log(expected / current) / 0.0015,
              bubbles: true,
              cancelable: true,
            }));
          }
        }, fov);
        await pollPage(page, (expected) => {
          const current = window.__opdIss && window.__opdIss.getVerticalFieldOfView ? window.__opdIss.getVerticalFieldOfView() : null;
          return Number.isFinite(current) && Math.abs(current - expected) <= 0.5 ? { ok: true, current } : { current };
        }, 'iss fov after context replace', 10000, fov);
      }
    }
    const fullscreenHeld = await page.evaluate(() => !!document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-fullscreen-active'));
    if (fullscreenHeld !== pose.fullscreen) await clickSelector(page, '[data-iss-fullscreen]');
    await pollPage(page, (expected) => ({
      ok: !!document.querySelector('[data-iss-scene]')?.hasAttribute('data-iss-fullscreen-active') === expected,
    }), 'iss fullscreen after context replace', 10000, pose.fullscreen);
    const telemetryHeld = await page.evaluate(() => document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'true');
    if (telemetryHeld !== pose.telemetryOpen) await clickSelector(page, '[data-iss-telemetry]');
    await pollPage(page, (expected) => ({
      ok: (document.querySelector('[data-iss-telemetry]')?.getAttribute('aria-expanded') === 'true') === expected,
    }), 'iss telemetry after context replace', 10000, pose.telemetryOpen);
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
  await restoreDisclosures(page, pose);
  await page.evaluate((visible) => document.body.classList.toggle('shotlist-bar-visible', visible), Boolean(pose.shotlist));
  if (pose.view === 'view-map' || pose.view === 'view-iss') await renderedFrame(page, pose.view);
}

async function restoreDisclosures(page, pose) {
  if (!pose) return;
  await page.evaluate((expanded) => {
    for (const saved of expanded || []) {
      const el = document.getElementById(saved.id);
      if (el && (el.getAttribute('aria-expanded') === 'true') !== saved.open) el.click();
    }
  }, pose.expanded);
  await page.evaluate((details) => {
    if (!window.__opdDisclosure) throw new Error('disclosure identity missing');
    for (const saved of details || []) {
      const el = window.__opdDisclosure.find(saved);
      if (el instanceof HTMLDetailsElement) el.open = saved.open;
    }
  }, pose.details);
  // Other control clicks dismiss the ISS shortcut sheet, so reopen it last.
  if (pose.view === 'view-iss') {
    const helpOpen = await page.evaluate(() => document.querySelector('[data-iss-aim-help]')?.getAttribute('aria-expanded') === 'true');
    if (helpOpen !== pose.aimHelpOpen) await clickSelector(page, '[data-iss-aim-help]');
  }
}

async function settleFocusedPose(page, pose) {
  if (!pose) return;
  if (pose.viteApp) {
    await page.evaluate(async () => {
      // Becoming visible asks SNAP to refresh Queue/Upcoming. Join those app
      // promises before their DOM rebuild can overwrite restored disclosures.
      const [app, { launchCatalog }] = await Promise.all([
        import('/src/main.ts'), import('/src/launch-catalog.ts'),
      ]);
      await Promise.all([app.refresh(), launchCatalog.refresh()]);
      app.rerenderCountdowns();
    });
  }
  await restoreDisclosures(page, pose);
  if (pose.view === 'view-map' || pose.view === 'view-iss') await renderedFrame(page, pose.view);
  await pollPage(page, (expected) => {
    if (!window.__opdDisclosure) return { ok: false, disclosures: false, expanded: false, help: false, follow: false, live: false };
    const misses = [];
    for (const saved of expected.details || []) {
      const el = window.__opdDisclosure.find(saved);
      if (el) {
        if (!(el instanceof HTMLDetailsElement) || el.open !== saved.open) {
          misses.push({ key: saved.key, ownerId: saved.ownerId, summary: saved.summary, savedOpen: saved.open, foundOpen: el.open });
        }
      } else if (!window.__opdDisclosure.retired(saved)) {
        misses.push({ key: saved.key, ownerId: saved.ownerId, summary: saved.summary, savedOpen: saved.open, missing: true });
      }
    }
    const disclosures = misses.length === 0;
    const now = disclosures ? [] : [...document.querySelectorAll('details')].flatMap((el) => {
      const saved = window.__opdDisclosure.capture(el);
      return saved ? [saved] : [];
    });
    const expanded = (expected.expanded || []).every((saved) => {
      const el = document.getElementById(saved.id);
      return el && (el.getAttribute('aria-expanded') === 'true') === saved.open;
    });
    const help = expected.view !== 'view-iss'
      || (document.querySelector('[data-iss-aim-help]')?.getAttribute('aria-expanded') === 'true') === expected.aimHelpOpen;
    const follow = expected.follow === null
      || document.getElementById('toggle-follow-iss')?.getAttribute('aria-pressed') === String(expected.follow);
    const live = !expected.time || !document.getElementById('time-slider-readout')?.classList.contains('time-slider-scrubbed') === expected.time.live;
    return { ok: disclosures && expanded && help && follow && live, disclosures, expanded, help, follow, live, misses, now };
  }, 'restored controls before context switch', 10000, pose);
}

async function restorePage(session, snapshot) {
  if (!snapshot.url || snapshot.url === 'about:blank') return;
  // localStorage/cookies are seeded by newContext's origin-scoped storageState.
  // A disposable same-origin document seeds this tab's sessionStorage exactly once.
  // No init callback or erasable storage sentinel survives to replay it on reload.
  if (Object.keys(snapshot.storage.session).length) {
    const origin = new URL(snapshot.url).origin;
    if (origin !== 'null') {
      const bootstrapUrl = `${origin}/__opd_context_storage_bootstrap__`;
      const bootstrap = route => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">',
      });
      await session.page.route(bootstrapUrl, bootstrap);
      try {
        await session.page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded' });
        await session.page.evaluate((entries) => {
          for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
        }, snapshot.storage.session);
      } finally {
        await session.page.unroute(bootstrapUrl, bootstrap);
      }
    }
  }
  await session.page.goto(snapshot.url, { waitUntil: 'domcontentloaded' });
  await waitForContextSize(session.page, session.descriptor);
  await applyPose(session.page, snapshot.pose);
}

export async function replaceDeviceContext(session, params, signal) {
  signal?.throwIfAborted();
  if (metricsMatch(session, params)) return;
  const snapshot = await capturePage(session.page);
  signal?.throwIfAborted();
  const spec = specForMetrics(session, params);
  const opened = await openDeviceContext(session.browser, spec, {
    initScripts: session.initScripts,
    requestHandlers: session.requestHandlers,
    baseDescriptor: params.deviceSpec ? undefined : session.baseDescriptor,
    storageState: snapshot.storageState,
  });
  let closing;
  const closeCandidate = () => (closing ??= opened.context.close());
  const abortCandidate = () => { closeCandidate().catch(() => {}); };
  signal?.addEventListener('abort', abortCandidate, { once: true });
  let removeClockSeed;
  try {
    signal?.throwIfAborted();
    removeClockSeed = await installOneShotClock(opened.page, snapshot.url, snapshot.pose?.frozenNow);
    // Keep the rendered predecessor and public session untouched throughout
    // navigation, app boot, pose restoration and the final renderer frame.
    await restorePage(opened, snapshot);
    await opened.page.bringToFront();
    await settleFocusedPose(opened.page, snapshot.pose);
    if (removeClockSeed && !opened.page.isClosed()) await removeClockSeed();
    signal?.throwIfAborted();
  } catch (error) {
    await closeCandidate();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortCandidate);
  }
  const previous = session.context;
  Object.assign(session, opened);
  await previous.close();
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
  const send = async function send(method, params = {}, { signal } = {}) {
    if (method === 'Emulation.setDeviceMetricsOverride') {
      const predecessor = session.page;
      await replaceDeviceContext(session, params, signal);
      return { contextReplaced: session.page !== predecessor };
    }
    const page = session.page;
    if (method === 'Runtime.evaluate') {
      const unbounded = params.timeout === 0;
      if (unbounded) page.setDefaultTimeout(0);
      try {
        const value = await page.evaluate(params.expression);
        return { result: { value } };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { exceptionDetails: { text }, result: {} };
      } finally {
        if (unbounded) page.setDefaultTimeout(30_000);
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
  send.replacesContext = true;
  return send;
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
