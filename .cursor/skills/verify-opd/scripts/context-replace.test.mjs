import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WEBKIT_DEVICES, launchWebkit, openDeviceContext, playwrightSend, readContextMetrics } from './webkit-devices.mjs';

const META = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';

function pageUrl(body) {
  return `data:text/html,${encodeURIComponent(`${META}${body}`)}`;
}

test('same metrics keep the open WebKit context', async () => {
  const browser = await launchWebkit();
  try {
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    await session.page.goto(pageUrl('<title>keep</title>'), { waitUntil: 'domcontentloaded' });
    await session.page.evaluate(() => { window.__mark = 'kept'; });
    const context = session.context;
    const send = playwrightSend(session);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 664,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(session.context, context);
    assert.equal(await session.page.evaluate(() => window.__mark), 'kept');
    const metrics = await readContextMetrics(session.page);
    assert.equal(metrics.innerWidth, 390);
    assert.equal(metrics.innerHeight, 664);
    assert.equal(metrics.devicePixelRatio, 3);
  } finally {
    await browser.close();
  }
});

test('a WebKit size change restores the captured SNAP pose', async () => {
  const browser = await launchWebkit();
  try {
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    const previous = session.context;
    await session.page.goto(pageUrl('<div id="status-banner">Ready</div><div id="view" class="view-queue"></div><button id="tab-queue">Queue</button>'), { waitUntil: 'domcontentloaded' });
    await session.page.evaluate(() => document.body.classList.add('shotlist-bar-visible'));
    const send = playwrightSend(session);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 874,
      height: 402,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(browser.contexts().includes(previous), false);
    assert.equal(browser.contexts().length, 1);
    const metrics = await readContextMetrics(session.page);
    assert.equal(metrics.innerWidth, 874);
    assert.equal(metrics.innerHeight, 402);
    assert.equal(metrics.devicePixelRatio, 3);
    const pose = await session.page.evaluate(() => ({
      view: document.getElementById('view').className,
      shotlist: document.body.classList.contains('shotlist-bar-visible'),
      banner: document.getElementById('status-banner').textContent,
    }));
    assert.equal(pose.view, 'view-queue');
    assert.equal(pose.shotlist, true);
    assert.equal(pose.banner, 'Ready');
  } finally {
    await browser.close();
  }
});

// ISS launch/control/renderer restoration is exercised against real SNAP in
// context-state.test.mjs; DOM boxes alone are not a ready ISS renderer.

async function serveHtml(body) {
  const html = `${META}${body}`;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/snap` };
}

test('a later storage write survives the reload after a size change', async () => {
  const browser = await launchWebkit();
  const served = await serveHtml('<div id="status-banner">Ready</div><div id="view" class="view-queue"></div><button id="tab-queue">Queue</button>');
  try {
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    await session.page.goto(served.url, { waitUntil: 'domcontentloaded' });
    await session.page.evaluate(() => localStorage.setItem('opd-aim', 'first'));
    const send = playwrightSend(session);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 874,
      height: 402,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await session.page.evaluate(() => localStorage.setItem('opd-aim', 'second'));
    await session.page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await session.page.evaluate(() => localStorage.getItem('opd-aim')), 'second');
  } finally {
    served.server.close();
    await browser.close();
  }
});

test('a restored clock keeps ticking across a size change', async () => {
  const browser = await launchWebkit();
  const served = await serveHtml('<div id="status-banner">Ready</div><div id="view" class="view-queue"></div><button id="tab-queue">Queue</button>');
  try {
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    await session.page.goto(served.url, { waitUntil: 'domcontentloaded' });
    await session.page.evaluate(() => { window.__opdRealNow = Date.now; });
    const send = playwrightSend(session);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 844,
      height: 390,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const first = await session.page.evaluate(() => Date.now());
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
    const second = await session.page.evaluate(() => Date.now());
    assert.equal(second > first, true);
  } finally {
    served.server.close();
    await browser.close();
  }
});

test('inserted disclosure wrappers do not redirect saved open or closed states', async () => {
  let documents = 0;
  const server = createServer((req, res) => {
    documents += 1;
    const primary = documents > 1;
    res.setHeader('content-type', 'text/html');
    res.end(`${META}<div id="status-banner">Ready</div><div id="view" class="view-queue"></div>
      <section id="queue-pane"><details class="launch-data-details"><summary>Launch data</summary></details></section>
      <section id="map-pane">
        ${primary ? '<details class="map-launch-primary"><summary>New primary</summary>' : ''}
        <details class="launch-data-details"><summary>Launch data</summary></details>
        ${primary ? '</details>' : ''}
        <details class="launch-data-details"><summary>Duplicate label</summary></details>
        <details class="launch-data-details"><summary>Duplicate label</summary></details>
      </section>`);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  let browser;
  try {
    browser = await launchWebkit();
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    await session.page.goto(`http://127.0.0.1:${server.address().port}/snap`);
    await session.page.evaluate(() => {
      document.querySelectorAll('details').forEach((el, index) => { el.open = index !== 2; });
    });
    await playwrightSend(session)('Emulation.setDeviceMetricsOverride', { width: 874, height: 402 });
    assert.deepEqual(await session.page.evaluate(() => [...document.querySelectorAll('details')].map((el) => ({
      summary: el.querySelector(':scope > summary').textContent, open: el.open,
    }))), [
      { summary: 'Launch data', open: true },
      { summary: 'New primary', open: false },
      { summary: 'Launch data', open: true },
      { summary: 'Duplicate label', open: false },
      { summary: 'Duplicate label', open: true },
    ]);
  } finally {
    try { await browser?.close(); }
    finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  }
});
