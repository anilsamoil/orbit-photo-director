import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));

export const SAFE_AREA_SIZES = [
  { width: 719, height: 521 },
  { width: 800, height: 600 },
  { width: 430, height: 400 },
  { width: 719, height: 400 },
  { width: 874, height: 402 },
];

export const SAFE_AREA_INSET_SETS = [
  { name: 'prove', top: 24, right: 0, bottom: 20, left: 47 },
  { name: 'left-47', top: 24, right: 20, bottom: 47, left: 47 },
];

const LEFT_CHROME = [
  { name: 'zoom stack', selector: '.maplibregl-ctrl-top-left' },
  { name: 'compass', selector: '.maplibregl-ctrl-compass' },
  { name: 'time strip', selector: '.map-command' },
];

export function safeAreaChromeFailures({ controls, banner, viewportHeight, insets }) {
  const failures = [];
  for (const control of controls) {
    if (!control || !(control.width > 0) || !(control.height > 0)) continue;
    if (control.left < insets.left - 0.5) {
      failures.push(`${control.name} x=${Math.round(control.left)} inside left inset ${insets.left}`);
    }
  }
  if (banner && banner.height > 0 && banner.bottom > viewportHeight - insets.bottom + 0.5) {
    failures.push(`status banner bottom=${Math.round(banner.bottom)} over bottom inset ${insets.bottom}`);
  }
  return failures;
}

export function hitOwnershipFailures(hits, insets) {
  const failures = [];
  const span = (insets?.top || 0) + (insets?.right || 0) + (insets?.bottom || 0) + (insets?.left || 0);
  if (!(span > 0)) failures.push('hit ownership requires a nonzero inset');
  for (const hit of hits || []) {
    if (!hit.owned) failures.push(`${hit.name} hit ${hit.hit || 'nothing'}`);
  }
  return failures;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

async function readSample(page, insets) {
  return page.evaluate((expected) => {
    const box = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.paddingTop = 'env(safe-area-inset-top, 0px)';
    probe.style.paddingRight = 'env(safe-area-inset-right, 0px)';
    probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
    probe.style.paddingLeft = 'env(safe-area-inset-left, 0px)';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const side = (name) => Math.round(Number.parseFloat(style[name]) || 0);
    const env = { top: side('paddingTop'), right: side('paddingRight'), bottom: side('paddingBottom'), left: side('paddingLeft') };
    probe.remove();
    window.__opdSyncMapChrome?.();
    const owns = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return { name: selector, owned: false, hit: 'missing' };
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return { name: selector, owned: false, hit: 'box' };
      const node = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const owned = !!node && (node === el || el.contains(node));
      return { name: selector, owned, hit: node ? (node.id || node.getAttribute('aria-label') || node.className || node.tagName) : 'nothing' };
    };
    return {
      env,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      controls: [
        { name: 'zoom stack', ...box(document.querySelector('.maplibregl-ctrl-top-left')) },
        { name: 'compass', ...box(document.querySelector('.maplibregl-ctrl-compass')) },
        { name: 'time strip', ...box(document.querySelector('.map-command')) },
      ],
      banner: box(document.getElementById('status-banner')),
      hits: [
        '.maplibregl-ctrl-zoom-in',
        '.maplibregl-ctrl-zoom-out',
        '.maplibregl-ctrl-compass',
        '#map-legend-toggle',
        '#map-chrome-toggle',
        '#time-slider',
        '#time-back-90',
        '#time-fwd-90',
        '#filter-launches-map',
        '#bearing-north',
      ].map(owns),
      slotted: document.body.classList.contains('map-slot-time'),
      expected,
    };
  }, insets);
}

async function showChrome(page) {
  await page.waitForFunction(() => {
    const text = document.getElementById('status-banner')?.textContent || '';
    return text.length > 0 && !text.includes('Loading');
  }, null, { timeout: 30000 });
  await page.waitForSelector('#map-chrome-toggle', { timeout: 30000 });
  const label = await page.locator('#map-chrome-toggle').innerText();
  if (/Controls/.test(label)) await page.locator('#map-chrome-toggle').click();
  await page.waitForFunction(() => {
    const shown = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return getComputedStyle(el).display !== 'none' && rect.width > 1 && rect.height > 1;
    };
    return shown('.maplibregl-ctrl-top-left') && shown('.maplibregl-ctrl-compass') && shown('.map-command');
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => typeof window.__opdSyncMapChrome === 'function', null, { timeout: 30000 });
  await page.evaluate(() => window.__opdSyncMapChrome());
}

export async function driveMapSafeArea({ baseUrl, evidenceDir }) {
  mkdirSync(evidenceDir, { recursive: true });
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const lines = [];
  const failures = [];
  try {
    for (const insets of SAFE_AREA_INSET_SETS) {
      for (const size of SAFE_AREA_SIZES) {
        const label = `${size.width}x${size.height} ${insets.name} top/right/bottom/left ${insets.top}/${insets.right}/${insets.bottom}/${insets.left}`;
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          screen: { width: size.width, height: size.height },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        try {
          const client = await context.newCDPSession(page);
          try {
            await client.send('Emulation.setSafeAreaInsetsOverride', {
              insets: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${label} Emulation.setSafeAreaInsetsOverride rejected: ${message}`);
          }
          await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await showChrome(page);
          await page.waitForFunction(() => document.body.classList.contains('map-slot-owned'), null, { timeout: 5000 });
          await page.evaluate(() => window.__opdSyncMapChrome());
          await page.waitForTimeout(300);
          const sample = await readSample(page, insets);
          const env = sample.env;
          if (env.top !== insets.top || env.right !== insets.right || env.bottom !== insets.bottom || env.left !== insets.left) {
            throw new Error(`${label} env() is ${env.top}/${env.right}/${env.bottom}/${env.left}`);
          }
          if (sample.viewport.width !== size.width || sample.viewport.height !== size.height) {
            throw new Error(`${label} opened at ${sample.viewport.width}x${sample.viewport.height}`);
          }
          const controls = LEFT_CHROME.map((entry) => sample.controls.find((control) => control.name === entry.name));
          for (const control of controls) {
            if (!control || !(control.width > 0)) throw new Error(`${label} missing ${control?.name || 'control'}`);
          }
          if (!sample.banner || !(sample.banner.height > 0)) throw new Error(`${label} missing status banner`);
          const named = [
            ...safeAreaChromeFailures({
              controls,
              banner: sample.banner,
              viewportHeight: sample.viewport.height,
              insets,
            }),
            ...hitOwnershipFailures(sample.hits, insets),
          ];
          const zoom = controls[0];
          const compass = controls[1];
          const strip = controls[2];
          lines.push(`${label} zoom x=${round(zoom.left)} compass x=${round(compass.left)} time x=${round(strip.left)} banner bottom=${round(sample.banner.bottom)} viewport ${sample.viewport.height} slotted ${sample.slotted}`);
          for (const failure of named) failures.push(`${label} ${failure}`);
          const shotName = `map-safe-area-${size.width}x${size.height}-${insets.name}.png`;
          await page.screenshot({ path: resolve(evidenceDir, shotName) });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(resolve(evidenceDir, 'map-safe-area.txt'), `${lines.join('\n')}\n`);
  for (const line of lines) console.log(line);
  if (failures.length) throw new Error(['map-safe-area fail', ...failures].join('\n'));
  return 'map-safe-area pass';
}
