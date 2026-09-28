import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { devices, webkit } = require('playwright');

const DEVICES = [
  { name: 'iPhone 13', standalone: true, tap: 'sign-in' },
  { name: 'iPad Pro 11', standalone: false, tap: 'reload' },
];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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

async function signedIn(browser, spec, baseUrl, evidenceDir) {
  const context = await browser.newContext({ ...devices[spec.name] });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/?e2e`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const text = document.getElementById('status-banner')?.textContent || '';
      return text.includes('Last updated');
    }, { timeout: 30000 });
    const text = await page.locator('#status-banner').innerText();
    if (/sign in/i.test(text)) throw new Error(`${spec.name} signed-in banner asked to sign in`);
    await page.screenshot({ path: `${evidenceDir}/webkit-${slug(spec.name)}.png` });
    return `${spec.name} signed in`;
  } finally {
    await context.close();
  }
}

async function denied(browser, spec, baseUrl, evidenceDir) {
  const context = await browser.newContext({ ...devices[spec.name] });
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
    await page.screenshot({ path: `${evidenceDir}/webkit-${slug(spec.name)}-auth.png` });
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

export async function driveWebkitDevices({ baseUrl, evidenceDir }) {
  mkdirSync(evidenceDir, { recursive: true });
  let browser;
  try {
    browser = await webkit.launch();
  } catch (error) {
    throw new Error(`WebKit did not launch. From frontend run npx playwright install webkit. ${error instanceof Error ? error.message : error}`);
  }
  try {
    const notes = [];
    for (const spec of DEVICES) {
      if (!devices[spec.name]) throw new Error(`Playwright has no ${spec.name} descriptor`);
      notes.push(await signedIn(browser, spec, baseUrl, evidenceDir));
      notes.push(await denied(browser, spec, baseUrl, evidenceDir));
    }
    return notes.join('; ');
  } finally {
    await browser.close();
  }
}
