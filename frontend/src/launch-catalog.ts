import { parseLaunchCatalogPointer, type LaunchCatalog, type LaunchCatalogPointer } from './launch-schema';
import { launchStore, validateLaunchBytes } from './launch-store';
import { tiersAt, type TierCatalog } from './launch-tiers';

const POINTER_PATH = '/launch/catalog/latest.json';
const CATALOG_TIMEOUT_MS = 12_000;

type Held = { readonly pointer: LaunchCatalogPointer; readonly catalog: LaunchCatalog };

function samePointer(a: LaunchCatalogPointer, b: LaunchCatalogPointer): boolean {
  return a.revision === b.revision && a.sha256 === b.sha256 && a.generated_at === b.generated_at
    && a.valid_until === b.valid_until && a.path === b.path;
}

function signature(tiers: TierCatalog | null): string {
  if (!tiers) return '';
  const ids = (rows: readonly { eventId: string }[]) => rows.map((row) => row.eventId).join(',');
  return [
    tiers.revision,
    tiers.closedLabel,
    ids(tiers.pins),
    ids(tiers.highlights),
    ids(tiers.upcoming),
    ids(tiers.groups.shot),
    ids(tiers.groups.likely),
    ids(tiers.groups.watch),
    ids(tiers.all),
  ].join('|');
}

/** Schema 3 catalog slot. Memory only, with its own fetch, abort, and pointer. */
export class LaunchCatalogStore {
  private held: Held | null = null;
  private seen: LaunchCatalogPointer | null = null;
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private readKey = '';

  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}

  read(now: number): TierCatalog | null {
    if (!this.held) return null;
    if (this.seen && !samePointer(this.seen, this.held.pointer)) return null;
    return tiersAt(this.held.catalog, now);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  refresh(online = true): Promise<void> {
    if (!online) {
      this.controller?.abort();
      return Promise.resolve();
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().then(() => undefined, () => undefined).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  tick(now: number): void {
    const key = signature(this.read(now));
    if (key === this.readKey) return;
    this.readKey = key;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async load(): Promise<void> {
    const beforeHeld = this.held;
    const beforeSeen = this.seen;
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      const pointer = parseLaunchCatalogPointer(await this.document(POINTER_PATH, 'no-store', controller.signal));
      if (this.held && Date.parse(pointer.generated_at) < Date.parse(this.held.catalog.generated_at)) return;
      this.seen = pointer;
      if (this.held && samePointer(pointer, this.held.pointer)) return;
      const bytes = await this.bytes(`/${pointer.path}`, 'force-cache', controller.signal);
      if (controller.signal.aborted) throw new Error('catalog aborted');
      const artifact = await validateLaunchBytes(pointer, bytes);
      if (artifact.schema_version !== 3) throw new Error('catalog schema');
      const settled = parseLaunchCatalogPointer(await this.document(POINTER_PATH, 'no-store', controller.signal));
      if (!samePointer(pointer, settled)) {
        this.seen = settled;
        throw new Error('catalog superseded');
      }
      this.held = { pointer, catalog: artifact };
    } catch {
      /* A miss keeps the previous hold. A newer pointer already in seen supersedes it. */
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
      const seenChanged = this.seen === null
        ? beforeSeen !== null
        : beforeSeen === null || !samePointer(this.seen, beforeSeen);
      if (this.held !== beforeHeld || seenChanged) this.emit();
    }
  }

  private async document(path: string, cache: RequestCache, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(path, { cache, redirect: 'error', credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (type.includes('text/html') || text.trimStart().startsWith('<')) throw new Error('catalog html');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('catalog json');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('catalog json');
    return parsed;
  }

  private async bytes(path: string, cache: RequestCache, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await this.fetcher(path, { cache, redirect: 'error', credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/html')) throw new Error('catalog html');
    const payload = await response.arrayBuffer();
    const head = new TextDecoder().decode(payload.slice(0, 64)).trimStart();
    if (head.startsWith('<')) throw new Error('catalog html');
    return payload;
  }
}

export const launchCatalog = new LaunchCatalogStore();

/** Both launch slots. Surfaces that branch on the catalog subscribe here. */
export function subscribeLaunchSlots(listener: () => void): () => void {
  const offStore = launchStore.subscribe(listener);
  const offCatalog = launchCatalog.subscribe(listener);
  return () => {
    offStore();
    offCatalog();
  };
}
