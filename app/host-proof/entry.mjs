import fixture from 'virtual:g1-fixture';
import { createProof, waitFor } from './probes.mjs';

const rawFetch = globalThis.fetch.bind(globalThis);
const tile = Uint8Array.from(atob(fixture.tile), (character) => character.charCodeAt(0));
const workers = [];
const localTiles = { map: 0, iss: 0 };
const offline = {
  policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
  serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
  fixtureResponses: 0, deniedFetches: 0, blockedResources: 0,
};
const NativeWorker = globalThis.Worker;
globalThis.Worker = new Proxy(NativeWorker, {
  construct(target, args) {
    const worker = Reflect.construct(target, args);
    workers.push({ url: String(args[0]), type: args[1]?.type ?? 'classic' });
    return worker;
  },
});
document.addEventListener('securitypolicyviolation', () => { offline.blockedResources++; });

const local = new URL(location.href);
local.searchParams.set('e2e', '');
local.searchParams.set('u', 'g1-fixture');
history.replaceState(null, '', local);
Date.now = () => fixture.now;
// The website shell requires an available account/plan transport on its
// first load. In this build that transport is the offline fixture below.
Object.defineProperty(navigator, 'onLine', { value: true });

const tabKey = 'opd-g1-tab';
const recoveredTab = localStorage.getItem(tabKey);
if (recoveredTab === 'tab-iss') {
  sessionStorage.setItem('opd-map-import-view', recoveredTab);
}
const tabs = document.querySelector('.tabs');
new MutationObserver(() => {
  const active = tabs.querySelector('.tab.active')?.id;
  if (active === 'tab-map' || active === 'tab-iss') localStorage.setItem(tabKey, active);
}).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] });

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), location.href);
  const method = init?.method ?? request?.method ?? 'GET';
  const sameOrigin = url.protocol === local.protocol && url.host === local.host;
  if (sameOrigin && method === 'GET') {
    const body = fixture.files[url.pathname];
    if (Object.hasOwn(fixture.files, url.pathname)) {
      offline.fixtureResponses++;
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    }
    if (/^\/(assets|fonts|glyphs)\//.test(url.pathname) || url.pathname === '/ne_110m_coastline.geojson') {
      return rawFetch(input, init);
    }
    const match = url.pathname.match(/^\/__g1\/(map|iss)\.png$/);
    if (match) {
      const response = await rawFetch(input, init);
      if (response.ok) localTiles[match[1]]++;
      return response;
    }
  }
  if (method === 'GET' && url.protocol === 'https:' && (
    (url.hostname === 'gibs.earthdata.nasa.gov' && /\/(BlueMarble[^/]*|VIIRS_Black_Marble)\//.test(url.pathname))
    || (url.hostname === 'server.arcgisonline.com' && /\/MapServer\/tile\//.test(url.pathname))
  )) {
    const kind = url.hostname === 'gibs.earthdata.nasa.gov' ? 'iss' : 'map';
    const signal = init?.signal ?? request?.signal;
    return globalThis.fetch(new URL('/__g1/' + kind + '.png', local).href, { signal });
  }
  offline.deniedFetches++;
  throw new TypeError('G1 offline fixture has no local route for this request');
};

const proof = createProof({ rawFetch, tile, workers, localTiles, offline, fixture });
window.__opdG1 = proof;
proof.ready = import('/src/main.ts');
proof.fixtureReady = proof.ready.then(async (main) => {
  const manifest = await waitFor(() => {
    const active = main.getCurrentManifest();
    return active?.version === 'g1-fixture' && active;
  }, 'active fixture plan');
  const card = await waitFor(() => {
    const name = document.querySelector('#cards [data-target-id="g1-synthetic"] .card-name')?.textContent;
    return name === 'Synthetic proof target' && name;
  }, 'fixture queue card');
  proof.fixtureEvidence = {
    version: manifest.version,
    generatedAt: manifest.generated_at,
    trackSHA256: manifest.artifacts.track.sha256,
    queueCard: card,
  };
  if (recoveredTab === 'tab-iss') {
    await waitFor(() => proof.state().tab === recoveredTab && window.__opdIss?.loaded(), 'restored ISS tab');
  }
});
// The native digest and bridge checks still run if fixture rendering fails.
void proof.fixtureReady.catch(() => {});
