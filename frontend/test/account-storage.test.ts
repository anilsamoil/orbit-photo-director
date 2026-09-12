import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalibPayload, PassEntry } from '../src/types';
import type { Snapshot } from '../src/snapshot';

const session = vi.hoisted(() => ({ account: null as { name: string; displayName: string; isVerified?: boolean } | null }));
vi.mock('../src/profile-session', () => ({ getAccountProfile: () => session.account }));
vi.mock('../src/main', () => ({ getCurrentProfile: () => null }));

import { clearSnapshot, readSnapshot, saveSnapshot } from '../src/snapshot';
import { clearShotlist, getShotlist, toggleShotlist } from '../src/shotlist';
import { buildPayload, clearQueue, drainQueue, enqueue, postCalib, queuedCalibCount, readQueue } from '../src/calib';

const rating = (profile?: string, target_id = 'test'): CalibPayload => ({
  target_id, pass_time: '2026-09-12T12:00:00Z', action: 'rate', rating: 4, ...(profile ? { profile } : {}),
});
const pass = (target_id: string) => ({ target_id, target_name: target_id, closest_approach: '2026-09-13T12:00:00Z' } as PassEntry);
const snapshot = (name: string) => ({ manifest: { version: name }, track: {}, top5: [pass(name)], top_24h: [], status: null, savedAt: 1 } as unknown as Snapshot);
function signIn(name: string, isVerified = true): void { session.account = { name, displayName: name, isVerified }; }

beforeEach(() => { session.account = null; localStorage.clear(); });
afterEach(() => { session.account = null; vi.unstubAllGlobals(); });

describe('account-owned offline data', () => {
  it('isolates snapshots and reminders across sign-ins without exposing or deleting legacy data', () => {
    saveSnapshot(snapshot('legacy'));
    toggleShotlist(pass('legacy'));
    const legacySnapshot = localStorage.getItem('opd-snapshot');
    const legacyShotlist = localStorage.getItem('opd_shotlist_v1');
    signIn('acct-one');
    expect(readSnapshot()).toBeNull();
    expect(getShotlist()).toEqual([]);
    saveSnapshot(snapshot('one'));
    toggleShotlist(pass('one'));
    signIn('acct-two');
    expect(readSnapshot()).toBeNull();
    expect(getShotlist()).toEqual([]);
    saveSnapshot(snapshot('two'));
    toggleShotlist(pass('two'));
    signIn('acct-one');
    expect(readSnapshot()?.top5[0]?.target_id).toBe('one');
    expect(getShotlist().map((p) => p.target_id)).toEqual(['one']);
    clearSnapshot();
    clearShotlist();
    expect(readSnapshot()).toBeNull();
    expect(getShotlist()).toEqual([]);
    signIn('acct-two');
    expect(readSnapshot()?.top5[0]?.target_id).toBe('two');
    expect(getShotlist().map((p) => p.target_id)).toEqual(['two']);
    expect(localStorage.getItem('opd-snapshot')).toBe(legacySnapshot);
    expect(localStorage.getItem('opd_shotlist_v1')).toBe(legacyShotlist);
  });

  it('allows the verified Anil alias to resume legacy data without resurrecting it after clear', () => {
    saveSnapshot(snapshot('legacy'));
    toggleShotlist(pass('legacy'));
    signIn('anil');
    expect(readSnapshot()?.top5[0]?.target_id).toBe('legacy');
    expect(getShotlist().map((p) => p.target_id)).toEqual(['legacy']);
    clearSnapshot();
    clearShotlist();
    expect(readSnapshot()).toBeNull();
    expect(getShotlist()).toEqual([]);
    expect(localStorage.getItem('opd-snapshot')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('opd_shotlist_v1')!)).toHaveLength(1);
  });
});

describe('account-owned calibration queue', () => {
  it('drains only explicit owner records and preserves foreign and unstamped legacy entries', async () => {
    const legacy = [rating('anil'), rating('jack'), rating()];
    localStorage.setItem('opd-calib-queue', JSON.stringify(legacy));
    signIn('acct-new');
    expect(readQueue()).toEqual([]);
    expect(queuedCalibCount()).toBe(0);
    signIn('anil');
    expect(queuedCalibCount()).toBe(1);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await drainQueue()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).profile).toBe('anil');
    expect(readQueue()).toEqual([rating('jack'), rating()]);
    expect(await drainQueue()).toBe(0);
    clearQueue();
    expect(readQueue()).toEqual([rating('jack'), rating()]);
    expect(localStorage.getItem('opd-calib-queue')).toBe(JSON.stringify(legacy));
  });

  it('stamps the signed-in account and keeps legacy tokens out of session-authenticated requests', async () => {
    signIn('acct-new');
    localStorage.setItem('opd-calib-token', 'old-shared-token');
    const payload = buildPayload('shoot', 'test', '2026-09-12T12:00:00Z', 50);
    expect(payload.profile).toBe('acct-new');
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await postCalib(payload)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/log', expect.objectContaining({ headers: { 'content-type': 'application/json' } }));
  });

  it('blocks a stale foreign-profile action without sending or retagging it', async () => {
    signIn('acct-new');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await postCalib(rating('anil'))).toEqual({ ok: false, reason: 'profile_mismatch' });
    expect(readQueue()[0]?.profile).toBe('anil');
    expect(await drainQueue()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps cached offline account ratings local until the matching account is verified', async () => {
    signIn('acct-one', false);
    saveSnapshot(snapshot('one'));
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    expect(readSnapshot()?.top5[0]?.target_id).toBe('one');
    expect(await postCalib(rating('acct-one'))).toEqual({ ok: false, reason: 'sign_in_required' });
    expect(queuedCalibCount()).toBe(1);
    expect(await drainQueue()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    signIn('acct-two');
    expect(await drainQueue()).toBe(0);
    signIn('acct-one');
    expect(await drainQueue()).toBe(1);
  });

  it('stops an in-flight drain at an account switch and removes only the original confirmed record', async () => {
    signIn('acct-one');
    enqueue(rating('acct-one', 'first'));
    enqueue(rating('acct-one', 'second'));
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const draining = drainQueue();
    signIn('acct-two');
    enqueue(rating('acct-two', 'other'));
    finish(new Response('{"ok":true}'));
    expect(await draining).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readQueue()).toEqual([rating('acct-two', 'other')]);
    signIn('acct-one');
    expect(readQueue()).toEqual([rating('acct-one', 'second')]);
  });

  it('queues a failed in-flight save under its original account after switching', async () => {
    signIn('acct-one');
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const saving = postCalib(rating('acct-one'));
    signIn('acct-two');
    enqueue(rating('acct-two', 'other'));
    finish(new Response('', { status: 503 }));
    expect((await saving).ok).toBe(false);
    expect(readQueue()).toEqual([rating('acct-two', 'other')]);
    signIn('acct-one');
    expect(readQueue()[0]).toMatchObject(rating('acct-one'));
  });
});
