import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  DESKTOP_CHROME_SPEC, WEBKIT_DEVICES, deviceDescriptor,
  launchChrome, launchWebkit, openDeviceContext, playwrightSend,
} from './webkit-devices.mjs';

const HTML = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style><canvas id="map" width="50" height="50"></canvas><details id="legend"><summary>Legend</summary>Open</details>';
const CASES = [
  ['iPhone 13', WEBKIT_DEVICES[0]],
  ['iPhone 17 portrait', WEBKIT_DEVICES[2]],
  ['iPhone 17 landscape', { ...WEBKIT_DEVICES[2], viewport: { width: 874, height: 402 } }],
  ['iPad portrait', WEBKIT_DEVICES[1]],
  ['iPad landscape', { ...WEBKIT_DEVICES[1], viewport: { width: 1194, height: 834 } }],
  ['844x390 phone', { ...WEBKIT_DEVICES[0], viewport: { width: 844, height: 390 } }],
  ['desktop', DESKTOP_CHROME_SPEC],
];

async function serveHtml() {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/descriptor` };
}

function auditBrowser(browser) {
  const counts = { opened: 0, closed: 0, navigated: 0, dcl: 0 };
  const options = new WeakMap();
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (args) => {
    const context = await newContext(args);
    counts.opened += 1;
    options.set(context, structuredClone(args));
    context.on('close', () => { counts.closed += 1; });
    context.on('page', (page) => {
      page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) counts.navigated += 1; });
      page.on('domcontentloaded', () => { counts.dcl += 1; });
    });
    return context;
  };
  return { counts, options };
}

function readMetrics(page) {
  return page.evaluate(() => ({
    inner: [innerWidth, innerHeight],
    visual: [visualViewport.width, visualViewport.height, visualViewport.scale, visualViewport.offsetLeft, visualViewport.offsetTop],
    screen: [screen.width, screen.height],
    dpr: devicePixelRatio,
    userAgent: navigator.userAgent,
    touch: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches,
    fine: matchMedia('(pointer: fine)').matches,
    hover: matchMedia('(hover: hover)').matches,
    portrait: matchMedia('(orientation: portrait)').matches,
    standalone: navigator.standalone === true,
  }));
}

async function assertSameSizeIdentity(session, audit) {
  await session.page.evaluate(() => {
    window.__savedCanvas = document.querySelector('#map');
    window.__savedDocument = document;
    window.__marker = 'retained';
    document.querySelector('#legend').open = true;
    const paint = window.__savedCanvas.getContext('2d');
    paint.fillStyle = 'red';
    paint.fillRect(0, 0, 50, 50);
  });
  const page = session.page;
  const context = session.context;
  const baseDescriptor = session.baseDescriptor;
  const before = { ...audit.counts };
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const metrics = await readMetrics(page);
  const send = playwrightSend(session);
  const params = { ...session.descriptor.viewport };
  await send('Emulation.setDeviceMetricsOverride', { ...params, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
  await send('Emulation.setDeviceMetricsOverride', { ...params, mobile: !session.descriptor.isMobile });
  await send('Emulation.setDeviceMetricsOverride', { ...params, deviceScaleFactor: session.descriptor.deviceScaleFactor === 1 ? 2 : 1 });
  for (let index = 0; index < 20; index += 1) {
    await send('Emulation.setDeviceMetricsOverride', {
      ...params,
      mobile: index % 2 === 0,
      deviceScaleFactor: index % 2 === 0 ? 1 : 2,
      screenOrientation: { type: index % 2 === 0 ? 'portraitPrimary' : 'landscapePrimary', angle: index % 2 === 0 ? 0 : 90 },
    });
  }
  assert.equal(session.page, page);
  assert.equal(session.context, context);
  assert.equal(session.baseDescriptor, baseDescriptor);
  assert.deepEqual(audit.counts, before, 'same-size hints and 20-call loop must open/close/navigate/load zero documents');
  assert.deepEqual(await readMetrics(page), metrics);
  const { timeOrigin: afterTimeOrigin, ...identity } = await page.evaluate(() => ({
    document: window.__savedDocument === document,
    canvas: window.__savedCanvas === document.querySelector('#map'),
    marker: window.__marker,
    pixel: Array.from(window.__savedCanvas.getContext('2d').getImageData(0, 0, 1, 1).data),
    legend: document.querySelector('#legend').open,
    timeOrigin: performance.timeOrigin,
  }));
  assert.deepEqual(identity, { document: true, canvas: true, marker: 'retained', pixel: [255, 0, 0, 255], legend: true });
  // WebKit can round this getter to neighboring milliseconds on one unchanged
  // document. Object identities and all lifecycle counters above remain exact.
  assert.ok(Math.abs(afterTimeOrigin - timeOrigin) <= 1, `timeOrigin changed from ${timeOrigin} to ${afterTimeOrigin}`);
}

for (const [engine, launch] of [['Chrome', launchChrome], ['WebKit', launchWebkit]]) {
  test(`${engine}: every size leg preserves the complete immutable device and same-size document`, async (t) => {
    const served = await serveHtml();
    let browser;
    try {
      browser = await launch();
      const audit = auditBrowser(browser);
      for (const [label, requestedSpec] of CASES) {
        await t.test(label, async () => {
          const spec = structuredClone(requestedSpec);
          const session = await openDeviceContext(browser, spec);
          try {
            await session.page.goto(served.url, { waitUntil: 'domcontentloaded' });
            const base = structuredClone(deviceDescriptor(requestedSpec));
            const immutableBase = session.baseDescriptor;
            const originalMetrics = await readMetrics(session.page);
            const start = { ...audit.counts };
            spec.name = 'changed caller-owned spec';
            spec.viewport = { width: 1, height: 1 };
            if (spec.descriptor) spec.descriptor.screen.width = 1;
            assert.ok(Object.isFrozen(immutableBase));
            assert.ok(Object.isFrozen(immutableBase.viewport));
            assert.ok(Object.isFrozen(immutableBase.screen));
            assert.throws(() => { immutableBase.deviceScaleFactor = 1; }, TypeError);
            assert.throws(() => { immutableBase.screen.width = 1; }, TypeError);
            const sizes = [base.viewport, { width: 1600, height: 1000 }, { width: 390, height: 520 }, base.viewport];
            for (const [leg, viewport] of sizes.entries()) {
              if (leg) {
                const oldPage = session.page;
                await playwrightSend(session)('Emulation.setDeviceMetricsOverride', {
                  ...viewport, mobile: viewport.width < 900, deviceScaleFactor: 1,
                });
                assert.equal(oldPage.isClosed(), true);
                assert.notEqual(session.page, oldPage);
              }
              assert.equal(session.baseDescriptor, immutableBase);
              assert.deepEqual(session.baseDescriptor, base);
              assert.deepEqual(session.descriptor, { ...base, viewport });
              const { storageState, ...contextOptions } = audit.options.get(session.context);
              assert.deepEqual(contextOptions, { ...base, viewport, serviceWorkers: 'block' }, `${label} leg ${leg}: compare every context option`);
              if (storageState) {
                assert.deepEqual(storageState.cookies, []);
                assert.ok(storageState.origins.every((origin) => origin.origin === new URL(served.url).origin && origin.localStorage.length === 0));
              }
              const actual = await readMetrics(session.page);
              assert.deepEqual(actual, {
                inner: [viewport.width, viewport.height],
                visual: [viewport.width, viewport.height, 1, 0, 0],
                screen: [base.screen.width, base.screen.height],
                dpr: base.deviceScaleFactor,
                userAgent: base.userAgent,
                touch: originalMetrics.touch,
                coarse: base.hasTouch,
                fine: !base.hasTouch,
                hover: !base.hasTouch,
                portrait: viewport.height >= viewport.width,
                standalone: Boolean(requestedSpec.standalone),
              }, `${label} leg ${leg}: actual browser screen/DPR/UA/touch/media`);
              assert.equal(audit.counts.opened - start.opened, leg);
              assert.equal(audit.counts.closed - start.closed, leg);
              assert.equal(browser.contexts().length, 1);
              await assertSameSizeIdentity(session, audit);
            }
          } finally {
            await session.context.close();
          }
        });
      }
      await t.test('only an explicit new device spec changes the device', async () => {
        const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
        try {
          await session.page.goto(served.url, { waitUntil: 'domcontentloaded' });
          const previous = session.page;
          const viewport = { ...session.descriptor.viewport };
          await playwrightSend(session)('Emulation.setDeviceMetricsOverride', { ...viewport, deviceSpec: WEBKIT_DEVICES[1] });
          assert.notEqual(session.page, previous);
          assert.equal(previous.isClosed(), true);
          assert.equal(session.descriptor.deviceScaleFactor, 2);
          assert.equal(session.descriptor.userAgent, deviceDescriptor(WEBKIT_DEVICES[1]).userAgent);
          assert.deepEqual(session.descriptor.screen, deviceDescriptor(WEBKIT_DEVICES[1]).screen);
          assert.equal((await readMetrics(session.page)).standalone, false);
          await assertSameSizeIdentity(session, audit);
          const current = session.page;
          await playwrightSend(session)('Emulation.setDeviceMetricsOverride', { ...viewport, deviceSpec: WEBKIT_DEVICES[1] });
          assert.equal(session.page, current);
        } finally {
          await session.context.close();
        }
      });
      assert.equal(audit.counts.opened, 30);
      assert.equal(audit.counts.closed, 30);
      assert.equal(browser.contexts().length, 0);
    } finally {
      await browser?.close();
      await new Promise((resolve) => served.server.close(resolve));
    }
  });
}

test('incomplete custom descriptors fail before opening any browser context', async () => {
  const browser = { newContext() { assert.fail('must validate the complete descriptor before creating a context'); } };
  for (const key of ['viewport', 'screen', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'userAgent', 'defaultBrowserType']) {
    const descriptor = structuredClone(DESKTOP_CHROME_SPEC.descriptor);
    delete descriptor[key];
    await assert.rejects(openDeviceContext(browser, { name: 'Custom', descriptor }), /descriptor/);
  }
});
