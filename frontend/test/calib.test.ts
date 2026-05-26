import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildPayload,
  clearQueue,
  drainQueue,
  enqueue,
  getToken,
  postCalib,
  queuedCalibCount,
  readQueue,
  setToken,
} from '../src/calib';

describe('token helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a token', () => {
    setToken('abc');
    expect(getToken()).toBe('abc');
  });

  it('returns null when unset', () => {
    expect(getToken()).toBeNull();
  });
});

describe('buildPayload', () => {
  beforeEach(() => {
    // Slot 8: buildPayload reads getCurrentProfile() via the main.ts
    // module. We can't rely on init() having run in tests, so the active
    // profile is null and buildPayload falls back to DEFAULT_PROFILE_NAME.
    // Tests that need a non-default profile can stash one in localStorage
    // (loadOrCreateProfileFromURL caches it via the picker) — but since
    // calib.ts's getCurrentProfile import lazily resolves the live
    // module-scope `currentProfile` variable in main.ts (which is null
    // until init() runs), the default-fallback branch is what we exercise
    // here.
    localStorage.clear();
  });

  it('packs an action correctly', () => {
    const p = buildPayload('shoot', 'tokyo-night', '2024-10-17T12:00:00Z', 87);
    expect(p.target_id).toBe('tokyo-night');
    expect(p.action).toBe('shoot');
    expect(p.score_at_time).toBe(87);
    expect(p.pass_time.endsWith('Z')).toBe(true);
  });

  it('defaults profile to "anil" when no current profile is set', () => {
    // In unit tests main.ts.init() has not run; getCurrentProfile()
    // returns null and buildPayload falls back to DEFAULT_PROFILE_NAME.
    // Mirrors the Worker's legacy-default behavior for back-compat.
    const p = buildPayload('shoot', 'tokyo-night', '2024-10-17T12:00:00Z', 87);
    expect(p.profile).toBe('anil');
  });

  it('sends profile field in the POST body', async () => {
    setToken('s');
    const captured: Array<{ profile?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: RequestInit) => {
        captured.push(JSON.parse(opts.body as string) as { profile?: string });
        return new Response('{}', { status: 200 });
      }),
    );
    const payload = buildPayload('shoot', 'tokyo-night', '2024-10-17T12:00:00Z', 87);
    await postCalib(payload);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.profile).toBe('anil');
    vi.restoreAllMocks();
  });
});

describe('postCalib', () => {
  beforeEach(() => {
    localStorage.clear();
    clearQueue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues when no token set', async () => {
    const r = await postCalib(
      { target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }
    );
    expect(r.ok).toBe(false);
    expect(readQueue()).toHaveLength(1);
  });

  it('sends when token + network ok', async () => {
    setToken('s');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const r = await postCalib(
      { target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }
    );
    expect(r.ok).toBe(true);
    expect(readQueue()).toHaveLength(0);
  });

  it('queues on 5xx', async () => {
    setToken('s');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    );
    const r = await postCalib(
      { target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }
    );
    expect(r.ok).toBe(false);
    expect(readQueue()).toHaveLength(1);
  });

  it('queues on network error', async () => {
    setToken('s');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    const r = await postCalib(
      { target_id: 't', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' }
    );
    expect(r.ok).toBe(false);
    expect(readQueue()).toHaveLength(1);
  });
});

describe('drainQueue', () => {
  beforeEach(() => {
    localStorage.clear();
    clearQueue();
    setToken('s');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 when queue empty', async () => {
    const sent = await drainQueue();
    expect(sent).toBe(0);
  });

  it('sends queued items when network ok', async () => {
    enqueue({ target_id: 't1', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' });
    enqueue({ target_id: 't2', pass_time: '2024-10-17T12:30:00Z', action: 'skip' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const sent = await drainQueue();
    expect(sent).toBe(2);
    expect(readQueue()).toHaveLength(0);
  });

  it('keeps failed items in queue', async () => {
    enqueue({ target_id: 't1', pass_time: '2024-10-17T12:00:00Z', action: 'shoot' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('err', { status: 502 }))
    );
    const sent = await drainQueue();
    expect(sent).toBe(0);
    expect(readQueue()).toHaveLength(1);
  });
});

describe('queuedCalibCount', () => {
  beforeEach(() => clearQueue());
  afterEach(() => clearQueue());

  it('returns 0 when nothing is queued', () => {
    expect(queuedCalibCount()).toBe(0);
  });

  it('reflects queue length after enqueues', () => {
    enqueue(buildPayload('shoot', 'tokyo', '2024-10-17T12:00:00Z', 50));
    enqueue(buildPayload('skip', 'baikal', '2024-10-17T13:00:00Z', 30));
    expect(queuedCalibCount()).toBe(2);
  });

  it('returns 0 on a corrupted queue (parse failure)', () => {
    localStorage.setItem('opd-calib-queue', '{not valid json');
    expect(queuedCalibCount()).toBe(0);
  });
});
