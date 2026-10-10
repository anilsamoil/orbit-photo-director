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

test('a WebKit size change reselects the open ISS launch', async () => {
  const browser = await launchWebkit();
  try {
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    const body = [
      '<div id="status-banner">Ready</div>',
      '<div id="view" class="view-iss"></div>',
      '<button id="tab-iss">ISS</button>',
      '<div data-iss-scene>',
      '<div data-iss-frame style="width:120px;height:120px"></div>',
      '<button data-iss-telemetry style="width:44px;height:44px">Telemetry</button>',
      '<button data-iss-fullscreen style="width:44px;height:44px">Full</button>',
      '<select data-iss-launch-picker><option value="">Choose</option><option value="pad">Verify</option></select>',
      '<div data-iss-launch-card hidden><span data-iss-launch-name></span></div>',
      '</div>',
      '<script>',
      'const scene = document.querySelector("[data-iss-scene]");',
      'if (window.innerHeight <= 564) scene.setAttribute("data-iss-short", "");',
      'document.querySelector("[data-iss-launch-picker]").addEventListener("change", (event) => {',
      '  const card = document.querySelector("[data-iss-launch-card]");',
      '  const name = card.querySelector("[data-iss-launch-name]");',
      '  card.hidden = event.target.value !== "pad";',
      '  name.textContent = event.target.value === "pad" ? "Verify Ascent" : "";',
      '});',
      '</script>',
    ].join('');
    await session.page.goto(pageUrl(body), { waitUntil: 'domcontentloaded' });
    await session.page.evaluate(() => {
      const picker = document.querySelector('[data-iss-launch-picker]');
      picker.value = 'pad';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const send = playwrightSend(session);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 874,
      height: 402,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const restored = await session.page.evaluate(() => ({
      value: document.querySelector('[data-iss-launch-picker]').value,
      name: document.querySelector('[data-iss-launch-name]').textContent,
      hidden: document.querySelector('[data-iss-launch-card]').hidden,
      short: document.querySelector('[data-iss-scene]').hasAttribute('data-iss-short'),
    }));
    assert.equal(restored.value, 'pad');
    assert.equal(restored.name, 'Verify Ascent');
    assert.equal(restored.hidden, false);
    assert.equal(restored.short, true);
  } finally {
    await browser.close();
  }
});

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
