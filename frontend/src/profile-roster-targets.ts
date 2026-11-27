import { rosterProfiles } from './crew-roster';
import { parseProfileFromURL, validatePersonalTargetInput, type PersonalTarget } from './profile';
import { getProfileTargets } from './profile-api';
import { ROSTER_READ_SCOPE_INVALIDATED } from './profile-events';
import { getRosterReadScope, invalidateRosterReadScope, resolveAccountProfile } from './profile-session';

export const LINKED_ROSTER_TARGETS_CHANGED = 'opd-linked-roster-targets-changed';

type ReadScope = NonNullable<ReturnType<typeof getRosterReadScope>>;

interface LinkedRosterTargets {
  label: string;
  targets: readonly PersonalTarget[];
}

type LinkedTargetsState =
  | { kind: 'pending'; scope: ReadScope; controller: AbortController; task: Promise<void> }
  | { kind: 'loaded'; scope: ReadScope; result: LinkedRosterTargets };

let state: LinkedTargetsState | undefined;
let offline = false;
let cachedPage = false;
let lifecycleRevision = 0;
let revalidation: { revision: number; task: Promise<void> } | undefined;

if (typeof window !== 'undefined') {
  window.addEventListener(ROSTER_READ_SCOPE_INVALIDATED, clearLinkedRosterTargets);
}

export function linkedRosterTargets(name: string): LinkedRosterTargets | undefined {
  if (state?.kind === 'loaded' && state.scope === getRosterReadScope(name)) {
    return state.result;
  }
}

export function hydrateLinkedRosterTargets(name: string): Promise<void> {
  if (offline || cachedPage) return Promise.resolve();
  const scope = getRosterReadScope(name);
  if (!scope) return Promise.resolve();
  if (state?.scope === scope) {
    return state.kind === 'pending' ? state.task : Promise.resolve();
  }

  clearLinkedRosterTargets();
  const controller = new AbortController();
  const task = readLinkedRosterTargets(scope, controller);
  state = { kind: 'pending', scope, controller, task };
  return task;
}

export function setLinkedRosterTargetsOffline(isOffline: boolean): void {
  if (offline === isOffline) return;
  offline = isOffline;
  if (offline) {
    lifecycleRevision += 1;
    invalidateRosterReadScope();
  } else {
    reverifyLinkedRosterTargets();
  }
}

export function bindLinkedRosterPageLifecycle(): void {
  window.addEventListener('pagehide', onLinkedRosterPageHide);
  window.addEventListener('pageshow', onLinkedRosterPageShow);
}

function onLinkedRosterPageHide(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  cachedPage = true;
  lifecycleRevision += 1;
  invalidateRosterReadScope();
}

function onLinkedRosterPageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  cachedPage = false;
  reverifyLinkedRosterTargets();
}

function reverifyLinkedRosterTargets(): void {
  if (offline || cachedPage || revalidation?.revision === lifecycleRevision) return;
  const url = window.location.href;
  const name = parseProfileFromURL(url);
  if (!rosterProfiles().some((profile) => profile.name === name && profile.accountProfile)) return;
  invalidateRosterReadScope();
  const revision = lifecycleRevision;
  const task = Promise.resolve(revalidation?.task).then(async () => {
    if (revision !== lifecycleRevision) return;
    try {
      await resolveAccountProfile(url);
    } catch {
      return;
    }
    if (revision === lifecycleRevision) await hydrateLinkedRosterTargets(name);
  }).finally(() => {
    if (revalidation?.revision === revision) revalidation = undefined;
  });
  revalidation = { revision, task };
}

export function clearLinkedRosterTargets(): void {
  const previous = state;
  state = undefined;
  if (previous?.kind === 'pending') previous.controller.abort();
  if (previous?.kind === 'loaded' && previous.result.targets.length) notifyLinkedTargetsChanged();
}

async function readLinkedRosterTargets(scope: ReadScope, controller: AbortController): Promise<void> {
  const { signal } = controller;
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const aborted = new Promise<undefined>((resolve) => {
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });

  try {
    const result = await Promise.race([getProfileTargets(scope.profileName, '', signal), aborted]).catch(() => undefined);
    if (!result?.ok || signal.aborted || scope !== getRosterReadScope(scope.account.name)) return;
    const targets = validatedTargets(result.data.targets, scope.profileName);
    state = { kind: 'loaded', scope, result: { label: `${scope.displayName}’s account profile`, targets } };
    if (targets.length) notifyLinkedTargetsChanged();
  } finally {
    clearTimeout(timeout);
    if (state?.kind === 'pending' && state.controller === controller) state = undefined;
  }
}

function validatedTargets(rows: readonly unknown[], profileName: string): readonly PersonalTarget[] {
  const targets = new Map<string, PersonalTarget>();
  for (const row of rows) {
    if (!row || typeof row !== 'object'
      || !('id' in row) || typeof row.id !== 'string'
      || !('name' in row) || typeof row.name !== 'string'
      || !('lat' in row) || typeof row.lat !== 'number'
      || !('lon' in row) || typeof row.lon !== 'number'
      || !('priority' in row) || typeof row.priority !== 'number'
      || !('createdAt' in row) || typeof row.createdAt !== 'string') continue;
    const { id, name, lat, lon, priority, createdAt } = row;
    const checked = validatePersonalTargetInput({ profileName, id, name, lat, lon, priority, createdAt });
    if (!checked.ok) continue;
    if (!targets.has(id)) targets.set(id, checked.target);
  }
  return [...targets.values()];
}

function notifyLinkedTargetsChanged(): void {
  window.dispatchEvent(new Event(LINKED_ROSTER_TARGETS_CHANGED));
}
