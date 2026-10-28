import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/package.json'));
const { webkit } = require('playwright');
const evidence = { intercepted: 0, peakPending: 0, pendingAtClose: [], requests: [] };
const pending = new Set();
const save = () => {
  if (process.env.OPD_VERIFY_HANG_EVIDENCE) writeFileSync(process.env.OPD_VERIFY_HANG_EVIDENCE, JSON.stringify(evidence, null, 2));
};
const hold = (request) => {
  pending.add(request);
  evidence.intercepted += 1;
  evidence.peakPending = Math.max(evidence.peakPending, pending.size);
  evidence.requests.push(request.url());
  save();
};
const launch = webkit.launch.bind(webkit);
webkit.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...contextArgs) => {
    const context = await newContext(...contextArgs);
    const newPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs) => {
      const page = await newPage(...pageArgs);
      page.on('requestfinished', (request) => pending.delete(request));
      page.on('requestfailed', (request) => pending.delete(request));
      await page.route(/^https:\/\/realearth\.ssec\.wisc\.edu\//, (route) => {
        hold(route.request());
        return new Promise(() => {});
      });
      return page;
    };
    const close = context.close.bind(context);
    context.close = async (...closeArgs) => {
      evidence.pendingAtClose.push(pending.size);
      save();
      return close(...closeArgs);
    };
    return context;
  };
  return browser;
};

const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    this.hangEnabled = false;
    this.heldRequests = new Map();
    this.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Fetch.requestPaused') {
        const request = { url: () => message.params.request.url };
        this.heldRequests.set(message.params.networkId, request);
        hold(request);
      }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
        pending.delete(this.heldRequests.get(message.params.requestId));
      }
    });
  }
  send(data) {
    const command = JSON.parse(data);
    if (!this.hangEnabled && ['Network.enable', 'Page.enable'].includes(command.method)) {
      this.hangEnabled = true;
      super.send(JSON.stringify({ id: -1, method: 'Fetch.enable', params: { patterns: [{ urlPattern: 'https://realearth.ssec.wisc.edu/*', requestStage: 'Request' }] } }));
    }
    return super.send(data);
  }
  close(...args) {
    evidence.pendingAtClose.push(pending.size);
    save();
    return super.close(...args);
  }
};
