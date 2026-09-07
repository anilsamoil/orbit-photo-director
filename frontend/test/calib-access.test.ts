import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainQueue, enqueue, postCalib, readQueue } from '../src/calib';

const payload = { target_id: 'test', pass_time: '2026-09-07T12:00:00Z', action: 'rate' as const, rating: 4 };
beforeEach(() => localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); });

describe('Access session calibration', () => {
  for (const status of [302, 401, 403, 503]) {
    it(`preserves ratings on ${status}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
      expect((await postCalib(payload)).ok).toBe(false);
      expect(readQueue()).toHaveLength(1);
    });
  }
  for (const body of ['<html>Sign in</html>', '{}', '{"ok":false}', 'null']) {
    it(`never accepts HTTP200 without a save receipt: ${body}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
      expect(await postCalib(payload)).toEqual({ ok: false, reason: 'sign_in_required' });
      expect(readQueue()).toHaveLength(1);
    });
  }
  it('keeps a new rating added while draining and single-flights callers', async () => {
    enqueue(payload);
    let finish!: (response: Response) => void;
    const mock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', mock);
    const first = drainQueue();
    const second = drainQueue();
    expect(first).toBe(second);
    enqueue({ ...payload, target_id: 'new' });
    finish(new Response('{"ok":true}'));
    expect(await first).toBe(1);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(readQueue().map((entry) => entry.target_id)).toEqual(['new']);
  });
  it('failed drains neither lose nor multiply entries', async () => {
    enqueue(payload);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    expect(await drainQueue()).toBe(0);
    expect(await drainQueue()).toBe(0);
    expect(readQueue()).toEqual([payload]);
  });
});
