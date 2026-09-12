/** Once targets are edited locally, automatic additive hydration waits for
 * the next page load. In particular, an optimistic DELETE must not be undone
 * by a GET that still contains the soon-to-be-deleted server record. */
const locallyChanged = new Set<string>();
const REVISION_PREFIX = 'opd-profile-target-revision:';

/** Cross-tab coordination only; no targets or deletion history are stored. */
export function profileTargetRevision(profileName: string): string | null {
  try { return localStorage.getItem(REVISION_PREFIX + profileName); }
  catch { return null; }
}

export function markProfileTargetsChanged(profileName: string): void {
  locallyChanged.add(profileName);
  try {
    // Unique stamps avoid two tabs independently incrementing the same value.
    const revision = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID() : `${Date.now()}:${Math.random()}`;
    localStorage.setItem(REVISION_PREFIX + profileName, revision);
  } catch { /* local mutation still proceeds; storage errors surface on save */ }
}

export function profileTargetsChanged(profileName: string): boolean {
  return locallyChanged.has(profileName);
}

export function resetProfileTargetSyncForTests(): void {
  locallyChanged.clear();
}
