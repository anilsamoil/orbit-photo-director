/** Map-only launch selection. Each visit starts with normal sites and no panel. */
let enabled = false;
const listeners = new Set<(enabled: boolean) => void>();

export function getMapLaunchMode(): boolean { return enabled; }

export function setMapLaunchMode(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  for (const listener of [...listeners]) listener(enabled);
}

export function subscribeMapLaunchMode(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
