export const MAP_IMPORT_RETRY_KEY = 'opd-map-import-retry';
export const MAP_IMPORT_URL_KEY = 'opd-map-import-url';

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
