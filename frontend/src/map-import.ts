export const MAP_IMPORT_RETRY_KEY = 'opd-map-import-retry';
export const MAP_IMPORT_URL_KEY = 'opd-map-import-url';
export const MAP_IMPORT_VIEW_KEY = 'opd-map-import-view';
export const MAP_CHUNK_PROBE_TIMEOUT_MS = 2000;
export const MAP_MODULE_IDLE_TIMEOUT_MS = 10_000;
export const MAP_MODULE_DOWNLOAD_TIMEOUT_MS = 120_000;
// The built shell names Vite's native stylesheet without emitting a raw copy
// or depending on private preload-helper syntax or a discovery fetch.
export const MAP_STYLESHEET_URL = (typeof document === 'undefined' ? undefined
  : document.querySelector<HTMLMetaElement>('meta[name="opd-map-stylesheet"]')?.content)
  ?? '/node_modules/maplibre-gl/dist/maplibre-gl.css';

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

interface ModuleToken {
  value: string;
  start: number;
  end: number;
  kind: 'word' | 'string' | 'punctuation';
}

export interface ModuleReference {
  start: number;
  end: number;
  /** null identifies import.meta.url; other values are module specifiers. */
  specifier: string | null;
  dynamic: boolean;
}

/** Tokenize only to locate ECMAScript module references, never Vite's private
 * preload tables. Literal/comment/regexp text is not executable module syntax.
 * Template interpolations are executable, so they are visited recursively. */
function moduleTokens(source: string): ModuleToken[] {
  const tokens: ModuleToken[] = [];
  let cursor = 0;
  let previous = '';
  let canStartRegexp = true;
  type Parenthesis = { control: boolean; functionDeclaration?: boolean };
  const parentheses: Parenthesis[] = [];
  const declarationBodies: boolean[] = [];
  let closedParenthesis: Parenthesis | undefined;
  let templateExpressionStart: number | null = null;
  const functionHeader = (): boolean | undefined => {
    let index = tokens.length - 1;
    if (tokens[index]?.kind === 'word' && tokens[index]?.value !== 'function') index -= 1;
    if (tokens[index]?.value === '*') index -= 1;
    if (tokens[index]?.kind !== 'word' || tokens[index]?.value !== 'function') return undefined;
    index -= 1;
    if (tokens[index]?.kind === 'word' && tokens[index]?.value === 'async') index -= 1;
    if (templateExpressionStart !== null && index < templateExpressionStart) return false;
    const prefix = tokens[index];
    return !prefix
      || (prefix.kind === 'punctuation' && [';', '{', '}'].includes(prefix.value))
      || (prefix.kind === 'word' && (prefix.value === 'export'
        || (prefix.value === 'default' && tokens[index - 1]?.value === 'export')));
  };
  const push = (start: number, kind: ModuleToken['kind'], value = source.slice(start, cursor)) => {
    const punctuation = kind === 'punctuation';
    if (punctuation && value === '(') {
      parentheses.push({ control: /^(?:if|while|for|with|switch|catch)$/.test(previous), functionDeclaration: functionHeader() });
    }
    if (punctuation && value === '{') declarationBodies.push(closedParenthesis?.functionDeclaration === true);
    const closesDeclaration = punctuation && value === '}' && declarationBodies.pop() === true;
    closedParenthesis = punctuation && value === ')' ? parentheses.pop() : undefined;
    tokens.push({ start, end: cursor, kind, value });
    canStartRegexp = closesDeclaration || closedParenthesis?.control === true || (kind !== 'string' && (
      /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(value)
      || (kind === 'punctuation' && !/^(?:\)|\]|\}|\+\+|--|\.)$/.test(value))
    ));
    previous = value;
  };
  const scan = (templateExpression = false): void => {
    let braces = 0;
    while (cursor < source.length) {
      const character = source[cursor] ?? '';
      if (/\s/.test(character)) { cursor += 1; continue; }
      if (source.startsWith('//', cursor)) {
        const newline = source.indexOf('\n', cursor + 2);
        cursor = newline === -1 ? source.length : newline + 1;
        continue;
      }
      if (source.startsWith('/*', cursor)) {
        const end = source.indexOf('*/', cursor + 2);
        if (end === -1) throw new Error('unterminated module comment');
        cursor = end + 2;
        continue;
      }
      if (templateExpression && character === '}' && braces === 0) { cursor += 1; return; }
      if (character === '`') {
        cursor += 1;
        let closed = false;
        while (cursor < source.length) {
          if (source[cursor] === '\\') { cursor += 2; continue; }
          if (source[cursor] === '`') { cursor += 1; closed = true; break; }
          if (source.startsWith('${', cursor)) {
            cursor += 2;
            canStartRegexp = true;
            const outerExpressionStart = templateExpressionStart;
            templateExpressionStart = tokens.length;
            scan(true);
            templateExpressionStart = outerExpressionStart;
          } else cursor += 1;
        }
        if (!closed) throw new Error('unterminated module template');
        previous = '`';
        canStartRegexp = false;
        continue;
      }
      if (character === '"' || character === "'") {
        const start = cursor++;
        let value = '';
        let closed = false;
        while (cursor < source.length) {
          const next = source[cursor++];
          if (next === character) { closed = true; break; }
          if (next !== '\\') { value += next; continue; }
          const escaped = source[cursor++] ?? '';
          if (escaped === '\n') continue;
          if (escaped === '\r') { if (source[cursor] === '\n') cursor += 1; continue; }
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
          if (escaped === 'x' || escaped === 'u') {
            const braced = escaped === 'u' && source[cursor] === '{';
            if (braced) cursor += 1;
            const end = braced ? source.indexOf('}', cursor) : cursor + (escaped === 'x' ? 2 : 4);
            const hex = source.slice(cursor, end);
            if (!/^[\da-f]+$/i.test(hex)) throw new Error('invalid module string escape');
            value += String.fromCodePoint(parseInt(hex, 16));
            cursor = end + (braced ? 1 : 0);
          } else value += escapes[escaped] ?? escaped;
        }
        if (!closed) throw new Error('unterminated module string');
        push(start, 'string', value);
        continue;
      }
      if (character === '/' && canStartRegexp) {
        cursor += 1;
        let characterClass = false;
        let closed = false;
        while (cursor < source.length) {
          const next = source[cursor++];
          if (next === '\\') { cursor += 1; continue; }
          if (next === '[') characterClass = true;
          else if (next === ']') characterClass = false;
          else if (next === '/' && !characterClass) { closed = true; break; }
        }
        if (!closed) throw new Error('unterminated module regexp');
        while (/[a-z]/i.test(source[cursor] ?? '')) cursor += 1;
        previous = '/';
        canStartRegexp = false;
        continue;
      }
      const start = cursor++;
      if (/[\w$]/.test(character)) {
        while (/[\w$]/.test(source[cursor] ?? '')) cursor += 1;
        push(start, 'word');
        continue;
      }
      if (character === '{') braces += 1;
      if (character === '}') braces -= 1;
      if ((character === '+' || character === '-') && source[cursor] === character) cursor += 1;
      push(start, 'punctuation');
    }
  };
  scan();
  return tokens;
}

export function moduleReferences(source: string): ModuleReference[] {
  const tokens = moduleTokens(source);
  const references: ModuleReference[] = [];
  const add = (token: ModuleToken | undefined, dynamic = false) => {
    if (token?.kind === 'string') references.push({ start: token.start, end: token.end, specifier: token.value, dynamic });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'word' || tokens[index - 1]?.value === '.') continue;
    if (token.value === 'import') {
      const next = tokens[index + 1];
      if (next?.kind === 'string') { add(next); continue; }
      if (next?.value === '(') {
        if (tokens[index + 3]?.value === ')' || tokens[index + 3]?.value === ',') add(tokens[index + 2], true);
        continue;
      }
      if (next?.value === '.') {
        if (tokens[index + 2]?.value === 'meta' && tokens[index + 3]?.value === '.' && tokens[index + 4]?.value === 'url') {
          references.push({ start: token.start, end: tokens[index + 4]?.end ?? token.end, specifier: null, dynamic: false });
        }
        continue;
      }
      if (next?.kind !== 'word' && next?.value !== '{' && next?.value !== '*') continue;
    } else if (token.value !== 'export' || !['{', '*'].includes(tokens[index + 1]?.value ?? '')) continue;
    for (let following = index + 1; following < tokens.length; following += 1) {
      const candidate = tokens[following];
      if (candidate?.value === ';') break;
      if (candidate?.kind === 'word' && candidate.value === 'from') { add(tokens[following + 1]); break; }
    }
  }
  return references.filter((reference, index) => references.findIndex((other) => other.start === reference.start) === index);
}

/** The lazy loader's literal import is emitted by the build. No filename,
 * preload count/order, or minifier/helper name identifies the map entry. */
export function mapModuleUrl(loaderSource: string, baseUrl: string): string | null {
  const imports = moduleReferences(loaderSource).filter((reference) => reference.dynamic && reference.specifier !== null);
  if (imports.length !== 1 || !imports[0]?.specifier) return null;
  return new URL(imports[0].specifier, baseUrl).href;
}

export async function readModuleSource(url: string): Promise<string> {
  const controller = new AbortController();
  let idleTimer = setTimeout(() => controller.abort(), MAP_CHUNK_PROBE_TIMEOUT_MS);
  const overallTimer = setTimeout(() => controller.abort(), MAP_MODULE_DOWNLOAD_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const noteProgress = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), MAP_MODULE_IDLE_TIMEOUT_MS);
  };
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new TypeError(`Failed to fetch dynamically imported module: ${url}`);
    // Headers have their own short deadline. Download time is bounded by
    // inactivity, not chunk size or bandwidth; trickling cannot evade the cap.
    noteProgress();
    if (!response.body) return '';
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const source: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      noteProgress();
      source.push(decoder.decode(value, { stream: true }));
    }
    source.push(decoder.decode());
    return source.join('');
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    controller.abort();
    reader?.releaseLock();
  }
}

const freshModuleLoads = new Map<string, Promise<unknown>>();

/** A query on just the entry leaves WebKit's failed transitive module records
 * intact. Each recovered source gets a new Blob module identity, and every
 * import in that graph points to the corresponding fresh dependency. The
 * already-running shell and its static dependency closure retain their native
 * identities, so recovery does not execute the application twice. */
export function loadFreshMapModule<T>(entryUrl: string, nonce: string, shellUrl: string): Promise<T> {
  const key = `${entryUrl}\n${nonce}\n${shellUrl}`;
  const existing = freshModuleLoads.get(key);
  if (existing) return existing as Promise<T>;
  const promise = buildFreshMapModule<T>(entryUrl, nonce, shellUrl);
  freshModuleLoads.set(key, promise);
  void promise.catch(() => { if (freshModuleLoads.get(key) === promise) freshModuleLoads.delete(key); });
  return promise;
}

async function buildFreshMapModule<T>(entryUrl: string, nonce: string, shellUrl: string): Promise<T> {
  const stable = new Set<string>();
  const preserve = async (url: string): Promise<void> => {
    if (stable.has(url)) return;
    stable.add(url);
    const source = await readModuleSource(url);
    const references = moduleReferences(source).filter((reference) => reference.specifier !== null && !reference.dynamic);
    await Promise.all(references.map((reference) => preserve(new URL(reference.specifier ?? '', url).href)));
  };
  // Missing graph discovery is a real recovery failure, never "styles OK".
  await preserve(shellUrl);
  const sources = new Map<string, { source: string; references: ModuleReference[] }>();
  const visiting = new Set<string>();
  const discover = async (url: string): Promise<void> => {
    if (stable.has(url) || visiting.has(url)) return;
    visiting.add(url);
    if (new URL(url).origin !== new URL(shellUrl).origin) throw new Error('map module graph must be same-origin');
    const source = await readModuleSource(retryMapModuleUrl(url, nonce));
    const references = moduleReferences(source);
    sources.set(url, { source, references });
    await Promise.all(references.filter((reference) => reference.specifier !== null).map((reference) => discover(new URL(reference.specifier ?? '', url).href)));
  };
  await discover(entryUrl);
  const blobs = new Map<string, string>();
  const constructing = new Set<string>();
  const rewrite = (url: string): string => {
    if (stable.has(url)) return url;
    const existing = blobs.get(url);
    if (existing) return existing;
    if (constructing.has(url)) throw new Error('cyclic map recovery graph');
    const module = sources.get(url);
    if (!module) throw new Error('incomplete map recovery graph');
    constructing.add(url);
    let source = module.source;
    for (const reference of [...module.references].sort((left, right) => right.start - left.start)) {
      const replacement = reference.specifier === null ? url : rewrite(new URL(reference.specifier, url).href);
      source = source.slice(0, reference.start) + JSON.stringify(replacement) + source.slice(reference.end);
    }
    const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    blobs.set(url, blob);
    constructing.delete(url);
    return blob;
  };
  try {
    const root = rewrite(entryUrl);
    // Successful Blob URLs live with this document. Later dynamic imports must
    // still be able to dereference them, including after a bfcache restoration.
    return await import(/* @vite-ignore */ root) as T;
  } catch (error) {
    blobs.forEach((blob) => URL.revokeObjectURL(blob));
    throw error;
  }
}

function stylesheetApplied(link: HTMLLinkElement): boolean {
  try {
    return !link.disabled && (!link.media || window.matchMedia(link.media).matches)
      && link.sheet !== null && !link.sheet.disabled && link.sheet.cssRules.length > 0;
  } catch {
    return false;
  }
}

function sameStylesheet(link: HTMLLinkElement, href: string): boolean {
  return link.href === href || assetPath(link.href) === assetPath(href);
}

const stylesheetLoads = new Map<string, Promise<void>>();

export function loadStylesheet(href: string, timeoutMs = MAP_CHUNK_PROBE_TIMEOUT_MS): Promise<void> {
  const absolute = new URL(href, document.baseURI).href;
  const key = assetPath(absolute);
  const pending = stylesheetLoads.get(key);
  if (pending) return pending;
  const matching = [...document.querySelectorAll('link[rel="stylesheet"]')].filter(
    (node): node is HTMLLinkElement => node instanceof HTMLLinkElement && sameStylesheet(node, absolute),
  );
  // A successful native preload is usable too. Do not replace a healthy link.
  if (matching.some(stylesheetApplied)) return Promise.resolve();
  // Only failed/unowned preload links remain here. Active recovery links are
  // shared by the promise above, so another waiter can never remove one.
  matching.forEach((link) => link.remove());
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stylesheetLoads.delete(key);
      if (!failed) {
        link.dataset.opdStyleReady = '1';
        resolve();
        return;
      }
      link.remove();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => finish(true, 'map stylesheet timed out'), timeoutMs);
    link.addEventListener('load', () => finish(!stylesheetApplied(link), 'map stylesheet has no applied rules'), { once: true });
    link.addEventListener('error', () => finish(true, 'map stylesheet failed'), { once: true });
    document.head.appendChild(link);
  });
  stylesheetLoads.set(key, promise);
  return promise;
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
  isCurrent: () => boolean = () => true,
): Promise<MapImportAction> {
  const kind = await classifyMapImportFailure(error, probe);
  if (!isCurrent()) return { action: 'show-error' };
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
