import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../package.json'));
const { webkit, devices } = require('playwright');

const base = process.env.OPD_VERIFY_BASE || 'http://127.0.0.1:41731';
const out = process.env.OPD_TOPBAR_OUT || '/tmp/opd-topbar-reach';
mkdirSync(out, { recursive: true });

const NAME = 'anilsamoilenko-astro';
const iphone13 = devices['iPhone 13'];
const ipad = devices['iPad Pro 11'];

const surfaces = [
  { slug: 'iphone-17-pro', width: 402, height: 874, dpr: 3, userAgent: iphone13.userAgent },
  { slug: 'iphone-17-pro-land', width: 874, height: 402, dpr: 3, userAgent: iphone13.userAgent },
  { slug: 'iphone-13', width: 390, height: 844, dpr: 3, userAgent: iphone13.userAgent },
  { slug: 'iphone-13-land', width: 844, height: 390, dpr: 3, userAgent: iphone13.userAgent },
  { slug: 'ipad-pro-11', width: ipad.viewport.width, height: ipad.viewport.height, dpr: ipad.deviceScaleFactor, userAgent: ipad.userAgent },
  { slug: 'desktop', width: 1400, height: 900, dpr: 1, userAgent: devices['Desktop Chrome'].userAgent, mobile: false },
];

function reach() {
  const bar = document.querySelector('.topbar');
  const badge = document.getElementById('profile-badge');
  if (!bar || !badge || badge.hidden || !badge.textContent.includes('anilsamoilenko')) return null;
  const selectors = ['#tab-queue', '#tab-upcoming', '#tab-map', '#tab-profile', '#tab-log', '#kp-widget', '#profile-badge'];
  const targets = selectors.map((sel) => document.querySelector(sel)).filter((el) => el && !el.hidden && getComputedStyle(el).display !== 'none');
  const misses = [];
  for (const el of targets) {
    bar.scrollLeft = 0;
    let rect = el.getBoundingClientRect();
    const start = bar.getBoundingClientRect();
    if (rect.left < start.left - 1 || rect.right > start.right + 1) {
      bar.scrollLeft += rect.left - start.left;
      rect = el.getBoundingClientRect();
    }
    const current = bar.getBoundingClientRect();
    const fully = rect.width >= 44 && rect.height >= 44 && rect.left >= current.left - 1 && rect.right <= current.right + 1;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 22));
    const owner = hit?.closest('#tab-queue, #tab-upcoming, #tab-map, #tab-profile, #tab-log, #kp-widget, #profile-badge');
    if (!fully || owner !== el) {
      misses.push({
        id: el.id,
        fully,
        hit: owner?.id || hit?.className || null,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        barRight: Math.round(current.right),
        scroll: bar.scrollLeft,
      });
    }
  }
  const nodes = [...bar.children].filter((el) => !el.hidden && getComputedStyle(el).display !== 'none');
  const overlaps = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i].getBoundingClientRect();
      const b = nodes[j].getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 1 && iy > 1) overlaps.push([nodes[i].id || nodes[i].className, nodes[j].id || nodes[j].className, Math.round(ix)]);
    }
  }
  if (misses.length || overlaps.length) return { misses, overlaps, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
  return { ok: true, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
}

const browser = await webkit.launch();
const failures = [];
try {
  for (const surface of surfaces) {
    const context = await browser.newContext({
      viewport: { width: surface.width, height: surface.height },
      deviceScaleFactor: surface.dpr,
      isMobile: surface.mobile !== false,
      hasTouch: surface.mobile !== false,
      userAgent: surface.userAgent,
    });
    const page = await context.newPage();
    await page.route('**/api/browser/session', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, profile: { name: 'anil', displayName: NAME } }),
    }));
    await page.goto(`${base}/?u=anil`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const badge = document.getElementById('profile-badge');
      const iss = document.getElementById('iss-now');
      const kp = document.getElementById('kp-widget');
      return badge?.textContent?.includes('anilsamoilenko')
        && iss && !iss.hidden && /^ISS\d/.test(iss.textContent || '')
        && kp && !kp.hidden;
    }, { timeout: 20000 });
    const result = await page.evaluate(reach);
    const line = `${surface.slug} ${JSON.stringify(result)}`;
    console.log(line);
    if (!result?.ok) failures.push(surface.slug);
    await page.screenshot({ path: resolve(out, `${surface.slug}.png`) });
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`topbar reach failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('topbar reach ok');
