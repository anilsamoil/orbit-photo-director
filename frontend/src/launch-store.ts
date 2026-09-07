import { parseLaunchArtifact, parseLaunchPointer, type LaunchArtifact, type LaunchPointer } from './launch-schema';

export const LAUNCH_STORAGE_KEY = 'opd-launch-v2';
const MAX_BYTES = 2_000_000;
export interface LaunchState {
  artifact: LaunchArtifact | null;
  pointer: LaunchPointer | null;
  availability: 'loading' | 'ready' | 'unavailable' | 'last-good' | 'offline';
}
type Envelope = { pointer: LaunchPointer; body: string };

export async function validateLaunchBytes(pointer: LaunchPointer, bytes: ArrayBuffer): Promise<LaunchArtifact> {
  if (bytes.byteLength > MAX_BYTES) throw new Error('Launch artifact too large');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
  if (hash !== pointer.sha256) throw new Error('Launch hash mismatch');
  const artifact = parseLaunchArtifact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (artifact.revision !== pointer.revision || artifact.generated_at !== pointer.generated_at || artifact.valid_until !== pointer.valid_until) {
    throw new Error('Launch revision mismatch');
  }
  return artifact;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function samePointer(a: LaunchPointer, b: LaunchPointer): boolean {
  return a.revision === b.revision && a.sha256 === b.sha256 && a.generated_at === b.generated_at && a.valid_until === b.valid_until;
}

/** A single public artifact, never profile-specific. Consumers do not fetch. */
export class LaunchStore {
  private state: LaunchState = freeze({ artifact: null, pointer: null, availability: 'loading' });
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private latestOnline = true;
  private onlineIntent = 0;
  private controller: AbortController | null = null;
  private restored: Promise<void> | null = null;
  private clockKey = '';
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}
  getState(): LaunchState { return this.state; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(state: LaunchState): void {
    this.state = freeze(state);
    for (const listener of this.listeners) listener();
  }
  restore(): Promise<void> {
    if (this.restored) return this.restored;
    this.restored = (async () => {
      try {
        const raw = localStorage.getItem(LAUNCH_STORAGE_KEY);
        if (!raw || raw.length > MAX_BYTES * 2) return;
        const saved = JSON.parse(raw) as Envelope;
        const pointer = parseLaunchPointer(saved.pointer);
        if (typeof saved.body !== 'string') return;
        const artifact = await validateLaunchBytes(pointer, new TextEncoder().encode(saved.body).buffer);
        if (!this.state.artifact) this.publish({ artifact, pointer, availability: this.latestOnline ? 'last-good' : 'offline' });
      } catch { /* A corrupt or inaccessible cache cannot block Earth data. */ }
    })();
    return this.restored;
  }
  refresh(online = true): Promise<void> {
    if (online !== this.latestOnline) this.onlineIntent += 1;
    this.latestOnline = online;
    if (!online && this.inFlight) {
      this.controller?.abort();
      this.publish({ ...this.state, availability: 'offline' });
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        let intent: number;
        do {
          intent = this.onlineIntent;
          await this.load(this.latestOnline);
        } while (intent !== this.onlineIntent);
      } finally { this.inFlight = null; }
    })();
    return this.inFlight;
  }
  private async load(online: boolean): Promise<void> {
    await this.restore();
    if (online !== this.latestOnline) return;
    if (!online) {
      this.publish({ ...this.state, availability: 'offline' });
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 12_000);
    const get = async (path: string, cache: RequestCache): Promise<Response> => {
      const response = await this.fetcher(path, { cache, redirect: 'error', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(`Launch fetch ${response.status}`);
      return response;
    };
    const getPointer = async () => parseLaunchPointer(await (await get('/launch/latest.json', 'no-store')).json());
    try {
      const pointer = await getPointer();
      if (controller.signal.aborted) throw new Error('Launch refresh aborted');
      const old = this.state.pointer;
      if (old && (Date.parse(pointer.generated_at) < Date.parse(old.generated_at)
        || (pointer.revision === old.revision && !samePointer(pointer, old))
        || (pointer.generated_at === old.generated_at && pointer.revision !== old.revision))) {
        throw new Error('Launch revision regression or collision');
      }
      if (old && samePointer(pointer, old)) {
        this.publish({ ...this.state, availability: 'ready' });
        return;
      }
      const bytes = await (await get(`/${pointer.path}`, 'force-cache')).arrayBuffer();
      const artifact = await validateLaunchBytes(pointer, bytes);
      if (controller.signal.aborted) throw new Error('Launch refresh aborted');
      // A pointer change during download must not publish an already
      // superseded capture instruction. Retry on the next common poll.
      if (!samePointer(pointer, await getPointer())) throw new Error('Launch pointer changed during refresh');
      if (controller.signal.aborted) throw new Error('Launch refresh aborted');
      this.publish({ artifact, pointer, availability: 'ready' });
      try {
        const saved: Envelope = { pointer, body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
        localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(saved));
      } catch { /* Quota/private mode: keep the validated in-memory revision. */ }
    } catch {
      if (this.latestOnline) this.publish({ ...this.state, availability: this.state.artifact ? 'last-good' : 'unavailable' });
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }
  }
  /** Called by the existing UI clock; no second fetch timer. */
  tick(now: number): void {
    const artifact = this.state.artifact;
    if (!artifact) return;
    const lifetime = Date.parse(artifact.valid_until) - Date.parse(artifact.generated_at);
    const sourceExpiries = [artifact.coverage.fetched_at, ...artifact.items.flatMap((item) => item.sources.map((source) => source.fetched_at))]
      .filter((timestamp): timestamp is string => timestamp !== null)
      .map((timestamp) => new Date(Date.parse(timestamp) + lifetime).toISOString());
    const boundaries = [artifact.valid_until, artifact.generated_at, artifact.coverage.until, ...artifact.items.flatMap((item) => [
      item.launch_window.net, item.launch_window.end ?? item.launch_window.net,
      ...item.capture_intervals.flatMap((interval) => [interval.start, interval.peak, interval.end]),
    ]), ...sourceExpiries];
    const key = boundaries.map((time) => {
      const t = Date.parse(time);
      return `${t > now}:${t > now - 30 * 60_000}:${t <= now + 90 * 60_000}:${t <= now + 36 * 3600_000}:${t <= now + 7 * 24 * 3600_000}`;
    }).join('|');
    if (key !== this.clockKey) {
      this.clockKey = key;
      for (const listener of this.listeners) listener();
    }
  }
}

export const launchStore = new LaunchStore();
