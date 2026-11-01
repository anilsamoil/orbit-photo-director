import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WEBKIT_DEVICES, launchChrome, launchWebkit, openDeviceContext, playwrightSend } from './webkit-devices.mjs';

const META = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
const phone = WEBKIT_DEVICES[0];

function shell(inner) {
  return `${META}<div id="status-banner">Ready</div><div id="view" class="view-queue"></div>${inner}`;
}

function publicationHtml(phase) {
  const stamp = phase === 'before' ? '12:00Z' : '12:05Z';
  return shell(`<section id="coverage"><details data-opd-control="schedule"><summary>Launch data details · schedule checked ${stamp}</summary></details></section>`);
}

function missingHtml(phase) {
  const details = phase === 'before'
    ? '<details data-opd-control="schedule"><summary>Launch data details · schedule checked 12:00Z</summary></details>'
    : '';
  return shell(`<section id="coverage">${details}<details id="unrelated-preferences"><summary>Unrelated preferences</summary></details></section>`);
}

function wrongOpenHtml(phase) {
  if (phase === 'before') {
    return shell('<section id="coverage"><details data-opd-control="schedule"><summary>Launch data details · schedule checked 12:00Z</summary></details></section>');
  }
  return shell(`<section id="coverage"><details data-opd-control="schedule"><summary>Launch data details · schedule checked 12:05Z</summary></details>
    <script>
      const el = document.querySelector('[data-opd-control="schedule"]');
      let shown = false;
      Object.defineProperty(el, 'open', { configurable: true, get() { return shown; }, set() { shown = false; } });
    </script></section>`);
}

function stolenSummaryHtml(phase) {
  if (phase === 'before') {
    return shell('<section id="coverage"><details data-opd-control="legacy"><summary>Retired legacy data</summary></details></section>');
  }
  return shell('<section id="coverage"><details data-opd-control="catalog" open><summary>Retired legacy data</summary></details></section>');
}

function attributionHtml(phase) {
  const stamp = phase === 'before' ? '12:00Z' : '12:05Z';
  const attrib = phase === 'before'
    ? '<div id="map-pane"><details class="maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact" open><summary class="maplibregl-ctrl-attrib-button"></summary></details></div>'
    : '<div id="map-pane"></div>';
  return shell(`${attrib}<section id="coverage"><details data-opd-control="schedule"><summary>Launch data details · schedule checked ${stamp}</summary></details></section>`);
}

function insertedHtml(phase) {
  if (phase === 'before') {
    return shell('<section id="coverage"><details data-opd-control="kept"><summary>Launch data details · schedule checked 12:00Z</summary></details></section>');
  }
  return shell(`<section id="coverage">
    <details data-opd-control="kept" open><summary>Launch data details · schedule checked 12:05Z</summary></details>
    <details data-opd-control="fresh" open><summary>Launch data details · schedule checked 12:00Z</summary></details>
  </section>`);
}

async function serve(render) {
  let phase = 'before';
  const server = createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (path !== '/snap') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(render(phase));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/snap`,
    publish() { phase = 'after'; },
  };
}

async function handoff(launch, render, prepare, read) {
  const served = await serve(render);
  let browser;
  try {
    browser = await launch();
    const session = await openDeviceContext(browser, phone);
    await session.page.goto(served.url, { waitUntil: 'domcontentloaded' });
    if (prepare) await prepare(session.page);
    served.publish();
    const predecessor = session.page;
    try {
      await playwrightSend(session)('Emulation.setDeviceMetricsOverride', {
        width: 874,
        height: 402,
        deviceScaleFactor: 1,
        mobile: true,
      });
    } catch (error) {
      assert.equal(session.page, predecessor, 'rejection retains the public predecessor');
      assert.equal(predecessor.isClosed(), false, 'rejection keeps the predecessor alive');
      assert.equal(browser.contexts().length, 1, 'rejection closes the candidate');
      throw error;
    }
    return read ? await read(session.page) : null;
  } finally {
    await browser?.close();
    served.server.closeAllConnections();
    await new Promise((done) => served.server.close(done));
  }
}

function readDisclosures(page) {
  return page.evaluate(() => [...document.querySelectorAll('details')].map((el) => ({
    control: el.getAttribute('data-opd-control'),
    summary: el.querySelector(':scope > summary')?.textContent || '',
    open: el.open,
  })));
}

let tail = Promise.resolve();

function serial(name, fn) {
  test(name, { timeout: 60000 }, async () => {
    const previous = tail;
    let release;
    tail = new Promise((done) => { release = done; });
    await previous;
    try {
      await fn();
    } finally {
      release();
    }
  });
}

for (const [engine, launch] of [['webkit', launchWebkit], ['chrome', launchChrome]]) {
  serial(`${engine}: a later publication stamp restores the same disclosure open state`, async () => {
    const rows = await handoff(launch, publicationHtml, (open) => open.evaluate(() => {
      document.querySelector('[data-opd-control="schedule"]').open = true;
    }), readDisclosures);
    assert.deepEqual(rows, [
      { control: 'schedule', summary: 'Launch data details · schedule checked 12:05Z', open: true },
    ]);
  });

  serial(`${engine}: a missing stable disclosure fails settle`, async () => {
    await assert.rejects(
      () => handoff(launch, missingHtml, (open) => open.evaluate(() => {
        document.querySelector('[data-opd-control="schedule"]').open = true;
      })),
      /restored controls before context switch/,
    );
  });

  serial(`${engine}: a missing stable ID beside an unrelated survivor fails settle`, async () => {
    await assert.rejects(
      () => handoff(launch, (phase) => missingHtml(phase).replace('data-opd-control="schedule"', 'id="persistent-preferences"'), (open) => open.evaluate(() => {
        document.getElementById('persistent-preferences').open = true;
      })),
      /restored controls before context switch/,
    );
  });

  serial(`${engine}: a disclosure left on the wrong open state fails settle`, async () => {
    await assert.rejects(
      () => handoff(launch, wrongOpenHtml, (open) => open.evaluate(() => {
        document.querySelector('[data-opd-control="schedule"]').open = true;
      })),
      /restored controls before context switch/,
    );
  });

  serial(`${engine}: a new control that copies a retired summary fails settle`, async () => {
    await assert.rejects(
      () => handoff(launch, stolenSummaryHtml, (open) => open.evaluate(() => {
        document.querySelector('[data-opd-control="legacy"]').open = false;
      })),
      /restored controls before context switch/,
    );
  });

  serial(`${engine}: an unmounted map attribution does not drop a saved disclosure`, async () => {
    const rows = await handoff(launch, attributionHtml, (open) => open.evaluate(() => {
      document.querySelector('[data-opd-control="schedule"]').open = true;
    }), readDisclosures);
    assert.deepEqual(rows, [
      { control: 'schedule', summary: 'Launch data details · schedule checked 12:05Z', open: true },
    ]);
  });

  serial(`${engine}: an inserted default-open disclosure does not take a saved open state`, async () => {
    const rows = await handoff(launch, insertedHtml, (open) => open.evaluate(() => {
      document.querySelector('[data-opd-control="kept"]').open = false;
    }), readDisclosures);
    assert.deepEqual(rows, [
      { control: 'kept', summary: 'Launch data details · schedule checked 12:05Z', open: false },
      { control: 'fresh', summary: 'Launch data details · schedule checked 12:00Z', open: true },
    ]);
  });
}
