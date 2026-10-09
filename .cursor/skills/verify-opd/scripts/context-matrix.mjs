import { DESKTOP_CHROME_SPEC, WEBKIT_DEVICES, launchChrome, launchWebkit, openDeviceContext, playwrightSend, readContextMetrics } from './webkit-devices.mjs';

const PAGE = 'data:text/html,' + encodeURIComponent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>size</title><p>size</p>');

const iphone13 = WEBKIT_DEVICES[0];
const ipad = WEBKIT_DEVICES[1];
const iphone17 = WEBKIT_DEVICES[2];

export const CONTEXT_MATRIX = [
  {
    label: 'desktop Chrome 1400x900',
    browser: 'chromium',
    spec: DESKTOP_CHROME_SPEC,
    expect: { innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1 },
  },
  {
    label: 'WebKit iPhone 13',
    browser: 'webkit',
    spec: iphone13,
    expect: { innerWidth: 390, innerHeight: 664, devicePixelRatio: 3 },
  },
  {
    label: 'WebKit iPhone 17 Pro 402x874',
    browser: 'webkit',
    spec: iphone17,
    expect: { innerWidth: 402, innerHeight: 874, devicePixelRatio: 3 },
  },
  {
    label: 'WebKit iPhone 17 Pro 874x402',
    browser: 'webkit',
    spec: { ...iphone17, viewport: { width: 874, height: 402 } },
    expect: { innerWidth: 874, innerHeight: 402, devicePixelRatio: 3 },
  },
  {
    label: 'WebKit iPad Pro 11 834x1194',
    browser: 'webkit',
    spec: ipad,
    expect: { innerWidth: 834, innerHeight: 1194, devicePixelRatio: 2 },
  },
  {
    label: 'WebKit 844x390',
    browser: 'webkit',
    spec: { name: 'iPhone 13', viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, standalone: true },
    expect: { innerWidth: 844, innerHeight: 390, devicePixelRatio: 3 },
  },
];

function sameMetrics(actual, expect) {
  return actual.innerWidth === expect.innerWidth
    && actual.innerHeight === expect.innerHeight
    && actual.devicePixelRatio === expect.devicePixelRatio;
}

export async function measureContext(browser, spec) {
  const session = await openDeviceContext(browser, spec);
  try {
    await session.page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    const metrics = await readContextMetrics(session.page);
    return { metrics, contexts: browser.contexts().length };
  } finally {
    await session.context.close();
  }
}

export async function replaceLandscape(browser, spec, width, height) {
  const session = await openDeviceContext(browser, spec);
  const previous = session.context;
  try {
    await session.page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    const send = playwrightSend(session);
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const metrics = await readContextMetrics(session.page);
    const stillOpen = browser.contexts().includes(previous);
    return { metrics, stillOpen, contexts: browser.contexts().length };
  } finally {
    await session.context.close();
  }
}

function line(label, metrics, expect, extra = '') {
  const mark = sameMetrics(metrics, expect) ? 'ok' : 'MISS';
  return `${mark} ${label} inner ${metrics.innerWidth}x${metrics.innerHeight} dpr ${metrics.devicePixelRatio} expect ${expect.innerWidth}x${expect.innerHeight} dpr ${expect.devicePixelRatio} ua ${metrics.userAgent} touch ${metrics.maxTouchPoints}${extra}`;
}

export async function runContextMatrix() {
  const lines = [];
  const chrome = await launchChrome();
  try {
    for (const row of CONTEXT_MATRIX.filter((entry) => entry.browser === 'chromium')) {
      const { metrics } = await measureContext(chrome, row.spec);
      lines.push({ ...row, metrics, text: line(row.label, metrics, row.expect) });
    }
  } finally {
    await chrome.close();
  }
  const webkitBrowser = await launchWebkit();
  try {
    for (const row of CONTEXT_MATRIX.filter((entry) => entry.browser === 'webkit')) {
      const { metrics } = await measureContext(webkitBrowser, row.spec);
      lines.push({ ...row, metrics, text: line(row.label, metrics, row.expect) });
    }
    const swapped = await replaceLandscape(webkitBrowser, iphone17, 874, 402);
    const swappedExpect = { innerWidth: 874, innerHeight: 402, devicePixelRatio: 3 };
    lines.push({
      label: 'replace iPhone 17 Pro to 874x402',
      expect: swappedExpect,
      metrics: swapped.metrics,
      text: line('replace iPhone 17 Pro to 874x402', swapped.metrics, swappedExpect, ` previous-open ${swapped.stillOpen} contexts ${swapped.contexts}`),
      stillOpen: swapped.stillOpen,
    });
    const wide = await replaceLandscape(webkitBrowser, iphone13, 844, 390);
    const wideExpect = { innerWidth: 844, innerHeight: 390, devicePixelRatio: 3 };
    lines.push({
      label: 'replace iPhone 13 to 844x390',
      expect: wideExpect,
      metrics: wide.metrics,
      text: line('replace iPhone 13 to 844x390', wide.metrics, wideExpect, ` previous-open ${wide.stillOpen} contexts ${wide.contexts}`),
      stillOpen: wide.stillOpen,
    });
  } finally {
    await webkitBrowser.close();
  }
  return lines;
}

function failed(row) {
  if (!sameMetrics(row.metrics, row.expect)) return true;
  if (row.stillOpen) return true;
  return false;
}

const isMain = process.argv[1] && process.argv[1].endsWith('context-matrix.mjs');
if (isMain) {
  const rows = await runContextMatrix();
  for (const row of rows) console.log(row.text);
  if (rows.some(failed)) process.exit(1);
}
