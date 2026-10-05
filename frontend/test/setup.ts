import { afterEach } from 'vitest';

const pending = new Set<number>();
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  const box = { id: 0 };
  box.id = nativeSetTimeout(() => {
    pending.delete(box.id);
    if (typeof handler === 'function') handler(...args);
  }, timeout) as unknown as number;
  pending.add(box.id);
  return box.id;
}) as typeof setTimeout;

globalThis.clearTimeout = ((id?: number) => {
  if (id !== undefined) pending.delete(id);
  nativeClearTimeout(id);
}) as typeof clearTimeout;

afterEach(() => {
  for (const id of pending) nativeClearTimeout(id);
  pending.clear();
});
