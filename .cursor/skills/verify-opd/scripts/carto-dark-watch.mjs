import { pathToFileURL } from 'node:url';

const BUFFER_SIZE = 250;
const PRECACHE_TILES = 340;
const WATERMARK = 'https://a.basemaps.cartocdn.com/dark_all/2/1/1@2x.png';

export function isAnonymousCartoDark(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'basemaps.cartocdn.com' || host.endsWith('.basemaps.cartocdn.com'))) return false;
    return parsed.pathname.includes('/dark_all');
  } catch {
    return /basemaps\.cartocdn\.com\/[^?\s]*\/dark_all(?:\/|$)/i.test(url);
  }
}

export function noteRequest(hits, url) {
  if (isAnonymousCartoDark(url)) hits.push(url);
}

export function resourceTimingBuffer(urls, size = BUFFER_SIZE) {
  return urls.slice(0, size);
}

export function planBasemapVerdict(hits, page) {
  if (!Array.isArray(hits)) return { ok: false, reason: 'untracked' };
  const url = hits.find((entry) => isAnonymousCartoDark(entry));
  if (url) return { ok: false, reason: 'carto', url };
  if (page && page.ok === true) return { ok: true };
  return { ok: false, reason: 'page' };
}

function esriPrecache(count) {
  const urls = [];
  for (let index = 0; index < count; index += 1) {
    const z = index % 4;
    const y = Math.floor(index / 4) % 8;
    const x = index % 16;
    urls.push(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`);
  }
  return urls;
}

function biteReport() {
  const precache = esriPrecache(PRECACHE_TILES);
  const followed = [...precache, WATERMARK];
  const tracked = [];
  for (const url of followed) noteRequest(tracked, url);
  const buffered = resourceTimingBuffer(followed);
  const resourceTimingSeesCarto = buffered.some((url) => isAnonymousCartoDark(url));
  const resourceTimingVerdict = planBasemapVerdict(
    buffered.filter((url) => isAnonymousCartoDark(url)),
    { ok: true },
  );
  const trackedVerdict = planBasemapVerdict(tracked, { ok: true });
  const esriOnly = [];
  for (const url of precache) noteRequest(esriOnly, url);
  const esriVerdict = planBasemapVerdict(esriOnly, { ok: true });
  return {
    precache: precache.length,
    bufferSize: BUFFER_SIZE,
    watermark: WATERMARK,
    resourceTimingSeesCarto,
    resourceTimingVerdict,
    trackedVerdict,
    esriVerdict,
  };
}

function runBite() {
  const report = biteReport();
  const bite = report.resourceTimingVerdict.ok === true
    && report.resourceTimingSeesCarto === false
    && report.trackedVerdict.ok === false
    && report.trackedVerdict.reason === 'carto'
    && report.trackedVerdict.url === WATERMARK
    && report.esriVerdict.ok === true;
  console.log(JSON.stringify({ ...report, bite }, null, 2));
  if (!bite) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBite();
}
