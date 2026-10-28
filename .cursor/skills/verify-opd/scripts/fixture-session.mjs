import { FIXTURE_COOKIE } from './fixtures.mjs';
import { freezeFixtureClock } from './fixture-clock.mjs';
import { closeBrowser } from '../../../../frontend/test/close-browser.mjs';

const fixtureBrowsers = new Set();
const closingBrowsers = new WeakMap();

export function closeFixtureBrowsers() {
  return Promise.allSettled([...fixtureBrowsers].map((browser) => {
    if (!closingBrowsers.has(browser)) {
      closingBrowsers.set(browser, closeBrowser({ browser }, 'verify fixture').finally(() => fixtureBrowsers.delete(browser)));
    }
    return closingBrowsers.get(browser);
  }));
}

export function fixtureCookie(baseUrl, token) {
  return { name: FIXTURE_COOKIE, value: token, url: baseUrl };
}

export async function pinFixtureCookie(send, baseUrl, token) {
  if (!token) return;
  await send('Network.enable');
  await send('Network.setCookie', fixtureCookie(baseUrl, token));
}

export async function createDeviceContext(browser, descriptor, { baseUrl, token, cookies = [], startOffset = 0 } = {}) {
  fixtureBrowsers.add(browser);
  browser.once?.('disconnected', () => fixtureBrowsers.delete(browser));
  const context = await browser.newContext({ ...descriptor, serviceWorkers: 'block' });
  const jar = [...cookies];
  if (token) jar.push(fixtureCookie(baseUrl, token));
  if (jar.length) await context.addCookies(jar);
  if (Number.isFinite(startOffset) && startOffset !== 0) {
    await context.addInitScript({ content: `(${freezeFixtureClock.toString()})(Date.now() + ${JSON.stringify(startOffset)}); Date.now = () => globalThis.__opdRealNow() + ${JSON.stringify(startOffset)};` });
  }
  return context;
}
