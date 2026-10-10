export const MAP_IMPORT_RETRY_KEY = 'opd-map-import-retry';
export const MAP_IMPORT_URL_KEY = 'opd-map-import-url';
export const MAP_IMPORT_VIEW_KEY = 'opd-map-import-view';
export const MAP_CHUNK_PROBE_TIMEOUT_MS = 2000;

const MAP_IMPORT_VIEW_IDS = ['tab-queue', 'tab-upcoming', 'tab-iss', 'tab-profile', 'tab-log'] as const;

export interface MapImportFlagStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type MapImportAction =
  | { action: 'reload-once'; href: string }
  | { action: 'show-error' };

const DYNAMIC_IMPORT_FAILURE = /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i;

export function dynamicImportUrl(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  const match = message.match(/https?:\/\/\S+/);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/, '');
}

export function cacheBustMapHref(href: string): string {
  const url = new URL(href);
  url.searchParams.set('map-chunk', '1');
  return url.toString();
}

export function retryMapHref(href: string, nonce: string): string {
  const url = new URL(href);
  url.searchParams.set('map-retry', nonce);
  return url.toString();
}

export function retryMapModuleUrl(chunkUrl: string, nonce: string): string {
  const url = new URL(chunkUrl);
  url.searchParams.set('map-retry', nonce);
  return url.toString();
}

export function stripMapImportParams(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('map-chunk');
  url.searchParams.delete('map-retry');
  return url.toString();
}

/** A query the precache route does not ignore, so the probe is not answered from the service worker. */
export function chunkProbeUrl(chunkUrl: string, nonce: string): string {
  const url = new URL(chunkUrl);
  url.searchParams.set('map-probe', nonce);
  return url.toString();
}

export function assetPath(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

export function isMapLibreVendorUrl(url: string): boolean {
  const path = assetPath(url);
  return /\/maplibre-vendor-[^/]+\.js$/.test(path) || /\/maplibre-gl-worker-[^/]+\.js$/.test(path);
}

export function isNonMapScriptUrl(url: string): boolean {
  if (!url || isMapLibreVendorUrl(url)) return true;
  return /\/(?:iss-view|satellites|profile-ui|profile-crud|photo-lookup)-[^/]+\.js$/.test(assetPath(url));
}

export function rememberedViewId(activeTabId: string | null): string | null {
  if (!activeTabId) return null;
  return (MAP_IMPORT_VIEW_IDS as readonly string[]).includes(activeTabId) ? activeTabId : null;
}

export function mapModuleFromViteDeps(source: string): { script: string; stylesheets: string[] } | null {
  const body = source.match(/m\.f\|\|\(m\.f=\[([^\]]+)\]\)/)?.[1];
  if (!body) return null;
  const files = [...body.matchAll(/"([^"]+)"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
  const calls = [...source.matchAll(/__vite__mapDeps\(\[([0-9,]+)\]\)/g)].flatMap((match) => {
    const raw = match[1];
    if (!raw) return [];
    const nums = raw.split(',').map(Number);
    if (nums.length <= 4 || nums.some((num) => !Number.isInteger(num))) return [];
    return [nums];
  });
  const mapCall = [...calls].sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0))[0];
  const scriptIndex = mapCall?.[0];
  if (!mapCall || scriptIndex === undefined) return null;
  const script = files[scriptIndex];
  if (!script || !script.endsWith('.js') || isMapLibreVendorUrl(script)) return null;
  const stylesheets = mapCall
    .map((index) => files[index])
    .filter((file): file is string => typeof file === 'string' && file.endsWith('.css'));
  return { script, stylesheets };
}

function sameStylesheet(link: HTMLLinkElement, href: string): boolean {
  return link.href === href || assetPath(link.href) === assetPath(href);
}

export function loadStylesheet(href: string, timeoutMs = MAP_CHUNK_PROBE_TIMEOUT_MS): Promise<void> {
  const existing = [...document.querySelectorAll('link[rel="stylesheet"]')].find(
    (node): node is HTMLLinkElement => node instanceof HTMLLinkElement && sameStylesheet(node, href) && node.dataset.opdStyleReady === '1',
  );
  if (existing) return Promise.resolve();
  document.querySelectorAll('link[rel="stylesheet"]').forEach((node) => {
    if (node instanceof HTMLLinkElement && sameStylesheet(node, href)) node.remove();
  });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!failed) {
        link.dataset.opdStyleReady = '1';
        resolve();
        return;
      }
      link.remove();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => finish(true, 'map stylesheet timed out'), timeoutMs);
    link.addEventListener('load', () => finish(false, ''), { once: true });
    link.addEventListener('error', () => finish(true, 'map stylesheet failed'), { once: true });
    document.head.appendChild(link);
  });
}

export async function readChunkStatus(
  chunkUrl: string,
  timeoutMs = MAP_CHUNK_PROBE_TIMEOUT_MS,
  nonce = String(Date.now()),
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(chunkProbeUrl(chunkUrl, nonce), {
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function reportedImportError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (current.name === 'AbortError' || DYNAMIC_IMPORT_FAILURE.test(current.message)) return current;
    if (!(current.cause instanceof Error)) break;
    current = current.cause;
  }
  return error;
}

/** 404 is a missing chunk. null is an abort or a network error. 500 and 200 are not a stale chunk. A dynamic-import message with no URL uses the same probe. */
export async function classifyMapImportFailure(
  error: unknown,
  probe: (url: string | null) => Promise<number | null>,
): Promise<'stale-chunk' | 'aborted' | 'other'> {
  const reported = reportedImportError(error);
  if (reported instanceof Error && reported.name === 'AbortError') return 'aborted';
  const message = reported instanceof Error ? reported.message : String(reported ?? '');
  if (/\baborted\b/i.test(message) && !DYNAMIC_IMPORT_FAILURE.test(message)) return 'aborted';
  if (!DYNAMIC_IMPORT_FAILURE.test(message)) return 'other';
  const status = await probe(dynamicImportUrl(reported));
  if (status === 404) return 'stale-chunk';
  if (status === null) return 'aborted';
  return 'other';
}

export function planMapImportRecovery(
  kind: 'stale-chunk' | 'aborted' | 'other',
  alreadyRetried: boolean,
  href: string,
): MapImportAction {
  if (kind === 'stale-chunk' && !alreadyRetried) {
    return { action: 'reload-once', href: cacheBustMapHref(href) };
  }
  return { action: 'show-error' };
}

export async function nextMapImportStep(
  error: unknown,
  store: MapImportFlagStore,
  href: string,
  probe: (url: string | null) => Promise<number | null>,
): Promise<MapImportAction> {
  const kind = await classifyMapImportFailure(error, probe);
  const action = planMapImportRecovery(kind, store.getItem(MAP_IMPORT_RETRY_KEY) === '1', href);
  if (action.action !== 'reload-once') return action;
  store.setItem(MAP_IMPORT_RETRY_KEY, '1');
  if (store.getItem(MAP_IMPORT_RETRY_KEY) !== '1') return { action: 'show-error' };
  return action;
}

export function noteMapImportSuccess(store: MapImportFlagStore): void {
  store.removeItem(MAP_IMPORT_RETRY_KEY);
  store.removeItem(MAP_IMPORT_URL_KEY);
}
