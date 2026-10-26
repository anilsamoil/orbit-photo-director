import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { proveLegendPanelBounds } from './drive.mjs';
import { WEBKIT_DEVICES, launchWebkit, openDeviceContext, playwrightSend } from './webkit-devices.mjs';

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; }
  #status-banner, #view { height: 0; overflow: hidden; }
  .topbar { position: absolute; top: 0; left: 0; right: 0; height: 40px; }
  .map-command { position: fixed; left: 0; right: 0; bottom: 0; height: 40px; }
  #map-legend-panel { display: none; }
  #map-legend-toggle[aria-expanded="true"] + #map-legend-panel {
    display: block;
    position: absolute;
    top: 48px;
    left: 8px;
    width: 200px;
    height: 80px;
    overflow-y: auto;
    pointer-events: auto;
  }
</style>
<div id="status-banner">Ready</div>
<div id="view" class="view-queue"></div>
<div class="topbar"></div>
<button id="map-legend-toggle" aria-expanded="false" type="button">Legend</button>
<div id="map-legend-panel"><div class="map-imagery-date">short</div></div>
<div class="map-command"></div>`;

test('webkit: legend bounds use the long label after the viewport replaces the document', { timeout: 60000 }, async () => {
  const server = createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (path !== '/snap') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const evidenceDir = await mkdtemp(resolve(tmpdir(), 'opd-legend-bounds-'));
  const browser = await launchWebkit();
  try {
    const session = await openDeviceContext(browser, WEBKIT_DEVICES[0]);
    await session.page.goto(`http://127.0.0.1:${server.address().port}/snap`, { waitUntil: 'domcontentloaded' });
    await proveLegendPanelBounds(playwrightSend(session), evidenceDir, { width: 390, height: 664, mobile: true });
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(evidenceDir, { recursive: true, force: true });
  }
});
