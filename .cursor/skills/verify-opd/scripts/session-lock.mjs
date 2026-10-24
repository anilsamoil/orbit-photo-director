import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deviceDescriptor, launchWebkit } from './webkit-devices.mjs';

export const SESSION_LOCK_SURFACES = [
  { id: 'webkit-iphone-17-pro-402x874', surface: 'iphone-17-pro', width: 402, height: 874, scale: 3, standalone: true },
  { id: 'webkit-ipad-m4-834x1210', surface: 'ipad-pro-11', width: 834, height: 1210, scale: 2, standalone: false },
];

const LOCKS = ['banner', 'profile', 'queue'];

const HELP = 'drive session-lock is one process per surface. Set OPD_VERIFY_LOCK to banner, profile, or queue, and OPD_VERIFY_SURFACE plus OPD_VERIFY_VIEWPORT to iphone-17-pro 402x874 or ipad-pro-11 834x1210. drive all leaves this probe out.';

const NETWORK_FETCH = `(() => {
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!String(url).includes('/api/browser/session')) return orig(input, init);
    window.__coldStart = performance.now();
    window.setTimeout(() => {
      window.__coldBannerAtTurn = !!document.querySelector('#status-banner .banner-action');
      window.__coldTurn = true;
    }, 0);
    return Promise.reject(new TypeError('Load failed'));
  };
})();`;

export function sessionLockPlan(surface, viewport, lock) {
  const name = String(surface || '').trim();
  const text = String(viewport || '').trim();
  const kind = String(lock || '').trim();
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!LOCKS.includes(kind) || !name || !match) throw new Error(HELP);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const plan = SESSION_LOCK_SURFACES.find((entry) => entry.surface === name && entry.width === width && entry.height === height);
  if (!plan) throw new Error(HELP);
  return { ...plan, lock: kind };
}

export function bannerTurnFailures(state) {
  const failures = [];
  if (!state?.coldTurn) failures.push('network turn did not run');
  if (state?.bannerAtTurn !== true) failures.push('banner action missing inside the first setTimeout(0)');
  const text = String(state?.text || '');
  if (!/Load failed|Failed to fetch/.test(text)) failures.push(`banner text ${text}`);
  if (state?.signIn !== 'Sign in') failures.push(`sign in ${state?.signIn}`);
  if (state?.reload !== 'Reload') failures.push(`reload ${state?.reload}`);
  if (state?.cards !== 0) failures.push(`cards ${state?.cards}`);
  return failures;
}

export function queueRecoveryFailures(state) {
  const failures = [];
  const text = String(state?.text || '');
  if (!text.includes('Please sign in again')) failures.push(`banner text ${text}`);
  if (state?.signIn !== 'Sign in' || state?.reload !== 'Reload') failures.push('recovery controls missing');
  if (state?.view !== 'view-queue') failures.push(`view ${state?.view}`);
  if (state?.queueActive !== true) failures.push('queue tab inactive');
  if (state?.cards !== 0) failures.push(`cards ${state?.cards}`);
  if (state?.disabled !== true || state?.ariaDisabled !== 'true') failures.push('profile stayed enabled');
  if (state?.profileActive === true) failures.push('profile tab active');
  return failures;
}

export function profileLockFailures(state) {
  const failures = [];
  if (state?.disabled !== true || state?.ariaDisabled !== 'true') failures.push('profile was not locked');
  if (state?.view === 'view-profile' || state?.profileActive === true) failures.push('profile pane opened');
  if (state?.showsStoredProfile || state?.showsPersonalTarget) failures.push('stored profile rendered');
  if (state?.keptQueue !== '[{"private":"unsent"}]') failures.push('ratings cleared');
  return failures;
}

export function profileReadyFailures(state) {
  const failures = [];
  if (state?.disabled !== false) failures.push(`profile disabled ${state?.disabled}`);
  if (state?.ariaDisabled != null) failures.push(`aria-disabled ${state?.ariaDisabled}`);
  if (state?.view !== 'view-profile') failures.push(`view ${state?.view}`);
  if (!String(state?.body || '').includes('Anil')) failures.push('pane omitted Anil');
  const banner = String(state?.banner || '');
  if (!banner.includes('Last updated')) failures.push(`banner ${banner}`);
  if (/sign in/i.test(banner)) failures.push('recovery footer remained');
  return failures;
}

function contextOptions(plan) {
  const spec = plan.surface === 'iphone-17-pro'
    ? { name: 'iPhone 17 Pro', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale }
    : { name: 'iPad Pro 11', viewport: { width: plan.width, height: plan.height }, deviceScaleFactor: plan.scale };
  return { ...deviceDescriptor(spec), viewport: { width: plan.width, height: plan.height }, serviceWorkers: 'block' };
}

async function preparedContext(browser, plan) {
  const context = await browser.newContext(contextOptions(plan));
  if (plan.standalone) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    });
  }
  return context;
}

async function assertCreatedSize(page, plan) {
  const size = await page.evaluate(({ width, height }) => {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && (root.clientWidth !== width || root.clientHeight !== height)) {
      meta.setAttribute('content', `width=${width}, height=${height}, initial-scale=1, viewport-fit=cover`);
    }
    return { w: window.innerWidth, h: window.innerHeight };
  }, plan);
  if (size.w !== plan.width || size.h !== plan.height) {
    throw new Error(`created-at-size ${plan.width}x${plan.height} opened ${size.w}x${size.h}`);
  }
  return size;
}

async function readBanner(page) {
  return page.evaluate(() => {
    const banner = document.getElementById('status-banner');
    const profile = document.getElementById('tab-profile');
    return {
      text: banner?.innerText || '',
      signIn: banner?.querySelector('a.banner-action')?.textContent || '',
      reload: banner?.querySelector('button.banner-action')?.textContent || '',
      cards: document.querySelectorAll('#cards > *').length,
      coldTurn: window.__coldTurn === true,
      bannerAtTurn: window.__coldBannerAtTurn === true,
      disabled: profile instanceof HTMLButtonElement ? profile.disabled : null,
      ariaDisabled: profile?.getAttribute('aria-disabled') ?? null,
    };
  });
}

async function proveBanner(page, plan, evidenceDir) {
  await page.goto(`${plan.baseUrl}/?u=anil`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await assertCreatedSize(page, plan);
  await page.waitForFunction(() => window.__coldTurn === true, null, { timeout: 15000 });
  const state = await readBanner(page);
  await page.screenshot({ path: resolve(evidenceDir, `session-lock-banner-${plan.id}.png`) });
  return state;
}

async function proveQueue(page, plan, evidenceDir) {
  await page.goto(`${plan.baseUrl}/?u=anil`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await assertCreatedSize(page, plan);
  await page.locator('#status-banner').getByRole('link', { name: 'Sign in' }).waitFor({ timeout: 15000 });
  await page.locator('#tab-queue').click();
  const state = await page.evaluate(() => {
    const banner = document.getElementById('status-banner');
    const profile = document.getElementById('tab-profile');
    const queue = document.getElementById('tab-queue');
    return {
      text: banner?.innerText || '',
      signIn: banner?.querySelector('a.banner-action')?.textContent || '',
      reload: banner?.querySelector('button.banner-action')?.textContent || '',
      view: document.getElementById('view')?.className || '',
      cards: document.querySelectorAll('#cards > *').length,
      queueActive: queue?.classList.contains('active') === true,
      disabled: profile instanceof HTMLButtonElement ? profile.disabled : null,
      ariaDisabled: profile?.getAttribute('aria-disabled') ?? null,
      profileActive: profile?.classList.contains('active') === true,
    };
  });
  await page.screenshot({ path: resolve(evidenceDir, `session-lock-queue-${plan.id}.png`) });
  return state;
}

async function proveProfile(browser, plan, evidenceDir) {
  const denied = await preparedContext(browser, plan);
  await denied.addCookies([{ name: 'opd-verify-session', value: 'deny', url: plan.baseUrl }]);
  const lockedPage = await denied.newPage();
  lockedPage.setDefaultTimeout(90000);
  let locked;
  try {
    await lockedPage.goto(`${plan.baseUrl}/?u=anil`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertCreatedSize(lockedPage, plan);
    await lockedPage.locator('#status-banner').getByRole('link', { name: 'Sign in' }).waitFor({ timeout: 15000 });
    await lockedPage.evaluate(() => {
      localStorage.setItem('opd-calib-queue', '[{"private":"unsent"}]');
      document.getElementById('tab-profile')?.click();
    });
    locked = await lockedPage.evaluate(() => {
      const profile = document.getElementById('tab-profile');
      const body = document.getElementById('profile-body')?.textContent || '';
      return {
        disabled: profile instanceof HTMLButtonElement ? profile.disabled : null,
        ariaDisabled: profile?.getAttribute('aria-disabled') ?? null,
        view: document.getElementById('view')?.className || '',
        profileActive: profile?.classList.contains('active') === true,
        showsStoredProfile: body.includes('unsent'),
        showsPersonalTarget: body.includes('Backyard'),
        keptQueue: localStorage.getItem('opd-calib-queue'),
      };
    });
    await lockedPage.screenshot({ path: resolve(evidenceDir, `session-lock-profile-${plan.id}.png`) });
    await denied.clearCookies();
    await lockedPage.evaluate(async () => {
      const main = await import('/src/main.ts');
      await main.init();
    });
    await lockedPage.locator('#tab-profile').click();
    await lockedPage.waitForFunction(() => (document.getElementById('profile-body')?.textContent || '').includes('Anil'), null, { timeout: 30000 });
    const ready = await lockedPage.evaluate(() => {
      const profile = document.getElementById('tab-profile');
      return {
        disabled: profile instanceof HTMLButtonElement ? profile.disabled : null,
        ariaDisabled: profile?.getAttribute('aria-disabled') ?? null,
        view: document.getElementById('view')?.className || '',
        body: document.getElementById('profile-body')?.textContent || '',
        banner: document.getElementById('status-banner')?.innerText || '',
      };
    });
    await lockedPage.screenshot({ path: resolve(evidenceDir, `session-lock-profile-ready-${plan.id}.png`) });
    return { locked, ready };
  } finally {
    await denied.close();
  }
}

export async function driveSessionLock({ baseUrl, evidenceDir }) {
  const plan = sessionLockPlan(process.env.OPD_VERIFY_SURFACE, process.env.OPD_VERIFY_VIEWPORT, process.env.OPD_VERIFY_LOCK);
  plan.baseUrl = baseUrl;
  mkdirSync(evidenceDir, { recursive: true });
  const browser = await launchWebkit();
  let line = '';
  try {
    if (plan.lock === 'profile') {
      console.log(`viewport session-lock surface ${plan.id} lock profile opened ${plan.width}x${plan.height} created-at-size`);
      const { locked, ready } = await proveProfile(browser, plan, evidenceDir);
      const failures = [...profileLockFailures(locked), ...profileReadyFailures(ready)];
      line = `session lock profile ${plan.id} disabled ${locked.disabled} ready ${ready.disabled} view ${ready.view}`;
      writeFileSync(resolve(evidenceDir, `session-lock-profile-${plan.id}.txt`), `${line}\nbanner ${JSON.stringify(ready.banner)}\n${failures.join('\n')}\n`);
      console.log(line);
      if (failures.length) throw new Error(['session-lock fail', ...failures].join('\n'));
      return line;
    }
    const context = await preparedContext(browser, plan);
    if (plan.lock === 'banner') await context.addInitScript(NETWORK_FETCH);
    if (plan.lock === 'queue') {
      await context.addCookies([{ name: 'opd-verify-session', value: 'deny', url: baseUrl }]);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    try {
      console.log(`viewport session-lock surface ${plan.id} lock ${plan.lock} opened ${plan.width}x${plan.height} created-at-size`);
      const state = plan.lock === 'banner'
        ? await proveBanner(page, plan, evidenceDir)
        : await proveQueue(page, plan, evidenceDir);
      const failures = plan.lock === 'banner' ? bannerTurnFailures(state) : queueRecoveryFailures(state);
      line = plan.lock === 'banner'
        ? `session lock banner ${plan.id} turn ${state.bannerAtTurn} cards ${state.cards}`
        : `session lock queue ${plan.id} view ${state.view} cards ${state.cards} profileDisabled ${state.disabled}`;
      writeFileSync(resolve(evidenceDir, `session-lock-${plan.lock}-${plan.id}.txt`), `${line}\n${JSON.stringify(state)}\n${failures.join('\n')}\n`);
      console.log(line);
      if (failures.length) throw new Error(['session-lock fail', ...failures].join('\n'));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return line;
}
