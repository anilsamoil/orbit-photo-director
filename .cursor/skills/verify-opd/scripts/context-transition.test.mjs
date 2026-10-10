import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WEBKIT_DEVICES, launchChrome, launchWebkit, openDeviceContext, replaceDeviceContext,
} from './webkit-devices.mjs';
import { isolateSnapRequests, serveSnap } from './context-state-fixture.mjs';

const phone = WEBKIT_DEVICES.find((entry) => entry.slug === 'iphone-17-pro');
const click = (page, selector) => page.locator(selector).evaluate((el) => el.click());
const mapReady = (page) => page.waitForFunction(() => window.__opdMap?.getLayer('iss-track-layer')
  && document.getElementById('toggle-follow-iss')?.hasAttribute('aria-pressed'));
const issReady = (page) => page.waitForFunction(() => window.__opdIss
  && document.querySelector('[data-iss-scene]')?.dataset.issPhase === 'running');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function disclosureState(page) {
  return page.evaluate(() => ({
    hidden: document.body.classList.contains('map-chrome-hidden'),
    survivors: ['cards-launch-coverage', 'upcoming-cards-launch-coverage'].map((id) => {
      const el = document.querySelector(`#${id} .launch-data-details`);
      return { scope: id, summary: el?.querySelector('summary')?.textContent, open: el?.open };
    }),
    legacyMapData: !!document.querySelector('#map-launch-coverage .launch-data-details'),
    primary: document.querySelector('#map-launch-coverage .map-launch-primary > summary')?.textContent,
    insertedMore: document.querySelector('#map-launch-coverage .map-launch-more')?.open,
  }));
}

for (const [engine, launch] of [['webkit', launchWebkit], ['chrome', launchChrome]]) {
  test(`${engine}: real SNAP reconciles delayed catalog disclosures with shown and hidden Map chrome`, { timeout: 180000 }, async (t) => {
    for (const hidden of [false, true]) {
      await t.test(`Map chrome ${hidden ? 'hidden' : 'shown'}`, async () => {
        const served = await serveSnap({ catalog: 'fallback' });
        let browser;
        let changing;
        const releaseCatalog = deferred();
        try {
          browser = await launch();
          isolateSnapRequests(browser, served.url);
          const session = await openDeviceContext(browser, phone);
          await session.page.goto(`${served.url}/?e2e`);
          await click(session.page, '#tab-map');
          await mapReady(session.page);
          // Finish the real legacy slot before recording stable disclosure labels.
          await session.page.evaluate(async () => {
            const app = await import('/src/main.ts');
            await app.refresh();
          });
          await session.page.waitForFunction(() => document.querySelector('#map-launch-coverage .launch-data-details'));
          if (await session.page.evaluate(() => document.body.classList.contains('map-chrome-hidden')) !== hidden) {
            await click(session.page, '#map-chrome-toggle');
          }
          await session.page.evaluate(() => {
            document.querySelector('#cards-launch-coverage .launch-data-details').open = true;
            document.querySelector('#upcoming-cards-launch-coverage .launch-data-details').open = false;
            document.querySelector('#map-launch-coverage .launch-data-details').open = false;
          });
          const before = await disclosureState(session.page);
          assert.equal(before.legacyMapData, true);
          assert.deepEqual(before.survivors.map((entry) => entry.open), [true, false]);
          assert.equal(before.insertedMore, undefined);
          const predecessor = session.page;
          const candidate = deferred();
          const catalogRequested = deferred();
          const original = browser.newContext.bind(browser);
          browser.newContext = async (...args) => {
            const context = await original(...args);
            await context.route(`${served.url}/launch/catalog/latest.json`, async (route) => {
              catalogRequested.resolve();
              await releaseCatalog.promise;
              await route.continue();
            });
            context.on('page', (page) => candidate.resolve(page));
            return context;
          };
          changing = replaceDeviceContext(session, { width: 874, height: 402 });
          // Keep the pending rejection observed while inspecting the candidate.
          changing.catch(() => {});
          const next = await candidate.promise;
          await catalogRequested.promise;
          await next.waitForFunction(() => document.querySelector('#map-launch-coverage .launch-data-details'));
          assert.equal(session.page, predecessor);
          assert.equal(predecessor.isClosed(), false);
          served.activateCatalog();
          releaseCatalog.resolve();
          await changing;
          const after = await disclosureState(session.page);
          assert.equal(after.hidden, hidden);
          assert.equal(after.legacyMapData, false, 'tier catalog legitimately retires the captured closed disclosure');
          assert.match(after.primary, /Shot/i, 'real schema-3 catalog was parsed and rendered');
          assert.deepEqual(after.survivors, before.survivors, 'mixed extant disclosures survive the refresh');
          assert.equal(after.insertedMore, false, 'new catalog disclosure keeps its default closed state');
          assert.equal(predecessor.isClosed(), true);
          assert.equal(browser.contexts().length, 1);
          await session.page.waitForTimeout(1100);
          assert.deepEqual(await disclosureState(session.page), after, 'the next app tick keeps reconciled state');
        } finally {
          releaseCatalog.resolve();
          await changing?.catch(() => {});
          try { await browser?.close(); }
          finally { await served.close(); }
        }
      });
    }
  });

  test(`${engine}: ISS-only unknown Follow accepts the initialized default; explicit on/off survive`, { timeout: 150000 }, async () => {
    const served = await serveSnap();
    let browser;
    const manifestGate = deferred();
    try {
      browser = await launch();
      isolateSnapRequests(browser, served.url);
      const session = await openDeviceContext(browser, { ...phone, viewport: { width: 874, height: 402 } });
      const manifestRequested = deferred();
      await session.page.route(`${served.url}/manifest.json`, async (route) => {
        manifestRequested.resolve();
        await manifestGate.promise;
        await route.continue();
      });
      await session.page.goto(`${served.url}/?e2e`, { waitUntil: 'domcontentloaded' });
      await manifestRequested.promise;
      await click(session.page, '#tab-iss');
      manifestGate.resolve();
      await issReady(session.page);
      assert.equal(await session.page.evaluate(() => !!window.__opdMap), false, 'predecessor never initialized Map');
      assert.equal(await session.page.locator('#toggle-follow-iss').getAttribute('aria-pressed'), null);
      const predecessor = session.page;
      const original = browser.newContext.bind(browser);
      browser.newContext = async (...args) => {
        const context = await original(...args);
        context.on('page', (page) => {
          const evaluate = page.evaluate.bind(page);
          page.evaluate = async (fn, arg) => {
            // Pick the other valid load order: default Map completes before
            // the harness dispatches the captured active-tab click.
            if (arg === '#tab-iss') await mapReady(page);
            return evaluate(fn, arg);
          };
        });
        return context;
      };
      await replaceDeviceContext(session, { width: 844, height: 390 });
      assert.equal(predecessor.isClosed(), true);
      assert.equal(await session.page.locator('#toggle-follow-iss').getAttribute('aria-pressed'), 'true');
      assert.equal(await session.page.locator('#view').getAttribute('class'), 'view-iss');
      await issReady(session.page);
      for (const [follow, viewport] of [[false, { width: 874, height: 402 }], [true, { width: 844, height: 390 }]]) {
        if (await session.page.locator('#toggle-follow-iss').getAttribute('aria-pressed') !== String(follow)) {
          await click(session.page, '#toggle-follow-iss');
        }
        await replaceDeviceContext(session, viewport);
        assert.equal(await session.page.locator('#toggle-follow-iss').getAttribute('aria-pressed'), String(follow));
        assert.equal(await session.page.locator('#view').getAttribute('class'), 'view-iss');
        await session.page.waitForTimeout(1100);
        assert.equal(await session.page.locator('#toggle-follow-iss').getAttribute('aria-pressed'), String(follow));
        assert.equal(browser.contexts().length, 1);
      }
    } finally {
      manifestGate.resolve();
      try { await browser?.close(); }
      finally { await served.close(); }
    }
  });
}
