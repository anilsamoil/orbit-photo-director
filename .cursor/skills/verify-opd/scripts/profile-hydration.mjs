#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolateSnapRequests } from './context-state-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const require = createRequire(resolve(repo, 'frontend/package.json'));
const { chromium } = require('playwright');

const PROFILE = 'u-pilot';
const DISPLAY = 'Pilot Example';
const GUEST = 'guest';
const LOCAL_ID = 'personal:u-pilot:11111111-1111-4111-8111-111111111111';
const SERVER_ID = 'personal:u-pilot:22222222-2222-4222-8222-222222222222';
const ONLY_ID = 'personal:u-pilot:33333333-3333-4333-8333-333333333333';
const origin = process.env.OPD_VERIFY_ORIGIN || 'http://127.0.0.1:41731';
const size = String(process.env.OPD_VERIFY_VIEWPORT || '').trim();
const artifacts = '/opt/cursor/artifacts';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (size !== '1440x900') fail('OPD_VERIFY_VIEWPORT must be 1440x900. The context is created at that size.');

function target(id, name) {
  return {
    id,
    name,
    lat: 1.25,
    lon: 2.5,
    priority: 5,
    createdAt: '2026-11-16T12:00:00.000Z',
  };
}

function profileRecord(additions, distanceThresholdKm = 1500) {
  return {
    version: 1,
    name: PROFILE,
    additions,
    removedCuratedIds: [],
    distanceThresholdKm,
    instantBuffer: [],
  };
}

function sessionBody() {
  return {
    ok: true,
    profile: { name: PROFILE, displayName: DISPLAY },
    profiles: [{ name: PROFILE, displayName: DISPLAY }],
  };
}

async function shot(page, name) {
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: resolve(artifacts, name), fullPage: false });
}

async function armTargets(page, handler) {
  const hits = [];
  await page.route('**/api/browser/profiles/**/targets**', async (route) => {
    hits.push(route.request().method());
    await handler(route, hits.length);
  });
  return hits;
}

const browser = await chromium.launch();
isolateSnapRequests(browser, origin);
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const denied = await context.newPage();
  const deniedHits = await armTargets(denied, (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: '{"error":"unexpected"}',
  }));
  await denied.route('**/api/browser/session', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: '{}',
  }));
  await denied.goto(`${origin}/?e2e`, { waitUntil: 'domcontentloaded' });
  await denied.waitForFunction(() => {
    const banner = document.getElementById('status-banner');
    const tab = document.getElementById('tab-profile');
    return banner?.textContent?.includes('Please sign in again to open your own profile.')
      && tab instanceof HTMLButtonElement
      && tab.disabled;
  }, null, { timeout: 20_000 });
  if (deniedHits.length) fail(`signed-out 401 fetched targets ${deniedHits.length} times`);
  await shot(denied, 'profile-hydration-signed-out.png');
  console.log('profile hydration signed-out 401 sign-in message targets 0');
  await denied.close();

  const guest = await context.newPage();
  const guestHits = await armTargets(guest, (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: '{"error":"unexpected"}',
  }));
  await guest.route('**/api/browser/session', (route) => route.fulfill({
    status: 404,
    contentType: 'text/html',
    body: '<!doctype html><title>local</title>',
  }));
  await guest.goto(`${origin}/?e2e&u=${GUEST}`, { waitUntil: 'domcontentloaded' });
  await guest.waitForFunction(() => document.getElementById('tab-profile') && !document.getElementById('tab-profile').disabled, null, { timeout: 20_000 });
  await guest.locator('#tab-profile').click();
  await guest.waitForSelector('#profile-threshold-slider', { timeout: 15_000 });
  await guest.waitForTimeout(500);
  if (guestHits.length) fail(`anonymous ?u= fetched targets ${guestHits.length} times`);
  await shot(guest, 'profile-hydration-anonymous.png');
  console.log('profile hydration anonymous ?u= targets 0');
  await guest.close();

  const retry = await context.newPage();
  let retryGets = 0;
  await armTargets(retry, (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    retryGets += 1;
    if (retryGets === 1) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ targets: [target(SERVER_ID, 'Harbor Example')], removedCuratedIds: [] }),
    });
  });
  await retry.route('**/api/browser/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(sessionBody()),
  }));
  await retry.goto(`${origin}/?e2e`, { waitUntil: 'domcontentloaded' });
  await retry.waitForFunction(() => {
    const tab = document.getElementById('tab-profile');
    return tab && !tab.disabled;
  }, null, { timeout: 20_000 });
  const retryDeadline = Date.now() + 20_000;
  while (retryGets < 1 && Date.now() < retryDeadline) await retry.waitForTimeout(100);
  if (retryGets !== 1) fail(`failed first read did not stay at one GET (${retryGets})`);
  await retry.locator('#tab-profile').click();
  await retry.waitForFunction(() => document.getElementById('profile-body')?.textContent?.includes('Harbor Example'), null, { timeout: 20_000 });
  if (retryGets < 2) fail('opening Profile did not retry the targets read');
  await shot(retry, 'profile-hydration-retry.png');
  console.log(`profile hydration retry reads ${retryGets} harbor kept`);
  await retry.close();

  const slider = await context.newPage();
  let releaseRead = () => {};
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let sliderGets = 0;
  await armTargets(slider, async (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    sliderGets += 1;
    if (sliderGets === 1) await gate;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ targets: [target(SERVER_ID, 'Harbor Example')], removedCuratedIds: [] }),
    });
  });
  await slider.route('**/api/browser/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(sessionBody()),
  }));
  await slider.goto(`${origin}/?e2e`, { waitUntil: 'domcontentloaded' });
  await slider.waitForFunction(() => {
    const tab = document.getElementById('tab-profile');
    return tab && !tab.disabled;
  }, null, { timeout: 20_000 });
  await slider.locator('#tab-profile').click();
  await slider.waitForSelector('#profile-threshold-slider', { timeout: 15_000 });
  const sliderDeadline = Date.now() + 20_000;
  while (sliderGets < 1 && Date.now() < sliderDeadline) await slider.waitForTimeout(100);
  if (sliderGets < 1) fail('slider case never started the targets read');
  await slider.locator('#profile-threshold-slider').evaluate((node) => {
    node.value = '800';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await slider.waitForFunction((name) => {
    const raw = localStorage.getItem(`opd-profile-${name}`);
    return !!raw && JSON.parse(raw).distanceThresholdKm === 800;
  }, PROFILE, { timeout: 10_000 });
  releaseRead();
  await slider.waitForFunction(() => document.getElementById('profile-body')?.textContent?.includes('Harbor Example'), null, { timeout: 20_000 });
  const threshold = await slider.locator('#profile-threshold-display').textContent();
  if (threshold?.trim() !== '800 km') fail(`slider display ${threshold}`);
  await shot(slider, 'profile-hydration-slider.png');
  console.log('profile hydration slider 800 km harbor kept');
  await slider.close();

  const edited = await context.newPage();
  await edited.addInitScript((record) => {
    localStorage.setItem('opd-profile-names', JSON.stringify([record.name]));
    localStorage.setItem(`opd-profile-${record.name}`, JSON.stringify(record));
  }, profileRecord([target(LOCAL_ID, 'Harbor Local')]));
  let releaseEdit = () => {};
  const editGate = new Promise((resolve) => { releaseEdit = resolve; });
  let editGets = 0;
  const serverList = [target(LOCAL_ID, 'Harbor Local'), target(ONLY_ID, 'Server Only')];
  await armTargets(edited, async (route) => {
    const method = route.request().method();
    if (method === 'PUT' || method === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (method !== 'GET') return route.fallback();
    editGets += 1;
    if (editGets === 1) await editGate;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ targets: serverList, removedCuratedIds: [] }),
    });
  });
  await edited.route('**/api/browser/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(sessionBody()),
  }));
  await edited.goto(`${origin}/?e2e`, { waitUntil: 'domcontentloaded' });
  await edited.waitForFunction(() => {
    const tab = document.getElementById('tab-profile');
    return tab && !tab.disabled;
  }, null, { timeout: 20_000 });
  await edited.locator('#tab-profile').click();
  const editDeadline = Date.now() + 20_000;
  while (editGets < 1 && Date.now() < editDeadline) await edited.waitForTimeout(100);
  if (editGets !== 1) fail(`edit case boot read was ${editGets}, expected the held GET`);
  await edited.getByRole('button', { name: 'Edit' }).click();
  await edited.locator('[id^="profile-edit-name-"]').fill('Harbor Kept');
  await edited.getByRole('button', { name: 'Save' }).click();
  await edited.waitForFunction((name) => {
    const raw = localStorage.getItem(`opd-profile-${name}`);
    const additions = raw ? JSON.parse(raw).additions : [];
    return additions.some((item) => item.name === 'Harbor Kept');
  }, PROFILE, { timeout: 15_000 });
  releaseEdit();
  await edited.waitForTimeout(600);
  const body = await edited.locator('#profile-body').innerText();
  if (!body.includes('Harbor Kept')) fail('local edit was not kept');
  if (body.includes('Server Only')) fail('server-only row was added during the local edit');
  await shot(edited, 'profile-hydration-edit.png');
  console.log('profile hydration local edit kept server-only absent');
  await edited.close();
  await context.close();
} finally {
  await browser.close();
}
