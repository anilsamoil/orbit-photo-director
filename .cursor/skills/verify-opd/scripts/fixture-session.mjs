import { FIXTURE_COOKIE } from './fixtures.mjs';

export function fixtureCookie(baseUrl, token) {
  return { name: FIXTURE_COOKIE, value: token, url: baseUrl };
}

export async function pinFixtureCookie(send, baseUrl, token) {
  if (!token) return;
  await send('Network.enable');
  await send('Network.setCookie', fixtureCookie(baseUrl, token));
}

export async function createDeviceContext(browser, descriptor, { baseUrl, token, cookies = [] } = {}) {
  const context = await browser.newContext({ ...descriptor, serviceWorkers: 'block' });
  const jar = [...cookies];
  if (token) jar.push(fixtureCookie(baseUrl, token));
  if (jar.length) await context.addCookies(jar);
  return context;
}
