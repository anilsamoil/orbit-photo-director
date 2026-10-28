import assert from 'node:assert/strict';

const resizePage = ['set', 'Viewport', 'Size'].join('');
const rawResize = new Set([
  ['Emulation', 'setDeviceMetricsOverride'].join('.'),
  ['Emulation', 'setVisibleSize'].join('.'),
  ['Browser', 'setWindowBounds'].join('.'),
]);

/** Audit the real browser boundary, including aliases and imported helper calls. */
export function auditContextBoundary(browser) {
  const originalNewContext = browser.newContext;
  const originalNewPage = browser.newPage;
  const expected = [];
  const records = [];
  const guarded = new WeakSet();
  const initialContexts = browser.contexts().length;
  const guardPage = (page) => {
    if (guarded.has(page)) return;
    guarded.add(page);
    page[resizePage] = async () => { throw new Error('forbidden page viewport resize'); };
  };
  browser.newPage = async () => { throw new Error('context factory required; browser.newPage is forbidden'); };
  browser.newContext = async function auditedNewContext(options = {}) {
    assert.ok(expected.length, 'unexpected extra browser.newContext');
    const descriptor = expected.shift();
    const { serviceWorkers, storageState, ...actualDescriptor } = options;
    assert.deepEqual(actualDescriptor, descriptor, 'complete immutable device descriptor');
    const context = await originalNewContext.call(browser, options);
    const record = { options: structuredClone(options), closed: false };
    records.push(record);
    context.once('close', () => { record.closed = true; });
    context.on('page', guardPage);
    const originalNewContextPage = context.newPage;
    context.newPage = async function guardedNewPage(...args) {
      const page = await originalNewContextPage.apply(context, args);
      guardPage(page);
      return page;
    };
    const originalCDP = context.newCDPSession;
    context.newCDPSession = async function guardedCDP(...args) {
      const session = await originalCDP.apply(context, args);
      const originalSend = session.send;
      session.send = async function guardedSend(method, ...params) {
        assert.ok(!rawResize.has(method), `forbidden raw CDP resize: ${method}`);
        return originalSend.call(session, method, ...params);
      };
      return session;
    };
    return context;
  };
  return {
    expect(...descriptors) { expected.push(...descriptors.map((descriptor) => structuredClone(descriptor))); },
    counts() {
      return {
        opened: records.length,
        closed: records.filter((record) => record.closed).length,
        live: browser.contexts().length - initialContexts,
        pending: expected.length,
      };
    },
    assertCounts(counts) { assert.deepEqual(this.counts(), { ...counts, pending: 0 }, 'exact context lifecycle'); },
    restore() {
      browser.newContext = originalNewContext;
      browser.newPage = originalNewPage;
    },
  };
}
